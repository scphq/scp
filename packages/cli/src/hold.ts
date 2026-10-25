import { spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { closeSync, openSync, statSync, writeSync } from "node:fs"
import { basename, isAbsolute } from "node:path"
import { Writable } from "node:stream"
import { connectBroker, type RelayClient, relayDir } from "@scp-dev/broker"
import {
  type Claim,
  CLI_NAME,
  type EndpointView,
  type Envelope,
  findSecret,
  LIMITS,
  PREAMBLE,
  RelayError,
  SPAWN_PROVIDER,
  validHandle,
  wrapMessage,
} from "@scp-dev/core"
import { RelayUsage } from "./common"
import { labelsFor, processKey } from "./identity"
import { linkedHandbackBody } from "./remote-spawn"
import { resumeLaunch } from "./resume"
import { harnessArgv, harnessOutput, museFirstRun, museResumeBase, programAt, resumeArgv, runHarness, stderrOutput } from "./spawn"
import { note, parseSeconds, SELF } from "./term"

type Env = Record<string, string | undefined>

/** how long a spawn holds a worker it can resume while no message comes, in seconds, unless `lifecycle.idle_after_s` or `swarm spawn --idle` sets it */
export const SPAWN_IDLE_S = 600

/** the harnesses whose headless session spawn resumes */
export type Resumable = "codex" | "agy" | "grok" | "muse"

/**
 * a durable spawn's hibernation ref: the harness, its session, the directory it runs in, the resumed run's words before its prompt (which
 * goes last), the idle timeout (null for none) and the parent the worker sits under; never a credential or the grant
 */
export interface HoldRef {
  harness: Resumable
  session: string
  cwd: string
  argv: string[]
  idle_s: number | null
  parent: string
}

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** `--idle <seconds|duration|Infinity>`: how long a held worker waits for a message; 0 holds nothing */
export function idleSeconds(value: string): number {
  if (value.trim() === "Infinity") return Number.POSITIVE_INFINITY
  if (/^0+(\.0*)?$/.test(value.trim())) return 0
  try {
    return parseSeconds(value, "--idle")
  } catch (error) {
    throw new RelayUsage(`${error instanceof Error ? error.message : String(error)}, or Infinity`)
  }
}

/** the harness `command` runs, when spawn can resume its session */
export function resumable(command: string[]): Resumable | undefined {
  const program = command[programAt(command)]
  const name = program === undefined ? "" : basename(program)
  return name === "codex" || name === "agy" || name === "grok" || name === "muse" ? name : undefined
}

/** a headless agy or grok command (a prompt flag, no `--`) as its launch reads it, with the words before its arguments */
function headless(harness: "agy" | "grok", command: string[], uuid?: () => string) {
  const at = programAt(command)
  try {
    const launch = resumeLaunch(harness, ["--", ...command.slice(at + 1)], {}, uuid)
    return launch.first && !launch.base.includes("--") ? { prefix: command.slice(0, at + 1), launch } : undefined
  } catch {
    return undefined
  }
}

/**
 * the first run of a command spawn may resume: a grok or muse exec without a session of its own starts one it names (`-s <uuid>`,
 * `--session-id <uuid>`), the session returned
 */
export function firstRun(command: string[], uuid: () => string = randomUUID): { command: string[]; session?: string } {
  if (resumable(command) === "muse") return museFirstRun(command, uuid) ?? { command }
  if (resumable(command) !== "grok") return { command }
  const found = headless("grok", command, uuid)
  if (!found?.launch.id) return { command }
  return { command: [...found.prefix, ...found.launch.first!], session: found.launch.id }
}

/** the session a resumed run of `command` names: codex's from its hooks or its output, agy's from the conversation file, grok's and muse's the one it was given */
export function resumeSession(command: string[], session: string | null | undefined): string | undefined {
  if (resumable(command) === "agy") session ??= headless("agy", command)?.launch.id
  return session && SESSION.test(session) ? session : undefined
}

/**
 * a resumed run's words before its prompt, which goes last: `codex exec [opts] resume [opts] <session>`, `agy [args] --conversation <id> -p`,
 * `grok [args] --resume <id> -p` (its messaging allow rules added at launch, as for any headless grok, so they stay out of a durable ref),
 * `muse [opts] exec [opts] --session-id <id>`; undefined for any other command, an ephemeral codex, a muse without a session log, or one that
 * is not headless
 */
export function resumeBase(command: string[], session: string): string[] | undefined {
  if (!SESSION.test(session)) return undefined
  const harness = resumable(command)
  if (harness === "codex") return resumeArgv(command, session, "")?.slice(0, -1)
  if (harness === "muse") return museResumeBase(command, session)
  if (harness !== "agy" && harness !== "grok") return undefined
  const found = headless(harness, command)
  if (!found) return undefined
  const conversation = harness === "agy" ? ["--conversation", session] : ["--resume", session]
  return [...found.prefix, ...found.launch.base, ...conversation, "-p"]
}

/** messages as one resume prompt: each framed as a channel push, joined by a blank line */
export function framed(messages: Envelope[]): string {
  return messages.map((message) => `${PREAMBLE}\n\n${wrapMessage(message)}`).join("\n\n")
}

/** why a durable spawn cannot keep `ref`, else undefined */
export function refProblem(ref: string): string | undefined {
  if (ref.length > LIMITS.wakeRefChars) return `its resume command and directory take ${ref.length} characters, over ${LIMITS.wakeRefChars}`
  if (/[\u0000-\u001f\u007f]/.test(ref)) return "its resume command holds control characters"
  if (findSecret(ref)) return "its resume command looks like it carries a credential"
  return undefined
}

/** a ref as `swarm spawn --durable` wrote it, or undefined */
export function parseHoldRef(text: string | undefined): HoldRef | undefined {
  let value: unknown
  try {
    value = JSON.parse(text ?? "")
  } catch {
    return undefined
  }
  const ref = value as Partial<HoldRef> | null
  if (!ref || typeof ref !== "object") return undefined
  const { harness, session, cwd, argv, idle_s, parent } = ref
  if (harness !== "codex" && harness !== "agy" && harness !== "grok" && harness !== "muse") return undefined
  if (typeof session !== "string" || !SESSION.test(session) || typeof cwd !== "string" || !isAbsolute(cwd)) return undefined
  if (!Array.isArray(argv) || !argv.length || !argv.every((word) => typeof word === "string") || resumable(argv) !== harness) return undefined
  if (idle_s !== null && (typeof idle_s !== "number" || !(idle_s > 0))) return undefined
  if (typeof parent !== "string" || !parent) return undefined
  return { harness, session, cwd, argv, idle_s, parent }
}

export interface Held {
  client: RelayClient
  endpoint: EndpointView
  /** the durable ref the broker took, when it did */
  durable?: string
  /** the session's resume token, before any harness run claims the session and replaces it */
  token?: string
}

/**
 * claims the worker's endpoint and holds it with wake `spawn-resume`, durably with `durable` when the broker can (else held plainly, said in a
 * note); undefined, with a note, when the claim or the wake fails
 */
export async function holdEndpoint(
  claim: Claim & { handle: string },
  durable: ((endpoint: EndpointView) => string | undefined) | undefined,
  log: (line: string) => void,
): Promise<Held | undefined> {
  let client: RelayClient | undefined
  try {
    client = await connectBroker(relayDir())
    const { endpoint: claimed, token } = await client.hello({ claim })
    const endpoint = claimed!
    let kept = durable?.(endpoint)
    try {
      await client.request("wake", { via: "spawn-resume", ...(kept ? { ref: kept } : {}) })
    } catch (error) {
      if (!kept || !(error instanceof RelayError) || error.code === "unauthorized") throw error
      log(`${CLI_NAME} spawn: ${claim.handle} is held, not durably: ${error.message}`)
      kept = undefined
      await client.request("wake", { via: "spawn-resume" })
    }
    return { client, endpoint, ...(kept ? { durable: kept } : {}), ...(token ? { token } : {}) }
  } catch (error) {
    client?.close()
    log(`${CLI_NAME} spawn: ${claim.handle} cannot be held for a resume: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

const STOPS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

/** SIGINT, SIGTERM and SIGHUP caught from now on, instead of ending the process: whether one came, and a promise of the first */
export function watchSignals(): { caught: () => boolean; next: Promise<void>; stop: () => void } {
  let caught = false
  let fire!: () => void
  const next = new Promise<void>((resolve) => (fire = resolve))
  const handler = () => {
    caught = true
    fire()
  }
  for (const signal of STOPS) process.on(signal, handler)
  const stop = () => {
    for (const signal of STOPS) process.off(signal, handler)
  }
  return { caught: () => caught, next, stop }
}

/**
 * holds a worker's endpoint until it was idle for `idleS` seconds, a signal came (`signals`) or its connection closed (`spawn_end`, or the
 * broker going away). Each batch of messages, taken and marked read once nothing else runs, starts one resumed run (`resume`); the idle time
 * starts again after it. Before letting go it takes any message that came meanwhile; a durable hold hibernates the endpoint by the built-in
 * waker, waiting for the broker's answer
 */
export async function holdLoop(
  held: Held,
  options: {
    idleS: number
    signals: ReturnType<typeof watchSignals>
    resume: (messages: Envelope[]) => Promise<void>
    /** runs as the hold lets go, before a durable hold hibernates */
    letGo?: () => void
  },
): Promise<"idle" | "ended" | "signal"> {
  const { client } = held
  const idleMs = options.idleS * 1000
  const finish = async (why: "idle" | "signal"): Promise<"idle" | "signal"> => {
    options.letGo?.()
    if (held.durable) await client.request("hibernate", { wake: SPAWN_PROVIDER, ref: held.durable }).catch(() => {})
    client.close()
    return why
  }
  let deadline = Date.now() + idleMs
  for (;;) {
    if (options.signals.caught()) return finish("signal")
    const left = deadline - Date.now()
    let page: { messages: Envelope[]; hold?: string | null } | "signal"
    try {
      page = await Promise.race([
        client.request<{ messages: Envelope[]; hold?: string | null }>("inbox", { wait_s: left > 0 ? Math.min(left / 1000, LIMITS.waitMaxS) : 0, offer: true }),
        options.signals.next.then(() => "signal" as const),
      ])
    } catch {
      client.close()
      return "ended"
    }
    if (page === "signal") return finish("signal")
    if (page.messages.length) {
      const seqs = page.messages.flatMap((message) => (message.seq === undefined ? [] : [message.seq]))
      try {
        await client.request("injected", { seqs, hold: page.hold, read: seqs })
        await client.request("status", { state: "working", note: "" })
      } catch {
        client.close()
        return "ended"
      }
      await options.resume(page.messages)
      deadline = Date.now() + idleMs
      continue
    }
    if (left <= 0) return finish("idle")
  }
}

/** the message that woke a run and came from the worker's parent, the newest of them */
export function wokeBy(messages: Envelope[]): string | undefined {
  return [...messages].reverse().find((message) => message.relation === "parent")?.id
}

/** a writable that drops what it gets */
function sink(): Writable {
  return new Writable({ write: (_chunk, _encoding, done) => done() })
}

/** the decline the built-in waker prints for a ref it cannot resume */
const UNRESUMABLE = JSON.stringify({ declined: "unresumable" })
/** how long the runner tries to take the endpoint back, while the spawn that hibernated it lets go */
const RECLAIM_MS = 10_000

/**
 * `swarm spawn-wake`, the broker's built-in `spawn` waker: reads the wake request (SPEC section 19.2) on stdin and starts a detached runner that
 * takes the worker's endpoint back and resumes its session; exit 0 once the runner holds the endpoint, 77 declining (`unresumable`) a ref it
 * cannot resume, 1 when the runner could not take the endpoint
 */
export async function spawnWakeCommand(args: string[], env: Env = process.env): Promise<number> {
  if (args[0] === "--run") return wakeRunner(env)
  let input = ""
  for await (const chunk of process.stdin) input += String(chunk)
  let event: { handle?: unknown; endpoint?: unknown; ref?: unknown } = {}
  try {
    event = JSON.parse(input) as typeof event
  } catch {}
  const text = typeof event.ref === "string" ? event.ref : env.SCP_WAKE_REF
  const ref = parseHoldRef(text)
  const handle = typeof event.handle === "string" ? event.handle : env.SCP_WAKE_HANDLE
  const endpoint = typeof event.endpoint === "string" ? event.endpoint : env.SCP_WAKE_ENDPOINT
  if (!ref || !handle || !validHandle(handle) || !endpoint || !statSync(ref.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    process.stdout.write(`${UNRESUMABLE}\n`)
    return 77
  }
  const child = spawn(SELF[0]!, [...SELF.slice(1), "spawn-wake", "--run"], {
    cwd: ref.cwd,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe"],
    env: { ...env, SCP_WAKE_HANDLE: handle, SCP_WAKE_ENDPOINT: endpoint, SCP_WAKE_REF: JSON.stringify(ref) },
  })
  const channel = child.stdio[3] as NodeJS.ReadableStream & { destroy(): void }
  const line = await new Promise<string>((resolve) => {
    let got = ""
    channel.on("data", (chunk: Buffer) => {
      got += chunk.toString()
      if (got.includes("\n")) resolve(got.slice(0, got.indexOf("\n")))
    })
    channel.once("end", () => resolve(got))
    child.once("error", () => resolve(""))
  })
  channel.destroy()
  child.unref()
  let reply: { ok?: true; error?: string } = {}
  try {
    reply = JSON.parse(line) as typeof reply
  } catch {}
  if (reply.ok) return 0
  note(`${CLI_NAME} spawn-wake: ${reply.error ?? "the runner ended before it held the endpoint"}`)
  return 1
}

/** the waker's runner: takes the endpoint back where it sits, holds it, resumes the session with each batch and hands each run back */
async function wakeRunner(env: Env): Promise<number> {
  let channel: number | undefined
  try {
    channel = openSync("/dev/fd/3", "w")
    closeSync(3)
  } catch {
    channel = 3
  }
  const reply = (value: object) => {
    if (channel === undefined) return
    try {
      writeSync(channel, `${JSON.stringify(value)}\n`)
      closeSync(channel)
    } catch {}
    channel = undefined
  }
  const ref = parseHoldRef(env.SCP_WAKE_REF)
  const handle = env.SCP_WAKE_HANDLE
  const address = env.SCP_WAKE_ENDPOINT
  const ticket = env.SCP_WAKE_TICKET
  if (!ref || !handle || !address || !ticket) {
    reply({ error: ticket ? "no resumable ref" : "no wake ticket: this broker cannot hand the endpoint back" })
    return 1
  }
  const session = randomBytes(16).toString("hex")
  let held: Held | undefined
  let failure = `${address} could not be taken back`
  const claim = {
    handle,
    harness: ref.harness,
    cwd: ref.cwd,
    session: `env:${session}`,
    process: processKey(process.pid),
    exact: true,
    ticket,
  }
  for (const deadline = Date.now() + RECLAIM_MS; !held && Date.now() < deadline; ) {
    held = await holdEndpoint(
      claim,
      () => JSON.stringify(ref),
      (line) => (failure = line),
    )
    if (!held) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!held) {
    reply({ error: failure })
    return 1
  }
  reply({ ok: true })
  const parent = held.endpoint.parent
  const {
    SCP_WAKE_HANDLE: _h,
    SCP_WAKE_ENDPOINT: _e,
    SCP_WAKE_REF: _r,
    SCP_WAKE_PROVIDER: _p,
    SCP_WAKE_MESSAGE_ID: _m,
    SCP_WAKE_FROM: _f,
    SCP_WAKE_KIND: _k,
    SCP_WAKE_THREAD: _t,
    SCP_WAKE_TICKET: _w,
    SCP_GRANT: _g,
    SCP_PARENT: _pa,
    ...clean
  } = env
  const runEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...clean, SCP_NAME: handle, SCP_SESSION: session, SCP_HARNESS_PID: String(process.pid) }))
    if (value !== undefined) runEnv[key] = value
  const spare = await resumed(held.token)
  const signals = watchSignals()
  try {
    await holdLoop(held, {
      idleS: ref.idle_s ?? Number.POSITIVE_INFINITY,
      signals,
      letGo: () => spare?.close(),
      resume: async (messages) => {
        const run = await runHarness(harnessArgv([...ref.argv, framed(messages)], runEnv, SELF, undefined, ref.cwd), runEnv, {
          capture: true,
          captureErr: true,
          out: sink(),
          err: sink(),
          stdin: "ignore",
          group: true,
        })
        const code = Math.min(run.code, 255)
        const woke = wokeBy(messages)
        const handBack = async (client: RelayClient) => {
          if (parent)
            await client.request("send", {
              to: parent,
              kind: "message",
              body: linkedHandbackBody(held.endpoint.address, code, harnessOutput(run), stderrOutput(run)),
              ...(woke ? { reply_to: woke } : {}),
            })
          await client.request("status", { state: "done", note: `exited ${code}` })
        }
        try {
          await handBack(held.client).catch(async (error: unknown) => {
            if (!spare || !held.client.closed) throw error
            await handBack(spare)
          })
        } catch (error) {
          note(`${CLI_NAME} spawn-wake: could not hand ${handle}'s result back: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
  } finally {
    signals.stop()
    spare?.close()
  }
  return 0
}

/**
 * a second connection to the held endpoint, resumed with its token before a harness run replaces it: `spawn_end` closes only the holding
 * connection, so a run in flight still hands back over this one
 */
async function resumed(token: string | undefined): Promise<RelayClient | undefined> {
  if (!token) return undefined
  let client: RelayClient | undefined
  try {
    client = await connectBroker(relayDir())
    await client.hello({ resume: token })
    return client
  } catch {
    client?.close()
    return undefined
  }
}

/** the claim with which a spawn holds its worker's endpoint once the harness exited: its grant, the spawner's lineage, spawn's own process */
export function holdClaim(options: {
  name: string
  harness: Resumable
  cwd: string
  session: string
  lineage: string[]
  grant: string
  env: Env
}): Claim & { handle: string } {
  return {
    handle: options.name,
    harness: options.harness,
    cwd: options.cwd,
    session: `env:${options.session}`,
    process: processKey(process.pid),
    exact: true,
    labels: labelsFor(options.env),
    ...(options.lineage.length ? { lineage: options.lineage } : {}),
    grant: options.grant,
  }
}
