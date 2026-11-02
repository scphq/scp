import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { createRequire } from "node:module"
import { constants as osConstants } from "node:os"
import { basename, resolve } from "node:path"
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
