import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { createRequire } from "node:module"
import { constants as osConstants } from "node:os"
import { basename, isAbsolute, resolve } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { capture, note, SELF } from "./term"

const require = createRequire(import.meta.url)

export function nativeKey(platform = process.platform, arch = process.arch, glibc = linuxGlibc()): string | undefined {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `darwin-${arch}`
  if (platform === "linux" && (arch === "x64" || (arch === "arm64" && glibc))) return `linux-${arch}-${glibc ? "gnu" : "musl"}`
  return undefined
}

function linuxGlibc(): boolean {
  if (process.platform !== "linux") return false
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
  return Boolean(header?.glibcVersionRuntime)
}

/** `override`, else `name` from this platform's native package, when it is an executable file whose `--version` prints `<name> <version>` */
function nativeBinary(
  name: string,
  override: string | undefined,
  env: Record<string, string | undefined>,
  version: string,
  timeout = 2000,
): string | undefined {
  try {
    const key = nativeKey()
    const bin = override !== undefined ? resolve(override) : key ? require.resolve(`@scp-dev/native-${key}/bin/${name}`) : undefined
    if (!bin) return undefined
    accessSync(bin, constants.X_OK)
    if (!statSync(bin).isFile()) return undefined
    const result = spawnSync(bin, ["--version"], { env, encoding: "utf8", timeout, maxBuffer: 4096 })
    return result.status === 0 && result.stdout === `${name} ${version}\n` ? bin : undefined
  } catch {
    return undefined
  }
}

export function nativeHook(env: Record<string, string | undefined>, version: string): string | undefined {
  return nativeBinary("scp-hook", env.SCP_HOOK_BIN, env, version)
}

export function nativeSwarm(env: Record<string, string | undefined>, version: string): string | undefined {
  return nativeBinary("swarm", env.SCP_SWARM_BIN, env, version, 10_000)
}

/** the native broker's environment: `base` with the words that start this CLI, which its built-in wakers run */
export function nativeDaemonEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  env.SCP_CLI_ARGV = JSON.stringify(SELF)
  return env
}

/** with `SCP_NATIVE=1`, the native `swarm` that runs the broker, else undefined; a missing or mismatched one is noted and the TypeScript broker runs */
export function nativeBroker(env: Record<string, string | undefined> = process.env, version = pkg.version): string | undefined {
  if (env.SCP_NATIVE !== "1") return undefined
  const bin = nativeSwarm(env, version)
  if (!bin) {
    const key = nativeKey()
    const fix = key ? `install @scp-dev/native-${key} or set SCP_SWARM_BIN` : "set SCP_SWARM_BIN"
    note(`SCP_NATIVE=1 but no native swarm ${version} binary for ${process.platform}-${process.arch} (${fix}); starting the TypeScript broker`)
  }
  return bin
}

/** runs the native broker in the foreground, forwarding SIGTERM, SIGINT and SIGHUP (as SIGTERM); its exit code, 128 + n after signal n */
export function nativeDaemon(bin: string, dir: string, idle: string | undefined, policyFile: string | undefined): Promise<number> {
  const args = ["daemon", ...(idle !== undefined ? ["--idle", idle] : []), ...(policyFile ? ["--policy", resolve(policyFile)] : [])]
  const child = spawn(bin, args, { stdio: "inherit", env: nativeDaemonEnv({ ...process.env, SCP_DIR: dir }) })
  const forwards = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((signal) => {
    const forward = () => child.kill(signal === "SIGHUP" ? "SIGTERM" : signal)
    process.on(signal, forward)
    return () => process.off(signal, forward)
  })
  return new Promise((done) => {
    const finish = (code: number) => {
      for (const off of forwards) off()
      done(code)
    }
    child.once("error", (error) => {
      note(`the native broker ${bin} did not start: ${error.message}`)
      finish(1)
    })
    child.once("exit", (code, signal) => finish(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1)))
  })
}

/** `native` when process `pid` runs a native broker executable, `ts` for any other, undefined when the process table does not say */
export function brokerEngine(pid: number): "ts" | "native" | undefined {
  const program = capture(["ps", "-p", String(pid), "-o", "comm="], undefined, 2000)?.trim()
  if (!program) return undefined
  const name = basename(program)
  return name === "swarm" || name === "scp-broker" ? "native" : "ts"
}

/** an MCP server a harness runs: its command line and the variables the mount adds to its environment */
export type Mount = { argv: string[]; env: Record<string, string>; native: boolean }

/** the variables a native mount sets, which a mount through Node drops */
export const NATIVE_MOUNT_VARS = ["SCP_NATIVE", "SCP_SWARM_BIN", "SCP_CLI_ARGV"] as const

let mountNoted = false

/** forgets that a missing native swarm was noted, so the next mount notes it again */
export const resetMountNote = (): void => {
  mountNoted = false
}

/** with `SCP_NATIVE=1`, the native `swarm` whose `swarm mcp` a mount runs directly, else undefined; a missing or mismatched one is noted once and mounts run through Node */
export function nativeMountBin(env: Record<string, string | undefined>, version = pkg.version): string | undefined {
  if (env.SCP_NATIVE !== "1") return undefined
  const bin = nativeSwarm(env, version)
  if (!bin && !mountNoted) {
    mountNoted = true
    const key = nativeKey()
    const fix = key ? `install @scp-dev/native-${key} or set SCP_SWARM_BIN` : "set SCP_SWARM_BIN"
    note(`SCP_NATIVE=1 but no native swarm ${version} binary for ${process.platform}-${process.arch} (${fix}); MCP mounts run swarm mcp through Node`)
  }
  return bin
}

/**
 * the mount that runs `swarm mcp <words>`: under `SCP_NATIVE=1` the native `swarm` itself, told the words that start this CLI (`launch`)
 * and that it is native, so no Node process stays resident; otherwise `launch` followed by `mcp`
 */
export function mcpMount(launch: string[], words: string[], env: Record<string, string | undefined>, version = pkg.version): Mount {
  return mountWith(nativeMountBin(env, version), launch, words, env)
}

/** the mount that runs `swarm mcp <words>` on the native `bin` when there is one, else on `launch` */
export function mountWith(bin: string | undefined, launch: string[], words: string[], env: Record<string, string | undefined>): Mount {
  if (!bin) return { argv: [...launch, "mcp", ...words], env: {}, native: false }
  return {
    argv: [bin, "mcp", ...words],
    env: { SCP_NATIVE: "1", ...(env.SCP_SWARM_BIN ? { SCP_SWARM_BIN: bin } : {}), SCP_CLI_ARGV: JSON.stringify(launch) },
    native: true,
  }
}

/** the words after `mcp` in a mount's command line, else `fallback` */
export function mcpWords(argv: string[], fallback: string[]): string[] {
  const at = argv.indexOf("mcp")
  return at < 0 ? fallback : argv.slice(at + 1)
}

/** `vars` without the ones a native mount sets, then with `mount`'s */
export function mountVars(vars: Record<string, string>, mount: Mount): Record<string, string> {
  const kept = Object.entries(vars).filter(([key]) => !(NATIVE_MOUNT_VARS as readonly string[]).includes(key))
  return { ...Object.fromEntries(kept), ...mount.env }
}

/** whether `command` is an absolute path to no executable file, as a mount's native swarm is once an upgrade or uninstall removed it */
export function goneCommand(command: unknown): boolean {
  if (typeof command !== "string" || !isAbsolute(command)) return false
  try {
    accessSync(command, constants.X_OK)
    return !statSync(command).isFile()
  } catch {
    return true
  }
}
