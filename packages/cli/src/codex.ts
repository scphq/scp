import { type ChildProcess, spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { connect, type Socket } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { setTimeout as sleep } from "node:timers/promises"
import { connectBroker, relayDir } from "@scp-dev/broker"
import { CLI_NAME, validHandle } from "@scp-dev/core"
import { MCP_PROTOCOLS, runRelayMcp } from "@scp-dev/mcp"
import { parse } from "smol-toml"
import { RelayUsage, startDaemon } from "./common"
import { readPsTable, relayIdentity } from "./identity"
import { CODEX_VALUED, codexMount, codexOverrides, toml } from "./spawn"
import { SELF } from "./term"

type Env = Record<string, string | undefined>
type Json = Record<string, unknown>
type Transport = { request(method: string, params: Json): Promise<Json> }

export const CODEX_HELP = `${CLI_NAME} codex [--name N | --as N] [--headless] [--resume THREAD] [--] [codex args...]
  every codex argument, profile and config value is honoured; a -- after codex arguments is passed through.
  runs codex with relay messages waking an idle thread or steering a running turn; approvals stay with the TUI.
  --headless runs an ambient worker without a TUI; --resume THREAD reopens its thread.
  $SCP_CODEX_BIN picks the codex binary (default codex on PATH).`

/** the codex arguments and environment, without the launching session's identity */
export function codexLaunch(args: string[], env: Env, _self: string[]): { name?: string; headless: boolean; resume?: string; codexArgs: string[]; env: Env } {
  let name: string | undefined
  let resume: string | undefined
  let headless = false
  const codexArgs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--") {
      codexArgs.push(...args.slice(codexArgs.length ? i : i + 1))
      break
    }
    if (arg === "--name" || arg === "--as") {
      name = args[++i]
      if (name === undefined) throw new RelayUsage(`${CLI_NAME} codex ${arg} takes a name`)
    } else if (arg.startsWith("--name=") || arg.startsWith("--as=")) name = arg.slice(arg.indexOf("=") + 1)
    else if (arg === "--headless") headless = true
    else if (arg === "--resume") {
      resume = args[++i]
      if (resume === undefined) throw new RelayUsage(`${CLI_NAME} codex --resume takes a thread`)
    } else if (arg.startsWith("--resume=")) resume = arg.slice("--resume=".length)
    else codexArgs.push(arg)
  }
  name = name?.replace(/^me\//, "")
  if (name !== undefined && !validHandle(name)) throw new RelayUsage(`${JSON.stringify(name)} is not a valid agent handle`)
  const { SCP_SESSION: _session, SCP_GRANT: _grant, SCP_PARENT: _parent, ...clean } = env
  return {
    ...(name !== undefined ? { name } : {}),
    headless,
    ...(resume !== undefined ? { resume } : {}),
    codexArgs: resume !== undefined && !headless ? ["resume", resume, ...codexArgs] : codexArgs,
    env: { ...clean, SCP_HARNESS: "codex", ...(name !== undefined ? { SCP_NAME: name } : {}) },
  }
}

/** a JSON-RPC WebSocket client on a private unix socket */
export class CodexSocket implements Transport {
  private socket: Socket
  private buffer: Buffer = Buffer.alloc(0)
  private opened = false
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  readonly ready = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve
    this.rejectReady = reject
  })
  private next = 1
  private pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private key = randomBytes(16).toString("base64")
  private fragments: Buffer[] = []

  constructor(
    path: string,
    private onMessage: (message: Json) => void = () => {},
  ) {
    this.socket = connect(path)
    this.socket.on("connect", () => {
      this.socket.write(
        `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    this.socket.on("data", (data) => {
      try {
        this.feed(typeof data === "string" ? Buffer.from(data) : data)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    this.socket.on("error", (error) => this.fail(error))
    this.socket.on("close", () => this.fail(new Error("codex socket closed")))
  }

  private fail(error: Error): void {
    this.rejectReady(error)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.socket.destroy()
  }

  private feed(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data])
    if (!this.opened) {
      const end = this.buffer.indexOf("\r\n\r\n")
      if (end < 0) return
      const header = this.buffer.subarray(0, end).toString()
      const accept = createHash("sha1").update(`${this.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
      if (!/^HTTP\/1\.1 101\b/.test(header) || !header.toLowerCase().includes(`sec-websocket-accept: ${accept}`.toLowerCase()))
        throw new Error("codex WebSocket upgrade failed")
      this.buffer = this.buffer.subarray(end + 4)
      this.opened = true
      this.resolveReady()
    }
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0]! & 15
      const final = (this.buffer[0]! & 128) !== 0
      const masked = (this.buffer[1]! & 128) !== 0
      let length = this.buffer[1]! & 127
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const size = this.buffer.readBigUInt64BE(2)
        if (size > 64n * 1024n * 1024n) throw new Error("codex WebSocket frame too large")
        length = Number(size)
        offset = 10
      }
      const start = offset + (masked ? 4 : 0)
      if (this.buffer.length < start + length) return
      const payload = Buffer.from(this.buffer.subarray(start, start + length))
      if (masked) for (let i = 0; i < length; i++) payload[i] = payload[i]! ^ this.buffer[offset + (i % 4)]!
      this.buffer = this.buffer.subarray(start + length)
      if (opcode === 8) {
        this.fail(new Error("codex WebSocket closed"))
        return
      }
      if (opcode === 9) this.frame(10, payload)
      if (opcode !== 1 && opcode !== 0) continue
      this.fragments.push(payload)
      if (!final) continue
      const message = JSON.parse(Buffer.concat(this.fragments).toString()) as Json
      this.fragments = []
      const pending = typeof message.id === "number" && !message.method ? this.pending.get(message.id) : undefined
      if (pending) {
        this.pending.delete(message.id as number)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
        else pending.resolve((message.result ?? {}) as Json)
      } else this.onMessage(message)
    }
  }

  private frame(opcode: number, payload: Buffer): void {
    const length = payload.length
    const header = Buffer.alloc(length < 126 ? 2 : length < 65536 ? 4 : 10)
    header[0] = 128 | opcode
    header[1] = 128 | (length < 126 ? length : length < 65536 ? 126 : 127)
    if (header.length === 4) header.writeUInt16BE(length, 2)
    if (header.length === 10) header.writeBigUInt64BE(BigInt(length), 2)
    const mask = randomBytes(4)
    const body = Buffer.from(payload)
    for (let i = 0; i < length; i++) body[i] = body[i]! ^ mask[i % 4]!
    this.socket.write(Buffer.concat([header, mask, body]))
  }

  send(message: Json): void {
    if (this.socket.destroyed) throw new Error("codex socket closed")
    this.frame(1, Buffer.from(JSON.stringify(message)))
  }

  async request(method: string, params: Json): Promise<Json> {
    await this.ready
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex ${method} timed out`))
      }, 15_000)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  close(): void {
    this.fail(new Error("codex socket closed"))
  }
}

/** queues channel messages for the current top-level thread, steering active turns */
export class CodexWaker {
  readonly status = new Map<string, string>()
  private changed = new Map<string, number>()
  private parents = new Map<string, boolean>()
  private waiting = new Set<string>()
  private queue: string[] = []
  private serial: Promise<void> | undefined
  private again = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private clock = 0

  constructor(
    private transport: Transport,
    private threadId?: string,
  ) {}

  push(text: string): void {
    this.queue.push(text)
    void this.flush()
  }

  notification(message: Json): void {
    if (message.method !== "thread/status/changed") return
    const params = message.params as { threadId: string; status: { type: string } }
    this.status.set(params.threadId, params.status.type)
    this.changed.set(params.threadId, ++this.clock)
    if (params.status.type === "idle") this.waiting.delete(params.threadId)
    void this.flush()
  }

  async target(): Promise<string | undefined> {
    if (this.threadId) return this.threadId
    const result = await this.transport.request("thread/loaded/list", {})
    const threads: string[] = []
    for (const id of result.data as string[]) {
      if (!this.parents.has(id)) {
        const read = await this.transport.request("thread/read", { threadId: id })
        this.parents.set(id, Boolean((read.thread as Json).parentThreadId))
      }
      if (!this.parents.get(id)) threads.push(id)
    }
    return threads.reduce<string | undefined>((best, id) => (!best || (this.changed.get(id) ?? 0) >= (this.changed.get(best) ?? 0) ? id : best), undefined)
  }

  flush(): Promise<void> {
    if (this.serial) {
      this.again = true
      return this.serial
    }
    if (this.stopped || !this.queue.length) return Promise.resolve()
    this.serial = (async () => {
      do {
        this.again = false
        if (this.stopped || !this.queue.length) break
        try {
          const threadId = await this.target()
          if (!threadId || this.stopped) break
          const status = this.status.get(threadId)
          if (this.waiting.has(threadId) || (status && status !== "idle" && status !== "active")) break
          const count = this.queue.length
          const input = [{ type: "text", text: this.queue.slice(0, count).join("\n\n") }]
          if (status === "active") {
            try {
              const turns = await this.transport.request("thread/turns/list", { threadId })
              const turn = (turns.data as Json[]).find((turn) => turn.status === "inProgress")
              if (!turn) throw new Error("no running turn")
              await this.transport.request("turn/steer", { threadId, expectedTurnId: turn.id, input })
            } catch {
              if (this.status.get(threadId) === "idle") {
                this.again = true
                continue
              }
              this.waiting.add(threadId)
              break
            }
          } else {
            await this.transport.request("turn/start", { threadId, input })
          }
          this.queue.splice(0, count)
        } catch {
          break
        }
      } while (this.again && this.queue.length)
    })().finally(() => {
      this.serial = undefined
      if (!this.queue.length) {
        clearTimeout(this.timer)
        this.timer = undefined
      }
      if (!this.stopped && this.queue.length && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined
          void this.flush()
        }, 2000)
      }
    })
    return this.serial
  }

  close(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }
}

function option(args: string[], ...names: string[]): string | undefined {
  let value: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (names.includes(arg)) {
      value = args[++i]
      if (value === undefined) throw new RelayUsage(`${CLI_NAME} codex ${arg} takes a value`)
    } else if (names.some((name) => arg.startsWith(`${name}=`))) value = arg.slice(arg.indexOf("=") + 1)
  }
  return value
}

const SERVER_CONFIG = ["-c", "--config", "--enable", "--disable"]
const SERVER_SETTINGS: Record<string, string> = {
  "-m": "model",
  "--model": "model",
  "-s": "sandbox_mode",
  "--sandbox": "sandbox_mode",
  "-a": "approval_policy",
  "--ask-for-approval": "approval_policy",
}

function leaves(value: unknown, path: string[], out: string[]): void {
  if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value)) leaves(child, [...path, key], out)
  } else if (path.length) out.push("-c", `${path.join(".")}=${toml(value instanceof Date ? value.toISOString() : value)}`)
}

/** the app-server options that give it the configuration `codex` would resolve from these arguments: profile, then -c and features, then model, sandbox and approval */
export function serverOptions(args: string[], env: Env, warn: (line: string) => void = (line) => void process.stderr.write(`${line}\n`)): string[] {
  const profile: string[] = []
  const config: string[] = []
  const settings: string[] = []
  const set = (key: string, value: string) => settings.push("-c", `${key}=${toml(value)}`)
  let conflict = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--") break
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    if (flag === "--strict-config") config.push(flag)
    else if (flag === "--dangerously-bypass-approvals-and-sandbox" || flag === "--yolo") {
      set("approval_policy", "never")
      set("sandbox_mode", "danger-full-access")
    }
    if (!CODEX_VALUED.has(flag)) continue
    const value = eq > 0 ? arg.slice(eq + 1) : args[++i]
    if (value === undefined) throw new RelayUsage(`${CLI_NAME} codex ${flag} takes a value`)
    if (SERVER_CONFIG.includes(flag)) {
      config.push(flag, value)
      if (/^mcp_servers\.("scp"|scp)\./.test(value)) conflict = true
    } else if (flag === "-p" || flag === "--profile") {
      const file = join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), `${value}.config.toml`)
      profile.length = 0
      if (existsSync(file)) {
        try {
          leaves(parse(readFileSync(file, "utf8")), [], profile)
        } catch (error) {
          warn(`${CLI_NAME} codex: could not read profile ${file}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } else if (SERVER_SETTINGS[flag]) set(SERVER_SETTINGS[flag], value)
  }
  if (conflict) warn(`${CLI_NAME} codex: your -c mcp_servers.scp settings override the ones ${CLI_NAME} sets, so messages may not wake this session`)
  return [...profile, ...config, ...settings]
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill("SIGTERM")
  })
}

function appServerPid(pid: number): number {
  const table = readPsTable()
  const seen = new Set<number>()
  while (!seen.has(pid)) {
    seen.add(pid)
    const child = [...(table ?? [])].find(([_, entry]) => entry.ppid === pid && /\sapp-server(?:\s|$)/.test(entry.args))
    if (!child) break
    pid = child[0]
  }
  return pid
}

/** runs an app-server with a channel waker and either a remote TUI or an ambient thread */
export async function codexCommand(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${CODEX_HELP}\n`)
    return 0
  }
  const launch = codexLaunch(args, process.env, SELF)
  const cwd = process.cwd()
  const bin = launch.env.SCP_CODEX_BIN || "codex"
  const overrides = [...codexOverrides(launch.env, codexMount(launch.env), SELF), ...serverOptions(launch.codexArgs, launch.env)]
  const dir = mkdtempSync(join(tmpdir(), "scp-codex-"))
  const path = join(dir, "app.sock")
  const server = spawn(bin, ["app-server", "--listen", `unix://${path}`, ...overrides], { env: launch.env, stdio: ["ignore", "ignore", "pipe"] })
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
    new RelayUsage(
      `${CLI_NAME} codex: app-server failed${serverError ? `: ${serverError.message}` : ""}${stderr.length ? `\n${stderr.toString().trim()}` : ""}`,
    )
  let socket: CodexSocket | undefined
  let waker: CodexWaker | undefined
  let tui: ChildProcess | undefined
  let channel: Promise<void> | undefined
  const input = new PassThrough()
  const ignore = () => {}
  let stopping = false
  const stop = () => {
    stopping = true
    finish(0)
  }
  const forward = (signal: NodeJS.Signals) => {
    if (tui) tui.kill(signal)
    else stop()
  }
  process.on("SIGINT", launch.headless ? stop : ignore)
  process.on("SIGTERM", launch.headless ? stop : forward)
  process.on("SIGHUP", launch.headless ? stop : forward)
  try {
    const end = Date.now() + 20_000
    while (!socket && Date.now() < end && !died && !stopping) {
      const candidate = new CodexSocket(path, (message) => {
        waker?.notification(message)
        if (!launch.headless) return
        if (message.id !== undefined && typeof message.method === "string") {
          if (message.method.endsWith("/requestApproval")) {
            process.stderr.write(`${CLI_NAME} codex: declined ${message.method}\n`)
            candidate.send({ id: message.id, result: { decision: "decline" } })
          } else candidate.send({ id: message.id, error: { code: -32601, message: "unsupported server request" } })
        }
        if (message.method === "item/completed") {
          const item = (message.params as Json).item as Json
          if (item.type === "agentMessage" && typeof item.text === "string") process.stdout.write(`${item.text}\n`)
        }
      })
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          (async () => {
            await candidate.ready
            await candidate.request("initialize", { clientInfo: { name: "scp-waker", version: "0.1.0" } })
            candidate.send({ method: "initialized" })
          })(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("initialize timed out")), Math.min(1000, end - Date.now()))
          }),
        ])
        socket = candidate
      } catch {
        candidate.close()
        if (!died) await sleep(100)
      } finally {
        clearTimeout(timeout)
      }
    }
    if (stopping) return 0
    if (!socket || died) throw failure()
    let threadId: string | undefined
    if (launch.headless) {
      const resume = launch.resume
      const model = option(launch.codexArgs, "-m", "--model")
      const sandbox = option(launch.codexArgs, "-s", "--sandbox")
      const result = await socket.request(resume ? "thread/resume" : "thread/start", {
        ...(resume ? { threadId: resume } : { cwd }),
        approvalPolicy: "never",
        ...(model !== undefined ? { model } : {}),
        ...(sandbox !== undefined ? { sandbox } : {}),
      })
      threadId = (result.thread as Json).id as string
    }
    if (stopping) return 0
    waker = new CodexWaker(socket, threadId)
    const pid = appServerPid(server.pid!)
    const claim = relayIdentity({ harness: "codex", fallbackHarness: "codex", cwd, env: launch.env, harnessPid: () => pid })
    const broker = relayDir(launch.env)
    let lines = ""
    channel = runRelayMcp({
      connect: async () => {
        while (!input.writableEnded) {
          const client = await connectBroker(broker, () => startDaemon(broker))
          try {
            // A second live claim gets a new endpoint; bind to the mounted shim's process instead.
            const hello = await client.hello({ observe: true, self: [claim.process], cwd })
            if (hello.endpoint) {
              client.hello = async () => hello
              return client
            }
          } catch (error) {
            client.close()
            throw error
          }
          client.close()
          await sleep(100)
        }
        throw new Error("codex channel stopped")
      },
      claim,
      channels: true,
      wake: "codex-app-server",
      input,
      env: launch.env,
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
      log: (line) => {
        process.stderr.write(`${line}\n`)
      },
    })
    void channel.catch((error: unknown) => {
      process.stderr.write(`${CLI_NAME} codex: ${String(error)}\n`)
      finish(1)
    })
    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOLS[0], capabilities: { experimental: { "claude/channel": {} } }, clientInfo: { name: "scp-waker", version: "0.1.0" } } })}\n`,
    )
    input.write(`${JSON.stringify({ method: "notifications/initialized" })}\n`)
    if (launch.headless) {
      process.stderr.write(`${CLI_NAME} codex: ${launch.name ?? claim.handle} waiting for messages (thread ${threadId})\n`)
    } else {
      tui = spawn(bin, ["--remote", `unix://${path}`, ...launch.codexArgs], { env: launch.env, stdio: "inherit" })
      tui.once("error", (error) => {
        process.stderr.write(`${CLI_NAME} codex: ${error.message}\n`)
        finish(1)
      })
      tui.once("exit", (code, signal) => finish(code ?? (signal ? 1 : 0)))
    }
    const code = await done
    if (died) {
      process.stderr.write(`${failure().message}\n`)
      return 1
    }
    return code
  } catch (error) {
    if (died) throw failure()
    throw error
  } finally {
    process.off("SIGINT", stop)
    process.off("SIGINT", ignore)
    process.off("SIGTERM", stop)
    process.off("SIGHUP", stop)
    process.off("SIGTERM", forward)
    process.off("SIGHUP", forward)
    waker?.close()
    input.end()
    await channel?.catch(() => {})
    socket?.close()
    if (tui) await terminate(tui)
    await terminate(server)
    rmSync(dir, { recursive: true, force: true })
  }
}
