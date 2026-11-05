import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"
import { processKey } from "./identity"
import { swarmBinary } from "./test-setup"

setDefaultTimeout(60_000)

const entry = join(import.meta.dir, "cli.ts")
/** the CLI as `SELF` names it when it runs as `bun --no-env-file cli.ts`, which the native swarm is told as SCP_CLI_ARGV */
const SELF = [process.execPath, "--no-env-file", "--config=/dev/null", entry]
const top = realpathSync(mkdtempSync(join(process.env.HOME!, "claude-native-")))
const brokers: Broker[] = []
afterAll(async () => {
  for (const broker of brokers) await broker.stop()
  rmSync(top, { recursive: true, force: true })
})

type Engine = "ts" | "native" | "routed"

/** a scratch machine: HOME with a fake claude on PATH that records its arguments and environment, and answers `agents` from agents.json */
function machine(engine: Engine, mount?: string[]) {
  const root = mkdtempSync(join(top, `${engine}-`))
  const bin = join(root, "bin")
  const work = join(root, "Work Dir")
  mkdirSync(bin)
  mkdirSync(join(work, ".git"), { recursive: true })
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `if [ "$1" = agents ]; then cat "${root}/agents.json" 2>/dev/null || echo '[]'; exit 0; fi`,
      `printf '%s\\n' "$@" > "${root}/claude.args"`,
      `env | grep -E '^(SCP_|CLAUDE)' | LC_ALL=C sort > "${root}/claude.env"`,
      `for a in "$@"; do [ "$a" = --bg ] && { echo 'backgrounded · 1a2b3c4d (idle)'; exit 0; }; done`,
      "exit 7",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  if (mount) writeFileSync(join(root, ".claude.json"), JSON.stringify({ mcpServers: { scp: { type: "stdio", command: "swarm", args: mount } } }))
  const env: Record<string, string> = {
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_STATE_HOME: join(root, ".state"),
    SCP_DIR: join(root, "relay"),
    SCP_HARNESS_DETECT: "0",
    SCP_CLI_ARGV: JSON.stringify(SELF),
    ...(process.env.SCP_ROUTE_LOG ? { SCP_ROUTE_LOG: process.env.SCP_ROUTE_LOG } : {}),
  }
  return { engine, root, work, env }
}

type Machine = ReturnType<typeof machine>

/** `swarm claude <args>` from a shell, on one engine; `agent` names the endpoint the broker binds to that shell's process */
async function run(m: Machine, args: string[], extra: Record<string, string> = {}, cwd = m.work, broker?: Broker, agent?: string) {
  for (const file of ["claude.args", "claude.env"]) rmSync(join(m.root, file), { force: true })
  const program = m.engine === "native" ? [resolve(swarmBinary!), "claude", ...args] : [process.execPath, "--no-env-file", entry, "claude", ...args]
  const env = { ...m.env, ...extra }
  if (m.engine === "routed") Object.assign(env, { SCP_NATIVE: "1", SCP_SWARM_BIN: resolve(swarmBinary!) })
  if (m.engine === "ts" && env.SCP_NATIVE) env.SCP_NATIVE_TS = "claude"
  const shell = Bun.spawn(["sh", "-c", 'read go; "$0" "$@"; exit $?', ...program], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env })
  const held = agent && broker ? await RelayClient.connect(broker.socket) : undefined
  const key = processKey(shell.pid)
  await held?.hello({ claim: { handle: agent!, harness: "claude-code", process: key, lineage: [key] } })
  shell.stdin.write("go\n")
  shell.stdin.end()
  const [stdout, stderr, code] = await Promise.all([new Response(shell.stdout).text(), new Response(shell.stderr).text(), shell.exited])
  held?.close()
  const read = (file: string) => (existsSync(join(m.root, file)) ? readFileSync(join(m.root, file), "utf8") : null)
  const dir = join(m.env.SCP_DIR!, "claude-bg")
  const records = existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .map((name) => {
          const path = join(dir, name)
          if (lstatSync(path).isSymbolicLink()) return `${name} -> ${readlinkSync(path)}`
          return `${name} ${(statSync(path).mode & 0o777).toString(8)}\n${readFileSync(path, "utf8")}`
        })
    : []
  const normal = (text: string) =>
    text
      .replaceAll(m.root, "<root>")
      .replace(/[0-9a-f]{16}\.json/g, "<record>.json")
      .replace(/krt_[0-9a-f]{64}/g, "<grant>")
      .replace(/SCP_CHANNELS=\d+/g, "SCP_CHANNELS=<pid>")
      .replace(/SCP_NATIVE_TS=claude\\n/g, "")
  const shown = { code, stdout, stderr, args: read("claude.args"), env: read("claude.env") }
  return { ...JSON.parse(normal(JSON.stringify(shown))), records: records.map(normal).sort() }
}

/** runs `steps` on a TypeScript machine and a native one, each set up by `prepare`, and expects every step to come out the same */
async function same(
  steps: (m: Machine) => Promise<unknown>[] | Promise<unknown[]>,
  prepare: (m: Machine) => void | Promise<void> = () => {},
  mount?: string[],
  engines: Engine[] = ["ts", "native"],
) {
  const results: unknown[][] = []
  for (const engine of engines) {
    const m = machine(engine, mount)
    await prepare(m)
    const outcomes: unknown[] = []
    for (const step of await steps(m)) outcomes.push(await step)
    results.push(outcomes)
  }
  expect(results[1]).toEqual(results[0]!)
  return results[0]!
}

const CHANNELS = ["mcp", "--harness", "claude", "--channels"]
const CHANNELS_FLAG = "--dangerously-load-development-channels"

/** runs each argument list in turn on one machine */
const each =
  (lists: [string[], Record<string, string>?, string?][]) =>
  async (m: Machine): Promise<unknown[]> => {
    const out: unknown[] = []
    for (const [args, extra, cwd] of lists) out.push(await run(m, args, extra, cwd ? join(m.root, cwd) : m.work))
    return out
  }

describe.skipIf(!swarmBinary)("swarm claude: the native swarm runs it as the TypeScript CLI does", () => {
  test("foreground launches: channel, name, name prompt, passthrough, exit code", async () => {
    const out = await same(
      each([
        [["--name", "lead", "-c"]],
        [["-c"]],
        [["--append-system-prompt", "mine"]],
        [["--name", "lead", "--", "--continue", "--model", "opus", "hello there"]],
        [["--as=me/lead", "--root", "--", "-p", "--", "--bg"]],
        [[CHANNELS_FLAG, "server:mine", "server:scp"]],
      ]),
      undefined,
      CHANNELS,
    )
    expect((out[0] as { code: number }).code).toBe(7)
  })

  test("manual join mode skips the name prompt", async () => {
    await same(
      each([[[]]]),
      (m) => {
        mkdirSync(join(m.env.XDG_CONFIG_HOME!, "scp"), { recursive: true })
        writeFileSync(join(m.env.XDG_CONFIG_HOME!, "scp", "config.json"), JSON.stringify({ join: "manual" }))
      },
      CHANNELS,
    )
  })

  test("usage errors and mount hints", async () => {
    await same(
      each([
        [[]],
        [["--name"]],
        [["--name", "me"]],
        [["--under"]],
        [["--root", "--under=lead"]],
        [["--under=me/vm/Bad"]],
        [["--mcp-config", "mine.json"]],
        [["--strict-mcp-config"]],
        [["attach"]],
        [["attach", "a", "b"]],
        [["attach", "a", "--name"]],
        [["attach", "a", "--name", "Bad"]],
      ]),
    )
    await same(each([[[]]]), undefined, ["mcp", "--harness", "claude"])
    await same(each([[[]]]), (m) => writeFileSync(join(m.root, ".claude.json"), "  "))
    await same(each([[[]]]), (m) => writeFileSync(join(m.root, ".claude.json"), "[1]"))
    await same(each([[[]]]), (m) =>
      writeFileSync(join(m.root, ".claude.json"), JSON.stringify({ mcpServers: { scp: { command: join(m.root, "gone", "swarm"), args: CHANNELS } } })),
    )
    await same(each([[[]]]), (m) =>
      writeFileSync(join(m.root, ".claude.json"), JSON.stringify({ projects: { [m.work]: { mcpServers: { scp: { command: "swarm", args: CHANNELS } } } } })),
    )
    await same(each([[[]]]), (m) => writeFileSync(join(m.work, ".mcp.json"), JSON.stringify({ mcpServers: { scp: { command: "swarm", args: CHANNELS } } })))
    await same(each([[["--strict-mcp-config"]]]), (m) =>
      writeFileSync(join(m.work, ".mcp.json"), JSON.stringify({ mcpServers: { scp: { command: "swarm", args: CHANNELS } } })),
    )
    await same(each([[[]]]), (m) => rmSync(join(m.root, "bin", "claude")), CHANNELS)
  })

  test("--bg writes the mount record, links the short id, and prints the address", async () => {
    await same(
      each([
        [["--bg"], { SCP_NAME: "bgkid", SCP_GRANT: "krt_grant", SCP_LABELS: "lane=x", SCP_CHANNELS: "1", SCP_HARNESS_ORIGIN: "stale" }],
        [["--bg", "--name", "lead", "--", "fix it"]],
        [["--", "--model", "opus", "--bg", "-n", "x"]],
        [["--background", "--system-prompt=x"]],
        [["--bg"], { CLAUDE_CODE_IS_COWORK: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_BG_SOURCE: "x" }],
        [["--root", "--bg"], { SCP_NAME: "caller", SCP_GRANT: "spent", SCP_UNDER: "old" }],
        [["--root"], { SCP_NAME: "caller", CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_MESSAGING_TOKEN: "t" }],
      ]),
      undefined,
      CHANNELS,
    )
    await same(each([[["--bg", "--name", "lead"]]]))
  })

  test("a background session that never says its id leaves no record and fails", async () => {
    await same(each([[["--bg", "--name", "lead"]]]), (m) =>
      writeFileSync(join(m.root, "bin", "claude"), "#!/bin/sh\necho 'something else'\nexit 0\n", { mode: 0o755 }),
    )
    await same(each([[["--bg", "--name", "lead"]]]), (m) => writeFileSync(join(m.root, "bin", "claude"), "#!/bin/sh\nexit 3\n", { mode: 0o755 }))
  })

  test("--bg --resume claims what the session's mount had, also when the resume forks a new id", async () => {
    const session = "1a2b3c4d-0000-4000-8000-000000000000"
    await same(
      (m) => {
        const caller = { SCP_NAME: "lead", SCP_GRANT: "krt_lead" }
        const forked = { mcpServers: { scp: { env: { SCP_NAME: "w2", SCP_GRANT: "krt_w2", SCP_UNDER: "" } } } }
        return (async () => [
          await run(m, ["--bg", "--name", "w1"], { SCP_GRANT: "krt_w1", SCP_UNDER: "me/lead" }),
          await run(m, ["--bg", "--resume", session], caller),
          await run(m, ["--bg", "--", "-r", `/t/${session}.jsonl`], { ...caller, SCP_HARNESS_ORIGIN: "stale" }),
          await (async () => {
            writeFileSync(join(m.env.SCP_DIR!, "claude-bg", "0f0f0f0f.json"), JSON.stringify(forked))
            return run(m, ["--bg", "--resume=0f0f0f0f"], caller)
          })(),
          await run(m, ["--bg", "--name", "w3", "--resume", "0f0f0f0f"], caller),
          await run(m, ["--bg", "--resume", "deadbeef"], caller),
          await run(m, ["--bg", "--root", "--resume", "0f0f0f0f"], caller),
        ])()
      },
      undefined,
      CHANNELS,
    )
  })

  test("--resume of a live background session attaches; attach by id or name renames first", async () => {
    const session = "1a2b3c4d-0000-4000-8000-000000000000"
    await same(
      each([
        [["--", "--resume", session]],
        [["--name", "lead", "-r", "0f0f0f0f-0000-4000-8000-000000000000"]],
        [["attach", "1a2b3c4d"]],
        [["attach", "0f0f0f0f", "--name", "x"]],
        [["attach", "nobody", "--as=me/x"]],
      ]),
      (m) =>
        writeFileSync(
          join(m.root, "agents.json"),
          JSON.stringify([{ id: "1a2b3c4d", sessionId: session, name: "lead", pid: 1, state: "working" }, null, { id: 3 }]),
        ),
      CHANNELS,
    )
  })

  test("attach --name renames the endpoint through the broker and the name the mount claims on resume", async () => {
    await same(
      async (m) => [
        await run(m, ["--bg", "--name", "bgkid"], { SCP_GRANT: "krt_grant" }),
        await run(m, ["attach", "1a2b3c4d", "--name", "bgkid"]),
        await run(m, ["attach", "1a2b3c4d", "--name", "lead"]),
        await run(m, ["attach", "1a2b3c4d", "--name", "lead"], { SCP_NAME: "bgkid", SCP_HARNESS: "claude-code" }),
        await (async () => {
          writeFileSync(join(m.root, "agents.json"), JSON.stringify([{ id: "1a2b3c4d", name: "lead", state: "working" }]))
          return run(m, ["attach", "lead", "--name=lead2"])
        })(),
      ],
      async (m) => {
        const broker = await startBroker({ dir: m.env.SCP_DIR!, idleMs: 0, policyPath: join(m.root, "policy.json"), log: () => {} })
        brokers.push(broker)
        broker.core.claim({ handle: "bgkid", harness: "claude-code" })
      },
      CHANNELS,
    )
  })

  test("the background mount under SCP_NATIVE=1 and mcp, and over a kept or gone user mount", async () => {
    const swarm = resolve(swarmBinary!)
    const write = (m: Machine, scp: Record<string, unknown>) => writeFileSync(join(m.root, ".claude.json"), JSON.stringify({ mcpServers: { scp } }))
    const cases: [Record<string, unknown> | undefined, Record<string, string>][] = [
      [
        { command: "swarm", args: [...CHANNELS, "--as", "kept"], env: { A: "b", SCP_CLI_ARGV: '["/stale"]', 1: "one" } },
        { SCP_NATIVE: "1", SCP_SWARM_BIN: swarm },
      ],
      [undefined, { SCP_NATIVE: "1", SCP_SWARM_BIN: swarm }],
      [
        { command: "swarm", args: CHANNELS },
        { SCP_NATIVE: "mcp", SCP_SWARM_BIN: swarm },
      ],
      [
        { command: "swarm", args: CHANNELS, env: { A: "b", SCP_NATIVE: "1", SCP_CLI_ARGV: '["/old"]' } },
        { SCP_NATIVE: "mcp", SCP_SWARM_BIN: "/nowhere/swarm" },
      ],
      [{ command: "/gone/swarm", args: [...CHANNELS, "--as", "kept"], env: { A: "b", SCP_NATIVE: "1", SCP_NAME: "first" } }, {}],
      [{ command: "swarm", args: ["mcp"], env: ["x", "y"] }, {}],
    ]
    for (const [scp, extra] of cases) await same(each([[["--bg", "--name", "worker"], extra]]), (m) => (scp ? write(m, scp) : undefined))
  })

  test("--under places the session without a grant; another machine's parent needs the broker's hub link", async () => {
    await same(
      each([
        [["--under", "me/lead", "--name", "fg", "--", "--mcp-config", "custom.json"], { SCP_NAME: "caller", SCP_GRANT: "spent" }],
        [["--bg", "--name", "worker", "--under", "lead"], { SCP_NAME: "caller", SCP_GRANT: "spent", SCP_SESSION: "s" }],
        [["--bg", "--under=me/lead", "--resume", "1a2b3c4d"], { SCP_NAME: "caller" }],
        [["--bg", "--name", "worker", "--under", "me/vm/lead"]],
      ]),
      async (m) => {
        const broker = await startBroker({ dir: m.env.SCP_DIR!, idleMs: 0, policyPath: join(m.root, "policy.json"), log: () => {} })
        brokers.push(broker)
      },
      CHANNELS,
    )
  })

  test("from an agent's shell the session gets a grant under that agent; a mismatched $SCP_NAME or --root does not", async () => {
    let broker: Broker | undefined
    await same(
      async (m) => [
        await run(m, ["--bg", "--name", "worker", "--", "do it"], {}, m.work, broker, "lead"),
        await run(m, ["--bg"], { SCP_NAME: "boss" }, m.work, broker, "boss"),
        await run(m, ["--bg", "--name", "kid"], { SCP_NAME: "other" }, m.work, broker, "boss2"),
        await run(m, ["--bg", "--root"], { SCP_NAME: "lead3" }, m.work, broker, "lead3"),
        await run(m, ["--name", "fgkid"], {}, m.work, broker, "fglead"),
        await run(m, ["--bg", "--name", "lone"], { SCP_DIR: join(m.root, "idle-relay") }),
      ],
      async (m) => {
        broker = await startBroker({ dir: m.env.SCP_DIR!, idleMs: 0, policyPath: join(m.root, "policy.json"), log: () => {} })
        brokers.push(broker)
      },
      CHANNELS,
    )
  })

  test("routed through the CLI under SCP_NATIVE=1, as the TypeScript CLI runs it", async () => {
    await same(
      each([
        [["--bg", "--name", "worker", "--", "hi"], { SCP_NATIVE: "1", SCP_SWARM_BIN: resolve(swarmBinary!) }],
        [["--name", "lead"], { SCP_NATIVE: "1", SCP_SWARM_BIN: resolve(swarmBinary!) }],
      ]),
      undefined,
      CHANNELS,
      ["ts", "routed"],
    )
  })
})
