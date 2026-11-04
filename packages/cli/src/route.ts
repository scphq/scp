import { spawn, spawnSync } from "node:child_process"
import { accessSync, appendFileSync, constants, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { constants as osConstants } from "node:os"
import { dirname, join, resolve } from "node:path"
import pkg from "../package.json" with { type: "json" }

// Runs before the rest of the CLI loads, so it takes node builtins and package.json only.

type Env = Record<string, string | undefined>

/** what the native `swarm` runs, as `swarm __verbs --json` prints it and release packaging keeps beside it as swarm-verbs.json */
export type Registry = { version: string; verbs: string[]; declines: string[]; decline_env: string[] }

export type Decision = { engine: "native"; bin: string; registry: Registry } | { engine: "ts"; reason: string }

export const REGISTRY_FILE = "swarm-verbs.json"

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

/** the verb of `argv`, past the `--as X`, `--as=X` and `--human` the CLI moves after it */
export function verbOf(argv: string[]): string | undefined {
  let i = 0
  while (i < argv.length) {
    if (argv[i] === "--as" && i + 1 < argv.length) i += 2
    else if (argv[i]!.startsWith("--as=") || argv[i] === "--human") i++
    else break
  }
  return i > 0 && i < argv.length ? argv[i] : argv[0]
}

/** whether `word` gives `flag`: a long flag alone or with `=value`, a short one anywhere in a short group */
export function gives(word: string, flag: string): boolean {
  if (flag.startsWith("--")) return word === flag || word.startsWith(`${flag}=`)
  return word.startsWith("-") && !word.startsWith("--") && word.length > 1 && word.slice(1).includes(flag.slice(1))
}

/** whether `argv` gives a flag, or `env` a variable, that the native verbs hand back to this CLI */
export function declined(argv: string[], env: Env, registry: Registry): boolean {
  const end = argv.indexOf("--")
  const words = end < 0 ? argv : argv.slice(0, end)
  if (words.some((word) => registry.declines.some((flag) => gives(word, flag)))) return true
  return registry.decline_env.some((pair) => {
    const at = pair.indexOf("=")
    return env[pair.slice(0, at)] === pair.slice(at + 1)
  })
}

/** the native swarm: `$SCP_SWARM_BIN`, else this platform's native package, when it is an executable file */
export function nativeBin(env: Env): string | undefined {
  try {
    const key = nativeKey()
    const bin = env.SCP_SWARM_BIN ? resolve(env.SCP_SWARM_BIN) : key ? createRequire(import.meta.url).resolve(`@scp-dev/native-${key}/bin/swarm`) : undefined
    if (!bin) return undefined
    accessSync(bin, constants.X_OK)
    return statSync(bin).isFile() ? bin : undefined
  } catch {
    return undefined
  }
}

function parseRegistry(text: string): Registry | undefined {
  try {
    const value = JSON.parse(text) as Partial<Registry>
    if (typeof value.version !== "string" || !Array.isArray(value.verbs)) return undefined
    return { version: value.version, verbs: value.verbs, declines: value.declines ?? [], decline_env: value.decline_env ?? [] }
  } catch {
    return undefined
  }
}

/** the registry beside `bin`, else what `bin __verbs --json` prints */
export function loadRegistry(bin: string, env: Env): Registry | undefined {
  try {
    return parseRegistry(readFileSync(join(dirname(bin), REGISTRY_FILE), "utf8"))
  } catch {}
  const result = spawnSync(bin, ["__verbs", "--json"], { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 10_000, maxBuffer: 1 << 20 })
  return result.status === 0 ? parseRegistry(result.stdout) : undefined
}

/** which CLI runs `argv`: the native swarm for a verb it registers, else this one, saying why */
export function decide(argv: string[], env: Env, version = pkg.version, locate = nativeBin, load = loadRegistry): Decision {
  if (env.SCP_ROUTED === "ts") return { engine: "ts", reason: "routed" }
  if (env.SCP_NATIVE !== "1") return { engine: "ts", reason: "off" }
  const verb = verbOf(argv)
  if (verb === undefined) return { engine: "ts", reason: "unported" }
  if (verb === "hook" || verb === "mcp") return { engine: "ts", reason: verb }
  const forced = (env.SCP_NATIVE_TS ?? "").split(/[\s,]+/).filter(Boolean)
  if (forced.includes("*") || forced.includes(verb)) return { engine: "ts", reason: "forced" }
  const bin = locate(env)
  const registry = bin ? load(bin, env) : undefined
  if (!bin || !registry) return { engine: "ts", reason: "missing" }
  if (registry.version !== version) return { engine: "ts", reason: "version" }
  if (!registry.verbs.includes(verb)) return { engine: "ts", reason: "unported" }
  if (declined(argv, env, registry)) return { engine: "ts", reason: "decline" }
  return { engine: "native", bin, registry }
}

/** appends `verb engine reason` to `$SCP_ROUTE_LOG` */
export function routeLog(env: Env, verb: string | undefined, engine: string, reason: string): void {
  if (!env.SCP_ROUTE_LOG) return
  try {
    appendFileSync(env.SCP_ROUTE_LOG, `${verb ?? "-"} ${engine} ${reason}\n`)
  } catch {}
}

/** this CLI as a command line, as `SELF` in term.ts has it */
function launch(): string[] {
  return [process.execPath, ...(process.versions.bun ? ["--no-env-file", "--config=/dev/null"] : []), process.argv[1]!]
}

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"] as const

/** runs `bin` as a child with this process's stdio, forwarding signals; leaves with its exit code, or dies of its signal */
function handOver(bin: string, argv: string[], env: Env): Promise<never> {
  const child = spawn(bin, argv, { stdio: "inherit", env: { ...env, SCP_CLI_PARENT: `${process.pid}:${process.ppid}` } as NodeJS.ProcessEnv })
  const forwards = FORWARDED.map((signal) => {
    const forward = () => child.kill(signal)
    process.on(signal, forward)
    return () => process.off(signal, forward)
  })
  return new Promise<never>(() => {
    child.once("error", (error) => {
      process.stderr.write(`swarm: the native swarm ${bin} did not start: ${error.message}\n`)
      process.exit(125)
    })
    child.once("exit", (code, signal) => {
      for (const off of forwards) off()
      if (code !== null) process.exit(code)
      const number = signal ? (osConstants.signals[signal] ?? 0) : 0
      if (signal) process.kill(process.pid, signal)
      setTimeout(() => process.exit(128 + number), 200)
    })
  })
}

/**
 * under `SCP_NATIVE=1`, hands a verb the native swarm registers to it: in place of this process (`process.execve`) where the runtime has
 * it, else as a child; returns when this CLI runs the command. `SCP_ROUTE_EXEC=spawn` takes the child path where execve exists too.
 */
export async function route(argv: string[] = process.argv.slice(2), env: Env = process.env): Promise<void> {
  const decision = decide(argv, env)
  delete env.SCP_ROUTED
  delete env.SCP_CLI_PARENT
  const verb = verbOf(argv)
  if (decision.engine === "ts") {
    if (decision.reason !== "off") routeLog(env, verb, "ts", decision.reason)
    return
  }
  const handed = { ...env, SCP_CLI_ARGV: JSON.stringify(launch()), SCP_ROUTED: "native" }
  const execve = (process as { execve?: (file: string, args: string[], env: Env) => never }).execve
  if (typeof execve === "function" && env.SCP_ROUTE_EXEC !== "spawn") {
    routeLog(env, verb, "native", "execve")
    try {
      execve.call(process, decision.bin, [decision.bin, ...argv], handed)
    } catch {}
  }
  routeLog(env, verb, "native", "spawn")
  await handOver(decision.bin, argv, handed)
}
