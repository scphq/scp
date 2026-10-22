import { type ChildProcess, spawn } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { WAKE_PROVIDER, type WakeDecline, type WakeJob, wakeDeclineOf } from "@scp-dev/core"
import type { FederatedCore } from "@scp-dev/hub"

export interface WakerConfig {
  command: string[]
  timeout_s: number
}

export type WakerConfigs = Record<string, WakerConfig>

const TIMEOUT_DEFAULT_S = 60
const TIMEOUT_MAX_S = 3600
const STDERR_KEEP = 1024
const STDOUT_KEEP = 4096
/** a waker's exit code for a decline, with `{"declined": "<reason>"}` on stdout */
export const WAKE_DECLINED_EXIT = 77

/** the decline a waker's exit 77 and stdout carry, or null */
function declineOf(code: number | null | undefined, stdout: string): WakeDecline | null {
  if (code !== WAKE_DECLINED_EXIT) return null
  try {
    return wakeDeclineOf((JSON.parse(stdout) as { declined?: unknown }).declined)
  } catch {
    return null
  }
}

/** a wakers.json object: `{ "<provider>": { "command": [argv...], "timeout_s"?: N } }`, other fields ignored; throws on anything else */
export function parseWakers(value: unknown): WakerConfigs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("wakers is an object of provider names")
  const out: WakerConfigs = {}
  for (const [provider, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!WAKE_PROVIDER.test(provider)) throw new Error(`${JSON.stringify(provider)} is not a provider name`)
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`waker ${provider} is not an object`)
    const { command, timeout_s } = entry as { command?: unknown; timeout_s?: unknown }
    if (!Array.isArray(command) || !command.length || !command.every((part) => typeof part === "string" && part.length > 0))
      throw new Error(`waker ${provider}: command is a nonempty array of strings`)
    const timeout = timeout_s ?? TIMEOUT_DEFAULT_S
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > TIMEOUT_MAX_S)
      throw new Error(`waker ${provider}: timeout_s is a whole number of seconds from 1 to ${TIMEOUT_MAX_S}`)
    out[provider] = { command: command as string[], timeout_s: timeout }
  }
  return out
}

export interface Wakers {
  /** whether a waker is configured for `provider` */
  known(provider: string): boolean
  /** runs the endpoint's wake hook when one is due, or once the one running ends; never throws, never waits */
  kick(endpoint: string): void
  /** kills the hooks still running */
  stop(): void
}

type RunResult = { ok: boolean; code?: number | null; error?: string; stdout: string }
type Outcome = { ok: boolean; code?: number | null; error?: string | null; declined?: WakeDecline }

/**
 * the broker's wake hooks: `wakers` as given, else the file at `path`, read again when its mtime changes. A malformed file is logged once
 * and configures nothing. At most one hook runs per endpoint; `changed` hears an endpoint whose shown wake failure changed
 */
export function startWakers(options: {
  core: FederatedCore
  path: string
  wakers?: Record<string, unknown> | undefined
  /** wakers configured whatever the file says, unless it or `wakers` names the same provider */
  builtin?: Record<string, unknown> | undefined
  dir: string
  machine: string
  now: () => number
  log: (line: string) => void
  changed: (endpoint: string) => void
}): Wakers {
  const busy = new Set<string>()
  /** endpoints kicked while their hook ran: kicked again once it ends */
  const missed = new Set<string>()
  const children = new Set<ChildProcess>()
  let stopped = false
  let fixed: WakerConfigs | null = null
  if (options.wakers !== undefined) {
    try {
      fixed = parseWakers(options.wakers)
    } catch (error) {
      options.log(`relay broker: the wakers are invalid (${message(error)}); no wake hook runs`)
      fixed = {}
    }
  }
  let builtin: WakerConfigs = {}
  if (options.builtin !== undefined) {
    try {
      builtin = parseWakers(options.builtin)
    } catch (error) {
      options.log(`relay broker: the built-in wakers are invalid (${message(error)})`)
    }
  }
  let loaded: { mtime: number; size: number; wakers: WakerConfigs } | null = null

  function configs(): WakerConfigs {
    return { ...builtin, ...configured() }
  }

  function configured(): WakerConfigs {
    if (fixed) return fixed
    const stat = statSync(options.path, { throwIfNoEntry: false })
    if (!stat) {
      loaded = null
      return {}
    }
    if (loaded && loaded.mtime === stat.mtimeMs && loaded.size === stat.size) return loaded.wakers
    let wakers: WakerConfigs = {}
    try {
      wakers = parseWakers(JSON.parse(readFileSync(options.path, "utf8")))
    } catch (error) {
      options.log(`relay broker: the wakers at ${options.path} are invalid (${message(error)}); no wake hook runs until it is fixed`)
    }
    loaded = { mtime: stat.mtimeMs, size: stat.size, wakers }
    return wakers
  }

  function finish(job: WakeJob, started: number, result: Outcome) {
    busy.delete(job.endpoint)
    if (stopped) return
    try {
      if (options.core.wakeResult(job.endpoint, { ...result, ms: options.now() - started, message: job.message.id })) options.changed(job.endpoint)
    } catch (error) {
      options.log(`relay broker: a wake result was not recorded: ${message(error)}`)
    }
    if (missed.delete(job.endpoint)) kick(job.endpoint)
  }

  /** runs the waker with stdin `input`, keeping the head of its stdout for a decline */
  function exec(config: WakerConfig, input: string, env: Record<string, string | undefined>): Promise<RunResult> {
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(config.command[0]!, config.command.slice(1), { stdio: ["pipe", "pipe", "pipe"], env, detached: true })
      } catch (error) {
        resolve({ ok: false, error: message(error), stdout: "" })
        return
      }
      children.add(child)
      let stdout = ""
      let stderr = ""
      let settled = false
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        kill(child)
      }, config.timeout_s * 1000)
      const settle = (result: RunResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        children.delete(child)
        resolve(result)
      }
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < STDOUT_KEEP) stdout += chunk.toString("utf8").slice(0, STDOUT_KEEP - stdout.length)
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < STDERR_KEEP) stderr += chunk.toString("utf8").slice(0, STDERR_KEEP - stderr.length)
      })
      child.on("error", (error) => settle({ ok: false, error: message(error), stdout: "" }))
      child.on("close", (code, signal) => {
        if (timedOut) settle({ ok: false, error: `timed out after ${config.timeout_s} s`, stdout: "" })
        else if (code === 0) settle({ ok: true, code, stdout })
        else {
          const last = stderr.trim().split("\n").at(-1)?.trim()
          settle({ ok: false, code, error: `${code === null ? `killed by ${signal}` : `exit ${code}`}${last ? `: ${last}` : ""}`, stdout })
        }
      })
      child.stdin?.on("error", () => {})
      child.stdin?.end(input)
    })
  }

  async function run(job: WakeJob, config: WakerConfig) {
    const started = options.now()
    const event = {
      scp: 1,
      event: "wake",
      endpoint: job.address,
      handle: job.handle,
      provider: job.provider,
      ref: job.ref,
      machine: options.machine,
      message: job.message,
      unread: job.unread,
    }
    const env: Record<string, string | undefined> = {
      ...process.env,
      SCP_DIR: options.dir,
      SCP_WAKE_ENDPOINT: job.address,
      SCP_WAKE_HANDLE: job.handle,
      SCP_WAKE_REF: job.ref ?? "",
      SCP_WAKE_PROVIDER: job.provider,
      SCP_WAKE_MESSAGE_ID: job.message.id,
      SCP_WAKE_FROM: job.message.from ?? "",
      SCP_WAKE_KIND: job.message.kind,
      SCP_WAKE_THREAD: job.message.thread,
      ...(job.ticket ? { SCP_WAKE_TICKET: job.ticket } : {}),
    }
    const result = await exec(config, `${JSON.stringify(event)}\n`, env)
    const declined = result.ok ? null : declineOf(result.code, result.stdout)
    finish(job, started, { ok: result.ok, code: result.code ?? null, ...(declined ? { declined } : { error: result.error ?? null }) })
  }

  function kick(endpoint: string) {
    try {
      if (stopped) return
      if (busy.has(endpoint)) {
        missed.add(endpoint)
        return
      }
      const job = options.core.wakeDue(endpoint, options.now())
      if (!job) return
      busy.add(endpoint)
      const config = configs()[job.provider]
      if (!config) {
        finish(job, options.now(), { ok: false, error: `no waker ${job.provider} is configured` })
        return
      }
      run(job, config).catch((error: unknown) => {
        busy.delete(endpoint)
        options.log(`relay broker: a wake hook failed: ${message(error)}`)
      })
    } catch (error) {
      busy.delete(endpoint)
      options.log(`relay broker: a wake hook did not start: ${message(error)}`)
    }
  }

  return {
    known: (provider) => Object.hasOwn(configs(), provider),
    kick,
    stop() {
      stopped = true
      for (const child of children) kill(child)
      children.clear()
    },
  }
}

function kill(child: ChildProcess) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
