import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { decide, declined, gives, type Registry, verbOf } from "./route"
import { swarmBinary } from "./test-setup"

setDefaultTimeout(60_000)

const CLI = join(import.meta.dir, "cli.ts")
const root = mkdtempSync(join(process.env.HOME!, "route-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const registry = (verbs: string[], version = pkg.version): Registry => ({
  version,
  verbs,
  declines: ["--help", "-h", "--cloud"],
  decline_env: ["SCP_TRANSPORT=cloud"],
})
const native = (env: Record<string, string>, argv: string[], reg = registry(["whoami", "daemon"])) =>
  decide(
    argv,
    { SCP_NATIVE: "1", ...env },
    pkg.version,
    () => "/bin/swarm",
    () => reg,
  )

describe("the routing decision", () => {
  test("the verb is past the identity flags the CLI hoists", () => {
    expect(verbOf(["--as", "x", "--human", "whoami", "-h"])).toBe("whoami")
    expect(verbOf(["--as=x", "set-now", "a"])).toBe("set-now")
    expect(verbOf(["--as", "x"])).toBe("--as")
    expect(verbOf([])).toBeUndefined()
  })

  test("a registered verb goes native, every skip rule keeps it here", () => {
    expect(native({}, ["whoami"]).engine).toBe("native")
    expect(native({}, ["--as", "x", "whoami"]).engine).toBe("native")
    const reason = (env: Record<string, string>, argv: string[], reg?: Registry) => {
      const decision = native(env, argv, reg)
      return decision.engine === "ts" ? decision.reason : "native"
    }
    expect(reason({ SCP_ROUTED: "ts" }, ["whoami"])).toBe("routed")
    expect(
      decide(
        ["whoami"],
        {},
        pkg.version,
        () => "/bin/swarm",
        () => registry(["whoami"]),
      ),
    ).toEqual({ engine: "ts", reason: "off" })
    expect(
      decide(
        ["whoami"],
        { SCP_NATIVE: "mcp" },
        pkg.version,
        () => "/bin/swarm",
        () => registry(["whoami"]),
      ),
    ).toEqual({ engine: "ts", reason: "off" })
    expect(reason({}, ["hook", "claude"], registry(["hook", "whoami"]))).toBe("hook")
    expect(reason({}, ["mcp"], registry(["mcp"]))).toBe("mcp")
    const install = { ...registry(["mcp"]), subverbs: { mcp: ["install"] } }
    expect(reason({}, ["mcp", "install", "--harness", "claude"], install)).toBe("native")
    expect(reason({}, ["mcp", "--harness", "claude", "install"], install)).toBe("mcp")
    expect(reason({}, ["mcp", "install"], registry(["whoami"]))).toBe("unported")
    expect(reason({ SCP_NATIVE_TS: "set-now, whoami" }, ["whoami"])).toBe("forced")
    expect(reason({ SCP_NATIVE_TS: "*" }, ["daemon"])).toBe("forced")
    expect(reason({ SCP_NATIVE_TS: "set-now" }, ["whoami"])).toBe("native")
    expect(reason({}, ["whoami"], registry(["whoami"], "0.0.1"))).toBe("version")
    expect(reason({}, ["list"])).toBe("unported")
    expect(reason({}, ["whoami", "--help"])).toBe("decline")
    expect(reason({ SCP_TRANSPORT: "cloud" }, ["whoami"])).toBe("decline")
    expect(reason({}, ["whoami", "--", "--help"])).toBe("native")
    expect(decide(["whoami"], { SCP_NATIVE: "1" }, pkg.version, () => undefined)).toEqual({ engine: "ts", reason: "missing" })
    expect(
      decide(
        ["whoami"],
        { SCP_NATIVE: "1" },
        pkg.version,
        () => "/bin/swarm",
        () => undefined,
      ),
    ).toEqual({ engine: "ts", reason: "missing" })
  })

  test("declined flags: long ones alone or with a value, short ones anywhere in a group", () => {
    expect(gives("--cloud=1", "--cloud")).toBe(true)
    expect(gives("--cloudy", "--cloud")).toBe(false)
    expect(gives("-xh", "-h")).toBe(true)
    expect(gives("--help", "-h")).toBe(false)
    expect(declined(["-h"], {}, registry([]))).toBe(true)
    expect(declined(["x"], { SCP_TRANSPORT: "cloud" }, registry([]))).toBe(true)
  })
})

/** a stand-in native swarm: it registers whoami for $FAKE_VERSION, prints what it was started with and exits 7, or sleeps */
const FAKE = join(root, "fake-swarm")
writeFileSync(
  FAKE,
  `#!/bin/sh
if [ "$1" = "__verbs" ]; then printf '{"version":"%s","verbs":["whoami"],"declines":["--help"],"decline_env":[]}' "$FAKE_VERSION"; exit 0; fi
if [ -n "$FAKE_SLEEP" ]; then exec sleep 30; fi
printf 'args=%s ppid=%s parent=%s routed=%s given=%s argv=%s\\n' "$*" "$PPID" "$SCP_CLI_PARENT" "$SCP_ROUTED" "$SCP_CLI_ARGV_GIVEN" "$SCP_CLI_ARGV"
exit 7
`,
)
chmodSync(FAKE, 0o755)

function baseEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("SCP_")) env[key] = value
  return { ...env, SCP_DIR: join(root, "relay"), SCP_HARNESS_DETECT: "0", SCP_NATIVE: "1", ...extra }
}

async function cli(argv: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, CLI, ...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { out, err, code, pid: child.pid, signal: child.signalCode }
}

const logLines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [])

describe("the hand-off", () => {
  const log = join(root, "fake.log")
  const fake = (extra: Record<string, string> = {}) => baseEnv({ SCP_SWARM_BIN: FAKE, FAKE_VERSION: pkg.version, SCP_ROUTE_LOG: log, ...extra })

  test("execve replaces the CLI: same pid, its parent, the launch words, no parent pair", async () => {
    rmSync(log, { force: true })
    const run = await cli(["--as", "x", "whoami", "--json"], fake())
    expect(run.code).toBe(7)
    expect(run.out).toContain(`args=--as x whoami --json ppid=${process.pid} parent= routed=native`)
    expect(JSON.parse(run.out.split("argv=")[1]!)).toEqual([process.execPath, "--no-env-file", "--config=/dev/null", CLI])
    expect(logLines(log)).toEqual(["whoami native execve"])
  })

  test("a caller's own SCP_CLI_ARGV travels beside the launch words that replace it", async () => {
    const plain = await cli(["whoami"], fake())
    expect(plain.out).toContain("routed=native given= argv=")
    const own = JSON.stringify(["/opt/node", "/old/cli.js"])
    const run = await cli(["whoami"], fake({ SCP_CLI_ARGV: own }))
    expect(run.out).toContain(`routed=native given=${own} argv=`)
    expect(JSON.parse(run.out.split("argv=")[1]!)).toEqual([process.execPath, "--no-env-file", "--config=/dev/null", CLI])
    const stale = await cli(["whoami"], fake({ SCP_CLI_ARGV_GIVEN: own }))
    expect(stale.out).toContain("routed=native given= argv=")
  })

  test("the spawn path names the router and the shell, and mirrors the exit code", async () => {
    rmSync(log, { force: true })
    const run = await cli(["whoami"], fake({ SCP_ROUTE_EXEC: "spawn" }))
    expect(run.code).toBe(7)
    const ppid = Number(/ppid=(\d+)/.exec(run.out)![1])
    expect(ppid).toBe(run.pid)
    expect(run.out).toContain(`parent=${run.pid}:${process.pid} routed=native`)
    expect(logLines(log)).toEqual(["whoami native spawn"])
  })

  test("the spawn path forwards a signal and dies of the one that ended the native swarm", async () => {
    const child = Bun.spawn([process.execPath, CLI, "whoami"], { env: fake({ SCP_ROUTE_EXEC: "spawn", FAKE_SLEEP: "1" }), stdout: "ignore", stderr: "ignore" })
    await Bun.sleep(700)
    child.kill("SIGTERM")
    await child.exited
    expect(child.signalCode).toBe("SIGTERM")
  })

  test("a version mismatch, SCP_NATIVE_TS and SCP_ROUTED=ts keep the command here", async () => {
    rmSync(log, { force: true })
    for (const extra of [{ FAKE_VERSION: "0.0.0" }, { SCP_NATIVE_TS: "*" }, { SCP_ROUTED: "ts" }]) {
      const run = await cli(["whoami", "--bogus"], fake(extra))
      expect(run.code).toBe(125)
      expect(run.err).toContain("Unknown option '--bogus'")
    }
    expect(logLines(log)).toEqual(["whoami ts version", "whoami ts forced", "whoami ts routed"])
  })

  test("a declined flag and an unregistered verb stay here", async () => {
    rmSync(log, { force: true })
    expect((await cli(["whoami", "--help"], fake())).out).toContain("whoami")
    expect((await cli(["policy", "--bogus"], fake())).code).toBe(125)
    expect(logLines(log)).toEqual(["whoami ts decline", "policy ts unported"])
  })
})

describe.skipIf(!swarmBinary)("the native swarm", () => {
  const log = join(root, "native.log")
  const env = () => baseEnv({ SCP_SWARM_BIN: swarmBinary!, SCP_ROUTE_LOG: log, SCP_DIR: join(root, "native-relay") })
  afterAll(async () => void (await cli(["daemon", "stop"], env())))

  test("the parent pair counts only when its router is the parent", async () => {
    const probe = async (parent: string) => {
      const child = Bun.spawn([swarmBinary!, "__probe", "identity", "whoami", "--as", "x"], { env: { ...env(), SCP_CLI_PARENT: parent }, stdout: "pipe" })
      return JSON.parse(await new Response(child.stdout).text()).shell as number
    }
    expect(await probe(`${process.pid}:4242`)).toBe(4242)
    expect(await probe(`${process.pid + 100000}:4242`)).toBe(process.pid)
    expect(await probe("junk")).toBe(process.pid)
  })

  test("both hand-offs run the verb natively with the same output", async () => {
    rmSync(log, { force: true })
    const execve = await cli(["--as", "lane", "set-title", "routed"], env())
    const spawned = await cli(["--as", "lane", "set-title", "routed"], { ...env(), SCP_ROUTE_EXEC: "spawn" })
    const ts = await cli(["--as", "lane", "set-title", "routed"], { ...env(), SCP_NATIVE_TS: "*" })
    for (const run of [execve, spawned]) expect(run).toMatchObject({ out: ts.out, err: ts.err, code: 0 })
    expect(ts.out).toBe("me/lane: title routed\n")
    expect(logLines(log)).toEqual(["set-title native execve", "set-title native run", "set-title native spawn", "set-title native run", "set-title ts forced"])
  })

  test("a hangup stops a routed foreground broker cleanly, on both hand-offs", async () => {
    for (const exec of ["execve", "spawn"]) {
      const dir = mkdtempSync("/tmp/scp-hup-")
      const child = Bun.spawn([process.execPath, CLI, "daemon", "--idle", "60"], { env: { ...env(), SCP_DIR: dir, SCP_ROUTE_EXEC: exec }, stderr: "ignore" })
      for (let i = 0; i < 100 && !existsSync(join(dir, "relay.sock")); i++) await Bun.sleep(100)
      child.kill("SIGHUP")
      expect(await child.exited).toBe(0)
      expect(existsSync(join(dir, "relay.sock"))).toBe(false)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a declined verb reaches the TypeScript CLI with the caller's SCP_CLI_ARGV, or none, not the router's", async () => {
    const ts = join(root, "fake-ts-cli")
    writeFileSync(ts, `#!/bin/sh\nprintf 'routed=%s argv=%s given=%s\\n' "$SCP_ROUTED" "\${SCP_CLI_ARGV-unset}" "\${SCP_CLI_ARGV_GIVEN-unset}"\n`)
    chmodSync(ts, 0o755)
    const declined = async (extra: Record<string, string>) => {
      const child = Bun.spawn([swarmBinary!, "whoami", "--help"], {
        env: { ...env(), SCP_ROUTED: "native", SCP_CLI_ARGV: JSON.stringify([ts]), ...extra },
        stdout: "pipe",
      })
      return (await new Response(child.stdout).text()).trim()
    }
    expect(await declined({})).toBe("routed=ts argv=unset given=unset")
    expect(await declined({ SCP_CLI_ARGV_GIVEN: '["/opt/node","/old/cli.js"]' })).toBe('routed=ts argv=["/opt/node","/old/cli.js"] given=unset')
  })

  test("a broker that cannot start says why at once", async () => {
    const run = await cli(["--as", "lane", "whoami"], { ...env(), SCP_DIR: "/dev/null/x" })
    expect(run).toMatchObject({ code: 125, err: "swarm: ENOTDIR: not a directory, mkdir '/dev/null/x'\n" })
  })

  test("a reader that went away ends the command quietly", async () => {
    const codes = join(root, "codes")
    const script = `( sleep 0.5; "$@" 2>"${codes}.err"; echo $? >"${codes}" ) | true`
    for (const exec of ["execve", "spawn"]) {
      rmSync(codes, { force: true })
      const child = Bun.spawn(["sh", "-c", script, "sh", process.execPath, CLI, "--as", "lane", "whoami"], { env: { ...env(), SCP_ROUTE_EXEC: exec } })
      await child.exited
      expect(readFileSync(codes, "utf8").trim()).toBe("0")
      expect(readFileSync(`${codes}.err`, "utf8")).toBe("")
    }
  })
})
