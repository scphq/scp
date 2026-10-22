import { Readable } from "node:stream"
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { type Envelope, PEEK } from "@scp-dev/core"
import { type Broker, MAX_LINE, type RelayClient } from "@scp-dev/broker"
import { hookModes, testBroker, testHook } from "./hook-test"

for (const mode of hookModes)
  describe(mode, () => {
    const runHook: typeof import("./hooks").runHook = (args, options) => testHook(mode, args, options)
    const startBroker: typeof import("@scp-dev/broker").startBroker = (options) => testBroker(mode, options)

    setDefaultTimeout(30_000)

    const entry = join(import.meta.dir, "cli.ts")
    const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|OPENCODE|GROK_|MUSE_|CODEX_THREAD_ID)/

    function cleanEnv(extra: Record<string, string>): Record<string, string> {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) env[key] = value
      return { ...env, ...extra }
    }

    const MESSAGE: Envelope = {
      id: "msg_peek1",
      seq: 4,
      thread: "thr_1",
      reply_to: null,
      kind: "message",
      from: { address: "me/peer", endpoint: "ep_peer", user: "u", auth: "local-uid", claims: { harness: "codex", model: null } },
      to: "me/peek-hook",
      body: { text: "hello", mime: "text/plain" },
      data_class: "public",
      attachments: [],
      hop: 0,
      created_at: new Date(0).toISOString(),
      expires_at: new Date(0).toISOString(),
    }

    type Call = [string, Record<string, unknown>]

    /** runHook against a fake broker that records every request and answers inject with `inject` */
    async function withFake(
      args: string[],
      payload: Record<string, unknown>,
      env: Record<string, string> = { CLAUDECODE: "1" },
      inject: Record<string, unknown> = {},
    ) {
      const calls: Call[] = []
      let connected = false
      const client = {
        hello: async () => ({ endpoint: { title: "t" } }),
        request: async (method: string, params: Record<string, unknown>) => {
          calls.push([method, params])
          return method === "inject" ? { messages: [], offered: [], hold: null, more: 0, unread: 0, block: false, ...inject } : {}
        },
        close: () => {},
      }
      const reply = await runHook(args, {
        env: cleanEnv({ SCP_SESSION: "peek-hook", SCP_NAME: "peek-hook", ...env }),
        cwd: process.env.HOME!,
        stdin: Readable.from([JSON.stringify({ cwd: process.env.HOME, ...payload })]),
        connect: async () => {
          connected = true
          return client as unknown as RelayClient
        },
        harnessPid: () => process.pid,
        print: () => true,
      })
      return { reply, connected, peek: calls.filter(([m]) => m === "peek_turn").map(([, params]) => params) }
    }

    describe("hooks feed the peek digest", () => {
      test("a prompt posts the user's text and a named stop the last reply, up to the broker's raw cap so it redacts before it clips; the reply printed is the same as without them", async () => {
        const long = `${"p".repeat(2500)}`
        const prompt = await withFake(["claude"], { hook_event_name: "UserPromptSubmit", prompt: long }, undefined, {
          messages: [MESSAGE],
          offered: [4],
          unread: 1,
        })
        expect(prompt.peek).toEqual([{ role: "user", text: long }])
        const huge = await withFake(["claude"], { hook_event_name: "UserPromptSubmit", prompt: "q".repeat(PEEK.rawChars + 10) })
        expect(huge.peek).toEqual([{ role: "user", text: "q".repeat(PEEK.rawChars) }])
        const wide = await withFake(["claude"], { hook_event_name: "UserPromptSubmit", prompt: "\ud800".repeat(PEEK.rawChars) })
        const sent = wide.peek[0]!.text as string
        expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(MAX_LINE / 2)
        expect(sent.length).toBeGreaterThan(PEEK.storeChars * 4)
        const bare = await withFake(["claude"], { hook_event_name: "UserPromptSubmit" }, undefined, { messages: [MESSAGE], offered: [4], unread: 1 })
        expect(bare.peek).toEqual([])
        expect(prompt.reply).toBeDefined()
        expect(prompt.reply).toBe(bare.reply)

        const stop = await withFake(["claude"], { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "REPLY-MARKER all green" })
        expect(stop.peek).toEqual([{ role: "assistant", text: "REPLY-MARKER all green" }])
        expect(stop.reply).toBe((await withFake(["claude"], { hook_event_name: "Stop", stop_hook_active: false })).reply)

        const codex = await withFake(["codex"], { hook_event_name: "Stop", turn_id: "t", last_assistant_message: "codex says done" }, { CODEX_THREAD_ID: "c" })
        expect(codex.peek).toEqual([{ role: "assistant", text: "codex says done" }])
        const grok = await withFake(
          ["claude"],
          { hookEventName: "user_prompt_submit", hook_event_name: "UserPromptSubmit", sessionId: "g", prompt: "grok prompt" },
          { GROK_SESSION_ID: "g" },
        )
        expect(grok.peek).toEqual([{ role: "user", text: "grok prompt" }])
        const muse = await withFake(["muse"], { hook_event_name: "UserPromptSubmit", prompt: "muse prompt" }, { MUSE_SESSION_ID: "m" })
        expect(muse.peek).toEqual([{ role: "user", text: "muse prompt" }])
      })

      test("a subagent's stop, a tool, an empty prompt and a prompt without text post nothing to the digest", async () => {
        for (const payload of [
          { hook_event_name: "SubagentStop", agent_id: "9b1c2d3e4f", agent_type: "Explore", last_assistant_message: "subagent reply" },
          { hook_event_name: "Stop", agent_id: "9b1c2d3e4f", last_assistant_message: "inside a subagent" },
          { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, prompt: "not a prompt" },
          { hook_event_name: "UserPromptSubmit", prompt: "   " },
          { hook_event_name: "UserPromptSubmit", prompt: 42 },
          { hook_event_name: "Stop", last_assistant_message: "" },
        ]) {
          const result = await withFake(["claude"], payload)
          expect(result.connected).toBe(true)
          expect(result.peek).toEqual([])
        }
      })

      test("with the cloud transport a hook posts nothing to the digest and connects to no broker", async () => {
        for (const payload of [
          { hook_event_name: "UserPromptSubmit", prompt: "cloud prompt" },
          { hook_event_name: "Stop", last_assistant_message: "cloud reply" },
        ]) {
          const result = await withFake(["claude"], payload, { CLAUDECODE: "1", SCP_TRANSPORT: "cloud" })
          expect(result).toEqual({ reply: undefined, connected: false, peek: [] })
        }
      })
    })

    describe("hooks feed the peek digest, through a broker", () => {
      let broker: Broker
      const dir = join(process.env.HOME!, "hook-peek-relay", mode)
      const project = join(process.env.HOME!, "hook-peek-project")

      beforeAll(async () => {
        mkdirSync(join(project, ".git"), { recursive: true })
        broker = await startBroker({ dir, idleMs: 0, policyPath: join(process.env.HOME!, "hook-peek-policy.json"), log: () => {} })
      })
      afterAll(async () => {
        await broker.stop()
      })

      async function hook(args: string[], payload: unknown, env: Record<string, string>) {
        const child = Bun.spawn([process.execPath, "--no-env-file", entry, "hook", ...args], {
          stdin: new TextEncoder().encode(JSON.stringify(payload)),
          stdout: "pipe",
          stderr: "pipe",
          env: cleanEnv(env),
        })
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        return { stdout, stderr, code }
      }

      test("an opted-in session's prompt and stop land in its digest; the hooks print exactly what they printed before, and nothing lands while peek is off", async () => {
        const env = { SCP_DIR: dir, SCP_SESSION: "peek-e2e", SCP_NAME: "peek-e2e", CLAUDECODE: "1" }
        const base = { session_id: "s", cwd: project }
        await hook(["claude"], { ...base, hook_event_name: "SessionStart", source: "startup" }, env)
        const human = { kind: "human", tty: true } as const
        expect(await hook(["claude"], { ...base, hook_event_name: "UserPromptSubmit", prompt: "BEFORE-MARKER" }, env)).toEqual({
          stdout: "",
          stderr: "",
          code: 0,
        })
        broker.core.peekSet(human, { endpoint: "peek-e2e", level: "on" })
        expect(await hook(["claude"], { ...base, hook_event_name: "UserPromptSubmit", prompt: "PROMPT-MARKER" }, env)).toEqual({
          stdout: "",
          stderr: "",
          code: 0,
        })
        expect(await hook(["claude"], { ...base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "REPLY-MARKER" }, env)).toEqual({
          stdout: "",
          stderr: "",
          code: 0,
        })
        expect(
          await hook(["claude"], { ...base, hook_event_name: "SubagentStop", agent_id: "abcdef1234", last_assistant_message: "SUBAGENT-MARKER" }, env),
        ).toEqual({ stdout: "", stderr: "", code: 0 })
        const peeked = broker.core.peek(human, { endpoint: "peek-e2e", turns: 10 })
        expect(peeked.turns.map((t) => [t.role, t.text])).toEqual([
          ["user", "PROMPT-MARKER"],
          ["assistant", "REPLY-MARKER"],
        ])
        expect(JSON.stringify(broker.core.activity({ limit: 1000 }))).not.toContain("MARKER")
      })

      test("a credential straddling the store cut is redacted whole by the broker, never kept in part", async () => {
        const env = { SCP_DIR: dir, SCP_SESSION: "peek-cut", SCP_NAME: "peek-cut", CLAUDECODE: "1" }
        const base = { session_id: "s-cut", cwd: project }
        await hook(["claude"], { ...base, hook_event_name: "SessionStart", source: "startup" }, env)
        const human = { kind: "human", tty: true } as const
        broker.core.peekSet(human, { endpoint: "peek-cut", level: "on" })
        const token = `ghp_${"Z9y8X7w6".repeat(5)}`
        const prompt = `${"word ".repeat(398)}${token} tail`
        expect(prompt.indexOf(token)).toBeLessThan(2000)
        expect(prompt.indexOf(token) + token.length).toBeGreaterThan(2000)
        expect(await hook(["claude"], { ...base, hook_event_name: "UserPromptSubmit", prompt }, env)).toEqual({ stdout: "", stderr: "", code: 0 })
        const turns = broker.core.peek(human, { endpoint: "peek-cut", turns: 10, full: true }).turns
        expect(turns).toHaveLength(1)
        expect(turns[0]!.text).not.toContain("ghp_")
        expect(turns[0]!.text).not.toContain("Z9y8")
      })
    })
  })
