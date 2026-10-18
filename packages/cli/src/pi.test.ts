import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { extensionPath, piLaunch } from "./pi"
import { ensureBuilt } from "./testing/fixtures"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "swarm-pi-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test("swarm pi names the session, marks the harness pi and passes the rest to pi with the extension", () => {
  const launch = piLaunch(["--name", "me/demo", "--", "--name", "x", "-c"], { PATH: "/bin" }, "/ext/index.ts")
  expect(launch.argv).toEqual(["pi", "--extension", "/ext/index.ts", "--name", "x", "-c"])
  expect(launch.env).toEqual({ PATH: "/bin", SCP_HARNESS: "pi", SCP_NAME: "demo" })
  expect(piLaunch(["--as=demo", "--continue"], { SCP_PI_BIN: "/opt/pi" }, "/e").argv).toEqual(["/opt/pi", "--extension", "/e", "--continue"])
  expect(piLaunch([], {}, "/e").env.SCP_NAME).toBeUndefined()
  expect(() => piLaunch(["--name", "Bad Name"], {}, "/e")).toThrow("not a valid agent handle")
  expect(() => piLaunch(["--name"], {}, "/e")).toThrow("takes a name")
  const args = ["--provider", "anthropic", "--model", "sonnet:high", "--name", "session", "--continue", "a prompt", "--", "-x"]
  expect(piLaunch(["--as", "demo", ...args], {}, "/e").argv).toEqual(["pi", "--extension", "/e", ...args])
  expect(piLaunch(args, {}, "/e").env.SCP_NAME).toBeUndefined()
})

test("the extension is $SCP_PI_EXTENSION, else the file bundled next to the CLI, else the workspace source", () => {
  const root = scratch()
  const dist = join(root, "packages", "cli", "dist")
  const source = join(root, "packages", "pi", "src", "index.ts")
  mkdirSync(dist, { recursive: true })
  const base = pathToFileURL(join(dist, "cli.js"))
  expect(() => extensionPath({}, base)).toThrow("found no pi extension")
  mkdirSync(join(root, "packages", "pi", "src"), { recursive: true })
  writeFileSync(source, "")
  expect(extensionPath({}, base)).toBe(source)
  writeFileSync(join(dist, "pi-extension.js"), "")
  expect(extensionPath({}, base)).toBe(join(dist, "pi-extension.js"))
  expect(extensionPath({ SCP_PI_EXTENSION: "/x.ts" }, base)).toBe("/x.ts")
})

test("the built CLI ships the extension as one self-contained file and hands it to pi", () => {
  ensureBuilt()
  const dist = join(import.meta.dir, "..", "dist")
  const bundled = join(dist, "pi-extension.js")
  expect(existsSync(bundled)).toBe(true)
  const imports = [...readFileSync(bundled, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])
  expect(imports.filter((spec) => spec!.startsWith(".") || spec!.startsWith("@scp-dev/"))).toEqual([])
  const root = scratch()
  const fakePi = join(root, "pi")
  writeFileSync(fakePi, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
  chmodSync(fakePi, 0o755)
  const { SCP_PI_EXTENSION: _, ...env } = process.env
  const result = spawnSync(Bun.which("node") ?? "bun", [join(dist, "cli.js"), "pi", "--name", "demo", "--", "-c"], {
    env: { ...env, SCP_PI_BIN: fakePi },
    encoding: "utf8",
    timeout: 30_000,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim().split("\n")).toEqual(["--extension", bundled, "-c"])
}, 180_000)
