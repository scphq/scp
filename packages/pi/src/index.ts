import { type ChildProcess, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"

type Json = Record<string, unknown>
type Env = Record<string, string | undefined>
type McpTool = { name: string; description?: string; inputSchema?: Json }
type McpContent = { type: string; text?: string }
type CallResult = { content?: McpContent[]; isError?: boolean }

const PROTOCOL = "2025-06-18"
const CHANNEL = "notifications/claude/channel"

/** the swarm argv: $SCP_PI_SWARM as a JSON array of words, else `swarm` on PATH */
export function swarmWords(env: Env): string[] {
  const raw = env.SCP_PI_SWARM
  if (!raw) return ["swarm"]
  const words = JSON.parse(raw) as unknown
  if (!Array.isArray(words) || !words.length || !words.every((word) => typeof word === "string"))
    throw new Error("SCP_PI_SWARM must be a JSON array of strings")
  return words
}

/** the shim this session mounts: `swarm mcp --harness pi --channels`, named by $SCP_NAME when set */
export function shimArgv(env: Env): string[] {
  return [...swarmWords(env), "mcp", "--harness", "pi", "--channels", ...(env.SCP_NAME ? ["--as", env.SCP_NAME] : [])]
}

/** newline-delimited JSON-RPC to a stdio MCP server, handing its channel pushes to `onPush` */
export class McpLink {
  private readonly child: ChildProcess
  private readonly pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>()
  private next = 1
  private closed = false

  constructor(argv: string[], env: Env, onPush: (content: string, meta: Json) => void, onExit: (code: number | null) => void) {
    this.child = spawn(argv[0]!, argv.slice(1), { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "ignore"] })
    this.child.stdin!.on("error", () => {})
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      let message: Json
      try {
        message = JSON.parse(line) as Json
      } catch {
        return
      }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id)!
        this.pending.delete(message.id)
        const error = message.error as { message?: string } | undefined
        if (error) waiter.reject(new Error(error.message ?? "mcp error"))
        else waiter.resolve((message.result ?? {}) as Json)
        return
      }
      if (message.method === CHANNEL) {
        const params = (message.params ?? {}) as { content?: unknown; meta?: Json }
        if (typeof params.content === "string") onPush(params.content, params.meta ?? {})
      }
    })
    this.child.once("error", () => this.fail(null, onExit))
    this.child.once("exit", (code) => this.fail(code, onExit))
  }

  private fail(code: number | null, onExit: (code: number | null) => void) {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.pending.values()) waiter.reject(new Error("the scp shim exited"))
    this.pending.clear()
    onExit(code)
  }

  request(method: string, params: Json = {}): Promise<Json> {
    if (this.closed) return Promise.reject(new Error("the scp shim exited"))
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  notify(method: string, params: Json = {}) {
    if (!this.closed) this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.child.stdin!.end()
    this.child.kill()
  }
}

/** an MCP tool result as pi's: its text parts, and an error result fails the call */
export function toolResult(result: CallResult): { content: { type: "text"; text: string }[]; details: Json } {
  const content = (result.content ?? []).flatMap((part) =>
    part.type === "text" && typeof part.text === "string" ? [{ type: "text" as const, text: part.text }] : [],
  )
  if (result.isError) throw new Error(content.map((part) => part.text).join("\n") || "the relay tool failed")
  return { content, details: {} }
}

/**
 * Joins this pi session to SCP through the `swarm mcp` shim: its relay tools become pi tools, and each message the shim pushes arrives
 * as a custom message that steers a running turn or, on an idle session, starts one.
 */
export default function scp(pi: ExtensionAPI) {
  let link: McpLink | undefined

  const warn = (ctx: ExtensionContext, text: string) => {
    if (ctx.hasUI) ctx.ui.notify(text, "warning")
  }

  pi.on("session_start", async (_event, ctx) => {
    if (process.env.SCP_PI === "0") return
    link?.close()
    const current = new McpLink(
      shimArgv(process.env),
      process.env,
      (content, meta) => {
        pi.sendMessage({ customType: "scp", content, display: true, details: meta }, { triggerTurn: true, deliverAs: "steer" })
      },
      (code) => {
        if (link === current) warn(ctx, `scp: the relay shim exited (${code ?? "error"}); relay tools are unavailable`)
      },
    )
    link = current
    try {
      await current.request("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: { experimental: { "claude/channel": {} } },
        clientInfo: { name: "pi", version: "1" },
      })
      const { tools } = (await current.request("tools/list")) as { tools?: McpTool[] }
      for (const tool of tools ?? []) {
        pi.registerTool({
          name: tool.name,
          label: tool.name,
          description: tool.description ?? tool.name,
          parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
          async execute(_id, params) {
            if (link !== current) throw new Error("this scp session ended")
            return toolResult((await current.request("tools/call", { name: tool.name, arguments: params ?? {} })) as CallResult)
          },
        })
      }
      current.notify("notifications/initialized")
    } catch (error) {
      warn(ctx, `scp: could not start the relay shim: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  pi.on("session_shutdown", async () => {
    link?.close()
    link = undefined
  })
}
