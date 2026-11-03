import { afterAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { daemonEnv } from "./common"
import { mcpLine } from "./main"
import {
  brokerEngine,
  goneCommand,
  mcpMount,
  mcpWords,
  mountVars,
  mountWith,
  nativeBroker,
  nativeDaemonEnv,
  nativeMode,
  nativeSwarm,
  resetMountNote,
} from "./native"
import { SELF } from "./term"
import { swarmBinary } from "./test-setup"
import { alive, waitFor } from "./testing/fixtures"

setDefaultTimeout(30_000)

const root = mkdtempSync(join(process.env.HOME!, "native-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const entry = join(import.meta.dir, "cli.ts")
async function swarm(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

/** an executable `swarm` that records each run in `calls` and prints `swarm <version>` */
function fakeSwarm(name: string, version: string) {
  const dir = join(root, name)
  mkdirSync(dir)
  const bin = join(dir, "swarm")
  const calls = join(dir, "calls")
  writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${calls}'\necho "swarm ${version}"\n`)
  chmodSync(bin, 0o755)
  return { bin, calls }
}

function lockPid(dir: string) {
  return Number(readFileSync(join(dir, "broker.lock"), "utf8").split(":")[0])
}

/** SIGTERM to a broker this test started, only while the pid still runs a broker */
function stopStarted(pid: number) {
  if (!alive(pid)) return
  const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]).stdout.toString()
  if (/(^|\s)daemon(\s|$)/.test(command)) process.kill(pid, "SIGTERM")
}

const FALLBACK =
  /^swarm: SCP_NATIVE=1 but no native swarm \S+ binary for \S+ \((install @scp-dev\/native-\S+ or )?set SCP_SWARM_BIN\); starting the TypeScript broker$/m

describe("nativeSwarm", () => {
  test("takes SCP_SWARM_BIN only when it prints this CLI's version", () => {
    const { bin } = fakeSwarm("versioned", "1.2.3")
    expect(nativeSwarm({ SCP_SWARM_BIN: bin }, "1.2.3")).toBe(bin)
    expect(nativeSwarm({ SCP_SWARM_BIN: bin }, "1.2.4")).toBeUndefined()
  })

  test("refuses a missing path, a directory and a file that is not executable", () => {
    const { bin } = fakeSwarm("plain", "1.2.3")
    expect(nativeSwarm({ SCP_SWARM_BIN: join(root, "missing") }, "1.2.3")).toBeUndefined()
    expect(nativeSwarm({ SCP_SWARM_BIN: root }, "1.2.3")).toBeUndefined()
    chmodSync(bin, 0o644)
    expect(nativeSwarm({ SCP_SWARM_BIN: bin }, "1.2.3")).toBeUndefined()
  })

  test("the native broker's environment names this CLI for its wakers", () => {
    expect(nativeDaemonEnv({ SCP_DIR: "/relay", UNSET: undefined })).toEqual({ SCP_DIR: "/relay", SCP_CLI_ARGV: JSON.stringify(SELF) })
  })
})

describe("SCP_NATIVE", () => {
  test("only 1 turns it on: any other value runs nothing native, not even a version check", () => {
    const { bin, calls } = fakeSwarm("off", pkg.version)
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) expect(nativeBroker({ SCP_NATIVE: value, SCP_SWARM_BIN: bin })).toBeUndefined()
    expect(existsSync(calls)).toBe(false)
    expect(nativeBroker({ SCP_NATIVE: "1", SCP_SWARM_BIN: bin })).toBe(bin)
    expect(readFileSync(calls, "utf8")).toBe("--version\n")
  })

  test("mcp names the MCP server only: the broker stays the TypeScript one, with no version check", () => {
    const { bin, calls } = fakeSwarm("mcp-only", pkg.version)
    expect([nativeMode({ SCP_NATIVE: "1" }), nativeMode({ SCP_NATIVE: "mcp" }), nativeMode({ SCP_NATIVE: "MCP" }), nativeMode({})]).toEqual([
      "all",
      "mcp",
      "off",
      "off",
    ])
    expect(nativeBroker({ SCP_NATIVE: "mcp", SCP_SWARM_BIN: bin })).toBeUndefined()
    expect(existsSync(calls)).toBe(false)
  })

  test("a started broker keeps SCP_NATIVE and SCP_SWARM_BIN, and only the variables it is allowed", () => {
    expect(daemonEnv("/relay", { SCP_NATIVE: "mcp", SCP_SWARM_BIN: "/b/swarm", SCP_CLI_ARGV: "[]", SCP_GRANT: "krt_x", HOME: "/h", UNSET: undefined })).toEqual(
      {
        SCP_DIR: "/relay",
        SCP_NATIVE: "mcp",
        SCP_SWARM_BIN: "/b/swarm",
        HOME: "/h",
      },
    )
  })

  test("under SCP_NATIVE=mcp the on-demand broker is the TypeScript one, and status says so", async () => {
    const { bin, calls } = fakeSwarm("mcp-broker", pkg.version)
    const env = { SCP_DIR: join(root, "mcp-relay"), SCP_IDLE: "30s", SCP_NATIVE: "mcp", SCP_SWARM_BIN: bin }
    try {
      const human = await swarm(["whoami", "--human"], env)
      expect([human.code, human.stderr]).toEqual([0, ""])
      const status = JSON.parse((await swarm(["status", "--json"], env)).stdout) as { broker: { engine: string }; mcp: { mode: string } }
      expect([status.broker.engine, status.mcp.mode]).toEqual(["ts", "mcp"])
      const text = (await swarm(["status"], env)).stdout
      expect(text).toContain(`(pid ${lockPid(env.SCP_DIR)}, engine ts)`)
      expect(text).not.toContain("mcp:")
      expect(existsSync(calls)).toBe(false)
    } finally {
      expect((await swarm(["daemon", "stop"], env)).code).toBe(0)
    }
  })

  test("without it the on-demand broker is the TypeScript one, whatever SCP_SWARM_BIN names", async () => {
    const { bin, calls } = fakeSwarm("unused", pkg.version)
    const env = { SCP_DIR: join(root, "off-relay"), SCP_IDLE: "30s", SCP_SWARM_BIN: bin }
    try {
      const human = await swarm(["whoami", "--human"], env)
      expect([human.code, human.stderr]).toEqual([0, ""])
      const status = JSON.parse((await swarm(["status", "--json"], env)).stdout) as { broker: { pid: number; engine: string } }
      expect(status.broker.engine).toBe("ts")
      expect(existsSync(calls)).toBe(false)
    } finally {
      expect((await swarm(["daemon", "stop"], env)).code).toBe(0)
    }
  })

  test("with no native binary it says so once and the TypeScript broker starts and serves", async () => {
    const env = { SCP_DIR: join(root, "fallback-relay"), SCP_IDLE: "30s", SCP_NATIVE: "1", SCP_SWARM_BIN: join(root, "nowhere", "swarm") }
    try {
      const human = await swarm(["whoami", "--human"], env)
      expect(human.code).toBe(0)
      expect(human.stdout.split("\n")[0]).toBe("me/ (human, human)")
      expect(human.stderr.match(new RegExp(FALLBACK.source, "gm"))).toHaveLength(1)
      const status = await swarm(["status"], env)
      expect(status.stdout).toContain(`(pid ${lockPid(env.SCP_DIR)}, engine ts)`)
    } finally {
      expect((await swarm(["daemon", "stop"], env)).code).toBe(0)
    }
  })

  test("the foreground daemon falls back the same way", async () => {
    const dir = join(root, "fallback-fg")
    const child = Bun.spawn([process.execPath, "--no-env-file", entry, "daemon", "--idle", "30s"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, SCP_DIR: dir, SCP_NATIVE: "1", SCP_SWARM_BIN: join(root, "nowhere", "swarm") },
    })
    try {
      await waitFor(() => existsSync(join(dir, "broker.lock")) && lockPid(dir) === child.pid, 15_000, "the TypeScript broker")
    } finally {
      child.kill("SIGTERM")
    }
    await child.exited
    expect(await new Response(child.stderr).text()).toMatch(FALLBACK)
  })
})

describe("MCP mounts", () => {
  const launch = ["/opt/node", "/opt/swarm/cli.js"]
  const words = ["--harness", "claude", "--channels"]

  test("without SCP_NATIVE=1 a mount runs swarm mcp through the launch and checks no binary", () => {
    const { bin, calls } = fakeSwarm("mount-off", pkg.version)
    for (const value of [undefined, "", "0", "true"])
      expect(mcpMount(launch, words, { SCP_NATIVE: value, SCP_SWARM_BIN: bin })).toEqual({ argv: [...launch, "mcp", ...words], env: {}, native: false })
    expect(existsSync(calls)).toBe(false)
  })

  test("with SCP_NATIVE=1 and a matching native swarm the mount runs it directly, told the launch", () => {
    const { bin } = fakeSwarm("mount-on", pkg.version)
    expect(mcpMount(launch, words, { SCP_NATIVE: "1", SCP_SWARM_BIN: bin })).toEqual({
      argv: [bin, "mcp", ...words],
      env: { SCP_NATIVE: "1", SCP_SWARM_BIN: bin, SCP_CLI_ARGV: JSON.stringify(launch) },
      native: true,
    })
    expect(mountWith("/pkg/bin/swarm", launch, words, {}).env).toEqual({ SCP_NATIVE: "1", SCP_CLI_ARGV: JSON.stringify(launch) })
  })

  test("with SCP_NATIVE=mcp the mount runs the native swarm too, and carries mcp so the broker it starts stays TypeScript", () => {
    const { bin } = fakeSwarm("mount-mcp", pkg.version)
    expect(mcpMount(launch, words, { SCP_NATIVE: "mcp", SCP_SWARM_BIN: bin })).toEqual({
      argv: [bin, "mcp", ...words],
      env: { SCP_NATIVE: "mcp", SCP_SWARM_BIN: bin, SCP_CLI_ARGV: JSON.stringify(launch) },
      native: true,
    })
    expect(mountWith("/pkg/bin/swarm", launch, words, { SCP_NATIVE: "mcp" }).env).toEqual({ SCP_NATIVE: "mcp", SCP_CLI_ARGV: JSON.stringify(launch) })
    expect(mountVars({ A: "1", SCP_NATIVE: "1", SCP_CLI_ARGV: "[]" }, mcpMount(launch, [], { SCP_NATIVE: "mcp", SCP_SWARM_BIN: bin }))).toEqual({
      A: "1",
      SCP_NATIVE: "mcp",
      SCP_SWARM_BIN: bin,
      SCP_CLI_ARGV: JSON.stringify(launch),
    })
  })

  test("the status line names each mount's engine", () => {
    expect(mcpLine([])).toBeUndefined()
    expect(
      mcpLine([
        { harness: "claude", engine: "native", mode: "mcp" },
        { harness: "codex", engine: "native", mode: "all" },
        { harness: "opencode", engine: "node", mode: "off" },
      ]),
    ).toBe("mcp: claude native (SCP_NATIVE=mcp), codex native (SCP_NATIVE=1), opencode node")
  })

  test("a missing or mismatched native swarm falls back to the node mount, noted once", () => {
    const { bin } = fakeSwarm("mount-old", "0.0.1")
    resetMountNote()
    const notes: string[] = []
    const write = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      notes.push(String(chunk))
      return true
    })
    try {
      for (const env of [
        { SCP_NATIVE: "1", SCP_SWARM_BIN: bin },
        { SCP_NATIVE: "1", SCP_SWARM_BIN: join(root, "nowhere", "swarm") },
      ])
        expect(mcpMount(launch, words, env)).toEqual({ argv: [...launch, "mcp", ...words], env: {}, native: false })
    } finally {
      write.mockRestore()
    }
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/^swarm: SCP_NATIVE=1 but no native swarm \S+ binary for \S+ \(.*\); MCP mounts run swarm mcp through Node\n$/)
  })

  test("a mount's words, its variables and a gone command", () => {
    expect(mcpWords(["/n", "/c.js", "mcp", "--harness", "codex", "--as", "w"], ["x"])).toEqual(["--harness", "codex", "--as", "w"])
    expect(mcpWords(["/wrapper.sh"], ["--harness", "codex"])).toEqual(["--harness", "codex"])
    const native = mountWith("/b/swarm", launch, [], {})
    expect(mountVars({ A: "1", SCP_NATIVE: "1", SCP_CLI_ARGV: "[]", SCP_SWARM_BIN: "/x" }, mcpMount(launch, [], {}))).toEqual({ A: "1" })
    expect(mountVars({ A: "1", SCP_CLI_ARGV: "[]" }, native)).toEqual({ A: "1", ...native.env })
    const { bin } = fakeSwarm("gone", pkg.version)
    expect(goneCommand(bin)).toBe(false)
    expect(goneCommand("swarm")).toBe(false)
    expect(goneCommand(undefined)).toBe(false)
    expect(goneCommand(join(root, "nowhere", "swarm"))).toBe(true)
    expect(goneCommand(root)).toBe(true)
  })
})

test("brokerEngine names a swarm or scp-broker executable native and anything else ts", async () => {
  expect(brokerEngine(process.pid)).toBe("ts")
  for (const name of ["swarm", "scp-broker"]) {
    const dir = mkdtempSync(join(root, "engine-"))
    symlinkSync("/bin/sleep", join(dir, name))
    const child = Bun.spawn([join(dir, name), "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    try {
      await waitFor(() => brokerEngine(child.pid) === "native", 5000, `${name} to run`)
    } finally {
      child.kill()
    }
  }
})

describe.skipIf(!swarmBinary)("SCP_NATIVE=1 with the native swarm in SCP_SWARM_BIN", () => {
  test("a command starts the native broker on demand, status names it, and daemon stop stops it", async () => {
    const env = { SCP_DIR: join(root, "native-relay"), SCP_IDLE: "30s", SCP_NATIVE: "1", SCP_SWARM_BIN: swarmBinary! }
    let pid: number | undefined
    try {
      const human = await swarm(["whoami", "--human"], env)
      expect([human.code, human.stderr]).toEqual([0, ""])
      expect(human.stdout.split("\n")[0]).toBe("me/ (human, human)")
      pid = lockPid(env.SCP_DIR)
      const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="])
        .stdout.toString()
        .trim()
      expect(command).toBe(`${resolve(swarmBinary!)} daemon`)
      expect((await swarm(["set-status", "blocked", "native", "--as", "lane"], env)).code).toBe(0)
      const status = JSON.parse((await swarm(["status", "--json"], env)).stdout) as {
        broker: { pid: number; engine: string }
        endpoints: { address: string; status: { state: string; note: string } | null }[]
      }
      expect(status.broker).toMatchObject({ pid, engine: "native" })
      expect(status.endpoints.find((e) => e.address === "me/lane")!.status).toEqual({ state: "blocked", note: "native" })
      expect((await swarm(["status"], env)).stdout).toContain(`(pid ${pid}, engine native)`)
      expect((await swarm(["daemon", "stop"], env)).stdout).toContain(`stopped the relay broker (pid ${pid})`)
      expect(alive(pid)).toBe(false)
    } finally {
      if (pid !== undefined) stopStarted(pid)
    }
  })

  test("daemon restart starts the native broker again", async () => {
    const env = { SCP_DIR: join(root, "native-restart"), SCP_IDLE: "30s", SCP_NATIVE: "1", SCP_SWARM_BIN: swarmBinary! }
    let pid: number | undefined
    try {
      const restarted = await swarm(["daemon", "restart"], env)
      expect([restarted.code, restarted.stderr]).toEqual([0, ""])
      pid = lockPid(env.SCP_DIR)
      expect(restarted.stdout).toBe(`started a fresh one (pid ${pid})\n`)
      expect(brokerEngine(pid)).toBe("native")
      expect((await swarm(["daemon", "stop"], env)).code).toBe(0)
      expect(alive(pid)).toBe(false)
    } finally {
      if (pid !== undefined) stopStarted(pid)
    }
  })

  test("the foreground daemon runs the native broker until SIGTERM reaches it", async () => {
    const dir = join(root, "native-fg")
    const policy = join(root, "native-fg-policy.json")
    const child = Bun.spawn([process.execPath, "--no-env-file", entry, "daemon", "--idle", "10m", "--policy", policy], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, SCP_DIR: dir, SCP_NATIVE: "1", SCP_SWARM_BIN: swarmBinary! },
    })
    let pid: number | undefined
    try {
      pid = await waitFor(() => (existsSync(join(dir, "broker.lock")) && lockPid(dir)) || undefined, 15_000, "the native broker")
      expect(pid).not.toBe(child.pid)
      expect(brokerEngine(pid)).toBe("native")
      const status = JSON.parse((await swarm(["status", "--json"], { SCP_DIR: dir })).stdout) as { broker: { policy: { file: string } } }
      expect(status.broker.policy.file).toBe(policy)
    } finally {
      child.kill("SIGTERM")
    }
    expect(await child.exited).toBe(0)
    if (pid !== undefined) {
      await waitFor(() => !alive(pid!), 5000, "the native broker to stop")
      stopStarted(pid)
    }
  })
})
