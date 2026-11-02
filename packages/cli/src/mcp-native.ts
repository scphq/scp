import { spawn } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { FAILED, note, SELF } from "./term"

type Env = Record<string, string | undefined>

/** the native MCP server binary `swarm mcp` hands its session to: with $SCP_NATIVE=1, $SCP_MCP_BIN when it is an executable file */
export function nativeMcpBin(env: Env): string | undefined {
  if (env.SCP_NATIVE !== "1") return undefined
  const bin = env.SCP_MCP_BIN
  try {
    if (bin && isAbsolute(bin) && statSync(bin).isFile()) {
      accessSync(bin, constants.X_OK)
      return bin
    }
  } catch {}
  note(`no usable native MCP server (${bin ? `${bin} is not an executable file` : "SCP_MCP_BIN is unset"}); the built-in one serves this session`)
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
