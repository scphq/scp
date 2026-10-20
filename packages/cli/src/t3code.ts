import { spawnSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { connectBroker, relayDir } from "@scp-dev/broker"
import { CLI_NAME, validHandle } from "@scp-dev/core"
import { MCP_PROTOCOLS, runRelayMcp } from "@scp-dev/mcp"
import { attribute, attributed, ROOT_HELP } from "./attribute"
import { RelayUsage, startDaemon } from "./common"
import { relayIdentity } from "./identity"
import { whichOnPath } from "./setup"
import { WebSocketLink } from "./websocket"

type Env = Record<string, string | undefined>
type Json = Record<string, unknown>
type Transport = { request(tag: string, payload: Json): Promise<Json> }

export const T3CODE_HELP = `${CLI_NAME} t3code [--name N | --as N] [--root] --thread THREAD [--base-dir DIR]
  holds an agent endpoint for one T3 Code thread, wake on: each batch of relay messages goes to the thread as a user
  message, starting a turn when it is idle and steering the running one otherwise; retried every 2 s until T3 Code takes it.
  finds the running server in DIR/userdata/server-runtime.json (DIR: --base-dir, else $T3CODE_HOME, else ~/.t3) or at
  $SCP_T3_URL, with the token $SCP_T3_TOKEN or one t3 auth session issue grants ($SCP_T3_BIN picks t3, default t3 on PATH).
  refuses to start without a server, a token or the thread, and exits non-zero when the connection drops.
  the thread's own agent joins through its provider's mount (codex or claude) as a separate t3code endpoint.
${ROOT_HELP}`

/** the active-run statuses of a T3 Code run */
const ACTIVE = new Set(["preparing", "starting", "running", "waiting"])
const CONNECT_TIMEOUT_MS = 10_000

export interface T3Launch {
  name?: string
  root?: true
  thread: string
  baseDir?: string
  env: Env
}

/** the launch of `swarm t3code`, with a fresh session and harness t3code in its environment */
export function t3Launch(args: string[], env: Env): T3Launch {
  let name: string | undefined
  let thread: string | undefined
  let baseDir: string | undefined
  let root = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--root") {
      root = true
      continue
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    if (flag !== "--name" && flag !== "--as" && flag !== "--thread" && flag !== "--base-dir")
      throw new RelayUsage(`${CLI_NAME} t3code takes --name, --root, --thread and --base-dir, not ${JSON.stringify(arg)}`)
    const value = eq > 0 ? arg.slice(eq + 1) : args[++i]
    if (!value) throw new RelayUsage(`${CLI_NAME} t3code ${flag} takes a value`)
    if (flag === "--thread") thread = value
    else if (flag === "--base-dir") baseDir = value
    else name = value
  }
  if (thread === undefined) throw new RelayUsage(`${CLI_NAME} t3code needs --thread THREAD: the T3 Code thread its messages wake`)
  name = name?.replace(/^me\//, "")
  if (name !== undefined && !validHandle(name)) throw new RelayUsage(`${JSON.stringify(name)} is not a valid agent handle`)
  const { SCP_SESSION: _session, SCP_PARENT: _parent, SCP_HARNESS_PID: _pid, ...clean } = env
  return {
    ...(name !== undefined ? { name } : {}),
    ...(root ? { root: true as const } : {}),
    thread,
    ...(baseDir !== undefined ? { baseDir } : {}),
    env: { ...clean, SCP_HARNESS: "t3code", SCP_SESSION: randomBytes(16).toString("hex"), ...(name !== undefined ? { SCP_NAME: name } : {}) },
  }
}

/** T3 Code's data directory: --base-dir, else $T3CODE_HOME, else ~/.t3 */
export function t3Home(env: Env, baseDir?: string): string {
  return baseDir || env.T3CODE_HOME || join(env.HOME || homedir(), ".t3")
}

export interface T3Server {
  host: string
  port: number
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const loopback = (host: string): string => (!host || host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host.replace(/^\[(.*)\]$/, "$1"))

/** the server to connect to: $SCP_T3_URL, else the one `home`'s server-runtime.json names while its process runs */
export function t3Server(env: Env, home: string, alive: (pid: number) => boolean = pidAlive): T3Server {
  if (env.SCP_T3_URL) {
    let url: URL
    try {
      url = new URL(env.SCP_T3_URL)
    } catch {
      throw new RelayUsage(`$SCP_T3_URL ${JSON.stringify(env.SCP_T3_URL)} is not a URL`)
    }
    if (url.protocol !== "http:" && url.protocol !== "ws:") throw new RelayUsage(`$SCP_T3_URL takes an http:// or ws:// address, not ${url.protocol}`)
    return { host: loopback(url.hostname), port: Number(url.port || 80) }
  }
  const file = join(home, "userdata", "server-runtime.json")
  let runtime: Json
  try {
    runtime = JSON.parse(readFileSync(file, "utf8")) as Json
  } catch {
    throw new RelayUsage(`${CLI_NAME} t3code: no T3 Code server runs for ${home} (no ${file}): start T3 Code or t3 serve, or set $SCP_T3_URL`)
  }
  const port = Number(runtime.port)
  const pid = Number(runtime.pid)
  if (!Number.isInteger(port) || port <= 0 || typeof runtime.host !== "string") throw new RelayUsage(`${CLI_NAME} t3code: ${file} names no server address`)
  if (Number.isInteger(pid) && pid > 0 && !alive(pid))
    throw new RelayUsage(`${CLI_NAME} t3code: the T3 Code server ${file} names (pid ${pid}) is not running: start T3 Code or t3 serve`)
  return { host: loopback(runtime.host), port }
}

export type IssueRunner = (argv: string[], env: Env) => { status: number | null; stdout: string; stderr: string }

const issueRun: IssueRunner = (argv, env) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] })
  return { status: result.status, stdout: result.stdout ?? "", stderr: `${result.stderr ?? ""}${result.error ? result.error.message : ""}` }
}

/** the t3 arguments that issue a token for reading threads and sending to them */
export function issueArgv(bin: string, home: string): string[] {
  return [
    bin,
    "auth",
    "session",
    "issue",
    "--base-dir",
    home,
    "--scope",
    "orchestration:read",
    "--scope",
    "orchestration:operate",
    "--ttl",
    "30d",
    "--label",
    `${CLI_NAME} t3code`,
    "--token-only",
  ]
}

/** $SCP_T3_TOKEN, else a token t3 issues for `home` */
export function t3Token(env: Env, home: string, run: IssueRunner = issueRun): string {
  const given = env.SCP_T3_TOKEN?.trim()
  if (given) return given
  const bin = env.SCP_T3_BIN || whichOnPath("t3", env)
  if (!bin) throw new RelayUsage(`${CLI_NAME} t3code: no token: set $SCP_T3_TOKEN, or put t3 on PATH (or set $SCP_T3_BIN) to issue one`)
  const result = run(issueArgv(bin, home), env)
  const token = result.stdout.trim().split("\n").at(-1)?.trim()
  if (result.status !== 0 || !token || /\s/.test(token))
    throw new RelayUsage(
      `${CLI_NAME} t3code: ${bin} auth session issue failed${result.stderr.trim() ? `: ${result.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`,
    )
  return token
}

/** the first reason an Effect RPC failure exit gives */
export function exitReason(exit: Json): string {
  const causes = Array.isArray(exit.cause) ? (exit.cause as Json[]) : []
  for (const cause of causes) {
    const error = (cause.error ?? cause.defect) as Json | string | undefined
    if (typeof error === "string") return error
    if (error && typeof error === "object") return String(error.message ?? error._tag ?? JSON.stringify(error))
    if (cause._tag === "Interrupt") return "interrupted"
  }
  return JSON.stringify(exit)
}

/** an Effect RPC client of the T3 Code server's /ws endpoint (JSON framing): requests, and streams it acknowledges chunk by chunk */
export class T3Socket implements Transport {
  private link: WebSocketLink
  readonly ready: Promise<void>
  private next = 1
  private pending = new Map<string, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private streams = new Map<string, { tag: string; onValue: (value: Json) => void }>()

  /** `onClose` runs once with the error that ended the connection, a stream's end included */
  constructor(server: T3Server, token: string, onClose: (error: Error) => void = () => {}) {
    const host = server.host.includes(":") ? `[${server.host}]` : server.host
    this.link = new WebSocketLink(
      connect({ host: server.host, port: server.port }),
      { path: "/ws?orchestrationProtocol=2", host: `${host}:${server.port}`, headers: { Authorization: `Bearer ${token}` } },
      "T3 Code",
      (text) => this.receive(text),
      (error) => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(error)
        }
        this.pending.clear()
        this.streams.clear()
        onClose(error)
      },
    )
    this.ready = this.link.ready
  }

  private receive(text: string): void {
    const message = JSON.parse(text) as Json
    const id = String(message.requestId)
    if (message._tag === "Chunk") {
      const stream = this.streams.get(id)
      if (!stream) return
      for (const value of (message.values as Json[] | undefined) ?? []) stream.onValue(value)
      this.send({ _tag: "Ack", requestId: id })
    } else if (message._tag === "Exit") {
      const exit = (message.exit ?? {}) as Json
      const stream = this.streams.get(id)
      if (stream) {
        this.streams.delete(id)
        this.link.fail(new Error(`T3 Code ended ${stream.tag}${exit._tag === "Failure" ? `: ${exitReason(exit)}` : ""}`))
        return
      }
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (exit._tag === "Success") pending.resolve((exit.value ?? {}) as Json)
      else pending.reject(new Error(exitReason(exit)))
    } else if (message._tag === "Ping") this.send({ _tag: "Pong" })
    else if (message._tag === "Defect") this.link.fail(new Error(`T3 Code failed: ${JSON.stringify(message.defect)}`))
  }

  private send(message: Json): void {
    this.link.send(JSON.stringify(message))
  }

  async request(tag: string, payload: Json, timeoutMs = 15_000): Promise<Json> {
    await this.ready
    const id = String(this.next++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`T3 Code ${tag} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ _tag: "Request", id, tag, payload, headers: [] })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  /** a stream the connection holds for its life: its end closes the connection */
  async subscribe(tag: string, payload: Json, onValue: (value: Json) => void): Promise<void> {
    await this.ready
    const id = String(this.next++)
    this.streams.set(id, { tag, onValue })
    this.send({ _tag: "Request", id, tag, payload, headers: [] })
  }

  close(): void {
    this.link.fail(new Error("T3 Code socket closed"))
  }
}

/** the run a T3 Code thread is busy with, from its projection's runs */
export function activeRun(runs: unknown): string | null {
  const run = (Array.isArray(runs) ? (runs as Json[]) : []).findLast((candidate) => ACTIVE.has(String(candidate.status)))
  return typeof run?.id === "string" ? run.id : null
}

/** hands channel messages to one T3 Code thread as a user message: a new turn when it is idle, a steer of the active run otherwise; retried every 2 s */
export class T3Waker {
  private queue: string[] = []
  private serial: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private failing = false
  active: string | null = null
  deleted = false

  constructor(
    private transport: Transport,
    private threadId: string,
    private retryMs = 2000,
    private log: (line: string) => void = () => {},
  ) {}

  /** a thread shell from the shell stream: the thread's active run */
  thread(shell: Json): void {
    if (shell.id !== this.threadId) return
    this.active = typeof shell.activeRunId === "string" ? shell.activeRunId : null
    if (shell.deletedAt) this.deleted = true
  }

  push(text: string): void {
    this.queue.push(text)
    void this.flush()
  }

  /** the dispatch of `text`: the server settles a stale view itself (deliveryIntent auto) */
  command(text: string): Json {
    return {
      type: "message.dispatch",
      commandId: randomUUID(),
      createdBy: "user",
      creationSource: "server",
      threadId: this.threadId,
      messageId: randomUUID(),
      text,
      attachments: [],
      dispatchMode: this.active ? { type: "steer_active", targetRunId: this.active } : { type: "start_immediately" },
      deliveryIntent: "auto",
    }
  }

  flush(): Promise<void> {
    if (this.serial) return this.serial
    if (this.stopped || !this.queue.length) return Promise.resolve()
    clearTimeout(this.timer)
    this.timer = undefined
    const count = this.queue.length
    this.serial = this.transport
      .request("orchestration.dispatchCommand", this.command(this.queue.slice(0, count).join("\n\n")))
      .then(
        () => {
          this.queue.splice(0, count)
          this.failing = false
          return true
        },
        (error: unknown) => {
          if (!this.failing && !this.stopped)
            this.log(`${CLI_NAME} t3code: T3 Code did not take the message (${error instanceof Error ? error.message : String(error)}); retrying every 2 s`)
          this.failing = true
          return false
        },
      )
      .then((ok) => {
        this.serial = undefined
        if (this.stopped || !this.queue.length) return
        if (ok) return this.flush()
        this.timer ??= setTimeout(() => {
          this.timer = undefined
          void this.flush()
        }, this.retryMs)
      })
    return this.serial
  }

  close(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }
}

/** `swarm t3code`: holds an endpoint and wakes one T3 Code thread with each batch of new messages */
export async function t3codeCommand(
  args: string[],
  env: Env = process.env,
  cwd: string = process.cwd(),
  err: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${T3CODE_HELP}\n`)
    return 0
  }
  const parsed = t3Launch(args, env)
  const home = t3Home(env, parsed.baseDir)
  const server = t3Server(env, home)
  const token = t3Token(env, home)
  const attribution = await attribute("t3code", parsed, env, cwd, err)
  const launch = attribution ? t3Launch(args, attributed(env, attribution)) : parsed
  let finish!: (code: number) => void
  const done = new Promise<number>((resolve) => {
    finish = resolve
  })
  let stopping = false
  let live = false
  const socket = new T3Socket(server, token, (error) => {
    if (stopping || !live) return
    err(`${CLI_NAME} t3code: the T3 Code connection closed: ${error.message}`)
    finish(1)
  })
  const where = `${server.host}:${server.port}`
  const input = new PassThrough()
  let waker: T3Waker | undefined
  let channel: Promise<void> | undefined
  const stop = () => {
    stopping = true
    finish(0)
  }
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
  for (const signal of signals) process.on(signal, stop)
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        socket.ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("timed out")), CONNECT_TIMEOUT_MS)
        }),
      ])
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      throw new RelayUsage(`${CLI_NAME} t3code: could not connect to T3 Code at ${where}: ${why}${/\b401\b/.test(why) ? " (the token was refused)" : ""}`)
    } finally {
      clearTimeout(timeout)
    }
    live = true
    let projection: Json
    try {
      projection = await socket.request("orchestration.getThreadProjection", { threadId: launch.thread })
    } catch (error) {
      throw new RelayUsage(`${CLI_NAME} t3code: T3 Code has no thread ${launch.thread} (${error instanceof Error ? error.message : String(error)})`)
    }
    if (stopping) return 0
    waker = new T3Waker(socket, launch.thread, 2000, err)
    waker.active = activeRun(projection.runs)
    const shellWaker = waker
    await socket.subscribe("orchestration.subscribeShell", {}, (value) => {
      const threads =
        value.kind === "snapshot" ? (((value.snapshot as Json | undefined)?.threads as Json[] | undefined) ?? []) : value.thread ? [value.thread as Json] : []
      for (const thread of threads) shellWaker.thread(thread)
      if (shellWaker.deleted && !stopping) {
        err(`${CLI_NAME} t3code: T3 Code deleted thread ${launch.thread}`)
        finish(1)
      }
    })
    const claim = relayIdentity({ harness: "t3code", fallbackHarness: "t3code", cwd, env: launch.env, harnessPid: () => process.pid })
    if (!validHandle(claim.handle)) throw new RelayUsage(`${JSON.stringify(claim.handle)} is not a valid agent handle`)
    const broker = relayDir(launch.env)
    let joined!: (result: Json) => void
    const whoami = new Promise<Json>((resolve) => {
      joined = resolve
    })
    let lines = ""
    channel = runRelayMcp({
      connect: () => connectBroker(broker, () => startDaemon(broker)),
      claim,
      channels: true,
      wake: "t3code",
      input,
      env: launch.env,
      output: (chunk) => {
        lines += chunk
        for (;;) {
          const end = lines.indexOf("\n")
          if (end < 0) break
          const message = JSON.parse(lines.slice(0, end)) as Json
          lines = lines.slice(end + 1)
          if (message.id === 2) joined((message.result ?? {}) as Json)
          if (message.method === "notifications/claude/channel") {
            const content = (message.params as Json).content
            if (typeof content === "string") shellWaker.push(content)
          }
        }
      },
      log: err,
    })
    void channel.catch((error: unknown) => {
      err(`${CLI_NAME} t3code: ${String(error)}`)
      finish(1)
    })
    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOLS[0], capabilities: { experimental: { "claude/channel": {} } }, clientInfo: { name: "scp-t3code", version: "0.1.0" } } })}\n`,
    )
    input.write(`${JSON.stringify({ method: "notifications/initialized" })}\n`)
    input.write(`${JSON.stringify({ id: 2, method: "tools/call", params: { name: "relay_whoami", arguments: {} } })}\n`)
    const result = await Promise.race([whoami, done.then(() => undefined)])
    if (result === undefined) return await done
    const text = ((result.content as { text?: string }[] | undefined) ?? []).map((part) => part.text ?? "").join("\n")
    const address = /^address: (\S+)$/m.exec(text)?.[1]
    if (result.isError || !address) throw new RelayUsage(`${CLI_NAME} t3code: could not join the relay: ${text || "no answer"}`)
    err(`${CLI_NAME} t3code: ${address} waking T3 Code thread ${launch.thread} at ${where}`)
    return await done
  } finally {
    for (const signal of signals) process.off(signal, stop)
    stopping = true
    waker?.close()
    input.end()
    await channel?.catch(() => {})
    socket.close()
  }
}
