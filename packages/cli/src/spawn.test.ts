import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"
import { lineage, processKey, readPsTable, spawnerKey } from "./identity"
import { agyRules } from "./setup"
import { PassThrough } from "node:stream"
import { type Envelope, LIMITS, steerNote, wrapMessage } from "@scp-dev/core"
import {
  agyNote,
  closedStdin,
  codexOverrideAt,
  codexOverrides,
  contributorRefusal,
  harnessArgv,
  harnessOutput,
  MESSAGING,
  repliesOutput,
  resumeArgv,
  runHarness,
  spawnEnvironment,
  spawnPrompt,
  spawnTitle,
  steerArgv,
  stderrOutput,
  transcriptReplies,
  workerName,
} from "./spawn"
import { agentShell, spawnDefaults, splitSpawn } from "./spawn"
import { grantParams } from "./common"
import { RELAY_HELP, verbHelp } from "./main"
import { SPAWN_HELP } from "./help-spawn"
import { alive, waitFor } from "./testing/fixtures"

setDefaultTimeout(30_000)

const entry = join(import.meta.dir, "cli.ts")
const SELF = [process.execPath, "--no-env-file", entry]

/** Codex fixture: applies config overrides, starts the shim, reports hooks and simulates output and late steers. */
const FAKE_CODEX = `
import { appendFileSync, existsSync, fstatSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { isatty } from "node:tty"
const argv = process.argv.slice(2)
if (argv.includes("--help")) {
  if (!process.env.FAKE_NO_SKIP) console.log("      --skip-git-repo-check\\n          Allow running Codex outside a Git repository")
  process.exit(0)
}
appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv, env: process.env }) + "\\n")
if (process.env.FAKE_STDERR) console.error(process.env.FAKE_STDERR)
if (process.env.FAKE_TRUST && !argv.includes("--skip-git-repo-check")) {
  let dir = process.cwd()
  while (!existsSync(join(dir, ".git")) && dirname(dir) !== dir) dir = dirname(dir)
  if (!existsSync(join(dir, ".git"))) {
    console.error("Not inside a trusted directory and --skip-git-repo-check was not specified.")
    process.exit(1)
  }
}
if (process.env.FAKE_STDIN) {
  const stat = fstatSync(0)
  const kind = isatty(0) ? "tty" : stat.isFIFO() || stat.isSocket() ? "pipe" : stat.isCharacterDevice() ? "devnull" : "file"
  const read = kind === "pipe" ? await Bun.stdin.text() : ""
  writeFileSync(process.env.FAKE_RECORD + ".stdin", JSON.stringify({ kind, read }))
}
const counter = process.env.FAKE_RECORD + ".runs"
const run = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1
writeFileSync(counter, String(run))
const resume = argv.includes("resume")
const base = "mcp_servers.scp."
const file = process.env.CODEX_HOME + "/config.toml"
const server = { ...((existsSync(file) ? Bun.TOML.parse(readFileSync(file, "utf8")) : {}).mcp_servers?.["scp"] ?? {}) }
const overrides = (from, to) => argv.slice(from, to).flatMap((arg, i, all) => (arg === "-c" ? [all[i + 1]] : []))
const sub = argv.indexOf("exec")
const exec = sub < 0 ? [] : overrides(sub + 1)
for (const pair of exec.length ? exec : overrides(0, sub < 0 ? argv.length : sub)) {
  const eq = pair.indexOf("=")
  const key = pair.slice(0, eq)
  if (key.startsWith(base)) server[key.slice(base.length)] = Bun.TOML.parse("v = " + pair.slice(eq + 1)).v
}
const env = {}
for (const key of ["HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER", ...(server.env_vars ?? [])]) if (process.env[key] !== undefined) env[key] = process.env[key]
Object.assign(env, server.env ?? {})
if ((!resume || process.env.FAKE_RESUME_SEND) && process.env.FAKE_SEND_TO && server.command && server.enabled !== false) {
  const shim = Bun.spawn([server.command, ...(server.args ?? [])], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const rpc = (id, method, params) => shim.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n")
  rpc(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "0" } })
  rpc(1, "tools/call", { name: "relay_send", arguments: { to: process.env.FAKE_SEND_TO, body: resume ? "hello from the resumed worker" : "hello from the worker" } })
  shim.stdin.flush()
  let text = ""
  const reader = shim.stdout.getReader()
  while (!text.split("\\n").some((line) => line.includes('"id":1'))) {
    const read = await reader.read()
    if (read.done) break
    text += new TextDecoder().decode(read.value)
  }
  shim.stdin.end()
  await shim.exited
  appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ shim: text.split("\\n").filter(Boolean).map((line) => JSON.parse(line)).find((m) => m.id === 1) }) + "\\n")
}
if (!resume && process.env.FAKE_SESSION) {
  const hook = Bun.spawn([...JSON.parse(process.env.FAKE_SWARM), "hook", "codex", "SessionStart"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", env: process.env })
  hook.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", session_id: process.env.FAKE_SESSION, cwd: process.cwd(), source: "startup" }))
  hook.stdin.end()
  await hook.exited
}
if (process.env.FAKE_WAIT) {
  writeFileSync(process.env.FAKE_RECORD + ".up" + run, "")
  while (!existsSync(process.env.FAKE_RECORD + ".go" + run)) await Bun.sleep(20)
}
if (process.env.FAKE_WAIT) console.log(resume ? "resumed " + run : "ran " + run)
process.exit(Number((resume ? process.env.FAKE_RESUME_EXIT : undefined) ?? process.env.FAKE_EXIT ?? 0))
`

/**
 * a stand-in for muse: it starts its stdio MCP server with a fixed environment (no SCP_GRANT or SCP_NAME, the broker dir from
 * its literal env map), asks relay_whoami, records the answer and exits 3
 */
const FAKE_MUSE = `
import { writeFileSync } from "node:fs"
writeFileSync(process.env.FAKE_RECORD + ".muse.argv", JSON.stringify(process.argv.slice(2)))
const shim = Bun.spawn(JSON.parse(process.env.FAKE_SHIM), { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
const rpc = (id, method, params) => shim.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n")
rpc(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "muse", version: "0" } })
rpc(1, "tools/call", { name: "relay_whoami", arguments: {} })
shim.stdin.flush()
let text = ""
const reader = shim.stdout.getReader()
while (!text.split("\\n").some((line) => line.includes('"id":1'))) {
  const read = await reader.read()
  if (read.done) break
  text += new TextDecoder().decode(read.value)
}
shim.stdin.end()
await shim.exited
writeFileSync(process.env.FAKE_RECORD + ".muse", JSON.stringify(text.split("\\n").filter(Boolean).map((line) => JSON.parse(line)).find((m) => m.id === 1)))
process.exit(3)
`

/**
 * a stand-in for claude -p: its SessionStart hook reports $FAKE_SESSION and $FAKE_TRANSCRIPT as Claude Code's does, then it prints only its
 * final message, "Done.", and exits $FAKE_EXIT
 */
const FAKE_CLAUDE = `
const hook = Bun.spawn([...JSON.parse(process.env.FAKE_SWARM), "hook", "claude", "SessionStart"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", env: { ...process.env, CLAUDE_PID: String(process.pid) } })
hook.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", session_id: process.env.FAKE_SESSION, transcript_path: process.env.FAKE_TRANSCRIPT, cwd: process.cwd(), source: "startup" }))
hook.stdin.end()
await hook.exited
console.log("Done.")
process.exit(Number(process.env.FAKE_EXIT ?? 0))
`

async function swarm(args: string[], env: Record<string, string>, cwd?: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
    ...(cwd ? { cwd } : {}),
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

type Record_ = { argv?: string[]; env?: Record<string, string>; shim?: { result?: { content?: { text: string }[]; isError?: boolean } } }

const records = (file: string): Record_[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record_)
    : []

describe("swarm spawn", () => {
  let broker: Broker
  let lead: RelayClient
  const root = mkdtempSync(join(process.env.HOME!, "spawn-"))
  const dir = join(root, "relay")
  const bin = join(root, "bin")
  const record = join(root, "record.jsonl")
  const env = (extra: Record<string, string> = {}) => ({ SCP_DIR: dir, PATH: `${bin}:${process.env.PATH}`, FAKE_RECORD: record, ...extra })
  const codexHome = (mounted: boolean) => {
    const home = mkdtempSync(join(root, "codex-"))
    if (mounted)
      writeFileSync(
        join(home, "config.toml"),
        `[mcp_servers.scp]\ncommand = ${JSON.stringify(SELF[0])}\nargs = ${JSON.stringify([...SELF.slice(1), "mcp", "--harness", "codex"])}\nenabled = false\n`,
      )
    return home
  }
  const inbox = async () => {
    const { messages } = await lead.request<{ messages: { seq: number; from: { address: string }; body: { text: string } }[] }>("inbox")
    if (messages.length) await lead.request("ack", { seqs: messages.map((m) => m.seq) })
    return messages
  }
  const take = () => {
    const taken = records(record)
    writeFileSync(record, "")
    return taken
  }

  beforeAll(async () => {
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(root, "fake-codex.ts"), FAKE_CODEX)
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(join(root, "fake-codex.ts"))} "$@"\n`)
    for (const name of ["claude", "opencode"])
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_RECORD.${name}.argv"\nenv > "$FAKE_RECORD.${name}.env"\nexit 4\n`)
    writeFileSync(join(root, "fake-claude.ts"), FAKE_CLAUDE)
    writeFileSync(
      join(bin, "cc-fake"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(join(root, "fake-claude.ts"))} "$@"\n`,
    )
    chmodSync(join(bin, "cc-fake"), 0o755)
    writeFileSync(join(root, "fake-muse.ts"), FAKE_MUSE)
    writeFileSync(
      join(bin, "muse"),
      `#!/bin/sh\nexec env -u SCP_GRANT -u SCP_NAME -u SCP_LABELS -u SCP_SESSION MUSE_SESSION_ID=fake-muse FAKE_SHIM=${JSON.stringify(JSON.stringify([...SELF, "mcp"]))} ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(join(root, "fake-muse.ts"))} "$@"\n`,
    )
    for (const name of ["codex", "claude", "opencode", "muse"]) chmodSync(join(bin, name), 0o755)
    broker = await startBroker({ dir, idleMs: 0, policyPath: join(root, "policy.json"), log: () => {} })
    lead = await RelayClient.connect(broker.socket)
    await lead.hello({ claim: { handle: "lead", harness: "claude-code", process: processKey(process.pid), lineage: [processKey(process.pid)] } })
  })
  afterAll(async () => {
    lead.close()
    await broker.stop()
  })

  test("a codex worker gets the grant through env_vars overrides, registers under the spawner with its scope, and sends over the MCP tools", async () => {
    const spawned = await swarm(
      ["spawn", "--fg", "--name", "w1", "--scope", "parent", "--ttl", "1h", "--", "codex", "exec", "send one message"],
      env({ CODEX_HOME: codexHome(true), FAKE_SEND_TO: "lead", FAKE_EXIT: "7", SCP_SESSION: "lead-session" }),
    )
    expect(spawned.code).toBe(7)
    expect(`${spawned.stdout}${spawned.stderr}`).not.toContain("krt_")
    const [call, shim] = take()
    const overrides = ["-c", call!.argv![1]!, "-c", "mcp_servers.scp.enabled=true", "-c", 'mcp_servers.scp.default_tools_approval_mode="approve"']
    const steered = /^send one message\n\n\[swarm spawn: me\/lead, .* key="([0-9a-z]{6})"> blocks: .*\]$/s.exec(call!.argv!.at(-1)!)
    expect(call!.argv).toEqual([...overrides, "exec", ...overrides, `send one message${steerNote("me/lead", steered![1]!)}`])
    expect(call!.argv!.join(" ")).not.toContain("krt_")
    expect(Object.values(call!.env!).join("\n")).not.toContain(steered![1]!)
    const [key, value] = [call!.argv![1]!.slice(0, call!.argv![1]!.indexOf("=")), call!.argv![1]!.slice(call!.argv![1]!.indexOf("=") + 1)]
    expect(key).toBe("mcp_servers.scp.env_vars")
    expect((Bun.TOML.parse(`v = ${value}`) as { v: string[] }).v.sort()).toEqual(["SCP_DIR", "SCP_GRANT", "SCP_NAME", "XDG_STATE_HOME"])
    expect(call!.env!.SCP_GRANT).toMatch(/^krt_[0-9a-f]{64}$/)
    expect(call!.env!.SCP_NAME).toBe("w1")
    expect(call!.env!.SCP_SESSION).toBeUndefined()
    expect(shim!.shim!.result!.isError).toBeFalsy()
    expect((await inbox()).map((m) => [m.from.address, m.body.text])).toEqual([
      ["me/w1", "hello from the worker"],
      ["me/w1", "worker me/w1 exited (exit 7) with no final output"],
    ])
    const scope = await lead.rules("w1")
    expect([scope.parent, scope.depth, scope.preset]).toEqual(["me/lead", 1, "parent"])
  })

  test("a codex worker given its own -c after exec still registers under the grant's name", async () => {
    const spawned = await swarm(
      [
        "spawn",
        "--fg",
        "--name",
        "wc5",
        "--scope",
        "parent",
        "--",
        "codex",
        "-m",
        "m1",
        "exec",
        "--skip-git-repo-check",
        "-c",
        "model_reasoning_effort=low",
        "go",
      ],
      env({ CODEX_HOME: codexHome(true), FAKE_SEND_TO: "lead" }),
    )
    expect(spawned.code).toBe(0)
    const [call, shim] = take()
    const exec = call!.argv!.indexOf("exec")
    expect(call!.argv!.slice(exec - 2, exec + 1)).toEqual(["-m", "m1", "exec"])
    expect(call!.argv!.slice(-4, -1)).toEqual(["--skip-git-repo-check", "-c", "model_reasoning_effort=low"])
    expect(call!.argv!.at(-1)).toStartWith("go\n\n[swarm spawn: me/lead,")
    expect(shim!.shim!.result!.isError).toBeFalsy()
    expect((await inbox()).map((m) => m.from.address)).toEqual(["me/wc5", "me/wc5"])
    expect((await lead.rules("wc5")).parent).toBe("me/lead")
  })

  test("--title names the worker as it starts: its endpoint carries the title", async () => {
    const spawned = await swarm(
      ["spawn", "--fg", "--name", "wt1", "--scope", "parent", "--title", "docs  pass", "--", "codex", "exec", "x"],
      env({ CODEX_HOME: codexHome(true), FAKE_SEND_TO: "lead" }),
    )
    expect(spawned.code).toBe(0)
    take()
    await inbox()
    expect(
      (await lead.request<{ endpoints: { address: string; title: string | null }[] }>("list", { all: true })).endpoints.find((e) => e.address === "me/wt1")!
        .title,
    ).toBe("docs pass")
    expect((await swarm(["spawn", "--title", "x".repeat(65), "--", "claude"], env())).stderr).toContain("longer than 64")
  })

  test("with --peek local a codex exec prompt, scrubbed, is the worker's first peek turn; without it nothing of the prompt is kept, and the spent grant drops it", async () => {
    const secret = `ghp_${"A1b2C3d4".repeat(5)}`
    for (const [name, peek] of [
      ["wp1", ["--peek", "local"]],
      ["wp2", []],
    ] as const) {
      const spawned = await swarm(
        ["spawn", "--fg", "--name", name, "--scope", "parent", ...peek, "--", "codex", "exec", "-m", "gpt", `PROMPT-MARKER ${secret}`],
        env({ CODEX_HOME: codexHome(true), FAKE_SEND_TO: "lead" }),
      )
      expect(spawned.code).toBe(0)
    }
    take()
    await inbox()
    const db = new Database(join(dir, "relay.db"), { readonly: true })
    try {
      const turns = db
        .query("SELECT e.handle, t.role, t.text FROM peek_turns t JOIN endpoints e ON e.id = t.endpoint WHERE e.handle IN ('wp1', 'wp2')")
        .all() as { handle: string; role: string; text: string }[]
      expect(turns.map((t) => [t.handle, t.role])).toEqual([["wp1", "user"]])
      expect(turns[0]!.text).toContain("PROMPT-MARKER")
      expect(turns[0]!.text).not.toContain(secret)
      expect(db.query("SELECT COUNT(*) AS n FROM grants WHERE prompt IS NOT NULL").get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  test("codex without an scp mount gets this swarm's shim as the server", async () => {
    const spawned = await swarm(
      ["spawn", "--fg", "--name", "w2", "--scope", "parent", "--", "codex", "exec", "hi"],
      env({ CODEX_HOME: codexHome(false), FAKE_SEND_TO: "lead" }),
    )
    expect(spawned.code).toBe(0)
    const [call, shim] = take()
    expect(call!.argv!.slice(0, 4)).toEqual([
      "-c",
      `mcp_servers.scp.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.scp.args=${JSON.stringify(["--no-env-file", "--config=/dev/null", entry, "mcp", "--harness", "codex"]).replaceAll(",", ", ")}`,
    ])
    expect(shim!.shim!.result!.isError).toBeFalsy()
    expect((await inbox()).map((m) => m.from.address)).toEqual(["me/w2", "me/w2"])
    expect((await lead.rules("w2")).parent).toBe("me/lead")
  })

  test("claude -p gets the relay tools allowed and opencode its argv untouched, both the grant in the environment they pass to MCP servers, without the spawner's identity", async () => {
    for (const harness of ["claude", "opencode"]) {
      const spawned = await swarm(
        ["spawn", "--fg", "--name", `${harness}-w`, "--labels", "role=worker", "--", harness, "-p", "a b"],
        env({ SCP_SESSION: "lead-session", SCP_PARENT: "boss", SCP_HARNESS: "cli" }),
      )
      expect(spawned.code).toBe(4)
      expect(`${spawned.stdout}${spawned.stderr}`).not.toContain("krt_")
      const argv = readFileSync(`${record}.${harness}.argv`, "utf8")
      const key = /key="([0-9a-z]{6})"/.exec(argv)?.[1]
      expect(argv).toBe(harness === "claude" ? `-p\na b${steerNote("me/lead", key!)}\n--allowedTools\n${MESSAGING.join("\n")}\n` : "-p\na b\n")
      const lines = readFileSync(`${record}.${harness}.env`, "utf8").split("\n")
      expect(lines.find((l) => l.startsWith("SCP_GRANT="))).toMatch(/^SCP_GRANT=krt_[0-9a-f]{64}$/)
      expect(lines).toContain(`SCP_NAME=${harness}-w`)
      expect(lines).toContain("SCP_LABELS=role=worker")
      expect(lines.filter((l) => /^SCP_(SESSION|PARENT|HARNESS)=/.test(l))).toEqual([])
    }
  })

  test("a harness that hands its MCP server no grant still claims the grant's name through the spawner's process, and goes done and offline when it exits", async () => {
    const spawned = await swarm(["spawn", "--fg", "--name", "wm1", "--scope", "parent", "--title", "muse worker", "--", "muse", "exec", "go"], env())
    expect(spawned.code).toBe(3)
    expect(spawned.stderr).not.toContain("never joined")
    const whoami = JSON.parse(readFileSync(`${record}.muse`, "utf8")) as { result: { content: { text: string }[]; isError?: boolean } }
    expect(whoami.result.isError).toBeFalsy()
    expect(whoami.result.content[0]!.text).toContain("me/wm1")
    const listed = await lead.request<{
      endpoints: {
        address: string
        harness: string
        parent: string | null
        presence: string
        title: string | null
        status: { state: string; note: string } | null
      }[]
    }>("list", { all: true })
    expect(listed.endpoints.find((e) => e.address === "me/wm1")).toMatchObject({
      harness: "muse",
      parent: "me/lead",
      presence: "offline",
      title: "muse worker",
      status: { state: "done", note: "exited 3" },
    })
    expect(listed.endpoints.map((e) => e.address)).not.toContain(expect.stringMatching(/^me\/muse-/))
    const shown = await swarm(["list", "--all"], env({ SCP_SESSION: "lead-session" }))
    expect(shown.stdout).toMatch(/me\/wm1.*offline.*done.*exited 3/)
    expect(JSON.parse(readFileSync(`${record}.muse.argv`, "utf8"))).toEqual(["exec", "--contributor-mode", "off", "go"])
    await swarm(["spawn", "--fg", "--name", "wm2", "--", "muse", "exec", "--contributor-mode=on", "go"], env())
    expect(JSON.parse(readFileSync(`${record}.muse.argv`, "utf8"))).toEqual(["exec", "--contributor-mode=on", "go"])
    const odd = await swarm(["spawn", "--fg", "--name", "wm3", "--", "muse", "exec", "--contributor-mode=maybe", "go"], env())
    expect([odd.code, odd.stderr]).toEqual([125, expect.stringContaining("muse runs with --contributor-mode off or on")])
  })

  test("without --, the harness command starts at the first word that is no spawn flag or its value", async () => {
    await inbox()
    const spawned = await swarm(
      ["spawn", "--fg", "--name", "wd1", "--scope", "parent", "--title=no dashes", "codex", "exec", "--json", "send it"],
      env({ CODEX_HOME: codexHome(true), FAKE_SEND_TO: "lead" }),
    )
    expect(spawned.code).toBe(0)
    const [call] = take()
    expect(call!.argv!.at(-2)).toBe("--json")
    expect(call!.argv!.at(-1)).toStartWith("send it\n\n[swarm spawn: me/lead")
    expect((await inbox()).map((m) => m.from.address)).toEqual(["me/wd1", "me/wd1"])
    expect(
      (await lead.request<{ endpoints: { address: string; title: string | null }[] }>("list", { all: true })).endpoints.find((e) => e.address === "me/wd1")!
        .title,
    ).toBe("no dashes")
    expect((await swarm(["spawn", "--fg", "--name", "wd2", "--", "sh", "-c", "exit 6"], env())).code).toBe(6)
    await inbox()
  })

  test("a spawn without --name, --title or a scope flag gets <harness>-<id>, the prompt's first line and no scope; explicit flags win", async () => {
    await inbox()
    const spawned = await swarm(
      ["spawn", "--fg", "codex", "exec", "Review the parser\nthen report"],
      env({ CODEX_HOME: codexHome(true), FAKE_SEND_TO: "lead" }),
    )
    expect(spawned.code).toBe(0)
    const [call] = take()
    const name = call!.env!.SCP_NAME!
    expect(name).toMatch(/^codex-[a-z0-9]{5}$/)
    expect((await inbox()).map((m) => m.from.address)).toEqual([`me/${name}`, `me/${name}`])
    const listed = (await lead.request<{ endpoints: { address: string; title: string | null }[] }>("list", { all: true })).endpoints
    expect(listed.find((e) => e.address === `me/${name}`)!.title).toBe("Review the parser")
    expect((await lead.rules(name)).preset).toBe("open")
    await swarm(["spawn", "--fg", "--name", "wa1", "--allow", "ep:lead", "--", "sh", "-c", "exit 0"], env())
    await swarm(["spawn", "--fg", "--name", "wa2", "--scope", "open", "--", "sh", "-c", "exit 0"], env())
    await inbox()
    const db = new Database(join(dir, "relay.db"), { readonly: true })
    try {
      const caps = (grant: string) =>
        JSON.parse((db.query("SELECT caps FROM grants WHERE name = ?").get(grant) as { caps: string }).caps) as { dir: string; sels: { sel: string }[] }[]
      expect(caps(name)).toEqual([])
      expect(caps("wa1").flatMap((c) => c.sels.map((e) => e.sel))).not.toContain("tree:parent")
      expect(caps("wa2")).toEqual([])
    } finally {
      db.close()
    }
  })

  test("without a scope flag, a worker spawned --under another endpoint reaches its spawner by the default reach, and one spawned --group reaches the group", async () => {
    await inbox()
    const mid = await RelayClient.connect(broker.socket)
    const buddy = await RelayClient.connect(broker.socket)
    try {
      await mid.hello({ claim: { handle: "mid", harness: "codex", grant: (await lead.grant({ name: "mid", scope: "open" })).token } })
      await buddy.hello({ claim: { handle: "buddy", harness: "codex", grant: (await lead.grant({ name: "buddy", scope: "open" })).token } })
      await lead.group({ action: "create", name: "crew" })
      await lead.group({ action: "add", name: "crew", endpoint: "buddy" })
      expect(
        (await swarm(["spawn", "--fg", "--name", "wu1", "--under", "mid", "codex", "exec", "x"], env({ CODEX_HOME: codexHome(true), FAKE_SEND_TO: "lead" })))
          .code,
      ).toBe(0)
      expect(take().find((r) => r.shim)!.shim!.result!.isError).toBeFalsy()
      expect((await lead.rules("wu1")).parent).toBe("me/mid")
      expect((await inbox()).map((m) => [m.from.address, m.body.text])).toContainEqual(["me/wu1", "hello from the worker"])
      expect(
        (await swarm(["spawn", "--fg", "--name", "wg1", "--group", "crew", "codex", "exec", "x"], env({ CODEX_HOME: codexHome(true), FAKE_SEND_TO: "buddy" })))
          .code,
      ).toBe(0)
      expect(take().find((r) => r.shim)!.shim!.result!.isError).toBeFalsy()
      const got = (await buddy.request<{ messages: { from: { address: string }; body: { text: string } }[] }>("inbox")).messages
      expect(got.map((m) => [m.from.address, m.body.text])).toContainEqual(["me/wg1", "hello from the worker"])
      expect((await lead.rules("wg1")).preset).toBe("open")
    } finally {
      mid.close()
      buddy.close()
      await inbox()
    }
  })

  test("the handback carries the harness's whole final output though stdout is a pipe; --handback-bytes caps it", async () => {
    await inbox()
    const script = `i=0; while [ $i -lt 60 ]; do printf '%099d\\n' $i; i=$((i+1)); done; printf 'the headline\\n'`
    expect((await swarm(["spawn", "--fg", "--name", "full1", "--", "sh", "-c", script], env())).code).toBe(0)
    const [whole] = await inbox()
    expect(whole!.body.text.startsWith(`worker full1 finished (exit 0), not a relay agent\n\n${"0".repeat(99)}\n`)).toBe(true)
    expect(whole!.body.text.endsWith("\nthe headline")).toBe(true)
    expect(whole!.body.text.length).toBeGreaterThan(6000)
    expect((await swarm(["spawn", "--fg", "--name", "full2", "--handback-bytes", "40", "--", "sh", "-c", script], env())).code).toBe(0)
    const [capped] = await inbox()
    const output = capped!.body.text.split("\n\n").slice(1).join("\n\n")
    expect(output).toBe("[earlier output cut]\nthe headline")
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(40)
  })

  describe("a Claude Code worker whose result came before its final message", () => {
    const session = "5f0e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b"
    const config = join(root, "claude-config")
    const transcript = (name: string) => {
      mkdirSync(join(config, "projects"), { recursive: true })
      const dir = mkdtempSync(join(config, "projects", "p-"))
      writeFileSync(join(dir, name), TRANSCRIPT.replaceAll("0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d", session))
      return join(dir, name)
    }
    const run = async (name: string, path: string, extra: string[] = []) => {
      await inbox()
      const spawned = await swarm(
        ["spawn", "--fg", "--name", name, ...extra, "--", "cc-fake", "-p", "write bullets"],
        env({ FAKE_SWARM: JSON.stringify(SELF), FAKE_SESSION: session, FAKE_TRANSCRIPT: path, CLAUDE_CONFIG_DIR: config }),
      )
      expect([spawned.code, spawned.stdout]).toEqual([0, "Done.\n"])
      return (await inbox()).find((m) => m.body.text.startsWith(`worker me/${name}`))!.body.text
    }

    test("hands back every assistant text since its prompt from the transcript its hook reported, the headline first", async () => {
      expect(await run("cc1", transcript(`${session}.jsonl`))).toBe(`worker me/cc1 finished (exit 0)\n\n${BULLETS}\n\nDone.`)
    })

    test("--handback-bytes caps it from the front, the final message whole", async () => {
      expect(await run("cc2", transcript(`${session}.jsonl`), ["--handback-bytes", "40"])).toBe(
        "worker me/cc2 finished (exit 0)\n\n[earlier output cut]\n\nDone.",
      )
    })

    test("hands back a 4 KB report with long bullets whole", async () => {
      const path = transcript(`${session}.jsonl`)
      writeFileSync(
        path,
        `${readFileSync(path, "utf8")}\n${JSON.stringify({ type: "assistant", sessionId: session, message: { role: "assistant", content: [{ type: "text", text: REPORT }] } })}`,
      )
      expect(await run("cc5", path)).toBe(`worker me/cc5 finished (exit 0)\n\n${BULLETS}\n\nDone.\n\n${REPORT}`)
    })

    test("falls back to its stdout when the transcript is not one it may read", async () => {
      expect(await run("cc3", transcript("other.jsonl"))).toBe("worker me/cc3 finished (exit 0)\n\nDone.")
      expect(await run("cc4", join(root, "gone", `${session}.jsonl`))).toBe("worker me/cc4 finished (exit 0)\n\nDone.")
    })
  })

  test("--no-push marks the grant: its spawner's stop never waits on that worker", async () => {
    expect((await swarm(["spawn", "--fg", "--name", "np1", "--no-push", "sh", "-c", "exit 0"], env())).code).toBe(0)
    expect((await swarm(["spawn", "--fg", "--name", "np2", "--", "sh", "-c", "exit 0"], env())).code).toBe(0)
    await inbox()
    const db = new Database(join(dir, "relay.db"), { readonly: true })
    try {
      expect(db.query("SELECT name, spawn, no_push FROM grants WHERE name IN ('np1', 'np2') ORDER BY name").all()).toEqual([
        { name: "np1", spawn: 1, no_push: 1 },
        { name: "np2", spawn: 1, no_push: null },
      ])
    } finally {
      db.close()
    }
  })

  test("a harness that never joins the relay gets its grant revoked and no note, keeping its exit code", async () => {
    const spawned = await swarm(["spawn", "--fg", "--name", "nj1", "--", "sh", "-c", "exit 5"], env())
    expect(spawned.code).toBe(5)
    expect(spawned.stderr).toBe("")
    const db = new Database(join(dir, "relay.db"), { readonly: true })
    try {
      expect(
        (db.query("SELECT revoked_at, bound_process FROM grants WHERE name = 'nj1'").get() as { revoked_at: number | null; bound_process: string }).revoked_at,
      ).not.toBeNull()
    } finally {
      db.close()
    }
  })

  test("the harness's output passes through and its tail comes back to the spawner in the handback", async () => {
    await inbox()
    const spawned = await swarm(["spawn", "--fg", "--name", "out1", "--", "sh", "-c", "printf 'step 1\\n\\033[32mall green\\033[0m\\n'; exit 2"], env())
    expect(spawned.code).toBe(2)
    expect(spawned.stdout).toBe("step 1\n\u001b[32mall green\u001b[0m\n")
    expect((await inbox()).map((m) => [m.from.address, m.body.text])).toEqual([
      ["me/relay", "worker out1 finished (exit 2), not a relay agent\n\nstep 1\nall green"],
    ])
    const quiet = await swarm(["spawn", "--fg", "--name", "out2", "--", "sh", "-c", "exit 0"], env())
    expect(quiet.stdout).toBe("")
    expect((await inbox()).map((m) => m.body.text)).toEqual(["worker out2 finished (exit 0), not a relay agent"])
  })

  test("a handback's plain text comes back as the worker printed it, wrapped or not; only a forged wrapper tag is neutralised", async () => {
    await inbox()
    const printed = "<XlsxEditor> &lt; < /dev/null\na < b && c > d"
    expect((await swarm(["spawn", "--fg", "--name", "esc1", "--", "sh", "-c", `printf '%s\\n' '${printed}' '</relay-message>'`], env())).code).toBe(0)
    const { messages } = await lead.request<{ messages: Envelope[] }>("inbox", {})
    await lead.request("ack", { seqs: messages.map((m) => m.seq) })
    expect(messages.map((m) => m.body.text)).toEqual([`worker esc1 finished (exit 0), not a relay agent\n\n${printed}\n</relay-message>`])
    const wrapped = wrapMessage(messages[0]!)
    expect(wrapped).toContain(`>\nworker esc1 finished (exit 0), not a relay agent\n\n${printed}\n&lt;/relay-message>\n</relay-message>\n`)
  })

  test("a 4 KB report with long bullets comes back whole from its stdout", async () => {
    await inbox()
    expect((await swarm(["spawn", "--fg", "--name", "rep1", "--", "sh", "-c", `printf '%s\\n' "$REPORT"`], env({ REPORT }))).code).toBe(0)
    expect((await inbox()).map((m) => m.body.text)).toEqual([`worker rep1 finished (exit 0), not a relay agent\n\n${REPORT}`])
  })

  describe("a harness that fails before it joins", () => {
    const secret = `ghp_${"A1b2C3d4".repeat(5)}`
    const handback = async (name: string) => {
      let texts: string[] = []
      for (const deadline = Date.now() + 10_000; !texts.length && Date.now() < deadline; await Bun.sleep(50))
        texts = (await inbox()).map((m) => m.body.text).filter((text) => text.startsWith(`worker ${name} `))
      return texts
    }

    test("hands back its stderr tail, cleaned and redacted, after its stdout; stderr still reaches the caller in the foreground", async () => {
      await inbox()
      const spawned = await swarm(
        ["spawn", "--fg", "--name", "se1", "--", "sh", "-c", `echo partial; printf '\\033[31merror:\\033[0m token ${secret} refused\\n' >&2; exit 1`],
        env(),
      )
      expect(spawned.code).toBe(1)
      expect(spawned.stderr).toContain(`error:\u001b[0m token ${secret} refused`)
      expect(await handback("se1")).toEqual([
        "worker se1 finished (exit 1), not a relay agent\n\npartial\n\nstderr (last 1 KB):\nerror: token [redacted github token] refused",
      ])
    })

    test("detached, a long stderr comes back as its last 1 KB from a line start, behind a marker, within the handback cap", async () => {
      await inbox()
      const script = `i=0; while [ $i -lt 400 ]; do printf 'noise line %03d\\n' $i >&2; i=$((i+1)); done; printf '%016000d\\n' 0; echo 'fatal: no trust' >&2; exit 0`
      const spawned = await swarm(["spawn", "--name", "se2", "--", "sh", "-c", script], env())
      expect(spawned.code).toBe(0)
      const [text] = await handback("se2")
      const [head, tail] = text!.split("\n\nstderr (last 1 KB):\n")
      expect(head!.startsWith("worker se2 finished (exit 0), not a relay agent\n\n[earlier output cut]\n0000")).toBe(true)
      expect(tail!.startsWith("[earlier stderr cut]\nnoise line ")).toBe(true)
      expect(tail!.endsWith("noise line 399\nfatal: no trust")).toBe(true)
      expect(new TextEncoder().encode(tail!).length).toBeLessThanOrEqual(1024 + "[earlier stderr cut]\n".length)
      expect(new TextEncoder().encode(text!.slice(text!.indexOf("\n\n") + 2)).length).toBeLessThanOrEqual(LIMITS.handbackBytes)
    })

    test("a joined worker's handback carries its stderr only when it exits non-zero", async () => {
      await inbox()
      const ok = await swarm(
        ["spawn", "--fg", "--name", "se3", "--", "codex", "exec", "go"],
        env({ CODEX_HOME: codexHome(true), FAKE_SEND_TO: "lead", FAKE_STDERR: "progress noise" }),
      )
      expect(ok.code).toBe(0)
      expect((await inbox()).map((m) => m.body.text)).toEqual(["hello from the worker", "worker me/se3 exited (exit 0) with no final output"])
      const failed = await swarm(
        ["spawn", "--fg", "--name", "se4", "--", "codex", "exec", "go"],
        env({ CODEX_HOME: codexHome(true), FAKE_SEND_TO: "lead", FAKE_STDERR: "quota exceeded", FAKE_EXIT: "3" }),
      )
      expect(failed.code).toBe(3)
      expect((await inbox()).map((m) => m.body.text)).toEqual([
        "hello from the worker",
        "worker me/se4 exited (exit 3) with no final output\n\nstderr (last 1 KB):\nquota exceeded",
      ])
      take()
    })
  })

  describe("a codex exec worker", () => {
    const outside = () => mkdtempSync(join(root, "nogit-"))

    test("outside a git repo gets --skip-git-repo-check after exec and runs; with it passed, inside a repo, or a codex without the flag, nothing is added", async () => {
      take()
      const ran = await swarm(
        ["spawn", "--fg", "--name", "sg1", "--", "codex", "exec", "go"],
        env({ CODEX_HOME: codexHome(true), FAKE_TRUST: "1", FAKE_SEND_TO: "lead" }),
        outside(),
      )
      expect(ran.code).toBe(0)
      const [call] = take()
      expect(call!.argv!.filter((arg) => arg === "--skip-git-repo-check")).toHaveLength(1)
      expect(call!.argv!.indexOf("--skip-git-repo-check")).toBeGreaterThan(call!.argv!.indexOf("exec"))
      const own = await swarm(
        ["spawn", "--fg", "--name", "sg2", "--", "codex", "exec", "--skip-git-repo-check", "go"],
        env({ CODEX_HOME: codexHome(true), FAKE_TRUST: "1" }),
        outside(),
      )
      expect(own.code).toBe(0)
      expect(take()[0]!.argv!.filter((arg) => arg === "--skip-git-repo-check")).toHaveLength(1)
      const repo = outside()
      mkdirSync(join(repo, ".git"))
      mkdirSync(join(repo, "sub"))
      expect(
        (await swarm(["spawn", "--fg", "--name", "sg3", "--", "codex", "exec", "go"], env({ CODEX_HOME: codexHome(true), FAKE_TRUST: "1" }), join(repo, "sub")))
          .code,
      ).toBe(0)
      expect(take()[0]!.argv).not.toContain("--skip-git-repo-check")
      await inbox()
      const old = await swarm(
        ["spawn", "--fg", "--name", "sg4", "--", "codex", "exec", "go"],
        env({ CODEX_HOME: codexHome(true), FAKE_TRUST: "1", FAKE_NO_SKIP: "1" }),
        outside(),
      )
      expect(old.code).toBe(1)
      expect(take()[0]!.argv).not.toContain("--skip-git-repo-check")
      expect((await inbox()).map((m) => m.body.text)).toEqual([
        "worker sg4 finished (exit 1), not a relay agent\n\nstderr (last 1 KB):\nNot inside a trusted directory and --skip-git-repo-check was not specified.",
      ])
    })

    test("in the foreground: piped context, a file with data and a - prompt reach codex exec; an agent shell's pipe still silent after the check gets /dev/null", async () => {
      take()
      const recorded = () => JSON.parse(readFileSync(`${record}.stdin`, "utf8")) as { kind: string; read: string }
      const run = async (prompt: string, input?: string | ReturnType<typeof Bun.file>, shell: { agent?: boolean; delayMs?: number } = {}) => {
        const argv = [process.execPath, "--no-env-file", entry, "spawn", "--fg", "--", "codex", "exec", prompt]
        const base = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|OPENCODE|GROK_|MUSE_|CODEX_THREAD_ID|ANTIGRAVITY_)/.test(key)),
        )
        const options = {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...base, ...env({ CODEX_HOME: codexHome(true), FAKE_STDIN: "1", ...(shell.agent === false ? {} : { CLAUDECODE: "1" }) }) },
        } as const
        if (typeof input === "object") return { code: await Bun.spawn(argv, { ...options, stdin: input }).exited, stdin: recorded() }
        const child = Bun.spawn(argv, { ...options, stdin: "pipe" })
        if (input !== undefined) {
          if (shell.delayMs) await Bun.sleep(shell.delayMs)
          child.stdin.write(input)
          child.stdin.end()
        }
        const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => "timeout" as const)])
        if (code === "timeout") child.kill()
        else if (input === undefined) child.stdin.end()
        return { code, stdin: recorded() }
      }
      expect(await run("go")).toEqual({ code: 0, stdin: { kind: "devnull", read: "" } })
      expect(await run("-", "the prompt from stdin")).toEqual({ code: 0, stdin: { kind: "pipe", read: "the prompt from stdin" } })
      expect(await run("review", "diff --git a/x b/x")).toEqual({ code: 0, stdin: { kind: "pipe", read: "diff --git a/x b/x" } })
      expect(await run("review", "")).toEqual({ code: 0, stdin: { kind: "devnull", read: "" } })
      expect(await run("review", "slow diff", { agent: false, delayMs: 1200 })).toEqual({ code: 0, stdin: { kind: "pipe", read: "slow diff" } })
      expect(await run("review", "slow diff", { delayMs: 1200 })).toEqual({ code: 0, stdin: { kind: "devnull", read: "" } })
      const context = join(root, "context.diff")
      writeFileSync(context, "diff --git a/y b/y")
      expect((await run("review", Bun.file(context))).stdin.kind).toBe("file")
      writeFileSync(context, "")
      expect((await run("review", Bun.file(context))).stdin.kind).toBe("devnull")
      take()
    })
  })

  test("a spawn grant lasts an hour unless --ttl says otherwise", async () => {
    const spawned = await swarm(["spawn", "--fg", "--name", "ttl-w", "--", "claude", "-p", "x"], env({ SCP_SESSION: "lead-session" }))
    expect(spawned.code).toBe(4)
    const db = new Database(join(dir, "relay.db"), { readonly: true })
    try {
      const row = db.query("SELECT created_at, expires_at FROM grants WHERE name = 'ttl-w'").get() as { created_at: number; expires_at: number }
      expect(row.expires_at - row.created_at).toBe(3_600_000)
    } finally {
      db.close()
    }
  })

  test("the harness's exit code and the signals sent to spawn pass through", async () => {
    expect((await swarm(["spawn", "--fg", "--", "sh", "-c", "exit 3"], env())).code).toBe(3)
    const marker = join(root, "trapped")
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        entry,
        "spawn",
        "--fg",
        "--",
        "sh",
        "-c",
        `trap 'echo term > "${marker}"; exit 9' TERM; touch "${marker}.up"; while :; do sleep 0.1; done`,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env() },
      },
    )
    await waitFor(() => existsSync(`${marker}.up`), 10_000, "the harness to start")
    child.kill("SIGTERM")
    expect(await child.exited).toBe(9)
    expect(readFileSync(marker, "utf8")).toBe("term\n")
  })

  test("a signal to a detached runner reaches the harness's whole process group", async () => {
    const pidfile = join(root, "group-sleep.pid")
    const spawned = await swarm(
      ["spawn", "--bg", "--no-push", "--name", "grp1", "--", "sh", "-c", `sleep 300 & echo $! > "${pidfile}.tmp"; mv "${pidfile}.tmp" "${pidfile}"; wait`],
      env(),
    )
    const runner = Number(/pid (\d+)/.exec(spawned.stdout)![1])
    await waitFor(() => existsSync(pidfile), 10_000, "the harness to start")
    const sleeper = Number(readFileSync(pidfile, "utf8"))
    try {
      process.kill(runner, "SIGTERM")
      await waitFor(() => !alive(sleeper), 5_000, "the harness's child to end")
      let handback: { body: { text: string } }[] = []
      for (const deadline = Date.now() + 10_000; !handback.some((m) => m.body.text.startsWith("worker grp1")) && Date.now() < deadline; await Bun.sleep(50))
        handback = await inbox()
    } finally {
      if (alive(sleeper)) process.kill(sleeper, "SIGKILL")
    }
  })

  test("a detached harness does not inherit the runner's handshake fd", async () => {
    const probe = join(root, "fd3")
    await swarm(
      [
        "spawn",
        "--bg",
        "--no-push",
        "--name",
        "fd3w",
        "--",
        "sh",
        "-c",
        `if { true >&3; } 2>/dev/null; then echo open; else echo closed; fi > "${probe}.tmp"; mv "${probe}.tmp" "${probe}"`,
      ],
      env(),
    )
    await waitFor(() => existsSync(probe), 10_000, "the probe")
    expect(readFileSync(probe, "utf8")).toBe("closed\n")
    let handback: { body: { text: string } }[] = []
    for (const deadline = Date.now() + 10_000; !handback.some((m) => m.body.text.startsWith("worker fd3w")) && Date.now() < deadline; await Bun.sleep(50))
      handback = await inbox()
    expect(handback.map((m) => m.body.text)).toContain("worker fd3w finished (exit 0), not a relay agent")
  })

  test("without a terminal, spawn returns at once with the worker's name while the harness runs, holding no pipe of its caller; the handback still arrives", async () => {
    await inbox()
    const began = Date.now()
    const spawned = await swarm(["spawn", "--name", "bg1", "--", "sh", "-c", "sleep 3; echo done"], env())
    expect(Date.now() - began).toBeLessThan(2500)
    expect(spawned).toEqual({
      code: 0,
      stderr: "",
      stdout: expect.stringMatching(/^bg1 started \(pid \d+\) and runs in the background: .*swarm send bg1 <text>\n$/),
    })
    const runner = Number(/pid (\d+)/.exec(spawned.stdout)![1])
    expect(process.kill(runner, 0)).toBe(true)
    let handback: { from: { address: string }; body: { text: string } }[] = []
    for (const deadline = Date.now() + 10_000; !handback.length && Date.now() < deadline; await Bun.sleep(50)) handback = await inbox()
    expect(handback.map((m) => [m.from.address, m.body.text])).toEqual([["me/relay", "worker bg1 finished (exit 0), not a relay agent\n\ndone"]])
    const forced = await swarm(["spawn", "--bg", "--name", "bg2", "--", "sh", "-c", "exit 6"], env())
    expect([forced.code, forced.stdout]).toEqual([0, expect.stringMatching(/^bg2 started/)])
    const both = await swarm(["spawn", "--bg", "--fg", "--", "sh", "-c", "exit 0"], env())
    expect([both.code, both.stderr]).toEqual([125, expect.stringContaining("--bg and --fg: pick one")])
    for (const deadline = Date.now() + 10_000; !handback.some((m) => m.body.text.startsWith("worker bg2")) && Date.now() < deadline; await Bun.sleep(50))
      handback = await inbox()
    expect(handback.map((m) => m.body.text)).toEqual(["worker bg2 finished (exit 6), not a relay agent"])
  })

  describe("a codex exec worker steered after its last step", () => {
    let n = 0
    /** spawns a codex exec worker that waits before each run ends, sending `steers[i]` from the lead while run i + 1 waits */
    const steered = async (steers: string[], extra: Record<string, string> = {}) => {
      const rec = join(root, `steered-${++n}.jsonl`)
      const name = `ws${n}`
      const spawned = swarm(
        ["spawn", "--fg", "--name", name, "--", "codex", "exec", "--skip-git-repo-check", "-s", "workspace-write", "-i", "shot.png", "do it"],
        env({ CODEX_HOME: codexHome(true), FAKE_SEND_TO: "lead", FAKE_RECORD: rec, FAKE_WAIT: "1", FAKE_SWARM: JSON.stringify(SELF), ...extra }),
      )
      let finished = false
      void spawned.then(() => (finished = true))
      for (let run = 1; ; run++) {
        await waitFor(() => existsSync(`${rec}.up${run}`) || finished, 15_000, `run ${run}`)
        if (!existsSync(`${rec}.up${run}`)) break
        if (steers[run - 1]) await lead.request("send", { to: name, body: steers[run - 1] })
        writeFileSync(`${rec}.go${run}`, "")
      }
      const result = await spawned
      const calls = records(rec)
        .filter((r) => r.argv)
        .map((r) => r.argv!)
      const messages = await inbox()
      return {
        result,
        calls,
        messages,
        shims: records(rec)
          .filter((r) => r.shim)
          .map((r) => r.shim!),
        handback: messages.find((m) => m.body.text.startsWith(`worker me/${name}`))!.body.text,
      }
    }

    test("is resumed once with the steer by the session id its hook reported, exec's options kept, and the handback says when it read the steer, not that it went unapplied", async () => {
      await inbox()
      const { result, calls, handback } = await steered(["also update the changelog"], { FAKE_SESSION: "019a-sess-1" })
      expect(result.code).toBe(0)
      expect(calls).toHaveLength(2)
      const argv = calls[1]!
      const exec = argv.indexOf("exec")
      const resume = argv.indexOf("resume")
      expect(argv.slice(resume + 1).filter((word, i, all) => word !== "-c" && all[i - 1] !== "-c")).toEqual([
        "--skip-git-repo-check",
        "019a-sess-1",
        argv.at(-1)!,
      ])
      expect(argv.slice(resume + 1)).toContain('sandbox_mode="workspace-write"')
      expect(argv.slice(resume + 1)).toContain("mcp_servers.scp.enabled=true")
      expect(argv.slice(exec + 1, resume).filter((word, i, all) => word !== "-c" && all[i - 1] !== "-c")).toEqual([])
      expect(argv).not.toContain("shot.png")
      expect(argv).not.toContain("do it")
      expect(argv.at(-1)).toMatch(/<relay-message from="me\/lead" relation="parent" key="[0-9a-z]{6}"[^>]*>\nalso update the changelog\n<\/relay-message>/)
      expect(argv.at(-1)).toEndWith("Your parent sent this after your last step: apply it now, then finish. If you already applied it, just finish.")
      expect(handback).toMatch(/^worker me\/ws1 finished \(exit 0\)\n\nresumed 2\n\nyour steer [0-9a-z]{6} was read at \d\d:\d\d:\d\d$/)
    })

    test("is resumed at most twice; a steer past that is reported not applied, with its text", async () => {
      await inbox()
      const { calls, handback } = await steered(["steer one", "steer two", "steer three"], { FAKE_SESSION: "019a-sess-2" })
      expect(calls).toHaveLength(3)
      expect(calls[1]!.at(-1)).toContain("steer one")
      expect(calls[2]!.at(-1)).toContain("steer two")
      expect(calls[2]!.at(-1)).not.toContain("steer one")
      expect(handback).toMatch(
        /^worker me\/ws2 finished \(exit 0\)\n\nresumed 3\n\n(your steer [0-9a-z]{6} was read at \d\d:\d\d:\d\d\n){2}steer not applied: "steer three" \([0-9a-z]{6}, arrived (under 1|\d+) s before it exited, after its last step\)$/,
      )
    })

    test("without a session id, or when the resume fails, the steer is reported not applied and the first run's exit and output stand", async () => {
      await inbox()
      const none = await steered(["keep it short"])
      expect(none.calls).toHaveLength(1)
      expect(none.handback).toMatch(
        /^worker me\/ws3 finished \(exit 0\)\n\nran 1\n\nsteer not applied: "keep it short" \([0-9a-z]{6}, arrived (under 1|\d+) s before it exited\)$/,
      )
      const failed = await steered(["rename it"], { FAKE_SESSION: "019a-sess-4", FAKE_RESUME_EXIT: "3" })
      expect([failed.result.code, failed.calls.length]).toEqual([0, 2])
      expect(failed.handback).toMatch(/^worker me\/ws4 finished \(exit 0\)\n\nran 1\n\nsteer not applied: "rename it" \(/)
    })

    test("keeps its relay tools when resumed: its shim re-claims the worker's endpoint with the spent grant and sends as it", async () => {
      await inbox()
      const { shims, messages, handback } = await steered(["one more thing"], { FAKE_SESSION: "019a-sess-r", FAKE_RESUME_SEND: "1" })
      expect(shims.map((shim) => shim.result?.isError ?? false)).toEqual([false, false])
      const name = /^worker (me\/ws\d+) /.exec(handback)![1]!
      expect(messages.filter((m) => m.body.text.startsWith("hello")).map((m) => [m.from.address, m.body.text])).toEqual([
        [name, "hello from the worker"],
        [name, "hello from the resumed worker"],
      ])
    })
  })

  test("spawn checks its arguments before it mints a grant", async () => {
    for (const args of [
      ["spawn"],
      ["spawn", "--name", "x"],
      ["spawn", "--name", "x", "--"],
      ["spawn", "--json", "--", "codex"],
      ["spawn", "--json", "codex"],
      ["spawn", "--scope", "wide", "--", "codex"],
      ...["0", "16385", "1.5", "lots"].map((n) => ["spawn", "--handback-bytes", n, "--", "codex"]),
    ]) {
      const result = await swarm(args, env())
      expect([args, result.code]).toEqual([args, 125])
      expect(result.stderr).toContain("swarm --help")
    }
    const missing = await swarm(["spawn", "--", "no-such-harness-xyz"], env())
    expect(missing.code).toBe(127)
    expect(missing.stderr).toContain("no-such-harness-xyz")
    expect(missing.stderr).not.toContain("krt_")
  })

  test("a harness that cannot start fails the spawn only: its grant is revoked and no handback follows, in the foreground or detached", async () => {
    await inbox()
    const db = new Database(join(dir, "relay.db"), { readonly: true })
    const revoked = (name: string) =>
      (db.query("SELECT revoked_at FROM grants WHERE name = ?").get(name) as { revoked_at: number | null } | null)?.revoked_at != null
    try {
      for (const [name, mode] of [
        ["nf-fg", "--fg"],
        ["nf-bg", "--bg"],
      ] as const) {
        const spawned = await swarm(["spawn", mode, "--name", name, "--", "no-such-harness-xyz"], env())
        expect([spawned.code, spawned.stdout]).toEqual([127, ""])
        expect(spawned.stderr).toContain("no-such-harness-xyz: command not found")
        await waitFor(() => revoked(name), 10_000, `${name}'s grant to be revoked`)
      }
      await Bun.sleep(300)
      expect((await inbox()).map((m) => m.body.text)).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe("the spawner's process key", () => {
  test("is spelled as a child's lineage spells its parent, and as processKey spells a pid", async () => {
    const child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" })
    try {
      const key = spawnerKey()
      expect(key).toMatch(/^pid:\d+:[A-Za-z0-9:-]+$/)
      expect(lineage(child.pid, readPsTable())[1]).toBe(key)
      expect(processKey(process.pid)).toBe(key!)
    } finally {
      child.kill()
    }
  })
})

describe("harness argv and environment", () => {
  const grant = { SCP_GRANT: `krt_${"a".repeat(64)}`, SCP_NAME: "w" }

  test("only codex gets overrides, at the top level and after a session subcommand; a path to codex counts", () => {
    const env = spawnEnvironment({ PATH: "/bin", SCP_DIR: "/r" }, grant)
    for (const command of [["claude", "x"], ["opencode", "run", "x"], ["aider"], ["env", "A=1", "claude", "x"], ["timeout", "60", "grok", "x"]])
      expect(harnessArgv(command, env, SELF, () => undefined)).toEqual(command)
    const o = [
      "-c",
      'mcp_servers.scp.env_vars=["SCP_GRANT", "SCP_NAME", "SCP_DIR"]',
      "-c",
      "mcp_servers.scp.enabled=true",
      "-c",
      'mcp_servers.scp.default_tools_approval_mode="approve"',
    ]
    const argv = (...args: string[]) => harnessArgv(["/opt/bin/codex", ...args], env, SELF, () => ({ command: "swarm" }))
    expect(argv("exec", "x")).toEqual(["/opt/bin/codex", ...o, "exec", ...o, "x"])
    expect(argv("-m", "m", "-c", "a=1", "e", "-c", "b=2", "x")).toEqual(["/opt/bin/codex", ...o, "-m", "m", "-c", "a=1", "e", ...o, "-c", "b=2", "x"])
    expect(argv("exec", "resume", "--last")).toEqual(["/opt/bin/codex", ...o, "exec", ...o, "resume", ...o, "--last"])
    expect(argv("review")).toEqual(["/opt/bin/codex", ...o, "review", ...o])
    expect(argv("-m", "m", "fix the exec bug")).toEqual(["/opt/bin/codex", ...o, "-m", "m", "fix the exec bug"])
    expect(argv()).toEqual(["/opt/bin/codex", ...o])
  })

  test("codex exec outside a git repo gets --skip-git-repo-check after exec, or after exec resume, when its codex has the flag; never twice, in a repo, for review or interactive", () => {
    const env = spawnEnvironment({ PATH: "/bin" }, grant)
    const root = mkdtempSync(join(process.env.HOME!, "git-"))
    const outside = join(root, "plain")
    const repo = join(root, "repo")
    const linked = join(root, "linked")
    for (const dir of [outside, join(repo, ".git"), join(repo, "a", "b"), linked]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(linked, ".git"), "gitdir: /elsewhere\n")
    const probed: string[] = []
    const probe = (takes: boolean) => (program: string) => {
      probed.push(program)
      return takes
    }
    const argv = (cwd: string, ...args: string[]) =>
      harnessArgv(["codex", ...args], env, SELF, () => ({ command: "swarm" }), cwd, probe(true)).filter((arg, i, all) => arg !== "-c" && all[i - 1] !== "-c")
    const skip = "--skip-git-repo-check"
    expect(argv(outside, "exec", "x")).toEqual(["codex", "exec", skip, "x"])
    expect(argv(outside, "-m", "m", "e", "--json", "x")).toEqual(["codex", "-m", "m", "e", skip, "--json", "x"])
    expect(argv(outside, "exec", "resume", "s1", "x")).toEqual(["codex", "exec", "resume", skip, "s1", "x"])
    expect(argv(outside, "exec", "--json", "resume", "--last", "x")).toEqual(["codex", "exec", "--json", "resume", skip, "--last", "x"])
    expect(probed).toEqual(["codex", "codex", "codex", "codex"])
    probed.length = 0
    for (const args of [["exec", skip, "x"], ["exec", "resume", skip, "s1", "x"], ["exec", "review"], ["review"], ["x"], []])
      expect(argv(outside, ...args)).toEqual(["codex", ...args])
    expect(argv(outside, "exec", "--", skip)).toEqual(["codex", "exec", skip, "--", skip])
    probed.length = 0
    for (const cwd of [repo, join(repo, "a", "b"), linked]) expect(argv(cwd, "exec", "x")).toEqual(["codex", "exec", "x"])
    expect(argv(outside, "-C", repo, "exec", "x")).toEqual(["codex", "-C", repo, "exec", "x"])
    expect(argv(repo, "exec", "--cd", outside, "x")).toEqual(["codex", "exec", skip, "--cd", outside, "x"])
    expect(probed).toEqual(["codex"])
    expect(
      harnessArgv(
        ["codex", "exec", "x"],
        env,
        SELF,
        () => ({ command: "swarm" }),
        outside,
        () => false,
      ),
    ).not.toContain(skip)
    expect(harnessArgv(["env", "A=1", "/opt/codex", "exec", "x"], env, SELF, () => ({ command: "swarm" }), outside, probe(true)).slice(0, 3)).toEqual([
      "env",
      "A=1",
      "/opt/codex",
    ])
    expect(probed.at(-1)).toBe("/opt/codex")
    expect(harnessArgv(["claude", "-p", "x"], env, SELF, () => undefined, outside, probe(true))).toEqual(["claude", "-p", "x", "--allowedTools", ...MESSAGING])
  })

  test("only codex exec with its prompt in argv runs on a closed stdin: a - prompt, no prompt or interactive codex keep theirs", () => {
    for (const command of [
      ["codex", "exec", "x"],
      ["codex", "-m", "m", "e", "--json", "x"],
      ["codex", "exec", "--", "x"],
      ["env", "A=1", "codex", "exec", "x"],
      ["codex", "exec", "resume", "s1", "x"],
      ["codex", "exec", "review", "look"],
      ["codex", "exec", "review"],
    ])
      expect([command, closedStdin(command)]).toEqual([command, true])
    for (const command of [
      ["codex", "exec", "-"],
      ["codex", "exec"],
      ["codex", "exec", "--json"],
      ["codex", "exec", "--", "-"],
      ["codex", "exec", "resume", "s1", "-"],
      ["codex", "exec", "review", "-"],
      ["codex"],
      ["codex", "fix it"],
      ["codex", "resume"],
      ["claude", "-p", "x"],
      ["sh", "-c", "codex exec x"],
    ])
      expect([command, closedStdin(command)]).toEqual([command, false])
  })

  test("codex behind env, VAR=value words, timeout, nohup or nice gets its overrides after the codex word, the wrappers kept", () => {
    const env = spawnEnvironment({ PATH: "/bin", SCP_DIR: "/r" }, grant)
    const o = harnessArgv(["codex"], env, SELF, () => ({ command: "swarm" })).slice(1)
    const argv = (...command: string[]) => harnessArgv(command, env, SELF, () => ({ command: "swarm" }))
    expect(argv("/usr/bin/env", "codex", "exec", "x")).toEqual(["/usr/bin/env", "codex", ...o, "exec", ...o, "x"])
    expect(argv("env", "-i", "-u", "FOO", "--unset=BAR", "A=1", "codex", "exec", "x")).toEqual([
      "env",
      "-i",
      "-u",
      "FOO",
      "--unset=BAR",
      "A=1",
      "codex",
      ...o,
      "exec",
      ...o,
      "x",
    ])
    expect(argv("A=1", "B=2", "codex")).toEqual(["A=1", "B=2", "codex", ...o])
    expect(argv("timeout", "-s", "KILL", "--kill-after=5", "--foreground", "600", "codex", "exec", "x")).toEqual([
      "timeout",
      "-s",
      "KILL",
      "--kill-after=5",
      "--foreground",
      "600",
      "codex",
      ...o,
      "exec",
      ...o,
      "x",
    ])
    expect(argv("nohup", "nice", "-n", "10", "codex", "review")).toEqual(["nohup", "nice", "-n", "10", "codex", ...o, "review", ...o])
    expect(argv("nice", "codex")).toEqual(["nice", "codex", ...o])
    expect(argv("nohup", "timeout", "60", "env", "A=1", "/opt/bin/codex", "e", "x")).toEqual([
      "nohup",
      "timeout",
      "60",
      "env",
      "A=1",
      "/opt/bin/codex",
      ...o,
      "e",
      ...o,
      "x",
    ])
    expect(argv("env", "-u", "FOO")).toEqual(["env", "-u", "FOO"])
  })

  test("codex overrides keep a mount's own env_vars and approval mode, and every value parses as TOML", () => {
    const env = spawnEnvironment({ XDG_STATE_HOME: "/s" }, grant, "role=w")
    const overrides = codexOverrides(
      env,
      { command: "swarm", env_vars: ["OTHER", "SCP_NAME", { name: "X", source: "local" }], default_tools_approval_mode: "prompt" },
      SELF,
    )
    const parsed = Object.fromEntries(
      overrides.filter((_, i) => i % 2).map((o) => [o.slice(0, o.indexOf("=")), (Bun.TOML.parse(`v = ${o.slice(o.indexOf("=") + 1)}`) as { v: unknown }).v]),
    )
    expect(parsed).toEqual({
      "mcp_servers.scp.env_vars": ["OTHER", "SCP_NAME", { name: "X", source: "local" }, "SCP_GRANT", "SCP_LABELS", "XDG_STATE_HOME"],
      "mcp_servers.scp.enabled": true,
    })
    const bare = codexOverrides(env, undefined, ['/odd "dir"/bun\u007f', "main.js"])
    expect((Bun.TOML.parse(`v = ${bare[1]!.slice(bare[1]!.indexOf("=") + 1)}`) as { v: string }).v).toBe('/odd "dir"/bun\u007f')
  })

  test("claude -p and grok headless get the relay tools allowed at the end, unless the user passed a permission flag", () => {
    const env = spawnEnvironment({ PATH: "/bin" }, grant)
    const argv = (...command: string[]) => harnessArgv(command, env, SELF, () => undefined)
    const allow = ["--allowedTools", ...MESSAGING]
    expect(argv("claude", "-p", "fix it")).toEqual(["claude", "-p", "fix it", ...allow])
    expect(argv("/opt/bin/claude", "--model", "m", "--print", "fix it")).toEqual(["/opt/bin/claude", "--model", "m", "--print", "fix it", ...allow])
    expect(argv("claude", "-p", "--", "-fix it")).toEqual(["claude", "-p", ...allow, "--", "-fix it"])
    expect(argv("env", "A=1", "timeout", "60", "claude", "-p", "x")).toEqual(["env", "A=1", "timeout", "60", "claude", "-p", "x", ...allow])
    for (const own of [
      ["--allowedTools", "Bash"],
      ["--allowed-tools", "Edit"],
      ["--allowedTools=Bash"],
      ["--allowed-tools=Edit"],
      ["--dangerously-skip-permissions"],
      ["--permission-mode", "plan"],
      ["--permission-mode=acceptEdits"],
    ]) {
      expect(argv("claude", "-p", ...own, "x")).toEqual(["claude", "-p", ...own, "x"])
    }
    expect(argv("claude", "fix it")).toEqual(["claude", "fix it"])
    expect(argv("claude", "--", "-p")).toEqual(["claude", "--", "-p"])
    const grok = MESSAGING.flatMap((tool) => ["--allow", tool])
    expect(argv("grok", "-p", "fix it")).toEqual(["grok", "-p", "fix it", ...grok])
    expect(argv("nohup", "grok", "--single=fix it")).toEqual(["nohup", "grok", "--single=fix it", ...grok])
    expect(argv("grok", "--prompt-file", "/p.md")).toEqual(["grok", "--prompt-file", "/p.md", ...grok])
    for (const own of [["--allow", "Bash"], ["--allowedTools", "Read"], ["--allowed-tools=Read"], ["--always-approve"], ["--permission-mode", "dontAsk"]]) {
      expect(argv("grok", "-p", "x", ...own)).toEqual(["grok", "-p", "x", ...own])
    }
    expect(argv("grok", "fix it")).toEqual(["grok", "fix it"])
    for (const command of [
      ["agy", "-p", "x"],
      ["opencode", "run", "x"],
    ])
      expect(argv(...command)).toEqual(command)
  })

  test("muse runs with --contributor-mode off: after exec, else right after the program; an explicit off or on is kept, any other mode refused", () => {
    const env = spawnEnvironment({ PATH: "/bin" }, grant)
    const argv = (...command: string[]) => harnessArgv(command, env, SELF, () => undefined)
    expect(argv("muse", "exec", "x")).toEqual(["muse", "exec", "--contributor-mode", "off", "x"])
    expect(argv("muse", "--model", "m", "exec", "--json", "x")).toEqual(["muse", "--model", "m", "exec", "--contributor-mode", "off", "--json", "x"])
    expect(argv("nohup", "/opt/bin/muse")).toEqual(["nohup", "/opt/bin/muse", "--contributor-mode", "off"])
    expect(argv("muse", "resume", "--last")).toEqual(["muse", "--contributor-mode", "off", "resume", "--last"])
    for (const own of [["--contributor-mode", "off"], ["--contributor-mode=off"], ["--contributor-mode", "on"], ["--contributor-mode=on"]])
      expect(argv("muse", "exec", ...own, "x")).toEqual(["muse", "exec", ...own, "x"])
    expect(contributorRefusal(["muse", "exec", "x"])).toBeNull()
    expect(contributorRefusal(["muse", "--contributor-mode", "off", "exec", "x"])).toBeNull()
    expect(contributorRefusal(["muse", "--contributor-mode", "on", "exec", "x"])).toBeNull()
    expect(contributorRefusal(["muse", "exec", "--contributor-mode=on", "x"])).toBeNull()
    for (const command of [
      ["muse", "--contributor-mode", "maybe", "exec", "x"],
      ["env", "A=1", "muse", "--contributor-mode"],
    ]) {
      expect(contributorRefusal(command)).toContain("muse runs with --contributor-mode off or on")
    }
    expect(contributorRefusal(["claude", "--contributor-mode", "on"])).toBeNull()
  })

  test("muse's mode lands after exec past -w with or without its mode and --flag=value words; a -c contributor setting other than off or on is refused", () => {
    const env = spawnEnvironment({ PATH: "/bin" }, grant)
    const argv = (...command: string[]) => harnessArgv(command, env, SELF, () => undefined)
    expect(argv("muse", "-w", "create", "exec", "x")).toEqual(["muse", "-w", "create", "exec", "--contributor-mode", "off", "x"])
    expect(argv("muse", "-w", "exec", "x")).toEqual(["muse", "-w", "exec", "--contributor-mode", "off", "x"])
    expect(argv("muse", "--worktree=existing", "--model=m", "exec", "x")).toEqual([
      "muse",
      "--worktree=existing",
      "--model=m",
      "exec",
      "--contributor-mode",
      "off",
      "x",
    ])
    expect(argv("muse", "-c", 'model="m"', "exec", "x")).toEqual(["muse", "-c", 'model="m"', "exec", "--contributor-mode", "off", "x"])
    expect(argv("muse", "-w", "create", "say hi")).toEqual(["muse", "--contributor-mode", "off", "-w", "create", "say hi"])
    for (const off of [["-c", "contributor_mode_enabled=false"], ["--config", 'contributor_mode="off"'], ["--config=contributor_mode_enabled=false"]]) {
      expect(contributorRefusal(["muse", "exec", ...off, "x"])).toBeNull()
      expect(argv("muse", "exec", ...off, "x")).toEqual(["muse", "exec", ...off, "x"])
    }
    for (const on of [["-c", "contributor_mode_enabled=true"], ["--config", 'contributor_mode="on"'], ["-c=contributor_mode_enabled=true"]]) {
      expect(contributorRefusal(["muse", ...on, "x"])).toBeNull()
      expect(argv("muse", ...on, "x")).toEqual(["muse", ...on, "x"])
    }
    for (const odd of [
      ["exec", "-c", "Contributor_Mode_Enabled=1"],
      ["--config", 'contributor_mode="maybe"'],
    ]) {
      expect(contributorRefusal(["muse", ...odd, "x"])).toContain("muse runs with --contributor-mode off or on")
    }
    expect(contributorRefusal(["muse", "-c", 'model="m"', "exec", "x"])).toBeNull()
  })

  test("a worker's default name is <harness>-<5 random characters>, a valid handle; its default title the prompt's first line", () => {
    expect(workerName(["/opt/bin/codex", "exec", "x"], () => "k3x9a")).toBe("codex-k3x9a")
    expect(workerName(["env", "A=1", "timeout", "60", "claude", "-p", "x"])).toMatch(/^claude-[a-z0-9]{5}$/)
    expect(workerName(["/x/My Tool!"], () => "ab12c")).toBe("my-tool-ab12c")
    expect(workerName(["..."], () => "ab12c")).toBe("worker-ab12c")
    expect(workerName([`${"a".repeat(80)}`], () => "ab12c")).toHaveLength(63)
    expect(new Set(Array.from({ length: 20 }, () => workerName(["codex"]))).size).toBeGreaterThan(1)
    expect(spawnTitle(["claude", "-p", "\n  Fix the   parser\nthen the tests"])).toBe("Fix the parser")
    expect(spawnTitle(["codex", "exec", "x".repeat(100)])).toBe("x".repeat(64))
    expect(spawnTitle(["codex", "exec", `${"x".repeat(63)}\u{1f600}`])).toBe("x".repeat(63))
    expect(spawnTitle(["codex", "exec", `use ghp_${"A1b2C3d4".repeat(5)} now`])).toBe("use [redacted github token] now")
    const straddling = spawnTitle(["codex", "exec", `${"x".repeat(56)} ghp_${"A1b2C3d4".repeat(5)}`])!
    expect(straddling).not.toContain("ghp_")
    expect(straddling.length).toBeLessThanOrEqual(64)
    expect(spawnTitle(["codex", "exec", "\n \n"])).toBeUndefined()
    expect(spawnTitle(["sh", "-c", "exit 0"])).toBeUndefined()
  })

  test("headless agy without swarm setup's permission rules gets a note naming setup; with them, or interactive, none", () => {
    const home = mkdtempSync(join(process.env.HOME!, "agy-"))
    const env = { HOME: home }
    const file = join(home, ".gemini", "antigravity-cli", "settings.json")
    expect(agyNote(["agy", "-p", "x"], env)).toContain("swarm setup")
    expect(agyNote(["timeout", "60", "agy", "--print", "x"], env)).toContain("swarm setup")
    expect(agyNote(["agy", "x"], env)).toBeNull()
    expect(agyNote(["agy", "-p", "--dangerously-skip-permissions", "x"], env)).toBeNull()
    expect(agyNote(["claude", "-p", "x"], env)).toBeNull()
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true })
    writeFileSync(file, "{ not json")
    expect(agyNote(["agy", "-p", "x"], env)).toContain("swarm setup")
    writeFileSync(file, JSON.stringify({ permissions: { allow: ["mcp(scp/relay_send)"] } }))
    expect(agyNote(["agy", "-p", "x"], env)).toContain("swarm setup")
    writeFileSync(file, JSON.stringify({ permissions: { allow: agyRules() } }))
    expect(agyNote(["agy", "-p", "x"], env)).toBeNull()
  })

  test("the spawn's prompt: claude -p's last operand past flag values, codex exec's first operand; none from stdin, resume or interactive runs", () => {
    expect(spawnPrompt(["claude", "-p", "fix it", "--model", "haiku"])).toBe("fix it")
    expect(spawnPrompt(["env", "A=1", "claude", "--print", "--allowedTools", "Bash", "do x"])).toBe("do x")
    expect(spawnPrompt(["claude", "-p", "--", "after dashes"])).toBe("after dashes")
    expect(spawnPrompt(["claude", "fix it"])).toBeUndefined()
    expect(spawnPrompt(["codex", "-c", "a=1", "exec", "-m", "gpt", "--json", "go now"])).toBe("go now")
    expect(spawnPrompt(["codex", "e", "-o", "/tmp/x", "go"])).toBe("go")
    expect(spawnPrompt(["codex", "exec", "-"])).toBeUndefined()
    expect(spawnPrompt(["codex", "exec", "resume", "--last"])).toBeUndefined()
    expect(spawnPrompt(["codex", "go"])).toBeUndefined()
    expect(spawnPrompt(["opencode", "run", "go"])).toBeUndefined()
  })

  test("the steer note goes onto the prompt's own word: claude -p's last operand, codex exec's first; nothing without a prompt or a valid steer", () => {
    const steer = { key: "k3y9ab", parent: "me/lead" }
    const note = steerNote("me/lead", "k3y9ab")
    expect(steerArgv(["claude", "-p", "fix it", "--model", "haiku"], steer)).toEqual(["claude", "-p", `fix it${note}`, "--model", "haiku"])
    expect(steerArgv(["claude", "-p", "--", "after", "dashes"], steer)).toEqual(["claude", "-p", "--", "after", `dashes${note}`])
    expect(steerArgv(["codex", "-c", "a=1", "exec", "-m", "gpt", "go now", "extra"], steer)).toEqual([
      "codex",
      "-c",
      "a=1",
      "exec",
      "-m",
      "gpt",
      `go now${note}`,
      "extra",
    ])
    expect(steerArgv(["env", "A=1", "codex", "exec", "--", "go"], steer)).toEqual(["env", "A=1", "codex", "exec", "--", `go${note}`])
    for (const command of [
      ["claude", "fix it"],
      ["claude", "-p"],
      ["codex", "exec", "-"],
      ["codex", "exec", "resume", "--last"],
      ["opencode", "run", "x"],
    ])
      expect(steerArgv(command, steer)).toEqual(command)
    expect(steerArgv(["claude", "-p", "fix it"], undefined)).toEqual(["claude", "-p", "fix it"])
    expect(steerArgv(["claude", "-p", "fix it"], { key: "BAD KEY", parent: "me/lead" })).toEqual(["claude", "-p", "fix it"])
    expect(spawnPrompt(steerArgv(["claude", "-p", "fix it"], steer))).toBe(`fix it${note}`)
  })

  test("a codex exec worker resumes as exec resume <session> <prompt>, wrappers and options kept where resume takes them; nothing else resumes", () => {
    expect(
      resumeArgv(
        ["timeout", "600", "codex", "-m", "m1", "exec", "--json", "--sandbox=read-only", "-C", "/w", "--worktree", "-o", "out.txt", "go", "--color", "never"],
        "s-1",
        "steer",
      ),
    ).toEqual([
      "timeout",
      "600",
      "codex",
      "-m",
      "m1",
      "exec",
      "-C",
      "/w",
      "--color",
      "never",
      "resume",
      "--json",
      "-c",
      'sandbox_mode="read-only"',
      "-o",
      "out.txt",
      "s-1",
      "steer",
    ])
    expect(resumeArgv(["codex", "exec", "--", "go"], "s-1", "steer")).toEqual(["codex", "exec", "resume", "s-1", "steer"])
    for (const command of [
      ["codex", "exec", "--ephemeral", "go"],
      ["codex", "exec", "-"],
      ["codex", "exec", "resume", "--last", "go"],
      ["codex", "go"],
      ["claude", "-p", "go"],
    ])
      expect(resumeArgv(command, "s-1", "steer")).toBeUndefined()
    expect(codexOverrideAt(["exec", "--skip-git-repo-check", "-m", "m1", "resume", "s-1", "p"])).toEqual([0, 1, 5])
  })

  test("the child environment drops the spawner's identity and never names the grant in argv", () => {
    const env = spawnEnvironment(
      { SCP_NAME: "lead", SCP_SESSION: "s", SCP_GRANT: "old", SCP_PARENT: "p", SCP_HARNESS: "cli", SCP_LABELS: "role=lead", HOME: "/h" },
      { SCP_GRANT: grant.SCP_GRANT },
    )
    expect(env).toEqual({ HOME: "/h", SCP_LABELS: "role=lead", SCP_GRANT: grant.SCP_GRANT })
    expect(harnessArgv(["codex"], env, SELF, () => undefined).join(" ")).not.toContain("krt_")
  })
})

describe("harness output", () => {
  test("only the messaging tools are allowed, never peek settings, groups or rules", () => {
    expect(MESSAGING.every((tool) => tool.startsWith("mcp__scp__relay_"))).toBe(true)
    for (const tool of ["relay_set_peek", "relay_peek", "relay_group", "relay_rules"]) expect(MESSAGING).not.toContain(`mcp__scp__${tool}`)
  })

  test("a handback carries the whole output up to its cap, its last bytes past it", () => {
    const run = { tail: new TextEncoder().encode(`${"line\n".repeat(2000)}final answer`), cut: false }
    expect(harnessOutput(run)).toBe(`${"line\n".repeat(2000)}final answer`)
    const brief = harnessOutput(run, 64)
    expect(brief).toMatch(/^\[earlier output cut\]\n(line\n)+final answer$/)
    expect(new TextEncoder().encode(brief).length).toBeLessThanOrEqual(64)
    const long = { tail: new TextEncoder().encode("x".repeat(LIMITS.handbackBytes + 10)), cut: false }
    expect(new TextEncoder().encode(harnessOutput(long)).length).toBeLessThanOrEqual(LIMITS.handbackBytes)
  })

  test("a private key cut at the front of the tail leaves nothing of its body", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"
    const tail = new TextEncoder().encode(`${body}\n${body}\n-----END PRIVATE KEY-----\nafter`)
    expect(harnessOutput({ tail, cut: true })).toBe("[earlier output cut]\nafter")
  })

  const sink = () => {
    const out = new PassThrough()
    const chunks: Buffer[] = []
    out.on("data", (chunk: Buffer) => chunks.push(chunk))
    return { out, text: () => Buffer.concat(chunks).toString("utf8") }
  }

  test("with stdout not a terminal, the output is teed unchanged and its last 16 KiB kept", async () => {
    const { out, text } = sink()
    const script = `printf 'head\\n'; i=0; while [ $i -lt 300 ]; do printf '%099d\\n' $i; i=$((i+1)); done; printf '\\033[1mlast\\033[0m line\\n'; exit 3`
    const run = await runHarness(["sh", "-c", script], { PATH: process.env.PATH! }, { capture: true, out })
    expect(run.code).toBe(3)
    expect(text().startsWith("head\n")).toBe(true)
    expect(text().endsWith("\u001b[1mlast\u001b[0m line\n")).toBe(true)
    expect(text().length).toBe(5 + 300 * 100 + 18)
    expect(run.cut).toBe(true)
    expect(run.tail.length).toBe(16 * 1024)
    const output = harnessOutput(run)
    expect(output.startsWith(`[earlier output cut]\n${"0".repeat(10)}`)).toBe(true)
    expect(output.endsWith(`\n${"299".padStart(99, "0")}\nlast line`)).toBe(true)
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(LIMITS.handbackBytes)
  })

  test("a short output comes back whole, cleaned of escapes and carriage-return redraws; on a terminal nothing is captured", async () => {
    const { out, text } = sink()
    const run = await runHarness(
      ["sh", "-c", "printf '\\033]0;title\\007\\033[2Kdone 50%%\\rdone 100%%\\r\\n  ok\\n\\n'"],
      { PATH: process.env.PATH! },
      { capture: true, out },
    )
    expect([run.code, run.cut]).toEqual([0, false])
    expect(text()).toBe("\u001b]0;title\u0007\u001b[2Kdone 50%\rdone 100%\r\n  ok\n\n")
    expect(harnessOutput(run)).toBe("done 100%\n  ok")
    const plain = sink()
    const inherited = await runHarness(["sh", "-c", "exit 4"], { PATH: process.env.PATH! }, { capture: false, out: plain.out })
    expect([inherited.code, inherited.tail.length, plain.text()]).toEqual([4, 0, ""])
    expect((await runHarness(["no-such-harness-xyz"], { PATH: process.env.PATH! }, { capture: true, out: sink().out })).code).toBe(127)
  })

  test("stderr is teed and its tail kept when stderr is not a terminal; it hands back cleaned, its last 1 KB from a line start behind a marker", async () => {
    const out = sink()
    const err = sink()
    const run = await runHarness(
      ["sh", "-c", "echo out; i=0; while [ $i -lt 2000 ]; do printf 'line %04d\\n' $i >&2; i=$((i+1)); done; printf '\\033[1mbad\\033[0m end\\n' >&2; exit 1"],
      { PATH: process.env.PATH! },
      { capture: true, out: out.out, err: err.out },
    )
    expect([run.code, out.text(), err.text().length]).toEqual([1, "out\n", 2000 * 10 + 16])
    expect(run.errCut).toBe(true)
    const tail = stderrOutput(run)
    expect(tail.startsWith("[earlier stderr cut]\nline ")).toBe(true)
    expect(tail.endsWith("line 1999\nbad end")).toBe(true)
    expect(new TextEncoder().encode(tail.slice("[earlier stderr cut]\n".length)).length).toBeLessThanOrEqual(1024)
    const short = await runHarness(["sh", "-c", "echo 'only this' >&2"], { PATH: process.env.PATH! }, { capture: true, out: sink().out, err: sink().out })
    expect(stderrOutput(short)).toBe("only this")
    const wide = stderrOutput({ err: new TextEncoder().encode(`${"\u00e9".repeat(1000)}\n`), errCut: false })
    expect(wide.startsWith("[earlier stderr cut]\n\u00e9")).toBe(true)
    expect(new TextEncoder().encode(wide).length).toBeLessThanOrEqual(1024 + 21)
    const inherited = await runHarness(["sh", "-c", "echo e >&2"], { PATH: process.env.PATH! }, { capture: true, out: sink().out, captureErr: false })
    expect(inherited.err.length).toBe(0)
  })

  test("a cut tail drops its partial first line and splits no character; credentials are redacted", () => {
    const tail = new TextEncoder().encode(`${"é".repeat(10)}\npartial ghp_${"A1b2C3d4".repeat(5)}\n${"ü".repeat(9000)}`)
    const output = harnessOutput({ tail: tail.subarray(1), cut: true })
    expect(output).not.toContain("\ufffd")
    expect(output).not.toContain("é")
    expect(output.startsWith("[earlier output cut]\nü")).toBe(true)
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(LIMITS.handbackBytes)
    const short = harnessOutput({ tail: new TextEncoder().encode(`x\nkey ghp_${"A1b2C3d4".repeat(5)}`), cut: true })
    expect(short).toBe("[earlier output cut]\nkey [redacted github token]")
  })
})

const BULLETS = "- one: the first point\n- two: the second point\n- three: the third point"

/** a line of `chars` characters: prose with markup, `<`, `&` and non-ASCII */
const reportLine = (n: number, chars: number) => {
  const words = `- ${n}: the parser keeps <XlsxEditor> & a < b && c > d; but it isn't the prompt, ç'est la vie, see src/relay-spawn.ts:42 `
  return words
    .repeat(Math.ceil(chars / words.length))
    .slice(0, chars)
    .trimEnd()
}

/** a 4 KB report whose bullets run past 200, 500 and 1000 characters */
const REPORT = [
  "Summary:",
  reportLine(1, 80),
  reportLine(2, 250),
  reportLine(3, 120),
  reportLine(4, 600),
  reportLine(5, 60),
  reportLine(6, 1200),
  reportLine(7, 300),
  reportLine(8, 900),
  "",
  "Done.",
].join("\n")

/** a Claude Code transcript: an earlier task, then the spawn's prompt, bullets in one turn, a tool round trip, hook context and "Done." */
const TRANSCRIPT = [
  { type: "summary", summary: "x" },
  { type: "user", message: { role: "user", content: "an earlier task" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "the earlier answer" }] } },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "write three bullets, run ls, then say Done." }] } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: BULLETS },
      ],
    },
  },
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] }, toolUseResult: { stdout: "a.txt" } },
  { type: "attachment", attachment: { type: "hook_additional_context", content: ["swarm: 1 new message"] } },
  { type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback:\nkeep going" } },
  { type: "user", message: { role: "user", content: "Stop hook feedback:\n<relay-message>also lint</relay-message>" } },
  { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "a subagent's chatter" }] } },
  "not json {",
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "  " },
        { type: "text", text: "Done." },
      ],
    },
  },
]
  .map((line) => (typeof line === "string" ? line : JSON.stringify({ ...line, sessionId: "0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d" })))
  .join("\n")

describe("a Claude Code worker's transcript", () => {
  const root = mkdtempSync(join(process.env.HOME!, "transcript-"))
  const session = "0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"
  const file = (name: string, text = TRANSCRIPT) => {
    const dir = mkdtempSync(join(root, "p-"))
    writeFileSync(join(dir, name), text)
    return join(dir, name)
  }

  test("holds every assistant text since the last prompt, in order: not tool results, hook context, a subagent's turns or malformed lines", () => {
    expect(transcriptReplies(file(`${session}.jsonl`), session, root)).toEqual([BULLETS, "Done."])
  })

  test("is read only as a regular file named <session>.jsonl at an absolute path, never through a link, and only its last bytes", () => {
    const good = file(`${session}.jsonl`)
    expect(transcriptReplies(good, "another-session", root)).toEqual([])
    expect(transcriptReplies(file(`${session}.json`), session, root)).toEqual([])
    expect(transcriptReplies(join(root, "missing", `${session}.jsonl`), session, root)).toEqual([])
    const link = join(mkdtempSync(join(root, "l-")), `${session}.jsonl`)
    symlinkSync(good, link)
    expect(transcriptReplies(link, session, root)).toEqual([])
    const dir = join(mkdtempSync(join(root, "d-")), `${session}.jsonl`)
    mkdirSync(dir)
    expect(transcriptReplies(dir, session, root)).toEqual([])
    const cwd = process.cwd()
    try {
      process.chdir(join(good, ".."))
      expect(transcriptReplies(`${session}.jsonl`, session, root)).toEqual([])
    } finally {
      process.chdir(cwd)
    }
    const big = file(
      `${session}.jsonl`,
      `${JSON.stringify({ type: "assistant", sessionId: session, message: { content: [{ type: "text", text: "x".repeat(200) }] } })}\n${TRANSCRIPT}`,
    )
    expect(transcriptReplies(big, session, root, new TextEncoder().encode(TRANSCRIPT).length + 50)).toEqual([BULLETS, "Done."])
  })

  test("is refused outside the transcript directory, and another session's entries in it are left out", () => {
    const good = file(`${session}.jsonl`)
    expect(transcriptReplies(good, session, mkdtempSync(join(root, "other-")))).toEqual([])
    const projects = mkdtempSync(join(root, "t-"))
    symlinkSync(join(good, ".."), join(projects, "proj"))
    expect(transcriptReplies(join(projects, "proj", `${session}.jsonl`), session, projects)).toEqual([])
    const mixed = file(`${session}.jsonl`, TRANSCRIPT.replaceAll(`"sessionId":"${session}"`, '"sessionId":"someone-else"'))
    expect(transcriptReplies(mixed, session, root)).toEqual([])
  })

  test("as a handback: cleaned and redacted, the newest whole within the cap, earlier turns dropped from the front behind a marker", () => {
    const secret = `ghp_${"A1b2C3d4".repeat(5)}`
    expect(repliesOutput(["- one\n- two", `\u001b[1mtoken ${secret}\u001b[0m`, "Done."])).toBe("- one\n- two\n\ntoken [redacted github token]\n\nDone.")
    const turns = ["a".repeat(9000), "b".repeat(9000), "c".repeat(100), "Done."]
    const capped = repliesOutput(turns)
    expect(capped).toBe(`[earlier output cut]\n\n${"b".repeat(9000)}\n\n${"c".repeat(100)}\n\nDone.`)
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(LIMITS.handbackBytes)
    expect(repliesOutput(turns, 40)).toBe("[earlier output cut]\n\nDone.")
    expect(repliesOutput(["- a: one\n- b: two", "Steer applied.\n\n- a: one\n- b: two\n\nSTEER-x"])).toBe("Steer applied.\n\n- a: one\n- b: two\n\nSTEER-x")
    expect(repliesOutput(["Reading the files now.", "- a: one\n- b: two"])).toBe("Reading the files now.\n\n- a: one\n- b: two")
    const huge = repliesOutput(["first", `${"é".repeat(9000)}end`])
    expect(huge.startsWith("[earlier output cut]\né")).toBe(true)
    expect(huge.endsWith("éend")).toBe(true)
    expect(new TextEncoder().encode(huge).length).toBeLessThanOrEqual(LIMITS.handbackBytes)
    expect(new TextEncoder().encode(repliesOutput(["x".repeat(100)], 10)).length).toBeLessThanOrEqual(10)
    expect(repliesOutput([" ", "\u001b[0m"])).toBe("")
  })

  test("as a handback: a 4 KB report with long lines stays whole, a carriage return is a line break, and a dropped reply is always marked", () => {
    expect(new TextEncoder().encode(REPORT).length).toBeGreaterThan(3500)
    expect(repliesOutput(["working on it", REPORT])).toBe(`working on it\n\n${REPORT}`)
    expect(repliesOutput(["50%\r100%\r\ndone"])).toBe("50%\n100%\ndone")
    expect(repliesOutput(["a".repeat(100), "b".repeat(30)], 40)).toBe(`[earlier output cut]\n${"b".repeat(19)}`)
  })

  test("a reply before the transcript's read window is not dropped silently: the replies start with the cut marker", () => {
    const lines = [
      { type: "user", message: { role: "user", content: "the task" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "early" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "late" }] } },
    ].map((l) => JSON.stringify({ ...l, sessionId: session }))
    const path = file(`${session}.jsonl`, lines.join("\n"))
    expect(transcriptReplies(path, session, root)).toEqual(["early", "late"])
    expect(transcriptReplies(path, session, root, new TextEncoder().encode(lines[2]!).length + 5)).toEqual(["[earlier output cut]", "late"])
    expect(repliesOutput(transcriptReplies(path, session, root, new TextEncoder().encode(lines[2]!).length + 5))).toBe("[earlier output cut]\n\nlate")
  })

  test("a read window with no prompt and no reply text hands back nothing, so the stdout tail stands in", () => {
    const tool = JSON.stringify({
      type: "assistant",
      sessionId: session,
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
    })
    const path = file(
      `${session}.jsonl`,
      [JSON.stringify({ type: "user", sessionId: session, message: { role: "user", content: "the task" } }), tool, tool].join("\n"),
    )
    const replies = transcriptReplies(path, session, root, new TextEncoder().encode(tool).length * 2)
    expect(replies).toEqual(["[earlier output cut]"])
    expect(repliesOutput(replies)).toBe("")
    expect(repliesOutput(["[earlier output cut]", " "])).toBe("")
  })

  test("a reply the model's output limit cut off says so", () => {
    const entry = (text: string, stop_reason: string | null) =>
      JSON.stringify({ type: "assistant", sessionId: session, message: { role: "assistant", stop_reason, content: [{ type: "text", text }] } })
    const path = file(
      `${session}.jsonl`,
      [
        JSON.stringify({ type: "user", sessionId: session, message: { role: "user", content: "go" } }),
        entry("- one\n- but it isn't the prom", "max_tokens"),
        entry("- two", "end_turn"),
      ].join("\n"),
    )
    expect(repliesOutput(transcriptReplies(path, session, root))).toBe("- one\n- but it isn't the prom\n[reply cut at the model's output limit]\n\n- two")
  })
})

test("spawn --help is short: the flags that matter, the handback, steering and the harness notes", async () => {
  const { stdout } = await swarm(["spawn", "--help"], {})
  expect(stdout).toBe(`${SPAWN_HELP}\n`)
  expect(Buffer.byteLength(SPAWN_HELP)).toBeLessThan(3072)
  for (const word of [
    "--name",
    "--no-push",
    "--bg",
    "--fg",
    "--handback-bytes",
    "do not background it",
    "steer not applied",
    "codex exec resume",
    "claude -p and grok -p",
    "network_access=true",
    "--contributor-mode off",
    "swarm help --all",
  ]) {
    expect(SPAWN_HELP).toContain(word)
  }
  expect((await swarm(["spawn", "-h", "codex", "exec", "x"], {})).stdout).toBe(stdout)
  expect((await swarm(["spawn", "--help", "--all"], {})).stdout).toBe(`${RELAY_HELP}\n`)
  expect(verbHelp("spawn")).toBe(SPAWN_HELP)
})

test("spawn's help names the claude -p and grok -p presets and the handback", () => {
  expect(RELAY_HELP).toContain("claude -p and grok -p get the relay messaging tools allowed")
  expect(RELAY_HELP).toContain("On exit you get a handback message")
  expect(RELAY_HELP).toContain("swarm reply <id> [text|-]")
  expect(RELAY_HELP).toContain("swarm ack <id|seq>... | --all")
})

test("an agent's shell is told by its harness's markers or a relay identity, even in a pseudo-terminal", () => {
  expect(agentShell({ CLAUDECODE: "1" })).toBe(true)
  expect(agentShell({ CODEX_THREAD_ID: "019a" })).toBe(true)
  expect(agentShell({ SCP_GRANT: "krt_x" })).toBe(true)
  expect(agentShell({ SCP_NAME: "w1" })).toBe(true)
  expect(agentShell({ TERM: "xterm-256color", SCP_NAME: "" })).toBe(false)
})

test("spawn's command starts after --, or without it at the first word that is no spawn flag or a flag's value", () => {
  expect(splitSpawn(["--name", "w", "--scope", "parent", "codex", "exec", "--json", "x"])).toEqual({
    flags: ["--name", "w", "--scope", "parent"],
    command: ["codex", "exec", "--json", "x"],
  })
  expect(splitSpawn(["--name=w", "--no-push", "--handback-bytes", "100", "claude", "-p", "x"])).toEqual({
    flags: ["--name=w", "--no-push", "--handback-bytes", "100"],
    command: ["claude", "-p", "x"],
  })
  expect(splitSpawn(["--name", "w", "--", "codex", "--name"])).toEqual({ flags: ["--name", "w"], command: ["codex", "--name"] })
  expect(splitSpawn(["codex", "--", "x"])).toEqual({ flags: [], command: ["codex", "--", "x"] })
  expect(splitSpawn(["--name", "w"])).toEqual({ flags: ["--name", "w"], command: [] })
  expect(splitSpawn(["-h"])).toEqual({ flags: ["-h"], command: [] })
})

test("spawn defaults: no scope unless a scope flag is given, the prompt's first line as title, a <harness>-<id> name; given flags win", () => {
  const command = ["codex", "exec", "Fix the parser\nnow"]
  const random = () => "ab12c"
  expect(spawnDefaults({}, command, random)).toEqual({ title: "Fix the parser", name: "codex-ab12c" })
  expect(spawnDefaults({ name: "w1", title: "own" }, command, random)).toEqual({ name: "w1", title: "own" })
  for (const flag of [{ scope: "tree" }, { rules: "ep:x" }, { in: "ep:x" }, { out: "ep:x" }, { allow: ["ep:x"] }])
    expect(spawnDefaults(flag, command, random)).not.toHaveProperty("scope", "parent")
  expect(spawnDefaults({}, ["sh", "-c", "exit 0"], random)).toEqual({ name: "sh-ab12c" })
  expect(grantParams(spawnDefaults({ rules: "ep:x" }, command, random))).toMatchObject({ scope: "none", allow: ["ep:x"] })
})

test("without a scope flag the grant carries no caps: --under and --group place the worker and leave its reach the default", () => {
  const command = ["codex", "exec", "go"]
  const random = () => "ab12c"
  const under = grantParams(spawnDefaults({ under: "mid" }, command, random))
  expect(under).toMatchObject({ under: "mid" })
  expect(under).not.toHaveProperty("scope")
  expect(under).not.toHaveProperty("allow")
  const grouped = grantParams(spawnDefaults({ group: "crew" }, command, random))
  expect(grouped).toMatchObject({ groups: ["crew"] })
  expect(grouped).not.toHaveProperty("scope")
  expect(grantParams(spawnDefaults({ under: "mid", scope: "tree" }, command, random))).toMatchObject({ scope: "tree" })
})
