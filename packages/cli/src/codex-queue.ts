import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { connectBroker, type RelayClient, relayDir } from "@scp-dev/broker"
import { CLI_NAME, type Envelope } from "@scp-dev/core"
import { CODEX_THREAD, codexSubcommand, type PsCommTable, readPsTable } from "./identity"
import { note } from "./term"

type Env = Record<string, string | undefined>
export type Run = (bin: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string; missing?: true }>

/**
 * who holds a Codex thread's writer lock: nobody, the desktop app, a `swarm codex` app server, an IDE's app server, another app server (a
 * daemon or a headless one), a running `codex exec`, a codex TUI, a process that is none of these, or a holder no tool could name
 */
export type CodexOwner = "none" | "desktop" | "scp" | "ide" | "app-server" | "exec" | "tui" | "other" | "unknown"

export interface CodexDeps {
  run?: Run
  table?: () => PsCommTable | undefined
  platform?: NodeJS.Platform
}

const BUNDLED = /\.app\/Contents\/Resources\/codex-cli\//
const DESKTOP_APP = /(^|\/)(ChatGPT|Codex)\.app\/Contents\/MacOS\//
const IDE = /Visual Studio Code|Code Helper|Cursor\.app|Windsurf|\.vscode|\.cursor|JetBrains|extensions\/openai\.chatgpt/
const SCP_SERVER = /--listen\s+unix:\/\/\S*\/scp-codex-[^/\s]*\/app\.sock/
const CODEX = /(^|\/)codex(\.js)?(\s|$)/
const RUN_TIMEOUT_MS = 30_000
/** how long the waker keeps trying a busy broker: well inside its run's timeout */
const WAKER_CONNECT_MS = 15_000
/** the most one `codex queue` message carries, under any argument length limit */
const BATCH_BYTES = 96 * 1024
const PAGES = 5

/** `value` when it is a Codex thread id (a UUID of any version), else undefined */
export function codexThread(value: unknown): string | undefined {
  return typeof value === "string" && CODEX_THREAD.test(value) ? value : undefined
}

/** the writer lock file of `thread`, a checked thread id, as an absolute path */
export function codexLockPath(thread: string, env: Env): string {
  return resolve(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "thread-writer-locks", `${thread}.lock`)
}

/** runs `bin` with `args` as given, never through a shell, and without the wake request's variables */
export const runFile: Run = (bin, args) =>
  new Promise((done) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SCP_WAKE_")))
    execFile(bin, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 1 << 20, encoding: "utf8", env }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : null) : 0
      done({ code, stdout: stdout ?? "", stderr: stderr ?? "", ...(error && error.code === "ENOENT" ? { missing: true as const } : {}) })
    })
  })

/** the surface process `pid` holding a writer lock belongs to, from the process table */
export function ownerOf(pid: number, table: PsCommTable | undefined): CodexOwner {
  const holder = table?.get(pid)
  if (!holder) return "unknown"
  const sub = codexSubcommand(holder.args)
  if (sub === "exec" || sub === "e") return "exec"
  if (sub !== "app-server") return CODEX.test(holder.args) ? "tui" : "other"
  if (SCP_SERVER.test(holder.args)) return "scp"
  if (BUNDLED.test(holder.args)) return "desktop"
  const seen = new Set([pid])
  for (let at = holder.ppid; at > 1 && !seen.has(at) && seen.size < 32; at = table!.get(at)?.ppid ?? 0) {
    seen.add(at)
    const args = table!.get(at)?.args ?? ""
    if (IDE.test(args)) return "ide"
    if (DESKTOP_APP.test(args) || BUNDLED.test(args)) return "desktop"
  }
  return "app-server"
}

/** one owner for several holders: their topmost processes (children inherit the lock's descriptor), an exec over all, desktop only when all are */
function ownerOfAll(pids: number[], table: PsCommTable | undefined): CodexOwner {
  const held = new Set(pids)
  const top = pids.filter((pid) => {
    const seen = new Set([pid])
    for (let at = table?.get(pid)?.ppid ?? 0; at > 1 && !seen.has(at); at = table?.get(at)?.ppid ?? 0) {
      if (held.has(at)) return false
      seen.add(at)
    }
    return true
  })
  const owners = top.map((pid) => ownerOf(pid, table))
  if (owners.includes("exec")) return "exec"
  return owners.find((owner) => owner !== "desktop") ?? "desktop"
}

/** the pids `lsof`, else `fuser`, names for the lock; null when neither could tell */
async function holders(path: string, env: Env, run: Run): Promise<number[] | null> {
  const lsof = await run(env.SCP_LSOF_BIN || "lsof", ["-t", "--", path])
  if (!lsof.missing && (lsof.code === 0 || (lsof.code === 1 && !lsof.stdout.trim() && !lsof.stderr.trim())))
    return [...lsof.stdout.matchAll(/^\s*(\d+)\s*$/gm)].map((match) => Number(match[1]))
  const fuser = await run(env.SCP_FUSER_BIN || "fuser", [path])
  if (fuser.missing || (fuser.code !== 0 && fuser.code !== 1)) return null
  return [...fuser.stdout.replaceAll(path, " ").matchAll(/(?:^|\s)(\d+)[a-zA-Z]*(?=\s|$)/g)].map((match) => Number(match[1]))
}

/** who holds `thread` (a checked thread id) open for writing: no lock file is nobody, and a lock no tool could name is `unknown` */
export async function codexOwner(thread: string, env: Env, deps: CodexDeps = {}): Promise<CodexOwner> {
  const path = codexLockPath(thread, env)
  if (!existsSync(path)) return "none"
  const pids = await holders(path, env, deps.run ?? runFile)
  if (pids === null) return "unknown"
  const own = pids.filter((pid) => pid > 1)
  if (!own.length) return "none"
  return ownerOfAll(own, (deps.table ?? readPsTable)())
}

/** how an owner is named to the user */
export function ownerName(owner: CodexOwner): string {
  if (owner === "desktop") return "the Codex desktop app"
  if (owner === "scp") return `another ${CLI_NAME} codex`
  if (owner === "ide") return "an IDE's Codex"
  if (owner === "exec") return "a running codex exec"
  if (owner === "tui") return "a codex session"
  if (owner === "app-server") return "another Codex app server"
  return "another process"
}

/** why `swarm codex --resume` cannot open `thread`: another surface holds it */
export function heldThreadText(thread: string, owner: CodexOwner): string {
  return `${CLI_NAME} codex: thread ${thread} is open in ${ownerName(owner)}, which holds it. Close it there, or run \`codex fork ${thread}\` to continue it in a new thread`
}

/** the messages as `codex queue` messages of at most BATCH_BYTES each (one larger message goes alone), in order */
function batches(messages: Envelope[], frame: (messages: Envelope[]) => string): Envelope[][] {
  const out: Envelope[][] = []
  let size = 0
  for (const message of messages) {
    const bytes = Buffer.byteLength(frame([message])) + 2
    if (!out.length || size + bytes > BATCH_BYTES) {
      out.push([])
      size = 0
    }
    out.at(-1)!.push(message)
    size += bytes
  }
  return out
}

/** confirms queued messages read, retried once: a lost confirmation would queue them again; whether all of them were */
async function confirm(client: RelayClient, seqs: number[], hold: string): Promise<boolean> {
  const marked = async () => (await client.request<{ injected: number }>("injected", { seqs, hold, read: seqs })).injected
  return (await marked().catch(marked)) === seqs.length
}

/** the decline the waker prints for a thread `codex queue` cannot take */
const NO_ROLLOUT = JSON.stringify({ declined: "no-rollout" })
const UNRESUMABLE = JSON.stringify({ declined: "unresumable" })

/**
 * `swarm codex-wake`, the broker's built-in `codex-queue` waker: reads the wake request (SPEC section 19.2), binds to the endpoint with the run's
 * wake ticket, queues the offered messages into the Codex thread named by the ref and confirms them read, then opens the thread in the desktop
 * app when the app or nobody holds it. A running `codex exec` keeps them for its hooks; exit 0, 77 declining (`no-rollout`, `unresumable`), or
 * 1 on a failure
 */
export async function codexWakeCommand(
  env: Env = process.env,
  deps: CodexDeps & { stdin?: AsyncIterable<unknown>; stdout?: (text: string) => void } = {},
): Promise<number> {
  const out = deps.stdout ?? ((text: string) => void process.stdout.write(text))
  let input = ""
  for await (const chunk of deps.stdin ?? process.stdin) input += String(chunk)
  let event: { ref?: unknown } = {}
  try {
    event = JSON.parse(input) as typeof event
  } catch {}
  const thread = codexThread(event.ref ?? env.SCP_WAKE_REF)
  if (!thread) {
    out(`${UNRESUMABLE}\n`)
    return 77
  }
  const ticket = env.SCP_WAKE_TICKET
  if (!ticket) {
    note(`${CLI_NAME} codex-wake: no wake ticket: this broker cannot hand the messages over`)
    return 1
  }
  const run = deps.run ?? runFile
  if ((await codexOwner(thread, env, { ...deps, run })) === "exec") return 0
  const { framed } = await import("./hold")
  const client = await connectBroker(relayDir(env), undefined, { budgetMs: WAKER_CONNECT_MS, env })
  let queued = false
  try {
    await client.hello({ observe: true, ticket })
    for (let page = 0; page < PAGES; page++) {
      const { messages, hold } = await client.request<{ messages: Envelope[]; hold: string | null }>("inbox", { offer: true })
      if (!hold || !messages.some((message) => message.seq !== undefined)) break
      for (const batch of batches(messages, framed)) {
        await client.request("whoami", {})
        const result = await run(env.SCP_CODEX_BIN || "codex", ["queue", `--thread=${thread}`, `--message=${framed(batch)}`])
        if (result.code !== 0) {
          if (/no rollout found/i.test(result.stderr)) {
            out(`${NO_ROLLOUT}\n`)
            return 77
          }
          const last = result.stderr.trim().split("\n").at(-1)?.trim()
          note(`${CLI_NAME} codex-wake: codex queue ${result.missing ? "is not installed" : `failed${last ? `: ${last}` : ""}`}`)
          return 1
        }
        queued = true
        if (
          !(await confirm(
            client,
            batch.flatMap((message) => (message.seq === undefined ? [] : [message.seq])),
            hold,
          ))
        ) {
          note(`${CLI_NAME} codex-wake: queued, but the broker no longer held the messages for this run`)
          return 1
        }
      }
    }
  } finally {
    client.close()
  }
  if (!queued || ((deps.platform ?? process.platform) !== "darwin" && !env.SCP_OPEN_BIN)) return 0
  const owner = await codexOwner(thread, env, { ...deps, run })
  if (owner !== "none" && owner !== "desktop") return 0
  const opened = await run(env.SCP_OPEN_BIN || "open", ["-g", `codex://threads/wake/${thread}`])
  if (opened.code !== 0) note(`${CLI_NAME} codex-wake: queued, but the desktop app did not open the thread (${opened.stderr.trim() || `exit ${opened.code}`})`)
  return 0
}
