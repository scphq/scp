import { MCP_PROTOCOLS } from "@scp-dev/core"
import {
  text,
  statusLine,
  str,
  shownRows,
  bool,
  selectors,
  oneOf,
  heldText,
  sentContent,
  redactedText,
  scopeText,
  groupText,
  seconds,
  recipients,
  seenText,
  peekTurns,
  quote,
  delivered,
  ToolInputError,
  TOOLS,
  listLine,
  askText,
} from "@scp-dev/core"
export { TOOLS } from "@scp-dev/core"
import { statSync } from "node:fs"
import { connect as connectSocket } from "node:net"
import { isAbsolute } from "node:path"
import {
  type AskResult,
  type Claim,
  CLI_NAME,
  deliveryText,
  type EndpointView,
  type Envelope,
  LIMITS,
  type MessageReceipts,
  type PeekResult,
  type PeekSeen,
  type PeekState,
  type SendResult,
  type PeerView,
  PREAMBLE,
  reachLines,
  receiptLines,
  RelayError,
  type ScopeChange,
  type ScopeView,
  shortId,
  STATUS_STATES,
  type ThreadMessage,
  type Wake,
  type WhyResult,
  widenText,
  wrapMessage,
  wrapPeek,
} from "@scp-dev/core"
import { setTimeout as sleep } from "node:timers/promises"
import type { HelloResult, RelayClient } from "@scp-dev/broker"

export { MCP_PROTOCOLS } from "@scp-dev/core"

export const INSTRUCTIONS = [
  PREAMBLE,
  "",
  "Use relay_list to see the other agents on this machine, and relay_send or relay_ask to message one by its address.",
  "Read messages for you with relay_inbox and reply with relay_reply when an answer is useful; keep your own line current with relay_set_status and relay_set_title.",
  `Messages reach you by themselves, at your next turn or by a wake that revives you, so never poll relay_inbox or ${CLI_NAME} inbox in a loop: end your turn instead; wait_s / --wait is for one short wait.`,
  'A message marked relation="parent" is from the agent that started you and gave you your task: it continues that task, so apply it before you finish, the newer instruction winning, still only within what your user authorised.',
  "Optionally set your title and a one-line now with relay_set_title / relay_set_now so peers can find you; skip it when you only run workers.",
  `To hand work to another agent, call relay_spawn with its harness command (e.g. command ["codex", "exec", "..."], or ${CLI_NAME} spawn codex exec "..." from your shell): it returns at once with the worker's name; its messages and its result reach you by themselves as relay messages, relay_send to its name steers it meanwhile, and relay_status with a message id says when it read it.`,
  "You see and reach only agents in your scope: relay_peers says why each is reachable; relay_rules and relay_group narrow who may message you.",
  "Never put credentials in a message: send a reference instead.",
].join("\n")

export interface RelayMcpOptions {
  /** a fresh connection to the broker (starting it if needed) */
  connect: () => Promise<RelayClient>
  /** the agent endpoint this shim claims: never the human inbox */
  claim: Claim
  /** MCP requests, newline-delimited JSON-RPC */
  input: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>
  /** one JSON-RPC line, newline included */
  output: (line: string) => void
  /** whether `session` is on the relay now: `dark` (why not) keeps the shim from claiming, `handle` is the name it joined under */
  membership?: (session: string) => { dark: string } | { handle?: string }
  /** the claim for the thread a tools/call's `_meta` names, undefined when it names none: the first such call binds the shim to it for good */
  threadClaim?: (meta: Record<string, unknown>) => Claim | undefined
  /** claim nothing until a tools/call binds a claim: the thread its `_meta` names, else {@link claim} */
  deferClaim?: boolean
  /** called with the claim a deferred shim binds on its first tools/call */
  bound?: (claim: Claim) => void
  /** HOME shortens cwds in relay_list */
  env?: Record<string, string | undefined>
  /** push deliveries as `notifications/claude/channel` to a client that declares `claude/channel` or was launched with channels */
  channels?: boolean
  /** the client was started with channels loaded (Claude Code does not declare the capability itself) */
  launchedWithChannels?: boolean
  /** Claude Code's per-session inbox socket (CLAUDE_CODE_MESSAGING_SOCKET): with channels enabled but not loaded, as in a background session, deliveries are queued there as the next turn */
  sessionInbox?: SessionInbox
  /** the wake the endpoint advertises while this shim pushes by channel, over `pi` for a pi client and `channels` for any other */
  wake?: Wake
  version?: string
  /** starts a worker for relay_spawn, resolving with its name and its runner's pid once its harness started; without it there is no relay_spawn */
  spawn?: (request: SpawnRequest) => Promise<{ name: string; pid: number }>
  /** diagnostics, never stdout */
  log?: (line: string) => void
  heartbeatMs?: number
}

/**
 * what relay_spawn asks for: `swarm spawn --bg` of `command` with these flags, acting as `as`, the shim's own address, of `harness`,
 * in `cwd`: the one asked for, else the caller's working directory when it exists, else (none) the shim's
 */
export interface SpawnRequest {
  command: string[]
  as: string
  harness?: string
  name?: string
  title?: string
  no_push?: boolean
  handback_bytes?: number
  /** the directory the worker runs in, absolute and existing */
  cwd?: string
}

type Json = Record<string, unknown>
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> }

const MAX_INPUT_LINE = 4 * 1024 * 1024
const DELIVERED_KEEP = 500
const ASK_WAIT_DEFAULT_S = 30

/** relay_spawn's arguments as a spawn request, all but who spawns; a `cwd` must be an existing directory's absolute path */
function spawnRequest(args: Json): Omit<SpawnRequest, "as" | "harness"> {
  if ((args.command === undefined) === (args.harness === undefined)) throw new ToolInputError("give command (the harness command as argv) or harness and task")
  let command: string[]
  if (args.command !== undefined) {
    const words = args.command
    if (!Array.isArray(words) || !words.length || !words.every((w) => typeof w === "string") || !String(words[0]).trim())
      throw new ToolInputError('command must be the harness command as a list of words, e.g. ["codex", "exec", "<task>"]')
    if (args.task !== undefined || args.model !== undefined) throw new ToolInputError("task and model go with harness; with command, put them in it")
    command = words as string[]
  } else {
    const harness = oneOf(args, "harness", ["claude", "codex"] as const)
    const model = str(args, "model")
    command = [...(harness === "claude" ? ["claude", "-p"] : ["codex", "exec"]), str(args, "task", true), ...(model ? ["--model", model] : [])]
  }
  const bytes = args.handback_bytes
  if (bytes !== undefined && (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1 || bytes > LIMITS.handbackBytes))
    throw new ToolInputError(`handback_bytes must be whole bytes, 1 to ${LIMITS.handbackBytes}`)
  const name = args.name === undefined ? undefined : str(args, "name", true)
  const title = str(args, "title")
  const noPush = bool(args, "no_push")
  const cwd = str(args, "cwd")
  if (cwd !== undefined && !isAbsolute(cwd)) throw new ToolInputError("cwd must be an absolute path")
  if (cwd !== undefined && !isDirectory(cwd)) throw new ToolInputError(`cwd ${cwd} is not an existing directory`)
  return {
    command,
    ...(name ? { name } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(noPush ? { no_push: true } : {}),
    ...(bytes !== undefined ? { handback_bytes: bytes } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const capped = (wait: unknown): boolean => typeof wait === "number" && wait > LIMITS.waitMaxS

async function* chunks(input: RelayMcpOptions["input"]): AsyncIterable<Uint8Array | string> {
  if (!("getReader" in input)) return yield* input
  const reader = input.getReader()
  for (let read = await reader.read(); !read.done; read = await reader.read()) yield read.value
}

export type SessionInbox = { socket: string; token?: string; sessionId?: string }

/** the inbox of the Claude Code session that started this process, from its environment */
export function sessionInboxOf(env: Record<string, string | undefined>): SessionInbox | undefined {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET
  if (!socket || !isAbsolute(socket)) return undefined
  return {
    socket,
    ...(env.CLAUDE_CODE_MESSAGING_TOKEN ? { token: env.CLAUDE_CODE_MESSAGING_TOKEN } : {}),
    ...(env.CLAUDE_CODE_SESSION_ID ? { sessionId: env.CLAUDE_CODE_SESSION_ID } : {}),
  }
}

/** queues one user turn on a Claude Code session's inbox socket; resolves once the lines are flushed and the socket closed */
export function sendToSessionInbox(inbox: SessionInbox, content: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(inbox.socket)
    const timer = setTimeout(() => socket.destroy(new Error("session inbox timed out")), timeoutMs)
    socket.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.once("close", (failed) => {
      clearTimeout(timer)
      if (!failed) resolve()
    })
    socket.once("connect", () => {
      const lines = [
        ...(inbox.token ? [{ type: "auth", token: inbox.token }] : []),
        { type: "user", ...(inbox.sessionId ? { session_id: inbox.sessionId } : {}), priority: "next", message: { role: "user", content } },
      ]
      socket.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(""))
    })
  })
}

/**
 * The relay's MCP server over stdio: newline-delimited JSON-RPC 2.0, nothing else on the output.
 * It claims one agent endpoint (a deferred shim on its first tools/call, for good), keeps one broker
 * connection (heartbeat, reconnect on the next call), and resolves when the input ends.
 */
export async function runRelayMcp(options: RelayMcpOptions): Promise<void> {
  const log = options.log ?? (() => {})
  const tools = options.spawn ? TOOLS : TOOLS.filter((t) => t.name !== "relay_spawn")
  const home = options.env?.HOME
  const sent = new Map<string, { from: string; thread: string }>()
  let client: RelayClient | undefined
  let connecting: Promise<RelayClient> | undefined
  let token: string | undefined
  let me: EndpointView | null = null
  let announced = false
  let initialized = false
  /** whether the client takes channel notifications: it says so, or it was launched with channels (Claude Code does not say so itself) */
  let channelClient = false
  /** the session inbox deliveries go to instead, for a Claude Code client without channels loaded */
  let inbox: SessionInbox | undefined
  let stopped = false
  /** seqs this shim pushed, so a push whose confirm was lost is not pushed again */
  const channelPushed = new Set<number>()
  let channelLoop: Promise<void> | undefined
  /** what the endpoint advertises once initialize said whether the client takes channel pushes; null advertises nothing */
  let wake: Wake | null | undefined
  let advertised: { client: RelayClient; via: Wake } | undefined
  /** the claim the shim acts as; undefined while a deferred shim waits for a tools/call */
  let bound: Claim | undefined = options.deferClaim ? undefined : options.claim
  /** whether a call naming another session than the bound one was logged */
  let rebound = false

  const write = (message: Json) => {
    if (!stopped) options.output(`${JSON.stringify(message)}\n`)
  }

  const remember = (message: Pick<Envelope, "id" | "thread"> & { from: { address: string } }) => {
    sent.delete(message.id)
    sent.set(message.id, { from: message.from.address, thread: message.thread })
    while (sent.size > DELIVERED_KEEP) sent.delete(sent.keys().next().value!)
  }

  /** the bound claim as the session's membership names it; a session off the relay, or a deferred shim not yet bound, is refused `unavailable` */
  function sessionClaim(): Claim {
    if (!bound) throw new RelayError("unavailable", "no thread is bound to this shim yet")
    const joined = options.membership?.(bound.session ?? "") ?? {}
    if ("dark" in joined) throw new RelayError("unavailable", joined.dark)
    return joined.handle ? { ...bound, handle: joined.handle } : bound
  }

  /** a deferred shim's first tools/call binds it for good; a later call naming another session keeps the binding */
  function bind(claim: Claim) {
    if (bound) {
      if (bound.session !== claim.session && !rebound) {
        rebound = true
        log(`${CLI_NAME} mcp: a tool call named session ${claim.session ?? ""}; this shim stays bound to ${bound.session ?? ""}`)
      }
      return
    }
    bound = claim
    options.bound?.(claim)
  }

  /**
   * a claim's hello. A wake ticket is good once: the shim drops it once a claim took it, or the broker refused it (spent, or its endpoint no
   * longer hibernated, as when a revived session's shim restarts) and the claim went on without it
   */
  async function claimHello(next: RelayClient, claim: Claim): Promise<HelloResult> {
    const cwd = claim.cwd === undefined ? {} : { cwd: claim.cwd }
    if (claim.ticket === undefined) return next.hello({ claim, ...cwd })
    const { ticket: _, ...plain } = claim
    const spend = () => {
      if (bound?.ticket === undefined) return
      const { ticket: _spent, ...rest } = bound
      bound = rest
    }
    try {
      const hello = await next.hello({ claim, ...cwd })
      spend()
      return hello
    } catch (error) {
      if (!(error instanceof RelayError) || error.code !== "unauthorized") throw error
      log(`${CLI_NAME} mcp: the wake ticket was refused (${error.message}); claiming without it`)
    }
    spend()
    return next.hello({ claim: plain, ...cwd })
  }

  async function open(): Promise<RelayClient> {
    const claim = sessionClaim()
    const next = await options.connect()
    try {
      let hello: HelloResult | undefined
      if (token) {
        try {
          hello = await next.hello({ resume: token, ...(claim.cwd === undefined ? {} : { cwd: claim.cwd }) })
        } catch (error) {
          if (!(error instanceof RelayError)) throw error
        }
      }
      hello ??= await claimHello(next, claim)
      if (hello.token) token = hello.token
      me = hello.endpoint
      if (!announced) {
        await next.request("status", { state: "working" })
        announced = true
      }
    } catch (error) {
      next.close()
      throw error
    }
    if (stopped) {
      next.close()
      throw new Error("the relay MCP shim is stopping")
    }
    client = next
    advertise()
    return next
  }

  /** tells the broker how a message wakes this session, once per connection and value, when both it and the client's capabilities are known */
  function advertise() {
    if (!client || wake === undefined) return
    const via = wake ?? "none"
    if ((advertised?.client === client && advertised.via === via) || (via === "none" && !advertised)) return
    advertised = { client, via }
    client.request("wake", { via }).catch(() => {})
  }

  function ensure(): Promise<RelayClient> {
    if (client) return Promise.resolve(client)
    connecting ??= open().finally(() => (connecting = undefined))
    return connecting
  }

  /** a broker call; a dropped connection is reopened (resume, else the same claim) and the call tried once more */
  async function call<T>(method: string, params: object = {}): Promise<T> {
    const first = await ensure()
    try {
      return await first.request<T>(method, params)
    } catch (error) {
      if (error instanceof RelayError || stopped) throw error
      if (client === first) {
        client = undefined
        first.close()
      }
      return (await ensure()).request<T>(method, params)
    }
  }

  const clientId = () => `mcp_${crypto.randomUUID()}`

  async function tool(name: string, args: Json): Promise<ToolResult> {
    switch (name) {
      case "relay_whoami": {
        const view = await call<EndpointView & Partial<PeekState>>("whoami")
        const labels = Object.entries(view.labels).map(([k, v]) => `${k}=${v}`)
        const peek =
          view.peek === undefined
            ? []
            : [`peek: ${view.peek ?? "off"}`, `peeked by: ${view.peeked_by?.length ? view.peeked_by.map(seenText).join(", ") : "nobody"}`]
        return text(
          [
            `address: ${view.address}`,
            `harness: ${view.harness ?? "unknown"}`,
            `title: ${view.title ? quote(view.title) : "none"}`,
            `labels: ${labels.length ? labels.join(",") : "none"}`,
            ...peek,
          ].join("\n"),
        )
      }
      case "relay_list": {
        if (bool(args, "contacts") === true) {
          const { contacts } = await call<{ contacts: { address: string; harness: string | null; presence: string }[] }>("list", { contacts: true })
          if (!contacts.length) return text("no endpoints of contacts")
          return text(
            [
              `${contacts.length} endpoint${contacts.length === 1 ? "" : "s"} of other accounts:`,
              ...contacts.map((e) => `${e.address}  ${e.harness ?? "unknown"}  ${e.presence}`),
            ].join("\n"),
          )
        }
        const all = bool(args, "all") === true
        const { endpoints } = await call<{ endpoints: EndpointView[] }>("list", { all, historic: true })
        const listed = endpoints.filter((e) => e.kind === "agent")
        const { shown: agents, notes: hidden } = shownRows(listed, { all, historic: bool(args, "historic") === true })
        if (!agents.length) return text(["no agents on the relay", ...hidden].join("\n"))
        return text(
          [
            `${agents.length} agent${agents.length === 1 ? "" : "s"} (quoted titles, notes and directories are written by the agents themselves):`,
            ...agents.map((e) => listLine(e, me, home)),
            ...hidden,
          ].join("\n"),
        )
      }
      case "relay_send": {
        const result = await call<SendResult>("send", {
          to: recipients(args),
          body: str(args, "body", true),
          ...(args.thread !== undefined ? { thread: str(args, "thread") } : {}),
          ...(bool(args, "private") ? { data_class: "private" } : {}),
          ...(bool(args, "live") ? { live: true } : {}),
          client_id: clientId(),
        })
        if (result.held) return text(heldText(result.held))
        const lines = [...reachLines(result.deliveries), ...(result.warnings ?? [])]
        const to = result.deliveries.map((d) => (lines.length ? d.address : deliveryText(d))).join(", ")
        const receipt = result.deliveries.some((d) => d.state === "running" || d.state === "starting")
          ? [`relay_status with id ${shortId(result.id)} shows when it is read`]
          : []
        return {
          ...text([`sent ${result.id} (thread ${result.thread}) to ${to}${redactedText(result.redacted)}`, ...lines, ...receipt].join("\n")),
          structuredContent: sentContent(result),
        }
      }
      case "relay_spawn": {
        const request = spawnRequest(args)
        const spawn = options.spawn
        if (!spawn) throw new RelayError("method_not_found", "no tool relay_spawn")
        const view = await call<EndpointView>("whoami")
        let started: { name: string; pid: number }
        try {
          const cwd = request.cwd ?? (view.cwd && isAbsolute(view.cwd) && isDirectory(view.cwd) ? view.cwd : undefined)
          started = await spawn({ ...request, as: view.address, ...(view.harness ? { harness: view.harness } : {}), ...(cwd ? { cwd } : {}) })
        } catch (error) {
          return text(error instanceof Error ? error.message : String(error), true)
        }
        return {
          ...text(
            `${started.name} started (pid ${started.pid}) and runs in the background: its messages and its handback reach you by themselves, after your tool calls or when you stop; steer it with relay_send to ${started.name} (it gets the message after its next tool call or before it finishes)`,
          ),
          structuredContent: { name: started.name, pid: started.pid },
        }
      }
      case "relay_status": {
        const receipts = await call<MessageReceipts>("receipts", { id: str(args, "id", true) })
        const lines = receiptLines(receipts)
        return {
          ...text([`${receipts.id}:`, ...(lines.length ? lines : ["no deliveries of it are kept any more"])].join("\n")),
          structuredContent: { ...receipts },
        }
      }
      case "relay_reply": {
        let id = str(args, "id", true)
        const body = str(args, "body", true)
        let original = sent.get(id)
        if (!original) {
          const { message } = await call<{ message: Envelope | ThreadMessage | null }>("message", { id, member: true })
          if (message) {
            remember(message)
            id = message.id
          }
          original = sent.get(id)
        }
        if (!original) throw new ToolInputError(`no message ${id} was delivered to this session or is in its threads; use relay_send to write to an agent`)
        const result = await call<SendResult>("send", {
          to: original.from,
          body,
          kind: "reply",
          reply_to: id,
          thread: original.thread,
          client_id: clientId(),
        })
        if (result.held) return text(heldText(result.held))
        const head = `replied ${result.id} to ${result.deliveries.map((d) => d.address).join(", ")}, answering ${shortId(id)} from ${original.from} (${id})${redactedText(result.redacted)}`
        return { ...text([head, ...reachLines(result.deliveries, true)].join("\n")), structuredContent: sentContent(result) }
      }
      case "relay_inbox": {
        const ack = bool(args, "ack") ?? true
        const { messages } = await call<{ messages: Envelope[] }>("inbox", { wait_s: seconds(args, 0) })
        if (!messages.length) return text(`no unread messages${capped(args.wait_s) ? `; waited ${LIMITS.waitMaxS} s (cap)` : ""}`)
        for (const message of messages) remember(message)
        if (ack) await call("ack", { seqs: messages.map((m) => m.seq) })
        return text(delivered(messages))
      }
      case "relay_ask": {
        const result = await call<AskResult>("ask", {
          to: str(args, "to", true),
          body: str(args, "body", true),
          wait_s: seconds(args, ASK_WAIT_DEFAULT_S),
          ...(bool(args, "require_reply") ? { require_reply: true } : {}),
          client_id: clientId(),
        })
        if (result.held) return text(heldText(result.held))
        if (result.reply) remember(result.reply)
        return text(`${result.redacted ? `request ${result.id} delivered${redactedText(result.redacted)}\n` : ""}${askText(result)}`)
      }
      case "relay_ask_wait": {
        const result = await call<AskResult>("ask_wait", { id: str(args, "id", true), wait_s: seconds(args, ASK_WAIT_DEFAULT_S) })
        if (result.reply) remember(result.reply)
        return text(askText(result))
      }
      case "relay_set_status": {
        const state = str(args, "state", true)
        if (!(STATUS_STATES as readonly string[]).includes(state)) throw new ToolInputError(`state must be one of ${STATUS_STATES.join(", ")}`)
        const view = await call<EndpointView>("status", { state, note: str(args, "note") ?? "" })
        return text(`${view.address}: ${view.status?.state}${view.status?.note ? `: ${quote(view.status.note)}` : ""}`)
      }
      case "relay_set_now": {
        if (typeof args.now !== "string") throw new ToolInputError("now must be a string")
        const view = await call<EndpointView>("status", { note: args.now })
        return text(`${view.address}: ${view.status?.state}${view.status?.note ? `: ${quote(view.status.note)}` : ""}`)
      }
      case "relay_join": {
        const name = str(args, "name")
        const under = str(args, "under")
        const current = bound ?? options.claim
        const joined = options.membership?.(current.session ?? "") ?? {}
        const claim = "handle" in joined && joined.handle ? { ...current, handle: joined.handle } : current
        const next = await options.connect()
        try {
          const hello = await next.hello({ transient: true, claim, join: { ...(name ? { handle: name } : {}), ...(under ? { under } : {}) } })
          me = hello.endpoint
        } finally {
          next.close()
        }
        await ensure()
        return text(
          `joined the relay as ${me?.address}${me?.parent ? ` under ${me.parent}` : ""}: peers can message you, and new messages reach you after your tool calls`,
        )
      }
      case "relay_link_accept": {
        const result = await call<{ endpoint: EndpointView; parent: string }>("link_accept", { id: str(args, "id", true) })
        me = result.endpoint
        return text(`${result.endpoint.address} now sits under ${result.parent} as its worker`)
      }
      case "relay_leave": {
        const view = await call<EndpointView>("leave")
        client?.close()
        client = undefined
        token = undefined
        return text(`${view.address} left the relay: it shows offline and gets no new messages pushed; its mail is kept until relay_join`)
      }
      case "relay_set_title": {
        if (typeof args.title !== "string") throw new ToolInputError("title must be a string")
        const view = await call<EndpointView>("title", { text: args.title })
        return text(`${view.address}: ${view.title ? `title ${quote(view.title)}` : "title cleared"}`)
      }
      case "relay_rules": {
        const action = oneOf(args, "action", ["show", "set", "widen", "lift", "why"] as const)
        const endpoint = str(args, "endpoint")
        switch (action) {
          case "show":
            return text(scopeText(await call<ScopeView>("rules", endpoint ? { endpoint } : {})))
          case "set": {
            const params = {
              endpoint,
              in: selectors(args, "in"),
              out: selectors(args, "out"),
              scope: args.scope === undefined ? undefined : oneOf(args, "scope", ["open", "tree", "parent", "none"] as const),
              allow: selectors(args, "allow"),
            }
            if (!params.in && !params.out && params.scope === undefined && !params.allow) throw new ToolInputError("set takes in, out, scope or allow")
            return text(scopeText(await call<ScopeView>("rules_set", params)))
          }
          case "widen": {
            if (!endpoint) throw new ToolInputError("widen takes the endpoint to loosen")
            const change = await call<ScopeChange>("rules_widen", { endpoint, in: selectors(args, "in"), out: selectors(args, "out") })
            return text(widenText(change, endpoint).join("\n"))
          }
          case "lift":
            if (!endpoint) throw new ToolInputError("lift takes the endpoint and the cap id")
            return text(scopeText(await call<ScopeView>("rules_lift", { endpoint, cap: str(args, "cap", true) })))
          case "why": {
            const from = str(args, "from") ?? (await call<EndpointView>("whoami")).address
            const result = await call<WhyResult>("why", { from, to: str(args, "to", true) })
            return text([`${from} ${result.allowed ? "may" : "may not"} message ${args.to}`, ...result.reasons.map((r) => `  ${r}`)].join("\n"))
          }
        }
        break
      }
      case "relay_group": {
        const action = oneOf(args, "action", ["create", "add", "remove", "rules", "ls", "show", "drop"] as const)
        const result = await call<unknown>("group", {
          action,
          name: str(args, "name"),
          endpoint: str(args, "endpoint"),
          rules: selectors(args, "rules"),
          in: selectors(args, "in"),
          out: selectors(args, "out"),
        })
        return text(groupText(result))
      }
      case "relay_peers": {
        const all = bool(args, "all") === true
        const { peers: listed } = await call<{ peers: PeerView[] }>("peers", { all, historic: true })
        const { shown: peers, notes: hidden } = shownRows(listed, { all, historic: bool(args, "historic") === true, human: true })
        const line = (p: PeerView) =>
          [
            p.address,
            p.kind,
            p.presence,
            p.title ? `title ${quote(p.title)}` : "",
            p.status ? statusLine(p.status) : "",
            p.reason,
            p.peekable ? "peekable" : "",
          ]
            .filter(Boolean)
            .join("  ")
        return text([...(peers.length ? peers.map(line) : ["nobody you may message"]), ...hidden].join("\n"))
      }
      case "relay_peek": {
        if (bool(args, "who") === true) {
          const { peeked_by } = await call<{ peeked_by: PeekSeen[] }>("peek_who", args.endpoint === undefined ? {} : { endpoint: str(args, "endpoint", true) })
          return text(peeked_by.length ? peeked_by.map(seenText).join("\n") : "nobody peeked")
        }
        const turns = peekTurns(args)
        const result = await call<PeekResult>("peek", {
          endpoint: str(args, "endpoint", true),
          ...(turns !== undefined ? { turns } : {}),
          ...(bool(args, "full") ? { full: true } : {}),
        })
        return text(`${PREAMBLE}\n\n${wrapPeek(result)}`)
      }
      case "relay_set_peek": {
        const on = bool(args, "on")
        if (on === undefined) throw new ToolInputError("on must be true or false")
        const result = await call<{ endpoint: string; peek: PeekState["peek"] }>("peek_set", { level: on ? "on" : "off" })
        return text(`${result.endpoint}: peek ${result.peek ?? "off"}`)
      }
    }
    throw new RelayError("method_not_found", `no tool ${name}`)
  }

  async function callTool(params: Json): Promise<ToolResult> {
    const name = params.name
    const args = params.arguments ?? {}
    if (typeof args !== "object" || args === null || Array.isArray(args)) return text("invalid_params: arguments must be an object", true)
    try {
      return await tool(String(name), args as Json)
    } catch (error) {
      if (error instanceof ToolInputError) return text(`invalid_params: ${error.message}`, true)
      if (error instanceof RelayError) return text(`${error.code}: ${error.message}${error.retryAfterS ? ` (retry in ${error.retryAfterS} s)` : ""}`, true)
      return text(`unavailable: the relay broker cannot be reached (${error instanceof Error ? error.message : String(error)})`, true)
    }
  }

  async function pushChannel(): Promise<void> {
    while (!stopped && (channelClient || inbox)) {
      try {
        const { messages, hold } = await call<{ messages: Envelope[]; hold?: string | null }>("inbox", { wait_s: LIMITS.injectHoldS, offer: true })
        for (const message of messages) {
          if (stopped || message.seq === undefined || channelPushed.has(message.seq)) continue
          channelPushed.add(message.seq)
          if (channelPushed.size > DELIVERED_KEEP) channelPushed.delete(channelPushed.values().next().value!)
          remember(message)
          const content = `${PREAMBLE}\n\n${wrapMessage(message)}`
          if (inbox) {
            try {
              await sendToSessionInbox(inbox, content)
            } catch (error) {
              channelPushed.delete(message.seq)
              throw error
            }
          } else
            write({
              jsonrpc: "2.0",
              method: "notifications/claude/channel",
              params: {
                content,
                meta: {
                  from: message.from.address,
                  id: message.id,
                  seq: String(message.seq),
                  thread: message.thread,
                  ...(message.for ? { for: message.for.address, subagent: message.for.subagent } : {}),
                },
              },
            })
        }
        const pushed = messages.flatMap((message) => (message.seq !== undefined && channelPushed.has(message.seq) ? [message.seq] : []))
        if (pushed.length) await call("injected", { seqs: pushed, hold })
      } catch (error) {
        if (stopped) return
        log(`${CLI_NAME} mcp: channel poll failed: ${error instanceof Error ? error.message : String(error)}`)
        await sleep(error instanceof RelayError ? 5000 : 1000)
      }
    }
  }

  async function handle(message: Json): Promise<void> {
    const method = message.method
    const isRequest = "id" in message && typeof method === "string"
    const id = message.id as string | number | null
    if ("id" in message && id !== null && typeof id !== "string" && typeof id !== "number") {
      return write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "a request id is a string, a number or null" } })
    }
    if (typeof method !== "string") {
      if ("id" in message) write({ jsonrpc: "2.0", id, error: { code: -32600, message: "a request names its method" } })
      return
    }
    const params = (typeof message.params === "object" && message.params !== null ? message.params : {}) as Json
    if (!isRequest) {
      if (method === "notifications/initialized" && options.channels && (channelClient || inbox))
        channelLoop ??= pushChannel().finally(() => (channelLoop = undefined))
      return
    }
    const respond = (result: unknown) => write({ jsonrpc: "2.0", id, result })
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion
        const protocolVersion = typeof asked === "string" && (MCP_PROTOCOLS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOLS[0]
        initialized = true
        const capabilities = params.capabilities as { experimental?: Record<string, unknown> } | undefined
        const channel = capabilities?.experimental?.["claude/channel"]
        channelClient = (typeof channel === "object" && channel !== null) || options.launchedWithChannels === true
        const clientInfo = params.clientInfo as { name?: unknown } | undefined
        inbox =
          options.channels &&
          !channelClient &&
          (clientInfo?.name === "claude-code" ||
            ((options.env?.CLAUDE_CODE_IS_COWORK === "1" || options.env?.CLAUDE_CODE_ENTRYPOINT === "remote_cowork") &&
              typeof clientInfo?.name === "string" &&
              clientInfo.name.startsWith("claude")))
            ? options.sessionInbox
            : undefined
        wake = options.channels && channelClient ? (options.wake ?? (clientInfo?.name === "pi" ? "pi" : "channels")) : inbox ? "claude-inbox" : null
        advertise()
        return respond({
          protocolVersion,
          capabilities: { tools: {}, ...(options.channels ? { experimental: { "claude/channel": {} } } : {}) },
          serverInfo: { name: "scp", version: options.version ?? "0.1.0" },
          instructions: INSTRUCTIONS,
        })
      }
      case "ping":
        return respond({})
      case "tools/list":
        return respond({ tools })
      case "tools/call": {
        if (!initialized) return write({ jsonrpc: "2.0", id, error: { code: -32002, message: "call initialize first" } })
        if (!tools.some((t) => t.name === params.name)) {
          return write({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${JSON.stringify(params.name)}` } })
        }
        const meta = typeof params._meta === "object" && params._meta !== null && !Array.isArray(params._meta) ? (params._meta as Json) : {}
        const named = options.threadClaim?.(meta)
        if (named) bind(named)
        else if (!bound) bind(options.claim)
        return respond(await callTool(params))
      }
    }
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } })
  }

  function line(raw: string) {
    if (!raw.trim()) return
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "a request is a JSON object" } })
    }
    const running = handle(message as Json).catch((error: unknown) =>
      log(`${CLI_NAME} mcp: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`),
    )
    inFlight.add(running)
    void running.finally(() => inFlight.delete(running))
  }

  const dark = (() => {
    if (!bound) return true
    try {
      sessionClaim()
      return false
    } catch {
      return true
    }
  })()
  if (!dark)
    ensure().catch((error: unknown) => log(`${CLI_NAME} mcp: could not reach the relay broker yet: ${error instanceof Error ? error.message : String(error)}`))
  const heartbeat = setInterval(() => {
    call("whoami").catch(() => {})
  }, options.heartbeatMs ?? 30_000)

  const inFlight = new Set<Promise<void>>()
  const decoder = new TextDecoder()
  let buffer = ""
  let skipping = false
  try {
    for await (const chunk of chunks(options.input)) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
      for (;;) {
        const nl = buffer.indexOf("\n")
        if (nl < 0) break
        const raw = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (skipping) skipping = false
        else line(raw)
      }
      if (buffer.length > MAX_INPUT_LINE) {
        if (!skipping) write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request too large" } })
        skipping = true
        buffer = ""
      }
    }
    if (buffer && !skipping) line(buffer)
    let cap: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.allSettled([...inFlight]), new Promise((resolve) => (cap = setTimeout(resolve, (LIMITS.waitMaxS + 10) * 1000)))])
    clearTimeout(cap)
  } finally {
    stopped = true
    clearInterval(heartbeat)
    client?.close()
    client = undefined
  }
}
