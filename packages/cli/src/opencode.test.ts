import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { opencodePlugin } from "./hooks"
import { opencodeCommand, opencodeLaunch, opencodeMountHint, pluginProblem } from "./opencode"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function scratch(): { root: string; config: string; project: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "swarm-opencode-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const config = join(root, ".config")
  const project = join(root, "project")
  mkdirSync(join(config, "opencode"), { recursive: true })
  mkdirSync(project, { recursive: true })
  return { root, config, project, env: { HOME: root, XDG_CONFIG_HOME: config, PATH: "/nonexistent" } }
}

test("swarm opencode names the session, marks it opencode with wake on and passes every other argument through", () => {
  const launch = opencodeLaunch(
    ["--name", "me/demo", "-m", "prov/model", "--agent", "plan", "--", "--name", "x"],
    { PATH: "/bin", SCP_WAKE: "0" },
    "/bin/opencode",
  )
  expect(launch.argv).toEqual(["/bin/opencode", "-m", "prov/model", "--agent", "plan", "--name", "x"])
  expect(launch.env).toEqual({ PATH: "/bin", SCP_HARNESS: "opencode", SCP_WAKE: "1", SCP_NAME: "demo" })
  expect(opencodeLaunch(["--as=demo", "run", "task"], {}, "oc").argv).toEqual(["oc", "run", "task"])
  expect(opencodeLaunch([], {}, "oc").env.SCP_NAME).toBeUndefined()
  expect(() => opencodeLaunch(["--name", "Bad Name"], {}, "oc")).toThrow("not a valid agent handle")
  expect(() => opencodeLaunch(["--name"], {}, "oc")).toThrow("takes a name")
})

test("the launcher refuses to start without the current plugin and names the fix", () => {
  const { config, project, env } = scratch()
  expect(pluginProblem(env, project)).toContain("has no swarm plugin")
  expect(pluginProblem(env, project)).toContain("swarm setup --write")
  const user = join(config, "opencode", "plugin", "scp.ts")
  mkdirSync(join(config, "opencode", "plugin"), { recursive: true })
  writeFileSync(user, "// scp: an older plugin\nconst BLOCK_STOP = false\n")
  expect(pluginProblem(env, project)).toContain("is not this swarm's plugin")
  writeFileSync(user, opencodePlugin({ blockStop: true }))
  expect(pluginProblem(env, project)).toBeUndefined()
  rmSync(user)
  mkdirSync(join(project, ".opencode", "plugin"), { recursive: true })
  writeFileSync(join(project, ".opencode", "plugin", "scp.ts"), opencodePlugin())
  expect(pluginProblem(env, project)).toBeUndefined()
})

test("the launcher hints at a missing MCP mount, read from the user's or the project's config", () => {
  const { config, project, env } = scratch()
  expect(opencodeMountHint(env, project)).toContain("no scp MCP mount")
  const mount = { mcp: { scp: { type: "local", command: ["swarm", "mcp", "--harness", "opencode"], enabled: true } } }
  writeFileSync(join(project, "opencode.json"), JSON.stringify(mount))
  expect(opencodeMountHint(env, project)).toBeUndefined()
  rmSync(join(project, "opencode.json"))
  writeFileSync(join(config, "opencode", "opencode.jsonc"), JSON.stringify({ model: "prov/model", ...mount }))
  expect(opencodeMountHint(env, project)).toBeUndefined()
})

test("swarm opencode runs the binary with the user's arguments, the name and wake on, and exits with its code", async () => {
  const { root, config, project, env } = scratch()
  mkdirSync(join(config, "opencode", "plugin"), { recursive: true })
  writeFileSync(join(config, "opencode", "plugin", "scp.ts"), opencodePlugin())
  const seen = join(root, "seen")
  const bin = join(root, "opencode")
  writeFileSync(bin, `#!/bin/sh\necho "$SCP_NAME $SCP_HARNESS $SCP_WAKE $*" > ${JSON.stringify(seen)}\nexit 3\n`)
  chmodSync(bin, 0o755)
  const errors: string[] = []
  const code = await opencodeCommand(
    ["--name", "oc1", "-m", "prov/model"],
    { ...env, PATH: `/usr/bin:/bin`, SCP_OPENCODE_BIN: bin },
    (line) => errors.push(line),
    project,
  )
  expect(code).toBe(3)
  expect(readFileSync(seen, "utf8").trim()).toBe("oc1 opencode 1 -m prov/model")
  expect(errors.join("\n")).toContain("no scp MCP mount")
  await expect(opencodeCommand([], { ...env, SCP_OPENCODE_BIN: bin }, () => {}, root)).resolves.toBe(3)
  rmSync(join(config, "opencode", "plugin", "scp.ts"))
  await expect(opencodeCommand([], { ...env, SCP_OPENCODE_BIN: bin }, () => {}, project)).rejects.toThrow("swarm setup --write")
})
