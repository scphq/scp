import { Readable } from "node:stream"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { RelayClient, startBroker, writeSessionMarker } from "@scp-dev/broker"
import { LIMITS } from "@scp-dev/core"
import { type HookOptions, OPENCODE_WAKE, runHook, WAKE } from "./hooks"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "hook-wake-"))
  const clock = { now: Date.now() }
  const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0, now: () => clock.now })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => broker.stop())
  const env = { SCP_NAME: "idle", SCP_SESSION: "wake-test", SCP_DIR: join(root, "state") }
  const printed: string[] = []
  const deadlines: number[] = []
  const run = (wake: boolean, extra: Partial<HookOptions> = {}) =>
    runHook(["opencode", ...(wake ? [WAKE, "1"] : [])], {
      env,
      cwd: root,
      stdin: Readable.from([JSON.stringify({ hook_event_name: wake ? "Wake" : "PostToolUse", session_id: "ses_root", cwd: root, tool_name: "read" })]),
      connect: async (start) => {
        expect(start).toBe(false)
        return RelayClient.connect(broker.socket)
      },
      harnessPid: () => process.pid,
      deadline: (ms) => deadlines.push(ms),
      print: (text) => printed.push(text) > 0,
      ...extra,
    })
  await run(false)
  const peer = broker.core.claim({ handle: "peer", harness: "test" }).endpoint
  const send = () => broker.core.send(peer.id, { to: "idle", body: "wake-message" })
  return { broker, clock, env, printed, deadlines, run, send }
}

describe("OpenCode wake hooks", () => {
  test("prints and confirms a waiting message once before the next tool hook", async () => {
    const { broker, printed, deadlines, run, send } = await setup()
    send()
    const reply = await run(true)
    const output = JSON.parse(reply!).hookSpecificOutput
    expect(output.hookEventName).toBe("UserPromptSubmit")
    expect(output.additionalContext).toContain('<relay-message from="me/peer"')
    expect(output.additionalContext).toContain("wake-message")
    expect(printed).toEqual([reply!])
    expect(deadlines).toEqual([3000])
    const endpoint = broker.core.list().find((e) => e.address === "me/idle")!
    expect(broker.core.inbox(endpoint.id)[0]!.shown_at).toEqual(expect.any(String))
    expect(await run(false)).toBeUndefined()
    expect(printed).toHaveLength(1)
  })

  test("the waiter advertises that the OpenCode plugin wakes the session", async () => {
    const { broker, run } = await setup()
    const wake = () => broker.core.list().find((e) => e.address === "me/idle")!.wake
    expect(wake()).toBeNull()
    expect(await run(true)).toBeUndefined()
    expect(wake()).toBe(OPENCODE_WAKE)
  })

  test("the waiter of a session that left advertises no wake", async () => {
    const { broker, env, run } = await setup()
    const idle = () => broker.core.list().find((e) => e.address === "me/idle")!
    await run(true)
    broker.core.leaveSession({ kind: "endpoint", id: idle().id, auth: "session" })
    writeSessionMarker(env.SCP_DIR, `env:${env.SCP_SESSION}`, { joined: false, handle: "idle" })
    expect(await run(true)).toBeUndefined()
    expect(idle().wake).toBeNull()
  })

  test("stopping before printing leaves the offer unconfirmed for a later tool hook", async () => {
    const { clock, printed, run, send } = await setup()
    send()
    expect(await run(true, { stopping: () => true })).toBeUndefined()
    expect(printed).toEqual([])
    clock.now += LIMITS.injectHoldS * 1000 + 1
    expect(await run(false)).toContain("wake-message")
    expect(printed).toHaveLength(1)
  })

  test("stopping after printing still confirms the offer", async () => {
    const { run, send } = await setup()
    send()
    let stopping = false
    expect(
      await run(true, {
        stopping: () => stopping,
        print: () => {
          stopping = true
          return true
        },
      }),
    ).toContain("wake-message")
    expect(await run(false)).toBeUndefined()
  })

  test("cloud, invalid handles and subagents never connect", async () => {
    for (const extra of [{ env: { SCP_TRANSPORT: "cloud" } }, { env: { SCP_NAME: "bad handle" } }, { payload: { agent_id: "child" } }]) {
      let connected = false
      expect(
        await runHook(["opencode", WAKE, "1"], {
          env: extra.env ?? {},
          cwd: "/work/oc",
          stdin: Readable.from([JSON.stringify({ hook_event_name: "Wake", ...extra.payload })]),
          connect: async () => {
            connected = true
            throw new Error("unexpected connection")
          },
          harnessPid: () => process.pid,
        }),
      ).toBeUndefined()
      expect(connected).toBe(false)
    }
  })
})
