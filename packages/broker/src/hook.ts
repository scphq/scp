import hookEnv from "../../spec/schema/broker/hook-env.json"
import { randomBytes } from "node:crypto"
import type { RelayClient } from "./client"
import { RelayError } from "@scp-dev/core"

export interface HookProc {
  pid: number
  ppid: number
  start: string | null
  args: string
  comm?: string
}

export interface HookParams {
  args: string[]
  payload: Record<string, unknown>
  cwd?: string
  env: Record<string, string>
  origin: number
  ends: number
  ppid: number
  procs: HookProc[]
  harness_pid?: number
}

export interface HookResult {
  stdout?: string
  stderr?: string
  exit: 0
  commit?: string
}

export interface HookContext {
  connect(): Promise<RelayClient>
  notify(ends: number): void
  closed(): boolean
  print(stdout: string): Promise<boolean>
}

export type HookHandler = (params: HookParams, context: HookContext) => Promise<HookResult>

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const closed = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key))

export function validateHook(value: Record<string, unknown>): HookParams {
  const fail = () => {
    throw new RelayError("invalid_params", "malformed hook params")
  }
  if (!closed(value, ["args", "payload", "cwd", "env", "origin", "ends", "ppid", "procs", "harness_pid"])) fail()
  if (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string")) fail()
  if (!object(value.payload) || !object(value.env) || !Object.values(value.env).every((entry) => typeof entry === "string")) fail()
  if (object(value.env) && !Object.keys(value.env).every((key) => hookEnv.includes(key))) fail()
  if (value.cwd !== undefined && typeof value.cwd !== "string") fail()
  if (typeof value.origin !== "number" || !Number.isFinite(value.origin) || typeof value.ends !== "number" || !Number.isFinite(value.ends)) fail()
  if (!pid(value.ppid) || (value.harness_pid !== undefined && !pid(value.harness_pid))) fail()
  if (!Array.isArray(value.procs) || value.procs.length > 64) fail()
  const seen = new Set<number>()
  for (const entry of value.procs as unknown[]) {
    if (!object(entry) || !closed(entry, ["pid", "ppid", "start", "args", "comm"])) fail()
    const proc = entry as Record<string, unknown>
    if (!pid(proc.pid) || seen.has(proc.pid as number) || !Number.isSafeInteger(proc.ppid) || Number(proc.ppid) < 0) fail()
    seen.add(proc.pid as number)
    if (proc.start !== null && (typeof proc.start !== "string" || !/^[A-Za-z0-9:-]{1,64}$/.test(proc.start))) fail()
    if (typeof proc.args !== "string" || (proc.comm !== undefined && typeof proc.comm !== "string")) fail()
    if (proc.pid === value.ppid && typeof proc.comm !== "string") fail()
  }
  return value as unknown as HookParams
}

/** One connection's offers; a commit waits for the handler's confirmation work. */
export class HookCalls {
  private readonly offers = new Map<string, { accept(): void; done: Promise<unknown>; cancel(): void }>()
  private readonly cancellations = new Set<() => void>()

  constructor(
    private readonly isClosed: () => boolean,
    private readonly notification: (ends: number) => void,
    private readonly connect: (params: HookParams) => Promise<RelayClient>,
  ) {}

  run(handler: HookHandler, params: HookParams): Promise<HookResult> {
    let ends = params.ends
    let timer: ReturnType<typeof setTimeout>
    let offered = false
    let cancelled = false
    let release: ((printed: boolean) => void) | undefined
    let token: string | undefined
    const cancel = () => {
      cancelled = true
      release?.(false)
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(cancel, Math.max(0, Math.min(2 ** 31 - 1, ends - Date.now())))
    }
    this.cancellations.add(cancel)
    arm()
    let answer!: (result: HookResult) => void
    let reject!: (error: unknown) => void
    const result = new Promise<HookResult>((yes, no) => {
      answer = yes
      reject = no
    })
    const done = Promise.resolve().then(() =>
      handler(params, {
        connect: () => this.connect(params),
        notify: (next) => {
          ends = next
          arm()
          this.notification(ends)
        },
        closed: () => cancelled || this.isClosed(),
        print: async (stdout) => {
          if (offered || cancelled || this.isClosed() || Date.now() >= ends) return false
          offered = true
          token = randomBytes(24).toString("hex")
          const printed = new Promise<boolean>((resolve) => {
            release = resolve
          })
          this.offers.set(token, { accept: () => release?.(!cancelled && !this.isClosed() && Date.now() < ends), done, cancel })
          answer({ stdout, exit: 0, commit: token })
          return printed
        },
      }),
    )
    void done
      .then(
        (value) => {
          if (!offered) answer(value)
        },
        (error: unknown) => {
          if (!offered) reject(error)
        },
      )
      .finally(() => {
        clearTimeout(timer)
        if (token) this.offers.delete(token)
        this.cancellations.delete(cancel)
      })
    return result
  }

  async commit(params: Record<string, unknown>): Promise<Record<string, never>> {
    if (!closed(params, ["commit"]) || typeof params.commit !== "string") throw new RelayError("invalid_params", "commit is a string")
    const offer = this.offers.get(params.commit)
    if (offer) {
      offer.accept()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        offer.done.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000)
        }),
      ])
      clearTimeout(timer)
    }
    return {}
  }

  close(): void {
    for (const cancel of this.cancellations) cancel()
    this.offers.clear()
  }
}
