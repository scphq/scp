import { resolve } from "node:path"
import { mcpBinary } from "../../conformance/src/environment"

export { mcpBinary }

/** which MCP server a test runs: this package's runRelayMcp, or the native binary SCP_MCP_BIN names */
export type ServerMode = "ts" | "native"
export const serverModes: ServerMode[] = mcpBinary ? ["ts", "native"] : ["ts"]

/** the native server's test setup, as its SCP_MCP_TEST takes it */
export interface NativeSpec {
  socket: string
  claim: object
  env?: Record<string, string>
  channels?: boolean
  launched?: boolean
  wake?: string
  version?: string
  heartbeat_ms?: number
  defer_claim?: boolean
  membership?: { dark: string } | { handle?: string }
  thread_claims?: Record<string, object>
  session_inbox?: { socket: string; token?: string; sessionId?: string }
  spawn?: { pid: number; name?: string; fallback?: string; error?: string; refuse?: Record<string, string>; log?: string }
}

export interface NativeServer {
  /** each JSON-RPC line it wrote, newline included */
  lines: string[]
  /** what it wrote to stderr, a line each: its log, and `test: connect` / `test: bound <session>` */
  logged: string[]
  /** writes a chunk to its stdin; null ends the input */
  raw: (chunk: string | null) => void
  /** resolves once it exited and its output is read */
  done: Promise<void>
}

async function readLines(stream: ReadableStream<Uint8Array>, into: string[], newline: boolean) {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      into.push(buffer.slice(0, nl) + (newline ? "\n" : ""))
      buffer = buffer.slice(nl + 1)
    }
  }
  if (buffer) into.push(buffer)
}

/** the native MCP server over stdio under `spec` */
export function startNative(spec: NativeSpec): NativeServer {
  if (!mcpBinary) throw new Error("SCP_MCP_BIN is not set")
  const child = Bun.spawn([resolve(mcpBinary)], {
    env: { ...process.env, SCP_MCP_TEST: JSON.stringify(spec) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const lines: string[] = []
  const logged: string[] = []
  const read = Promise.all([readLines(child.stdout, lines, true), readLines(child.stderr, logged, false)])
  let ended = false
  return {
    lines,
    logged,
    raw: (chunk) => {
      if (ended) return
      if (chunk === null) {
        ended = true
        void child.stdin.end()
        return
      }
      child.stdin.write(chunk)
      void child.stdin.flush()
    },
    done: Promise.all([child.exited, read]).then(() => {}),
  }
}
