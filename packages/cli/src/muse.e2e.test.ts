import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cli = join(import.meta.dir, "cli.ts")
const bin = Bun.which("muse") ?? undefined

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

test.skipIf(!bin)(
  "setup installs and approves the Muse plugin, and a headless muse exec joins as muse and gets a message on its prompt (skipped without muse)",
  () => {
    const root = mkdtempSync(join(tmpdir(), "scp-muse-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const project = join(root, "proj")
    const tools = join(root, "bin")
    const shown = join(root, "prompt-hook.txt")
    mkdirSync(project, { recursive: true })
    mkdirSync(tools, { recursive: true })
    const run = `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}`
    writeFileSync(
      join(tools, "swarm"),
      `#!/bin/sh\nif [ "$3" = UserPromptSubmit ]; then ${run} "$@" | tee -a ${JSON.stringify(shown)}; exit 0; fi\nexec ${run} "$@"\n`,
    )
    chmodSync(join(tools, "swarm"), 0o755)
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `${tools}:${process.env.PATH ?? ""}`,
      HOME: root,
      XDG_CONFIG_HOME: join(root, ".config"),
      XDG_STATE_HOME: join(root, ".local", "state"),
      XDG_DATA_HOME: join(root, ".local", "share"),
      XDG_CACHE_HOME: join(root, ".cache"),
      SCP_IDLE: "60s",
    }
    for (const key of ["SCP_DIR", "SCP_NAME", "SCP_SESSION", "SCP_GRANT", "SCP_PARENT", "SCP_HARNESS", "SCP_TRANSPORT", "SCP_WAKE", "MUSE_SESSION_ID"])
      delete env[key]
    const swarm = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, cwd: project, encoding: "utf8", timeout: 60_000 })
    const muse = (prompt: string) =>
      spawnSync(bin!, ["exec", "--provider", "echo", "--approval-mode", "never", prompt], { env, cwd: project, encoding: "utf8", timeout: 60_000 })
    cleanups.push(() => swarm("daemon", "stop"))

    const setup = swarm("setup", "--write", "--harness", "muse")
    expect(setup.status).toBe(0)
    expect(setup.stdout).toContain("muse hooks: installed (muse plugins list)")
    expect(existsSync(join(root, ".config", "scp", "muse-plugin", ".muse-plugin", "plugin.json"))).toBe(true)
    const inspect = spawnSync(bin!, ["plugins", "inspect", "scp", "--json"], { env, encoding: "utf8" })
    const caps = (JSON.parse(inspect.stdout) as { runtime_capabilities: { status: string }[] }).runtime_capabilities
    expect(caps.length).toBeGreaterThan(0)
    expect(caps.every((cap) => cap.status === "trusted_enabled")).toBe(true)

    expect(muse("hello").status).toBe(0)
    const listed = JSON.parse(swarm("list", "--as", "tester", "--all", "--json").stdout) as { endpoints: { address: string; harness: string }[] }
    expect(listed.endpoints.find((e) => e.address === "me/muse-proj")?.harness).toBe("muse")

    expect(swarm("send", "--as", "tester", "muse-proj", "ping from tester").status).toBe(0)
    expect(muse("hello again").status).toBe(0)
    const context = readFileSync(shown, "utf8")
    expect(context).toContain('"hookEventName":"UserPromptSubmit"')
    expect(context).toContain("ping from tester")
  },
  180_000,
)
