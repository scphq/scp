import { existsSync } from "node:fs"

/** Claude subagents receive tool context only from foreground hooks. */
export const SUBAGENT = "--subagent"
export const STDIN_CAP = 8 * 1024 * 1024

let preread: string | undefined

/** whether this process runs inside a Cowork session, local or cloud */
export function coworkLive(env: Record<string, string | undefined>): boolean {
  return env.CLAUDE_CODE_IS_COWORK === "1" || env.CLAUDE_CODE_ENTRYPOINT === "remote_cowork"
}

/** a cloud Cowork session with no broker dir, which reaches the relay through the remote connector instead */
export function cloudWithoutBroker(dir: string, env: Record<string, string | undefined>): boolean {
  return env.CLAUDE_CODE_ENTRYPOINT === "remote_cowork" && !existsSync(dir)
}

/** `start` unless this is a cloud Cowork session without a broker dir, where the connection fails at once instead */
export function coworkBrokerStart(dir: string, env: Record<string, string | undefined>, start: () => void): (() => void) | undefined {
  return cloudWithoutBroker(dir, env) ? undefined : start
}

export async function readCapped(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    const taken = bytes.subarray(0, STDIN_CAP - size)
    chunks.push(taken)
    size += taken.length
    if (size >= STDIN_CAP) break
  }
  return Buffer.concat(chunks, size).toString("utf8")
}

/** whether `argv` is a {@link SUBAGENT} hook whose payload names no subagent (no agent_id): a main-thread event, which it leaves at once */
export function subagentSkip(argv: string[], payload: string): boolean {
  return argv[0] === "hook" && argv.includes(SUBAGENT) && !/"agent(_id|Id)"/.test(payload)
}

/** Reads subagent payloads before loading the CLI; matching payloads are handed to the runtime once. */
export async function subagentFastPath(argv: string[]): Promise<boolean> {
  if (argv[0] === "hook" && argv.includes("--cowork-only") && !coworkLive(process.env)) return true
  if (!(argv[0] === "hook" && argv.includes(SUBAGENT))) return false
  const payload = await readCapped(process.stdin)
  if (subagentSkip(argv, payload)) return true
  preread = payload
  return false
}

/** the hook payload the entry already read from stdin, once; undefined when it read none */
export function prereadStdin(): string | undefined {
  const payload = preread
  preread = undefined
  return payload
}
