import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { type Claim, PREAMBLE } from "@scp-dev/core"
import { RelayClient } from "@scp-dev/broker"
import { BrokerTarget, brokerTargetEnabled, cli } from "../../conformance/src/broker/target"
import { checkTools } from "../../../scripts/mcp-tools"
import { mcpBinary, type ServerMode, serverModes, startNative } from "./native-test"
import { INSTRUCTIONS, runRelayMcp, TOOLS } from "./server"

setDefaultTimeout(30_000)

type Result = { content?: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> }
type Message = { id?: number; method?: string; result?: Record<string, unknown> & Result; error?: { code: number }; params?: Record<string, unknown> }

const textOf = (result: Result) => result.content![0]!.text
const idOf = (text: string) => /id="(msg_[^"]+)"/.exec(text)![1]!

/** an MCP client over stdio JSON-RPC to either server, its broker at `socket` */
function client(mode: ServerMode, socket: string, options: { claim: Record<string, unknown>; channels?: boolean; launched?: boolean; spawn?: boolean }) {
  let lines: string[] = []
  const logged: string[] = []
  let push: (chunk: string | null) => void
  let done: Promise<void>
  if (mode === "native") {
    const native = startNative({
      socket,
      claim: options.claim,
      env: { HOME: "/work" },
      ...(options.channels ? { channels: true } : {}),
      ...(options.launched ? { launched: true } : {}),
      ...(options.spawn ? { spawn: { pid: 1, name: "w" } } : {}),
    })
    lines = native.lines
    push = native.raw
    done = native.done
    return wrap(lines, native.logged, push, done)
  }
  const queue: (string | null)[] = []
  let waiting: (() => void) | undefined
  push = (chunk) => {
    queue.push(chunk)
    waiting?.()
  }
  async function* input() {
    for (;;) {
      while (!queue.length) await new Promise<void>((resolve) => (waiting = resolve))
      const chunk = queue.shift()!
      if (chunk === null) return
      yield chunk
    }
  }
  done = runRelayMcp({
    connect: () => RelayClient.connect(socket),
    claim: options.claim as Claim,
    input: input(),
    output: (line) => lines.push(line),
    env: { HOME: "/work" },
    log: (line) => logged.push(line),
    ...(options.channels ? { channels: true } : {}),
    ...(options.launched ? { launchedWithChannels: true } : {}),
    ...(options.spawn ? { spawn: async () => ({ name: "w", pid: 1 }) } : {}),
  })
  return wrap(lines, logged, push, done)
}

function wrap(lines: string[], logged: string[], push: (chunk: string | null) => void, done: Promise<void>) {
  let nextId = 1
  const messages = () => lines.map((l) => JSON.parse(l) as Message)
  async function request(method: string, params: object = {}): Promise<Message> {
    const id = nextId++
    push(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    for (let i = 0; i < 2500; i++) {
      const found = messages().find((m) => m.id === id)
      if (found) return found
      await Bun.sleep(10)
    }
    throw new Error(`no answer to ${method}`)
  }
  return {
    logged,
    messages,
    request,
    call: async (name: string, args: object = {}) => (await request("tools/call", { name, arguments: args })).result!,
    notify: (method: string) => push(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
    close: async () => {
      push(null)
      await done
    },
  }
}

const agent = (handle: string, harness = "claude-code") => ({ handle, harness, cwd: "/work/proj" })

test("crates/scp-mcp/tools.json is what TOOLS generates", () => {
  checkTools()
})

describe.skipIf(!mcpBinary)("the native server introduces itself as runRelayMcp does", () => {
  test("instructions and tools, relay_spawn only with a spawn", async () => {
    for (const spawn of [false, true]) {
      const s = client("native", "/nonexistent/relay.sock", { claim: agent("intro"), spawn })
      try {
        const init = await s.request("initialize", { protocolVersion: "2025-06-18" })
        expect(init.result).toEqual({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "scp", version: "0.1.0" },
          instructions: INSTRUCTIONS,
        })
        const tools = (await s.request("tools/list")).result!.tools
        expect(tools).toEqual(JSON.parse(JSON.stringify(spawn ? TOOLS : TOOLS.filter((t) => t.name !== "relay_spawn"))))
      } finally {
        await s.close()
      }
    }
  })
})

/** `ts` runs the built CLI's broker (packages/cli/dist), `rust` the one SCP_BROKER_BIN names */
const brokers = ["ts", "rust"].filter((name) => (name === "ts" ? existsSync(cli) : brokerTargetEnabled(name)))

for (const broker of brokers) {
  for (const mode of serverModes) {
    describe(`${broker} broker, ${mode} server`, () => {
      let target: BrokerTarget
      const open = (options: Parameters<typeof client>[2]) => client(mode, target.socket, options)

      beforeAll(async () => {
        target = new BrokerTarget(broker)
        await target.start()
      })
      afterAll(async () => {
        await target.dispose()
      })

      test("initialize, instructions and the tools list", async () => {
        const s = open({ claim: agent("w-init") })
        try {
          const init = await s.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "0" } })
          expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "scp" }, instructions: INSTRUCTIONS })
          const tools = (await s.request("tools/list")).result!.tools as { name: string }[]
          expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name).filter((n) => n !== "relay_spawn"))
          expect((await s.request("ping")).result).toEqual({})
        } finally {
          await s.close()
        }
      })

      test("relay_whoami", async () => {
        const s = open({ claim: agent("w-who") })
        try {
          await s.request("initialize", { protocolVersion: "2025-06-18" })
          const who = textOf(await s.call("relay_whoami"))
          expect(who).toContain("address: me/w-who")
          expect(who).toContain("harness: claude-code")
          expect(who).toContain("title: none")
        } finally {
          await s.close()
        }
      })

      test("relay_send, relay_inbox and relay_reply between two shims", async () => {
        const a = open({ claim: agent("w-send-a") })
        const b = open({ claim: agent("w-send-b") })
        try {
          for (const s of [a, b]) await s.request("initialize", { protocolVersion: "2025-06-18" })
          await b.call("relay_whoami")
          const sent = await a.call("relay_send", { to: "w-send-b", body: "hello b" })
          expect(textOf(sent)).toStartWith("sent msg_")
          expect(sent.structuredContent).toMatchObject({ recipients: [{ address: "me/w-send-b" }] })
          const inbox = textOf(await b.call("relay_inbox", { wait_s: 5 }))
          expect(inbox.startsWith(PREAMBLE)).toBe(true)
          expect(inbox).toContain('<relay-message from="me/w-send-a"')
          expect(inbox).toContain("hello b")
          expect(textOf(await b.call("relay_reply", { id: idOf(inbox).slice(-6), body: "hello a" }))).toContain("to me/w-send-a, answering")
          const back = textOf(await a.call("relay_inbox", { wait_s: 5 }))
          expect(back).toContain('kind="reply"')
          expect(back).toContain("hello a")
          expect(textOf(await a.call("relay_inbox"))).toBe("no unread messages")
        } finally {
          await Promise.all([a.close(), b.close()])
        }
      })

      test("relay_ask and relay_ask_wait", async () => {
        const a = open({ claim: agent("w-ask-a") })
        const b = open({ claim: agent("w-ask-b") })
        try {
          for (const s of [a, b]) await s.request("initialize", { protocolVersion: "2025-06-18" })
          await b.call("relay_whoami")
          const pending = textOf(await a.call("relay_ask", { to: "w-ask-b", body: "anyone?", wait_s: 0 }))
          const id = /relay_ask_wait with id (\S+)/.exec(pending)![1]!
          const asked = textOf(await b.call("relay_inbox", { wait_s: 5 }))
          expect(asked).toContain("the sender asked a question")
          const waiting = a.call("relay_ask_wait", { id, wait_s: 10 })
          await b.call("relay_reply", { id: idOf(asked), body: "yes" })
          const answered = textOf(await waiting)
          expect(answered.startsWith(PREAMBLE)).toBe(true)
          expect(answered).toContain("yes")
        } finally {
          await Promise.all([a.close(), b.close()])
        }
      })

      test("a channel push, once, and the message stays unread", async () => {
        const c = open({ claim: agent("w-chan"), channels: true, launched: true })
        const peer = await RelayClient.connect(target.socket)
        try {
          const init = await c.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2" } })
          expect(init.result!.capabilities).toEqual({ tools: {}, experimental: { "claude/channel": {} } })
          c.notify("notifications/initialized")
          await c.call("relay_whoami")
          await peer.hello({ claim: { handle: "w-chan-peer", harness: "codex" } })
          await peer.request("send", { to: "w-chan", body: "pushed body" })
          const pushes = () => c.messages().filter((m) => m.method === "notifications/claude/channel")
          for (let i = 0; i < 1000 && !pushes().length; i++) await Bun.sleep(10)
          await Bun.sleep(300)
          expect(pushes()).toHaveLength(1)
          const params = pushes()[0]!.params as { content: string; meta: Record<string, string> }
          expect(params.content.startsWith(`${PREAMBLE}\n\n<relay-message from="me/w-chan-peer"`)).toBe(true)
          expect(Object.keys(params.meta).sort()).toEqual(["from", "id", "seq", "thread"])
          expect(params.meta.from).toBe("me/w-chan-peer")
          expect(textOf(await c.call("relay_inbox"))).toContain("pushed body")
          expect(pushes()).toHaveLength(1)
        } finally {
          peer.close()
          await c.close()
        }
      })

      test("relay_leave and relay_join", async () => {
        const proc = "pid:4343:Thu-Oct-15-10:00:00-2026"
        const s = open({ claim: { ...agent("w-leave"), session: proc, process: proc } })
        try {
          await s.request("initialize", { protocolVersion: "2025-06-18" })
          await s.call("relay_whoami")
          expect(textOf(await s.call("relay_leave"))).toBe(
            "me/w-leave left the relay: it shows offline and gets no new messages pushed; its mail is kept until relay_join",
          )
          expect(textOf(await s.call("relay_join"))).toBe(
            "joined the relay as me/w-leave: peers can message you, and new messages reach you after your tool calls",
          )
          expect(textOf(await s.call("relay_whoami"))).toContain("address: me/w-leave")
        } finally {
          await s.close()
        }
      })

      test("relay_set_status, relay_set_title and relay_set_now", async () => {
        const s = open({ claim: agent("w-status") })
        try {
          await s.request("initialize", { protocolVersion: "2025-06-18" })
          expect(textOf(await s.call("relay_set_status", { state: "blocked", note: "needs  review" }))).toBe('me/w-status: blocked: "needs review"')
          expect(textOf(await s.call("relay_set_title", { title: "docs pass" }))).toBe('me/w-status: title "docs pass"')
          expect(textOf(await s.call("relay_set_now", { now: "  pass\n two " }))).toBe('me/w-status: blocked: "pass two"')
          expect(textOf(await s.call("relay_list"))).toContain('me/w-status (you)  claude-code  online  title "docs pass"  blocked: "pass two"  "~/proj"')
          const bad = await s.call("relay_set_status", { state: "sleeping" })
          expect([bad.isError, textOf(bad)]).toEqual([true, "invalid_params: state must be one of working, waiting, blocked, done"])
        } finally {
          await s.close()
        }
      })

      test("relay_rules show and relay_peers", async () => {
        const a = open({ claim: agent("w-rules-a") })
        const b = open({ claim: agent("w-rules-b") })
        try {
          for (const s of [a, b]) await s.request("initialize", { protocolVersion: "2025-06-18" })
          await b.call("relay_whoami")
          const rules = textOf(await a.call("relay_rules", { action: "show" }))
          expect(rules).toStartWith("me/w-rules-a: scope ")
          expect(rules).toContain("\nrules in: ")
          expect(textOf(await a.call("relay_peers"))).toMatch(/^me\/w-rules-b {2}agent {2}online/m)
          expect(textOf(await a.call("relay_rules", { action: "why", to: "w-rules-b" }))).toStartWith("me/w-rules-a may message w-rules-b")
        } finally {
          await Promise.all([a.close(), b.close()])
        }
      })

      test("a refused claim backs the channel poll off instead of retrying each second", async () => {
        const s = open({ claim: { ...agent("w-refused", "codex"), grant: `krt_${"0".repeat(64)}` }, channels: true, launched: true })
        try {
          await s.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2" } })
          const refused = await s.call("relay_whoami")
          expect([refused.isError, textOf(refused)]).toEqual([true, expect.stringMatching(/^unauthorized: grant refused: /)])
          s.notify("notifications/initialized")
          await Bun.sleep(3000)
          const failed = s.logged.filter((line) => line.includes("channel poll failed"))
          expect(failed).toHaveLength(1)
          expect(failed[0]).toContain("grant refused: ")
        } finally {
          await s.close()
        }
      })
    })
  }
}
