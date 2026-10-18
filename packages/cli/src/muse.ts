import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { PassThrough, type Readable, type Writable } from "node:stream"
import { connectBroker, type RelayClient, relayDir } from "@scp-dev/broker"
import { CLI_NAME, validHandle } from "@scp-dev/core"
import { MCP_PROTOCOLS, runRelayMcp } from "@scp-dev/mcp"
import { connectCodexChannel } from "./codex"
import { RelayUsage, startDaemon } from "./common"
import { processKey, relayIdentity, writeMuseLaunch } from "./identity"
import { mcpFile, mountedEntry } from "./setup"
import { MUSE_MODE, MUSE_MODES_ALLOWED, museModes } from "./spawn"

type Env = Record<string, string | undefined>
type Json = Record<string, unknown>
type Transport = { request(method: string, params: Json): Promise<Json> }

export const MUSE_HELP = `${CLI_NAME} muse [--name N | --as N] [--resume SESSION] [--approval-mode never|on-request|untrusted] [--] [muse serve args...]
  runs a headless Muse session (muse serve) that relay messages wake: a message starts a turn on the idle session or steers a running one.
  every other argument goes to muse serve (--provider, --model, -c, sandbox flags); it runs with --contributor-mode off unless you pass on.
  prints the agent's messages; approvals the mode leaves to a human are declined. --resume SESSION reopens a stored session.
  needs the scp mount and plugin ${CLI_NAME} setup --write installs. $SCP_MUSE_BIN picks the muse binary (default muse on PATH).`

/** Muse's tool approval modes, as the TUI names them, to the modes muse serve takes on the wire */
const APPROVAL: Record<string, string> = { never: "allowAll", "on-request": "onRequest", untrusted: "promptUnmatched" }
const NO_USER_INPUT = "--disable-request-user-input"

/** the muse serve arguments and environment, without the launching session's identity */
export function museLaunch(args: string[], env: Env): { name?: string; resume?: string; approvalMode: string; serveArgs: string[]; env: Env } {
  let name: string | undefined
  let resume: string | undefined
  let approval = "on-request"
  const serveArgs: string[] = []
  const value = (flag: string, next: string | undefined): string => {
    if (next === undefined) throw new RelayUsage(`${CLI_NAME} muse ${flag} takes a value`)
    return next
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--") {
      serveArgs.push(...args.slice(i + 1))
      break
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    const take = () => (eq > 0 ? arg.slice(eq + 1) : value(flag, args[++i]))
    if (flag === "--name" || flag === "--as") name = take()
    else if (flag === "--resume") resume = take()
    else if (flag === "--approval-mode") approval = take()
    else serveArgs.push(arg)
  }
  name = name?.replace(/^me\//, "")
  if (name !== undefined && !validHandle(name)) throw new RelayUsage(`${JSON.stringify(name)} is not a valid agent handle`)
  const approvalMode = APPROVAL[approval]
  if (!approvalMode) throw new RelayUsage(`${CLI_NAME} muse --approval-mode takes never, on-request or untrusted, not ${JSON.stringify(approval)}`)
  const modes = museModes(serveArgs)
  for (const mode of modes) {
    if (mode === undefined || !MUSE_MODES_ALLOWED.has(mode))
      throw new RelayUsage(`${CLI_NAME} muse: muse runs with ${MUSE_MODE} off or on, not ${mode === undefined ? "a bare flag" : JSON.stringify(mode)}`)
  }
  const { SCP_SESSION: _session, SCP_PARENT: _parent, ...clean } = env
  return {
    ...(name !== undefined ? { name } : {}),
    ...(resume !== undefined ? { resume } : {}),
    approvalMode,
    serveArgs: [...(modes.length ? [] : [MUSE_MODE, "off"]), ...(serveArgs.includes(NO_USER_INPUT) ? [] : [NO_USER_INPUT]), ...serveArgs],
    env: { ...clean, SCP_HARNESS: "muse", ...(name !== undefined ? { SCP_NAME: name } : {}) },
  }
}

/** the broker Muse's shim and hooks reach: Muse starts them without SCP_DIR or XDG_STATE_HOME, so the default one under HOME */
export function museBroker(env: Env): string {
  return relayDir({ HOME: env.HOME || homedir() })
}

/** a time-ordered UUID (version 7), which muse serve requires for command ids */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16)
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 255
  bytes[6] = (bytes[6]! & 15) | 0x70
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** a JSON-RPC client of muse serve over its stdio, one message per line */
export class MuseHost implements Transport {
  private next = 1
  private buffer = ""
  private closed: Error | undefined
  private pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(
    private input: Writable,
    output: Readable,
    private onMessage: (message: Json) => void = () => {},
    private timeoutMs = 30_000,
  ) {
    output.setEncoding("utf8")
    output.on("data", (chunk: string) => {
      this.buffer += chunk
      for (;;) {
        const end = this.buffer.indexOf("\n")
        if (end < 0) break
        const line = this.buffer.slice(0, end).trim()
        this.buffer = this.buffer.slice(end + 1)
        if (line) this.receive(line)
      }
    })
    output.on("close", () => this.close(new Error("muse serve closed")))
    input.on("error", (error: Error) => this.close(error))
  }

  private receive(line: string): void {
    let message: Json
    try {
      message = JSON.parse(line) as Json
    } catch {
      return
    }
    const pending = typeof message.id === "number" && message.method === undefined ? this.pending.get(message.id) : undefined
    if (!pending) {
      this.onMessage(message)
      return
    }
    this.pending.delete(message.id as number)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
    else pending.resolve((message.result ?? {}) as Json)
  }

  send(message: Json): void {
    if (this.closed) throw this.closed
    this.input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  }

  request(method: string, params: Json): Promise<Json> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`muse ${method} timed out`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  close(error = new Error("muse serve closed")): void {
    this.closed ??= error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(this.closed)
    }
    this.pending.clear()
  }
}

/** hands channel messages to one session as a turn: started when it is idle, steered into the running one otherwise; retried every 2 s */
export class MuseWaker {
  private queue: string[] = []
  private serial: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(
    private transport: Transport,
    private sessionId: string,
    private retryMs = 2000,
  ) {}

  push(text: string): void {
    this.queue.push(text)
    void this.flush()
  }

  flush(): Promise<void> {
    if (this.serial) return this.serial
    if (this.stopped || !this.queue.length) return Promise.resolve()
    clearTimeout(this.timer)
    this.timer = undefined
    const count = this.queue.length
    this.serial = this.transport
      .request("turn/start", {
        commandId: uuidv7(),
        sessionId: this.sessionId,
        input: [{ type: "text", text: this.queue.slice(0, count).join("\n\n") }],
        ifBusy: "steer",
      })
      .then(
        (result) => {
          if (result.status !== "accepted") return false
          this.queue.splice(0, count)
          return true
        },
        () => false,
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

/** answers a server request of muse serve for a session no human watches: approvals are declined, anything else is refused */
export function answerRequest(host: Pick<MuseHost, "send" | "request">, message: Json, log: (line: string) => void): void {
  const params = (message.params ?? {}) as Json
  if (message.method !== "approval/request") {
    host.send({ id: message.id, error: { code: -32601, message: `${String(message.method)} is unsupported in a headless session` } })
    return
  }
  host.send({ id: message.id, result: {} })
  const choices = Array.isArray(params.availableChoices) ? (params.availableChoices as Json[]) : []
  const choice = choices.find((c) => c.decision === "denied") ?? choices.find((c) => c.decision === "abort")
  const subject = (params.subject ?? {}) as Json
  log(`${CLI_NAME} muse: declined ${String(subject.command ?? subject.kind ?? "an approval")}`)
  if (!choice) return
  void host
    .request("approval/decide", {
      approvalId: params.approvalId,
      choiceId: choice.choiceId,
      commandId: uuidv7(),
      requirementId: params.currentRequirementId,
      sessionId: params.sessionId,
    })
    .catch((error: unknown) => log(`${CLI_NAME} muse: could not decline: ${String(error)}`))
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill("SIGTERM")
  })
}

const BIND_TIMEOUT_MS = 30_000

/** runs muse serve with one session that relay messages wake, printing the agent's messages */
export async function museCommand(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${MUSE_HELP}\n`)
    return 0
  }
  const launch = museLaunch(args, process.env)
  const cwd = process.cwd()
  const log = (line: string) => void process.stderr.write(`${line}\n`)
  try {
    if (!mountedEntry("muse", mcpFile("muse", launch.env)))
      throw new RelayUsage(`${CLI_NAME} muse: Muse has no scp MCP mount, so messages cannot wake this session; run ${CLI_NAME} setup --write`)
  } catch (error) {
    if (error instanceof RelayUsage) throw error
    throw new RelayUsage(
      `${CLI_NAME} muse: ${mcpFile("muse", launch.env)} is unreadable, so the scp mount is unchecked; fix it or run ${CLI_NAME} setup --write`,
    )
  }
  const broker = museBroker(launch.env)
  if (relayDir(launch.env) !== broker) log(`${CLI_NAME} muse: Muse starts its shim and hooks without SCP_DIR or XDG_STATE_HOME, so this session uses ${broker}`)
  const env: Env = { ...launch.env, SCP_DIR: broker }
  const bin = env.SCP_MUSE_BIN || "muse"
  const server = spawn(bin, ["serve", ...launch.serveArgs], { env: launch.env, stdio: ["pipe", "pipe", "pipe"] })
  let stderr = Buffer.alloc(0)
  server.stderr!.on("data", (data: Buffer) => {
    stderr = Buffer.concat([stderr, data]).subarray(-8192)
  })
  let serverError: Error | undefined
  let died = false
  let finish!: (code: number) => void
  const done = new Promise<number>((resolve) => {
    finish = resolve
  })
  server.on("error", (error) => {
    serverError = error
    died = true
    finish(1)
  })
  server.on("exit", () => {
    died = true
    finish(1)
  })
  const failure = () =>
    new RelayUsage(`${CLI_NAME} muse: muse serve failed${serverError ? `: ${serverError.message}` : ""}${stderr.length ? `\n${stderr.toString().trim()}` : ""}`)
  let waker: MuseWaker | undefined
  let channel: Promise<void> | undefined
  let unlaunch = () => {}
  const input = new PassThrough()
  let stopping = false
  const stop = () => {
    stopping = true
    finish(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  process.on("SIGHUP", stop)
  const host = new MuseHost(server.stdin!, server.stdout!, (message) => {
    if (message.id !== undefined && typeof message.method === "string") {
      answerRequest(host, message, log)
      return
    }
    if (message.method !== "item/completed") return
    const item = ((message.params as Json | undefined)?.item ?? {}) as Json
    if (item.kind === "agentMessage" && typeof item.text === "string" && item.text) process.stdout.write(`${item.text}\n`)
  })
  try {
    if (!server.pid) await new Promise((resolve) => setImmediate(resolve))
    if (died || !server.pid) throw failure()
    const key = processKey(server.pid)
    unlaunch = writeMuseLaunch(key, { ...(env.SCP_NAME ? { name: env.SCP_NAME } : {}), ...(env.SCP_GRANT ? { grant: env.SCP_GRANT } : {}) }, env)
    const started = await Promise.race([
      (async () => {
        await host.request("initialize", { clientInfo: { name: "scp_waker", version: "0.1.0" } })
        host.send({ method: "initialized" })
        const result = launch.resume
          ? await host.request("session/resume", { commandId: uuidv7(), sessionId: launch.resume, excludeItems: true })
          : await host.request("session/start", { commandId: uuidv7(), approvalMode: launch.approvalMode, workspaceRoot: cwd })
        return (result.session as Json).sessionId as string
      })(),
      done.then(() => undefined),
    ])
    if (stopping) return 0
    if (!started || died) throw failure()
    const claim = relayIdentity({ harness: "muse", fallbackHarness: "muse", cwd, env, harnessPid: () => server.pid! })
    const deadline = Date.now() + BIND_TIMEOUT_MS
    const bind = (until: () => boolean) =>
      connectCodexChannel(
        () => connectBroker(broker, () => startDaemon(broker)),
        claim,
        cwd,
        () => input.writableEnded || until(),
      )
    let bindError: unknown
    let first: RelayClient | undefined = await Promise.race([
      bind(() => stopping || died || Date.now() > deadline).catch((error: unknown) => {
        bindError = error
        return undefined
      }),
      done.then(() => undefined),
    ])
    if (stopping) return 0
    if (died) throw failure()
    if (!first) {
      const why =
        Date.now() > deadline
          ? "the session's scp shim never joined"
          : `its channel could not bind (${bindError instanceof Error ? bindError.message : String(bindError)})`
      throw new RelayUsage(`${CLI_NAME} muse: ${why}, so messages cannot wake it; check the mount ${CLI_NAME} setup --write installs`)
    }
    waker = new MuseWaker(host, started)
    let lines = ""
    channel = runRelayMcp({
      connect: async () => {
        const client = first ?? (await bind(() => false))
        first = undefined
        return client
      },
      claim,
      channels: true,
      wake: "muse-serve",
      input,
      env,
      output: (chunk) => {
        lines += chunk
        for (;;) {
          const end = lines.indexOf("\n")
          if (end < 0) break
          const message = JSON.parse(lines.slice(0, end)) as Json
          lines = lines.slice(end + 1)
          if (message.method === "notifications/claude/channel") {
            const content = (message.params as Json).content
            if (typeof content === "string") waker!.push(content)
          }
        }
      },
      log,
    })
    void channel.catch((error: unknown) => {
      log(error instanceof Error ? error.message : String(error))
      finish(1)
    })
    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOLS[0], capabilities: { experimental: { "claude/channel": {} } }, clientInfo: { name: "scp-waker", version: "0.1.0" } } })}\n`,
    )
    input.write(`${JSON.stringify({ method: "notifications/initialized" })}\n`)
    log(`${CLI_NAME} muse: ${claim.handle} waiting for messages (session ${started})`)
    const code = await done
    if (died && !stopping) {
      log(failure().message)
      return 1
    }
    return code
  } catch (error) {
    if (died) throw failure()
    throw error
  } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    process.off("SIGHUP", stop)
    waker?.close()
    input.end()
    await channel?.catch(() => {})
    host.close()
    server.stdin?.end()
    await terminate(server)
    unlaunch()
  }
}
