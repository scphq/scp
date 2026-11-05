import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { RelayClient, startBroker, type BrokerOptions, type HookHandler, type HookParams } from "@scp-dev/broker"
import { readCapped } from "./hook-fast"
import { hookEnv, hookHandler, relayHookRpc } from "./hook-rpc"
import { readPsTable } from "./identity"
import { runHook, type HookOptions } from "./hooks"
import { nativeCli } from "./test-setup"

const processTable = readPsTable() ?? new Map()

export const hookModes = ["direct", "rpc"] as const
export type HookMode = (typeof hookModes)[number]

export function testBroker(mode: HookMode, options: BrokerOptions) {
  return startBroker({ ...options, ...(mode === "rpc" ? { hook: hookHandler(options.dir, options.dir) } : routedHooks(options.dir)) })
}

/** Exercises the transport while retaining each fixture's clock and downstream broker. */
export async function testHook(mode: HookMode, args: string[], options: HookOptions): Promise<string | undefined> {
  options = { startOf: (pid) => processTable.get(pid)?.start, psTable: () => processTable, ...options }
  if (mode === "direct") return runHook(args, options)
  const root = mkdtempSync(join(tmpdir(), "hook-parity-"))
  const raw = await readCapped(options.stdin)
  let payload: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === "object" && value !== null && !Array.isArray(value)) payload = value as Record<string, unknown>
  } catch {}
  let finished!: () => void
  const done = new Promise<void>((resolve) => {
    finished = resolve
  })
  let failure: unknown
  let offered = false
  const broker = await startBroker({
    dir: root,
    idleMs: 0,
    policyPath: join(root, "policy.json"),
    log: () => {},
    hook: async (params, context) => {
      try {
        const stdout = await runHook(params.args, {
          ...options,
          env: params.env,
          stdin: Readable.from([JSON.stringify(params.payload)]),
          print: (stdout) => {
            offered = true
            return context.print(stdout)
          },
          deadline: (ms) => {
            options.deadline?.(ms)
            context.notify((options.began ?? params.origin) + ms)
          },
        })
        return { ...(stdout ? { stdout } : {}), exit: 0 }
      } catch (error) {
        failure = error
        throw error
      } finally {
        finished()
      }
    },
  })
  const client = await RelayClient.connect(broker.socket)
  try {
    const origin = options.began ?? Date.now()
    const params: HookParams = {
      args,
      payload,
      cwd: options.cwd,
      env: hookEnv(options.env),
      origin,
      ends: Date.now() + 30_000,
      ppid: process.ppid,
      procs: [],
    }
    const reply = await relayHookRpc(
      client,
      params,
      async (text) => (offered ? ((await options.print?.(text)) ?? true) : true),
      () => {},
    )
    client.close()
    await done
    return reply?.stdout
  } catch (error) {
    throw failure ?? error
  } finally {
    client.close()
    await broker.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

/** what a test's broker takes to serve hooks as a daemon does: the native hook has no in-process path, so under native routing it needs them */
export function routedHooks(dir: string): { hook?: HookHandler } {
  return nativeCli ? { hook: hookHandler(dir, dir) } : {}
}
