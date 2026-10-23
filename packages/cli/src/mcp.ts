import { type Claim, CLI_NAME, validHandle } from "@scp-dev/core"
import { connectBroker, relayDir } from "@scp-dev/broker"
import { runRelayMcp, sessionInboxOf, type SpawnRequest } from "@scp-dev/mcp"
import { CHANNELS_ENV, RelayUsage, startDaemon } from "./common"
import { cloudWithoutBroker, coworkLive } from "./hook-fast"
import { spawnDetached } from "./spawn"
import { mcpInstall } from "./install"
import {
  appServer,
  CODEX_THREAD,
  harnessAt,
  harnessPid,
  type IdentityInput,
  launcherPid,
  type PsCommTable,
  psParent,
  readPsTable,
  relayIdentity,
  writeShimBinding,
} from "./identity"
import { membership } from "./session"
import { safeCwd } from "./cwd"

/** how often the shim checks that the harness that started it still runs: one reparented away from it exits, freeing the endpoint */
const ORPHAN_CHECK_MS = 5000

type Values = { as?: string; harness?: string; human?: boolean; channels?: boolean; "cowork-only"?: boolean }

/** `$SCP_WAKE_TICKET` as a claim's `ticket`: a waker that revives a session hands it to the session's shim, which takes the endpoint back with it */
export function wakeTicket(env: Record<string, string | undefined>): { ticket?: string } {
  const ticket = env.SCP_WAKE_TICKET
  return ticket && WAKE_TICKET.test(ticket) ? { ticket } : {}
}

const WAKE_TICKET = /^kwt_[0-9a-f]{64}$/

/** `swarm mcp`: the stdio MCP shim for this harness session, or `mcp install` */
export async function relayMcpCommand(values: Values, positionals: string[]): Promise<number> {
  if (positionals[0] === "install") {
    if (positionals.length > 1 || values.human || values.channels) throw new RelayUsage(`${CLI_NAME} mcp install takes --harness H and optionally --as NAME`)
    return mcpInstall(values.harness, values.as, (line) => process.stdout.write(`${line}\n`))
  }
  if (positionals.length) throw new RelayUsage(`${CLI_NAME} mcp takes no arguments (did you mean ${CLI_NAME} mcp install?)`)
  if (values.human) throw new RelayUsage("the relay MCP shim is always an agent: --human is not available to it")
  if (await coworkMcpGuard(values, { env: process.env, input: process.stdin, output: (line) => void process.stdout.write(line) })) return 0
  let table: { value: PsCommTable | undefined } | undefined
  let pid: number | undefined
  const input: IdentityInput = {
    ...(values.as !== undefined ? { as: values.as } : {}),
    ...(values.harness !== undefined ? { harness: values.harness } : {}),
    fallbackHarness: "mcp",
    cwd: safeCwd(),
    env: process.env,
    harnessPid: () => {
      pid ??= launcherPid(process.env) ?? harnessPid()
      return pid
    },
    inferHarness: (at) => harnessAt(at, input.psTable!()),
    psTable: () => {
      table ??= { value: readPsTable() }
      return table.value
    },
  }
  const claim = { ...relayIdentity(input), ...wakeTicket(process.env) }
  if (!validHandle(claim.handle)) throw new RelayUsage(`${JSON.stringify(claim.handle)} is not a valid agent handle (me, user and relay are reserved)`)
  const dir = relayDir(process.env)
  const threadClaim = threadClaims(input, claim)
  let unbind = threadClaim ? () => {} : writeShimBinding(claim, process.env)
  const bound = (next: Claim) => {
    unbind()
    unbind = writeShimBinding({ process: next.process ?? "", handle: next.handle ?? "", harness: next.harness ?? "" }, process.env)
  }
  const clear = () => unbind()
  process.on("exit", clear)
  const parent = process.ppid
  const orphaned = setInterval(() => {
    if (process.ppid !== parent) process.exit(0)
  }, ORPHAN_CHECK_MS)
  orphaned.unref()
  const inbox = sessionInboxOf(process.env)
  try {
    await runRelayMcp({
      connect: () => connectBroker(dir, () => startDaemon(dir)),
      claim,
      membership: (session) => membership(process.env, session),
      ...(threadClaim ? { threadClaim, deferClaim: true, bound } : {}),
      input: process.stdin,
      output: (line) => void process.stdout.write(line),
      env: process.env,
      channels: values.channels === true,
      launchedWithChannels: values.channels === true && launchedWithChannels(process.env),
      ...(inbox ? { sessionInbox: inbox } : {}),
      spawn: (request) => spawnDetached(spawnWords(request), request.cwd ?? claim.cwd),
      log: (line) => void process.stderr.write(`${line}\n`),
    })
  } finally {
    clearInterval(orphaned)
    process.off("exit", clear)
    unbind()
  }
  return 0
}

/** what in a shim's environment or flags names its session or thread: a shim with any of it is never thread-hosted */
const NAMED = ["CODEX_THREAD_ID", "SCP_CODEX_THREAD", "SCP_SESSION", "SCP_NAME", "SCP_SHIM_BINDING", "SCP_HARNESS_PID"]

const thread = (value: unknown): string | undefined => (typeof value === "string" && CODEX_THREAD.test(value) ? value : undefined)

/** the thread a codex tool call's `_meta` names; a subagent child's call names its root thread, as a child's tools act as its root */
export function callThread(meta: Record<string, unknown>): string | undefined {
  const own = thread(meta.threadId)
  if (!own) return undefined
  const turn = meta["x-codex-turn-metadata"]
  const parent = typeof turn === "object" && turn !== null ? thread((turn as Record<string, unknown>).parent_thread_id) : undefined
  const session = thread(meta.sessionId)
  return (session !== own ? session : undefined) ?? parent ?? own
}

/**
 * for a codex shim an app server starts per thread (no thread or launcher identity in its environment, no --as): the claim for the thread
 * a tool call names, as that thread's hooks make it; undefined for any other shim
 */
export function threadClaims(input: IdentityInput, claim: { harness: string }): ((meta: Record<string, unknown>) => Claim | undefined) | undefined {
  if (input.as !== undefined || (claim.harness !== "codex" && claim.harness !== "codex-desktop") || NAMED.some((key) => input.env[key])) return undefined
  if (!appServer((input.psTable ?? readPsTable)()?.get(input.harnessPid(claim.harness))?.args)) return undefined
  const claims = new Map<string, Claim>()
  return (meta) => {
    const id = callThread(meta)
    if (!id) return undefined
    const found = claims.get(id) ?? relayIdentity({ ...input, harnessSession: id })
    claims.set(id, found)
    return found
  }
}

/** relay_spawn's request as `swarm spawn --bg` words, acting as the shim's own agent */
export function spawnWords(request: SpawnRequest): string[] {
  return [
    "--bg",
    "--as",
    request.as,
    ...(request.harness !== undefined ? ["--harness", request.harness] : []),
    ...(request.name !== undefined ? ["--name", request.name] : []),
    ...(request.title !== undefined ? ["--title", request.title] : []),
    ...(request.no_push ? ["--no-push"] : []),
    ...(request.handback_bytes !== undefined ? ["--handback-bytes", String(request.handback_bytes)] : []),
    "--",
    ...request.command,
  ]
}

/** whether this shim's harness is the process `swarm claude` started with channels loaded: its parent is the launcher named in the environment */
export function launchedWithChannels(env: NodeJS.ProcessEnv, harness = harnessPid, parentOf = psParent): boolean {
  const launcher = Number(env[CHANNELS_ENV])
  return Number.isInteger(launcher) && launcher > 1 && parentOf(harness())?.ppid === launcher
}

/** the synced plugin remains connected without claiming a terminal session */
export async function coworkMcpGuard(
  values: Values,
  options: { env: Record<string, string | undefined>; input: AsyncIterable<string | Uint8Array>; output: (line: string) => void },
): Promise<boolean> {
  if (!values["cowork-only"]) return false
  if (cloudWithoutBroker(relayDir(options.env), options.env)) {
    await inertMcp(options.input, options.output, "SCP has no relay in this cloud session; use the SCP connector.")
    return true
  }
  if (coworkLive(options.env)) return false
  await inertMcp(options.input, options.output)
  return true
}

/** a newline-delimited MCP server with no tools or relay connection */
export async function inertMcp(
  input: AsyncIterable<string | Uint8Array>,
  output: (line: string) => void,
  instructions = "SCP is inactive outside Cowork.",
): Promise<void> {
  const decoder = new TextDecoder()
  let pending = ""
  const respond = (line: string) => {
    let request: { id?: string | number | null; method?: string; params?: { protocolVersion?: string } }
    try {
      request = JSON.parse(line)
    } catch {
      return
    }
    if (!request || request.id === undefined) return
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: request.params?.protocolVersion,
            capabilities: {},
            serverInfo: { name: "scp", version: "0.0.0" },
            instructions,
          }
        : request.method === "tools/list"
          ? { tools: [] }
          : request.method === "ping"
            ? {}
            : undefined
    output(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(result === undefined ? { error: { code: -32601, message: "Method not found" } } : { result }) })}\n`,
    )
  }
  for await (const chunk of input) {
    pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    for (;;) {
      const end = pending.indexOf("\n")
      if (end < 0) break
      respond(pending.slice(0, end))
      pending = pending.slice(end + 1)
    }
  }
  pending += decoder.decode()
  if (pending.trim()) respond(pending)
}
