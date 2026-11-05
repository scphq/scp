import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { VERBS } from "./main"
import { swarmBinary } from "./test-setup"

setDefaultTimeout(240_000)

const entry = join(import.meta.dir, "cli.ts")
const root = mkdtempSync(join(process.env.HOME!, "help-native-"))
const log = join(root, "route.log")
afterAll(() => rmSync(root, { recursive: true, force: true }))

const LAUNCHERS = ["claude", "codex", "muse", "pi", "t3code", "opencode", "agy", "grok"]
const BROKER_VERBS = ["spawn-wake", "codex-wake", "claude-wake", "claude-bg-task"]
const verbs = [...Object.keys(VERBS), ...LAUNCHERS, "setup", "hook"]

const CASES: string[][] = [
  [],
  [""],
  ["help"],
  ["--help"],
  ["-h"],
  ["help", "--all"],
  ["--help", "--all"],
  ["-h", "--all"],
  ["help", "--", "send"],
  ["help", "send", "extra"],
  ["help", "--json", "send"],
  ["help", "nope"],
  ["help", "--as", "x", "send"],
  ["--help", "send"],
  ["-h", "nope"],
  ["--as", "x", "help"],
  ["--as", "x", "--help"],
  ["--as=x", "--human", "-h", "--all"],
  ["version"],
  ["--version"],
  ["version", "extra", "--bogus"],
  ["--version", "x"],
  ["--as", "x", "version"],
  ["-V"],
  ["-v"],
  ["nope"],
  ["nope", "--help"],
  ["--bogus"],
  ["--as"],
  ["--as", "x"],
  ["--human"],
  ["--json", "whoami"],
  ["Help"],
  ...verbs.flatMap((verb) => [
    ["help", verb],
    ["help", verb, "--all"],
    [verb, "--help"],
    [verb, "-h"],
    [verb, "--help", "--all"],
    [verb, "-h", "--all"],
    ["--as", "x", verb, "--help"],
  ]),
  ["whoami", "-hh"],
  ["whoami", "--help", "--bogus"],
  ["whoami", "--bogus", "--help"],
  ["whoami", "--help=1"],
  ["whoami", "--", "--help", "--bogus"],
  ["send", "x", "--wait", "-h"],
  ["send", "--all", "--help"],
  ["daemon", "stop", "--help"],
  ["hooks", "install", "--help"],
  ["mcp", "install", "--help"],
  ["mcp", "--help", "install"],
  ["mcp", "--nope"],
  ["mcp", "extra"],
  ["mcp", "--human"],
  ["mcp", "--json"],
  ["mcp", "--human", "--help"],
  ["mcp", "install", "extra"],
  ["mcp", "install", "--human"],
  ["mcp", "install", "--harness", "claude", "--as", "x"],
  ["spawn", "--help", "--bogus"],
  ["spawn", "--bogus", "--help"],
  ["spawn", "--name", "-h"],
  ["spawn", "--name=-h", "--", "--help"],
  ["spawn", "--", "--help"],
  ["spawn", "--all", "-h"],
  ["spawn", "--help=1"],
  ["spawn", "-hh"],
  ["spawn", "-hh", "--all"],
  ["setup", "--help", "--write"],
  ["setup", "--bogus", "--help"],
  ["setup", "extra", "--help"],
  ["setup", "claude-desktop", "--help"],
  ["setup", "claude-desktop", "-h"],
  ["setup", "claude-desktop", "--bogus", "-h"],
  ["setup", "claude-desktop", "extra", "--help"],
  ["claude", "--name", "x", "--help", "--bogus"],
  ["opencode", "--name", "x", "--help"],
  ["opencode", "-x", "-h"],
  ["opencode", "--", "--help"],
  ["pi", "--name", "x", "--help"],
]

async function swarm(engine: "ts" | "native", args: string[], dir: string) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("SCP_")) env[key] = value
  Object.assign(env, {
    SCP_DIR: dir,
    SCP_HARNESS_DETECT: "0",
    PATH: "/usr/bin:/bin",
    ...(engine === "native" ? { SCP_NATIVE: "1", SCP_SWARM_BIN: swarmBinary!, SCP_ROUTE_LOG: log } : {}),
  })
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], { env, cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, stdout, stderr: stderr.replace(/Executable not found in \$PATH: "(\S+)"/, "spawn $1 ENOENT") }
}

const dirOf = (engine: string) => join(root, `relay-${engine}`)

describe.skipIf(!swarmBinary)("help and version on both engines", () => {
  afterAll(async () => {
    await Promise.all([swarm("ts", ["daemon", "stop"], dirOf("ts")), swarm("native", ["daemon", "stop"], dirOf("native"))])
    if (process.env.SCP_ROUTE_LOG) appendFileSync(process.env.SCP_ROUTE_LOG, readFileSync(log, "utf8"))
  })

  test("every help, version and unknown word prints the same bytes and exits the same", async () => {
    mkdirSync(dirOf("ts"), { recursive: true })
    mkdirSync(dirOf("native"), { recursive: true })
    const failures: unknown[] = []
    let next = 0
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < CASES.length) {
          const args = CASES[next++]!
          const [ts, native] = await Promise.all([swarm("ts", args, dirOf("ts")), swarm("native", args, dirOf("native"))])
          if (JSON.stringify(ts) !== JSON.stringify(native)) failures.push({ args, ts, native })
        }
      }),
    )
    expect(failures).toEqual([])
    const lines = readFileSync(log, "utf8").trim().split("\n")
    expect(lines.filter((line) => line.split(" ")[1] === "ts")).toEqual([])
  })

  test("a word is a verb on both engines or on neither", () => {
    const registry = JSON.parse(Bun.spawnSync([swarmBinary!, "__verbs", "--json"]).stdout.toString()) as { verbs: string[]; ts_verbs: string[] }
    const known = [...verbs, ...BROKER_VERBS, "spawn", "help", "--help", "-h", "version", "--version"]
    expect([...new Set(known)].sort()).toEqual([...registry.verbs].sort())
    expect(registry.ts_verbs).toEqual(["mesh"])
  })
})
