import { spawn } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { nativeKey, nativeSwarm } from "./native"
import { FAILED, note, SELF } from "./term"

type Env = Record<string, string | undefined>

/** the native MCP server `swarm mcp` hands its session to: its binary and the words before the caller's */
export type NativeMcp = { bin: string; words: string[] }

/**
 * with $SCP_NATIVE=1, the native MCP server: $SCP_MCP_BIN when set (an executable file, run with the words as is), else the native
 * `swarm` that matches this CLI (run as `swarm mcp`); undefined, with a note, when there is none
 */
export function nativeMcp(env: Env, version = pkg.version): NativeMcp | undefined {
  if (env.SCP_NATIVE !== "1") return undefined
  const bin = env.SCP_MCP_BIN
  if (bin === undefined) {
    const swarm = nativeSwarm(env, version)
    if (swarm) return { bin: swarm, words: ["mcp"] }
    const key = nativeKey()
    note(
      `no usable native MCP server (no native swarm ${version}: ${key ? `install @scp-dev/native-${key}, ` : ""}set SCP_SWARM_BIN or SCP_MCP_BIN); the built-in one serves this session`,
    )
    return undefined
  }
  try {
    if (isAbsolute(bin) && statSync(bin).isFile()) {
      accessSync(bin, constants.X_OK)
      return { bin, words: [] }
    }
  } catch {}
  note(`no usable native MCP server (${bin} is not an executable file); the built-in one serves this session`)
  return undefined
}

const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"] as const

/**
 * `swarm mcp <args>` on the native server: stdio inherited, signals forwarded, its exit code (or signal) passed on. It learns this
 * process's parent, which it serves as, and how to start this CLI. Undefined when it could not start
 */
export async function runNativeMcp(bin: string, args: string[], self: string[] = SELF): Promise<number | undefined> {
  const child = spawn(bin, args, {
    stdio: "inherit",
    env: { ...process.env, SCP_SHIM_PPID: String(process.ppid), SCP_CLI_ARGV: JSON.stringify(self) },
  })
  const started = await new Promise<boolean>((resolve) => {
    child.once("spawn", () => resolve(true))
    child.once("error", () => resolve(false))
  })
  if (!started) {
    note(`could not start the native MCP server ${bin}; the built-in one serves this session`)
    return undefined
  }
  const forward = (signal: NodeJS.Signals) => void child.kill(signal)
  for (const signal of FORWARDED) process.on(signal, forward)
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.once("exit", (...exit) => resolve(exit)))
  for (const signal of FORWARDED) process.off(signal, forward)
  if (signal) process.kill(process.pid, signal)
  return code ?? FAILED
}
