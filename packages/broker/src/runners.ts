import { existsSync, readFileSync } from "node:fs"
import { findSecret, RUNNER_ATTACH, RUNNER_NAME, type EndpointView, type RunnerView, type ViaRecord } from "@scp-dev/core"
import type { FederatedCore } from "@scp-dev/hub"
import { accountHome } from "./paths"
import { runRunner } from "./runner-exec"

export interface Runner {
  command: string[]
  timeout_s: number
  stop?: string[]
  status?: string[]
  status_timeout_s?: number
}

export function parseRunnerConfig(text: string, path: string): Record<string, Runner> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${path} is not JSON`)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} maps runner names to {command, timeout_s?}`)
  const runners: Record<string, Runner> = Object.create(null)
  for (const [name, entry] of Object.entries(value)) {
    if (!RUNNER_NAME.test(name)) throw new Error(`${path}: runner ${JSON.stringify(name)} is not a valid name: lowercase letters, digits and -, at most 32`)
    const fields = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {}
    const argv = (field: string): string[] | undefined => {
      const words = fields[field]
      if (words === undefined && field !== "command") return undefined
      if (!Array.isArray(words) || !words.length || !words.every((w) => typeof w === "string" && w.length > 0))
        throw new Error(`${path}: runner ${name} needs ${field}, a non-empty list of words`)
      return [...words] as string[]
    }
    const timeout = (field: string, fallback: number, max: number): number => {
      const n = fields[field] === undefined || (field === "timeout_s" && fields[field] === null) ? fallback : fields[field]
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max) throw new Error(`${path}: runner ${name}'s ${field} is whole seconds, 1 to ${max}`)
      return n
    }
    const command = argv("command")!
    const stop = argv("stop"),
      status = argv("status")
    const statusTimeout = timeout("status_timeout_s", 5, 60)
    runners[name] = {
      command,
      timeout_s: timeout("timeout_s", 60, 3600),
      ...(stop ? { stop } : {}),
      ...(status ? { status } : {}),
      ...(fields.status_timeout_s !== undefined ? { status_timeout_s: statusTimeout } : {}),
    }
  }
  return runners
}

export function runnerEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(parent).filter(
      ([key]) =>
        !/^SCP_(?:NAME|SESSION|GRANT|PARENT|UNDER|HARNESS(?:_PID)?|SHIM_BINDING|SPAWN_RUNNER|AGY_CONVERSATION_FILE|LABELS|WAKE.*)$/.test(key) &&
        !key.startsWith("CLAUDE_CODE_") &&
        key !== "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    ),
  )
}

export function statusReply(stdout: string): { state: string; detail?: string; attach?: string } {
  try {
    const v = JSON.parse(stdout.trim()) as Record<string, unknown>
    if (!v || Array.isArray(v) || typeof v.state !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(v.state)) return { state: "unknown" }
    if (v.detail !== undefined && (typeof v.detail !== "string" || !/^[^\u0000-\u001f\u007f-\u009f]{0,200}$/.test(v.detail))) return { state: "unknown" }
    if (v.attach !== undefined && (typeof v.attach !== "string" || !RUNNER_ATTACH.test(v.attach))) return { state: "unknown" }
    return {
      state: v.state,
      ...(typeof v.detail === "string" && !findSecret(v.detail) ? { detail: v.detail } : {}),
      ...(typeof v.attach === "string" && !findSecret(v.attach) ? { attach: v.attach } : {}),
    }
  } catch {
    return { state: "unknown" }
  }
}

export function runnerInput(core: FederatedCore, record: ViaRecord, event: "stop" | "status") {
  const parent = core.whoami(record.spawner).address
  return {
    scp: 1,
    event,
    name: record.name,
    runner: record.runner,
    parent: core.machine ? `me/${core.machine}/${parent.slice(parent.indexOf("/") + 1)}` : parent,
    ...(record.address ? { address: record.address } : {}),
    ...(record.machine ? { machine: record.machine } : {}),
    ...(record.ref ? { ref: record.ref } : {}),
  }
}

export function runnerService(core: FederatedCore, path: string, now: () => number = Date.now) {
  const cache = new Map<string, { until: number; result: Promise<{ status: NonNullable<RunnerView["status"]>; attach?: string }> }>()
  function configs(): { runners: Record<string, Runner>; error?: string } {
    try {
      return { runners: existsSync(path) ? parseRunnerConfig(readFileSync(path, "utf8"), path) : {} }
    } catch (error) {
      return { runners: {}, error: (error as Error).message }
    }
  }
  function execute(record: ViaRecord, event: "stop" | "status", config: Runner, command: string[]) {
    return runRunner(
      { command, timeout_s: event === "status" ? (config.status_timeout_s ?? 5) : config.timeout_s },
      runnerInput(core, record, event),
      runnerEnvironment(process.env),
      accountHome(),
      "SIGKILL",
    )
  }
  async function enrich(views: EndpointView[]): Promise<EndpointView[]> {
    const { runners, error } = configs()
    for (const [key, value] of cache) if (value.until <= now()) cache.delete(key)
    await Promise.all(
      views.map(async (view) => {
        if (!view.runner) return
        const record = core.viaRecordFor(view.address)
        if (!record || record.ended_at !== null) return
        if (error !== undefined) {
          view.runner = { ...view.runner, status: { state: "error", detail: "invalid runners file", at: new Date(now()).toISOString() } }
          return
        }
        const config = runners[record.runner]
        if (!config?.status) return
        const key = JSON.stringify(record)
        let hit = cache.get(key)
        if (!hit || hit.until <= now()) {
          const result = execute(record, "status", config, config.status).then((r) => {
            const reply =
              r.code === 0
                ? statusReply(r.stdout)
                : r.code === 77
                  ? { state: "unknown" }
                  : { state: "error", detail: r.timedOut ? "timeout" : `exit ${r.code}` }
            const { attach, ...status } = reply as ReturnType<typeof statusReply>
            entry.until = now() + 15_000
            return { status: { ...status, at: new Date(now()).toISOString() }, ...(attach ? { attach } : {}) }
          })
          const entry = { until: Infinity, result }
          hit = entry
          cache.set(key, hit)
        }
        const result = await hit.result
        const current = core.viaRecordFor(view.address)
        if (current?.ended_at === null && JSON.stringify(current) === key) view.runner = { ...view.runner, ...result }
      }),
    )
    return views
  }
  return {
    enrich,
    async stop(record: ViaRecord): Promise<{ name: string; stop: "stopped" | "declined" | "failed" | "timeout" | "none"; code?: number; stderr?: string }> {
      const { runners, error } = configs()
      if (error !== undefined) return { name: record.runner, stop: "failed", stderr: error }
      const config = runners[record.runner]
      if (!config?.stop) return { name: record.runner, stop: "none" }
      const result = await execute(record, "stop", config, config.stop)
      return {
        name: record.runner,
        stop: result.timedOut ? "timeout" : result.code === 0 ? "stopped" : result.code === 77 ? "declined" : "failed",
        code: result.code,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      }
    },
  }
}
