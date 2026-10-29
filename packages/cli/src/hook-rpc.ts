import { Readable } from "node:stream"
import { realpathSync } from "node:fs"
import { dirname, isAbsolute, relative } from "node:path"
import type { HookHandler, HookParams, HookProc, HookResult, RelayClient } from "@scp-dev/broker"
import { harnessAt, hookHarnessPid, psParent, readPsTable, type PsCommTable } from "./identity"
import { runHook } from "./hooks"

export const HOOK_ENV = [
  "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_CONVERSATION_ID",
  "CLAUDECODE",
  "CLAUDE_BG_SOURCE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_IS_COWORK",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_KIND",
  "CLAUDE_CODE_WORKSPACE_HOST_PATHS",
  "CLAUDE_PID",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
  "GROK_HOOK_EVENT",
  "GROK_SESSION_ID",
  "HOME",
  "MUSE_SESSION_ID",
  "OPENCODE",
  "OPENCODE_PID",
  "PATH",
  "PWD",
  "SCP_AGY_CONVERSATION_FILE",
  "SCP_CODEX_THREAD",
  "SCP_DIR",
  "SCP_GRANT",
  "SCP_HARNESS",
  "SCP_HARNESS_DETECT",
  "SCP_HARNESS_PID",
  "SCP_LABELS",
  "SCP_NAME",
  "SCP_PARENT",
  "SCP_PUSH_WAIT",
  "SCP_SESSION",
  "SCP_SHIM_BINDING",
  "SCP_TLDR_EVERY",
  "SCP_TRANSPORT",
  "SCP_UNDER",
  "SCP_WAKE",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
] as const

export function hookEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(HOOK_ENV.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]!]])))
}

export function hookProcs(ppid: number, env: Record<string, string | undefined>, table = readPsTable(), parent = psParent(ppid)): HookProc[] {
  const procs = new Map<number, HookProc>()
  for (const root of [ppid, Number(env.CLAUDE_PID), Number(env.OPENCODE_PID), Number(env.SCP_HARNESS_PID)]) {
    let at = root
    while (Number.isSafeInteger(at) && at > 0 && procs.size < 64 && !procs.has(at)) {
      const entry = table?.get(at)
      if (!entry) {
        if (at === ppid && parent) {
          procs.set(at, { pid: at, ppid: parent.ppid, start: null, args: "", comm: parent.comm })
          at = parent.ppid
          continue
        }
        break
      }
      procs.set(at, {
        pid: at,
        ...entry,
        start: /^[A-Za-z0-9:-]{1,64}$/.test(entry.start) ? entry.start : null,
        ...(at === ppid ? { comm: parent?.comm ?? "" } : {}),
      })
      at = entry.ppid
    }
  }
  return [...procs.values()]
}

const LINE_LIMIT = 245760
export function shrinkHook(params: HookParams, id: number | string = 2): HookParams {
  const fits = (value: HookParams) => Buffer.byteLength(`${JSON.stringify({ jsonrpc: "2.0", id, method: "hook", params: value })}\n`) <= LINE_LIMIT
  if (fits(params)) return params
  const shrink = (value: unknown, cut: number): unknown => {
    if (typeof value === "string") return Array.from(value).slice(0, cut).join("")
    if (Array.isArray(value)) return value.slice(0, 64).map((item) => shrink(item, cut))
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item, cut)]))
    return value
  }
  for (const cut of [8192, 1024, 128]) {
    const candidate = { ...params, payload: shrink(params.payload, cut) as Record<string, unknown> }
    if (fits(candidate)) return candidate
  }
  return {
    ...params,
    payload: Object.fromEntries(
      Object.entries(params.payload).filter(
        ([, value]) =>
          value === null || typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && Array.from(value).length <= 128),
      ),
    ),
  }
}

export function procOptions(params: HookParams) {
  const table: PsCommTable = new Map(params.procs.map((entry) => [entry.pid, { ppid: entry.ppid, start: entry.start ?? "", args: entry.args }]))
  const parentOf = (pid: number) => {
    const entry = params.procs.find((proc) => proc.pid === pid)
    return entry ? { ppid: entry.ppid, comm: entry.comm ?? "" } : undefined
  }
  return {
    psTable: () => table,
    inferHarness: (pid: number) => harnessAt(pid, table, params.env),
    startOf: (pid: number) => table.get(pid)?.start || undefined,
    harnessPid: (harness: string) => params.harness_pid ?? hookHarnessPid(params.env, harness, params.ppid, parentOf),
  }
}

export function hookHandler(dir: string, configDir: string): HookHandler {
  const allowed = (path: string) => {
    try {
      const parent = realpathSync(dirname(path))
      return [dir, configDir].some((root) => {
        const rel = relative(realpathSync(root), parent)
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
      })
    } catch {
      return false
    }
  }
  return async (params, context) => {
    let ends = params.ends
    const clients = new Set<RelayClient>()
    const watcher = setInterval(() => {
      if (context.closed() || Date.now() >= ends) for (const client of clients) client.close()
    }, 25)
    try {
      const stdout = await runHook(params.args, {
        env: params.env,
        stateDir: dir,
        cwd: [params.cwd, params.env.PWD, params.env.HOME].find((path) => path && isAbsolute(path)) ?? "/",
        stdin: Readable.from([JSON.stringify(params.payload)]),
        began: params.origin,
        ...procOptions(params),
        deadline: (ms) => {
          ends = params.origin + ms
          context.notify(ends)
        },
        remaining: () => ends - Date.now(),
        stopping: context.closed,
        print: context.print,
        allowWrite: allowed,
        connect: async () => {
          const client = await context.connect()
          clients.add(client)
          return client
        },
      })
      return { ...(stdout ? { stdout } : {}), exit: 0 }
    } finally {
      clearInterval(watcher)
      for (const client of clients) client.close()
    }
  }
}

/** Returns undefined only when the broker has no hook capability. */
export async function relayHookRpc(
  client: RelayClient,
  input: HookParams | (() => HookParams),
  print: (stdout: string) => boolean | Promise<boolean>,
  deadline: (ends: number) => void,
  stderr: (text: string) => void = () => {},
): Promise<HookResult | undefined> {
  const hello = await client.hello({ observe: true })
  if (!hello.capabilities.includes("hook")) return undefined
  const params = typeof input === "function" ? input() : input
  client.onNotification((method, value) => {
    const ends = (value as { ends?: unknown } | null)?.ends
    if (method === "hook_deadline" && typeof ends === "number" && Number.isFinite(ends)) {
      params.ends = ends
      deadline(ends)
    }
  })
  const result = await client.request<HookResult>("hook", shrinkHook(params))
  if (result.stderr) stderr(result.stderr.split(/\r?\n/)[0]!)
  if (result.stdout && (await print(result.stdout)) && result.commit && Date.now() < params.ends) await client.request("hook_commit", { commit: result.commit })
  return result
}
