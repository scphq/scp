import { spawn, spawnSync } from "node:child_process"
import { accessSync, appendFileSync, constants, fstatSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { constants as osConstants } from "node:os"
import { dirname, join, resolve } from "node:path"
import pkg from "../package.json" with { type: "json" }

// Runs before the rest of the CLI loads, so it takes node builtins and package.json only.

type Env = Record<string, string | undefined>

/**
 * what the native `swarm` runs, as `swarm __verbs --json` prints it and release packaging keeps beside it as swarm-verbs.json; a verb in
 * `subverbs` runs natively only with one of those words right after it. With `ts_verbs`, every word but those goes native, which answers
 * one it does not know itself
 */
export type Registry = {
  version: string
  verbs: string[]
  subverbs?: Record<string, string[]>
  ts_verbs?: string[]
  declines: string[]
  decline_env: string[]
}

export type Decision = { engine: "native"; bin: string; registry: Registry } | { engine: "ts"; reason: string; bin?: string }

export const REGISTRY_FILE = "swarm-verbs.json"

/** how long `swarm __verbs` may take when no swarm-verbs.json lies beside the binary: long enough for a loaded machine */
const PROBE_MS = 60_000
/** a hook's share of that: its harness gives it a second or two, so it stays here rather than wait */
const HOOK_PROBE_MS = 500

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
    return {
      version: value.version,
      verbs: value.verbs,
      subverbs: value.subverbs ?? {},
      ...(value.ts_verbs ? { ts_verbs: value.ts_verbs } : {}),
      declines: value.declines ?? [],
      decline_env: value.decline_env ?? [],
    }
  } catch {
    return undefined
  }
}

/** the registry beside `bin`, else what `bin __verbs --json` prints; `slow` when it did not answer in time */
export function loadRegistry(bin: string, env: Env, budget = PROBE_MS): Registry | "slow" | undefined {
  try {
    const beside = parseRegistry(readFileSync(join(dirname(bin), REGISTRY_FILE), "utf8"))
    if (beside) return beside
  } catch {}
  const timeout = Number(env.SCP_ROUTE_PROBE_MS) || budget
  const result = spawnSync(bin, ["__verbs", "--json"], { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout, maxBuffer: 1 << 20 })
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return "slow"
  return result.status === 0 ? parseRegistry(result.stdout) : undefined
}

type Execve = (file: string, args: string[], env: Env) => never

/** `process.execve`, unless this runtime lacks it or `SCP_ROUTE_EXEC=spawn` asks for the child path */
function execveOf(env: Env): Execve | undefined {
  const execve = (process as { execve?: Execve }).execve
  return typeof execve === "function" && env.SCP_ROUTE_EXEC !== "spawn" ? execve : undefined
}

/** which CLI runs `argv`: the native swarm for a verb it registers, else this one, saying why */
export function decide(argv: string[], env: Env, version = pkg.version, locate = nativeBin, load = loadRegistry): Decision {
  if (env.SCP_ROUTED === "ts") return { engine: "ts", reason: "routed" }
  if (env.SCP_NATIVE !== "1") return { engine: "ts", reason: "off" }
  const verb = verbOf(argv) ?? "help"
  const forced = (env.SCP_NATIVE_TS ?? "").split(/[\s,]+/).filter(Boolean)
  if (forced.includes("*") || forced.includes(verb)) return { engine: "ts", reason: "forced" }
  // a native hook gives way to this CLI on a broker that runs no hooks, whose walk would start at a router still standing above it
  if (verb === "hook" && !execveOf(env)) return { engine: "ts", reason: "spawn" }
  const bin = locate(env)
  if (!bin) return { engine: "ts", reason: "missing" }
  const registry = load(bin, env, verb === "hook" ? HOOK_PROBE_MS : PROBE_MS)
  if (registry === "slow") return { engine: "ts", reason: "slow", bin }
  if (!registry) return { engine: "ts", reason: "unreadable", bin }
  if (registry.version !== version) return { engine: "ts", reason: "version" }
  if (registry.ts_verbs ? registry.ts_verbs.includes(verb) : !registry.verbs.includes(verb)) return { engine: "ts", reason: "unported" }
  const words = registry.subverbs?.[verb]
  if (words && !words.includes(argv[argv.indexOf(verb) + 1] ?? "")) return { engine: "ts", reason: "unported" }
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

/** the caller's own `SCP_CLI_ARGV`, which the router replaces with its launch words; the native swarm hands it on to a harness */
export const GIVEN_ARGV = "SCP_CLI_ARGV_GIVEN"

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

/** whether `fd` is open */
function open(fd: number): boolean {
  try {
    fstatSync(fd)
    return true
  } catch {
    return false
  }
}

/**
 * a detached spawn's runner: Node and Bun mark fd 3, its handshake pipe, close-on-exec as they start, so neither execve nor {@link handOver}
 * carries it. The native swarm starts as a child in its own session with fd 3 passed on, and this process leaves, so no router stays resident
 */
function handOff(bin: string, argv: string[], env: Env): Promise<never> {
  const child = spawn(bin, argv, { stdio: ["inherit", "inherit", "inherit", 3], detached: true, env: env as NodeJS.ProcessEnv })
  return new Promise<never>(() => {
    child.once("error", () => process.exit(125))
    child.once("spawn", () => {
      child.unref()
      process.exit(0)
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
    if (decision.bin)
      process.stderr.write(`swarm: the native swarm ${decision.bin} did not answer __verbs (${decision.reason}), so the TypeScript CLI runs this command\n`)
    return
  }
  const { [GIVEN_ARGV]: _stale, ...rest } = env
  const handed = {
    ...rest,
    ...(env.SCP_CLI_ARGV !== undefined ? { [GIVEN_ARGV]: env.SCP_CLI_ARGV } : {}),
    SCP_CLI_ARGV: JSON.stringify(launch()),
    SCP_ROUTED: "native",
    ...(verb === "hook" ? { SCP_HOOK_ORIGIN: String(Math.round(performance.timeOrigin)) } : {}),
  }
  if (verb === "spawn" && env.SCP_SPAWN_RUNNER !== undefined && open(3)) {
    routeLog(env, verb, "native", "handoff")
    await handOff(decision.bin, argv, handed)
  }
  const execve = execveOf(env)
  if (execve) {
    routeLog(env, verb, "native", "execve")
    try {
      execve.call(process, decision.bin, [decision.bin, ...argv], handed)
    } catch {}
  }
  routeLog(env, verb, "native", "spawn")
  await handOver(decision.bin, argv, handed)
}
