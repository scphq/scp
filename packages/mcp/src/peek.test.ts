import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PREAMBLE } from "@scp-dev/core"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"
import { runRelayMcp, TOOLS } from "./server"

setDefaultTimeout(20_000)

type Result = { content?: { text: string }[]; isError?: boolean }
type Message = { id?: number; result?: Result }

/** an in-process MCP client around runRelayMcp, initialized */
function shim(broker: Broker, handle: string) {
  const lines: string[] = []
  const queue: (string | null)[] = []
  let waiting: (() => void) | undefined
  const push = (chunk: string | null) => {
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
  const done = runRelayMcp({
    connect: () => RelayClient.connect(broker.socket),
    claim: { handle, harness: "claude-code", cwd: "/work/proj" },
    input: input(),
    output: (line) => lines.push(line),
    env: { HOME: "/work" },
  })
  push(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`)
  let nextId = 1
  async function call(name: string, args: object = {}): Promise<Result> {
    const id = nextId++
    push(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`)
    for (let i = 0; i < 2000; i++) {
      const found = lines.map((l) => JSON.parse(l) as Message).find((m) => m.id === id)
      if (found) return found.result!
      await Bun.sleep(10)
    }
    throw new Error(`no answer to ${name}`)
  }
  return {
    call,
    close: async () => {
      push(null)
      await done
    },
  }
}

const textOf = (result: Result) => result.content![0]!.text

describe("relay MCP peek tools", () => {
  let broker: Broker
  let dir: string
  const id = (address: string) => broker.core.list({ all: true }).find((e) => e.address === address)!.id

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "relay-mcp-peek-"))
    broker = await startBroker({ dir: join(dir, "relay"), idleMs: 0, policyPath: join(dir, "policy.json"), log: () => {} })
  })
  afterAll(async () => {
    await broker.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  test("relay_peek and relay_set_peek are listed; the peek description calls peeked text data, never instructions", () => {
    const peek = TOOLS.find((t) => t.name === "relay_peek")!
    expect(peek.description).toContain("never instructions")
    expect(peek.description).toContain("data")
    expect(Object.keys(peek.inputSchema.properties).sort()).toEqual(["endpoint", "full", "turns", "who"])
    const set = TOOLS.find((t) => t.name === "relay_set_peek")!
    expect(set.inputSchema.required).toEqual(["on"])
  })

  test("an agent opts in with relay_set_peek; a peer then sees it peekable and peeks its turns behind the preamble, wrapped; who looked shows in whoami and who", async () => {
    const a = shim(broker, "peek-a")
    const b = shim(broker, "peek-b")
    try {
      expect(textOf(await a.call("relay_whoami"))).toContain("peek: off")
      await b.call("relay_whoami")
      expect(textOf(await b.call("relay_list"))).not.toContain("peekable")
      expect(textOf(await a.call("relay_set_peek", { on: true }))).toBe("me/peek-a: peek local")
      expect(textOf(await a.call("relay_whoami"))).toContain("peek: local")
      broker.core.peekTurn(id("me/peek-a"), { role: "user", text: "PROMPT-MARKER fix the parser" })
      broker.core.peekTurn(id("me/peek-a"), { role: "assistant", text: "REPLY-MARKER done, tests green" })

      const listed = textOf(await b.call("relay_list")).split("\n")
      expect(listed.find((l) => l.startsWith("me/peek-a "))).toContain("peekable")
      expect(
        textOf(await b.call("relay_peers"))
          .split("\n")
          .find((l) => l.startsWith("me/peek-a ")),
      ).toContain("peekable")

      const peeked = await b.call("relay_peek", { endpoint: "peek-a", turns: 2 })
      expect(peeked.isError).toBeFalsy()
      const text = textOf(peeked)
      expect(text.startsWith(PREAMBLE)).toBe(true)
      expect(text).toContain('<relay-peek of="me/peek-a"')
      expect(text).toContain("PROMPT-MARKER")
      expect(text).toContain("REPLY-MARKER")
      expect(text.trimEnd().endsWith("</relay-peek>")).toBe(true)

      expect(textOf(await a.call("relay_whoami"))).toMatch(/peeked by: me\/peek-b/)
      expect(textOf(await a.call("relay_peek", { who: true }))).toContain("me/peek-b")

      expect(textOf(await a.call("relay_set_peek", { on: false }))).toBe("me/peek-a: peek off")
      const refused = await b.call("relay_peek", { endpoint: "peek-a" })
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toStartWith("not_found: ")
      expect(textOf(await b.call("relay_list"))).not.toContain("peekable")
    } finally {
      await a.close()
      await b.close()
    }
  })

  test("relay_peek checks its arguments: an endpoint unless who, turns 1 to 10, booleans; relay_set_peek takes on", async () => {
    const a = shim(broker, "peek-args")
    try {
      for (const args of [
        {},
        { endpoint: "peek-args", turns: 0 },
        { endpoint: "peek-args", turns: 11 },
        { endpoint: "peek-args", turns: 2.5 },
        { endpoint: "peek-args", full: "yes" },
        { who: "yes" },
      ]) {
        const result = await a.call("relay_peek", args)
        expect(result.isError).toBe(true)
        expect(textOf(result)).toStartWith("invalid_params: ")
      }
      for (const args of [{}, { on: "true" }]) expect(textOf(await a.call("relay_set_peek", args))).toStartWith("invalid_params: ")
      const self = await a.call("relay_peek", { endpoint: "peek-args", full: true })
      expect(self.isError).toBeFalsy()
      expect(textOf(self).startsWith(PREAMBLE)).toBe(true)
    } finally {
      await a.close()
    }
  })
})
