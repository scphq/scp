import { afterEach, expect, test } from "bun:test"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cli = join(import.meta.dir, "cli.ts")
const bin = Bun.which("muse") ?? undefined

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** a throwaway HOME and broker with Muse set up, whose prompt hook also appends what it prints to `shown` */
function sandbox() {
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
  cleanups.push(() => void swarm("daemon", "stop"))
  const setup = swarm("setup", "--write", "--harness", "muse")
  expect(setup.status).toBe(0)
  expect(setup.stdout).toContain("muse hooks: installed (muse plugins list)")
  return { root, project, shown, env, swarm }
}

async function until(probe: () => boolean, ms: number, what: () => string): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (probe()) return
    await Bun.sleep(200)
  }
  throw new Error(`timed out waiting for ${what()}`)
}

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000)
  child.kill("SIGTERM")
  await exited
  clearTimeout(timer)
}

test.skipIf(!bin)(
  "setup installs and approves the Muse plugin, and a headless muse exec joins as muse and gets a message on its prompt (skipped without muse)",
  () => {
    const { root, project, shown, env, swarm } = sandbox()
    const muse = (prompt: string) =>
      spawnSync(bin!, ["exec", "--provider", "echo", "--approval-mode", "never", prompt], { env, cwd: project, encoding: "utf8", timeout: 60_000 })
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

test.skipIf(!bin)(
  "swarm muse under a spawn grant links under its caller, advertises muse-serve, and a send wakes the idle session into one turn (skipped without muse)",
  async () => {
    const { project, shown, env, swarm } = sandbox()
    const grant = swarm("spawn-env", "--as", "parent", "--name", "kid")
    expect(grant.status, grant.stderr).toBe(0)
    const launchEnv = { ...env }
    for (const line of grant.stdout.trim().split("\n")) {
      const eq = line.indexOf("=")
      if (eq > 0) launchEnv[line.slice(0, eq)] = line.slice(eq + 1)
    }
    const child = spawn(process.execPath, [cli, "muse", "--approval-mode", "never", "--", "--provider", "echo"], {
      env: launchEnv,
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout!.on("data", (data: Buffer) => {
      out += data.toString()
    })
    child.stderr!.on("data", (data: Buffer) => {
      err += data.toString()
    })
    cleanups.push(() => stop(child))
    const kid = () => {
      const listed = JSON.parse(swarm("list", "--as", "parent", "--all", "--json").stdout) as {
        endpoints: { address: string; harness: string; wake?: string | null; parent?: string | null; title?: string | null }[]
      }
      return listed.endpoints.find((e) => e.address === "me/kid")
    }
    await until(
      () => err.includes("kid waiting for messages") && kid()?.wake === "muse-serve",
      60_000,
      () => `kid to advertise muse-serve: ${err}`,
    )
    expect(kid()).toMatchObject({ harness: "muse", parent: "me/parent" })

    expect(swarm("send", "--as", "peer", "kid", "ping from a peer").status).toBe(0)
    await until(
      () => out.includes("ping from a peer"),
      60_000,
      () => `the woken turn: ${err}`,
    )
    expect(out).toContain("echo: ")
    await Bun.sleep(1500)
    expect(out.split("ping from a peer").length - 1).toBe(1)
    expect(existsSync(shown) ? readFileSync(shown, "utf8") : "").not.toContain("ping from a peer")
    expect(kid()?.title ?? null).toBeNull()

    await stop(child)
    expect(child.exitCode).toBe(0)
  },
  180_000,
)
