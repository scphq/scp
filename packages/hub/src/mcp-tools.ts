import {
  type AskResult,
  type EndpointView,
  type Envelope,
  type MessageReceipts,
  type PeekState,
  type PeerView,
  type SendResult,
  type ThreadMessage,
  ToolInputError,
  type ToolResult,
  RelayError,
  STATUS_STATES,
  askText,
  bool,
  delivered,
  deliveryText,
  heldText,
  hiddenNote,
  listLine,
  quote,
  reachLines,
  receiptLines,
  recipients,
  redactedText,
  seenText,
  sentContent,
  shortId,
  statusLine,
  str,
  text,
} from "@scp-dev/core"
export type McpCall = <T>(method: string, params?: Record<string, unknown>) => Promise<T>
function wait(args: Record<string, unknown>, fallback: number): number {
  const value = args.wait_s ?? fallback
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ToolInputError("wait_s must be a nonnegative number")
  return Math.min(value, 50)
}
export async function remoteTool(name: string, args: Record<string, unknown>, call: McpCall, me: EndpointView): Promise<ToolResult> {
  const clientId = () => `mcp_${crypto.randomUUID()}`
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
      const { endpoints } = await call<{ endpoints: EndpointView[] }>("list", { all })
      const listed = endpoints.filter((e) => e.kind === "agent")
      const agents = all ? listed : listed.filter((e) => e.presence !== "offline")
      const hidden = hiddenNote(listed.length - agents.length)
      if (!agents.length) return text(["no agents on the relay", ...hidden].join("\n"))
      return text(
        [
          `${agents.length} agent${agents.length === 1 ? "" : "s"} (quoted titles, notes and directories are written by the agents themselves):`,
          ...agents.map((e) => listLine(e, me)),
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
      const { message } = await call<{ message: Envelope | ThreadMessage | null }>("message", { id, member: true })
      if (!message) throw new ToolInputError(`no message ${id} was delivered or is in this endpoint's threads`)
      id = message.id
      const original = { from: typeof message.from === "string" ? message.from : message.from.address, thread: message.thread }
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
      const { messages } = await call<{ messages: Envelope[] }>("inbox", { wait_s: wait(args, 0) })
      if (!messages.length) return text(`no unread messages${typeof args.wait_s === "number" && args.wait_s > 50 ? `; waited 50 s (cap)` : ""}`)
      const shown: Envelope[] = []
      for (const message of messages) {
        if (delivered([...shown, message]).length > 145_000) break
        shown.push(message)
      }
      if (ack && shown.length) await call("ack", { seqs: shown.map((m) => m.seq) })
      const left = messages.length - shown.length
      return text(`${delivered(shown)}${left ? `\n${left} messages left unread` : ""}`)
    }
    case "relay_ask": {
      const result = await call<AskResult>("ask", {
        to: str(args, "to", true),
        body: str(args, "body", true),
        wait_s: wait(args, 30),
        ...(bool(args, "require_reply") ? { require_reply: true } : {}),
        client_id: clientId(),
      })
      if (result.held) return text(heldText(result.held))
      return text(`${result.redacted ? `request ${result.id} delivered${redactedText(result.redacted)}\n` : ""}${askText(result)}`)
    }
    case "relay_ask_wait": {
      const result = await call<AskResult>("ask_wait", { id: str(args, "id", true), wait_s: wait(args, 30) })
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
    case "relay_set_title": {
      if (typeof args.title !== "string") throw new ToolInputError("title must be a string")
      const view = await call<EndpointView>("title", { text: args.title })
      return text(`${view.address}: ${view.title ? `title ${quote(view.title)}` : "title cleared"}`)
    }
    case "relay_peers": {
      const { peers: listed } = await call<{ peers: PeerView[] }>("peers")
      const peers = bool(args, "all") === true ? listed : listed.filter((p) => p.kind === "human" || p.presence !== "offline")
      const hidden = hiddenNote(listed.length - peers.length)
      const line = (p: PeerView) =>
        [p.address, p.kind, p.presence, p.title ? `title ${quote(p.title)}` : "", p.status ? statusLine(p.status) : "", p.reason, p.peekable ? "peekable" : ""]
          .filter(Boolean)
          .join("  ")
      return text([...(peers.length ? peers.map(line) : ["nobody you may message"]), ...hidden].join("\n"))
    }
  }
  throw new RelayError("method_not_found", `no tool ${name}`)
}
