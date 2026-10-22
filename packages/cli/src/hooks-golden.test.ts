import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { RelayClient, startBroker, type HookParams } from "@scp-dev/broker"
import { hookHandler, relayHookRpc } from "./hook-rpc"
import { runHook } from "./hooks"

setDefaultTimeout(30_000)

const fixtures = [
  ["session start", "SessionStart", false],
  ["prompt", "UserPromptSubmit", true],
  ["tool", "PostToolUse", true],
  ["empty stop", "Stop", false],
  ["pending stop", "Stop", true],
  ["session end", "SessionEnd", false],
] as const

for (const harness of ["claude-code", "codex", "opencode", "agy", "muse", "grok"])
  describe(`golden ${harness}`, () => {
    for (const [name, event, pending] of fixtures)
      test(name, async () => {
        const root = mkdtempSync(join(tmpdir(), "hook-golden-"))
        const template = join(root, "template")
        const clock = Date.now()
        const key = `pid:${process.pid}:fixture`
        const options = { idleMs: 0, policyPath: join(root, "policy.json"), now: () => clock, startOf: () => "fixture" }
        const seed = await startBroker({ ...options, dir: template })
        const endpoint = seed.core.claim({ handle: "golden", harness, session: "env:golden", process: key, cwd: "/tmp" }, { transient: true }).endpoint
        if (pending) {
          const peer = seed.core.claim({ handle: "peer", harness: "test" }).endpoint
          seed.core.send(peer.id, { to: "golden", body: "golden pending" })
        }
        await seed.stop()
        const outputs: { stdout: string; shown: boolean[] }[] = []
        try {
          for (const mode of ["direct", "rpc"] as const) {
            const dir = join(root, mode)
            mkdirSync(dir, { mode: 0o700 })
            copyFileSync(join(template, "relay.db"), join(dir, "relay.db"))
            const broker = await startBroker({ ...options, dir, hook: hookHandler(dir, dir) })
            const env = { SCP_NAME: "golden", SCP_SESSION: "golden", SCP_DIR: dir, SCP_HARNESS_DETECT: "0", HOME: root }
            const args = [
              harness,
              ...(harness === "agy" ? [event === "UserPromptSubmit" ? "PreInvocation" : event] : []),
              ...(name === "pending stop" ? ["--block-stop-on-unread"] : []),
            ]
            const payload =
              harness === "agy"
                ? {
                    workspacePaths: ["/tmp"],
                    conversationId: "fixture",
                    toolCall: { name: "Read", args: { file_path: "/tmp/golden" } },
                    terminationReason: "NO_TOOL_CALL",
                  }
                : {
                    hook_event_name: event,
                    cwd: "/tmp",
                    session_id: "fixture",
                    prompt: "golden prompt",
                    tool_name: "Read",
                    tool_input: { file_path: "/tmp/golden" },
                    terminationReason: "NO_TOOL_CALL",
                  }
            let stdout = ""
            const print = (text: string) => {
              stdout = `${text}\n`
              return true
            }
            const client = await RelayClient.connect(broker.socket)
            try {
              if (mode === "rpc") {
                const params: HookParams = {
                  args,
                  payload,
                  cwd: "/tmp",
                  env,
                  origin: Date.now(),
                  ends: Date.now() + 5000,
                  ppid: process.pid,
                  procs: [{ pid: process.pid, ppid: 1, start: "fixture", args: harness, comm: harness }],
                  harness_pid: process.pid,
                }
                await relayHookRpc(client, params, print, () => {})
              } else {
                const reply = await runHook(args, {
                  env,
                  cwd: "/tmp",
                  stdin: Readable.from([JSON.stringify(payload)]),
                  harnessPid: () => process.pid,
                  startOf: () => "fixture",
                  psTable: () => new Map([[process.pid, { ppid: 1, start: "fixture", args: harness }]]),
                  connect: () => RelayClient.connect(broker.socket),
                  print,
                })
                if (!stdout && reply) print(reply)
              }
              if (!stdout && harness === "agy") stdout = "{}\n"
              outputs.push({ stdout, shown: broker.core.inbox(endpoint.id).map((message) => message.shown_at !== null) })
            } finally {
              client.close()
              await broker.stop()
            }
          }
          expect(outputs[1]).toEqual(outputs[0])
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      })
  })
