import { findSecret } from "./scrub"

export const RUNNER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const RUNNER_REF = /^[\x21-\x7e]{1,256}$/
export const RUNNER_ATTACH = /^[^\u0000-\u001f\u007f-\u009f]{1,1024}$/
const MACHINE_ADDRESS = /^me\/([a-z0-9][a-z0-9-]{0,31})\/([^/]+)$/
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

export interface RunnerReply {
  address: string
  machine: string
  ref?: string
  attach?: string
}

/** the runner's optional stdout object `{address, machine, ref?, attach?}`; undefined when absent or invalid, a field that looks like a credential dropped */
export function runnerReply(stdout: string, name: string): RunnerReply | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout.trim())
  } catch {
    return undefined
  }
  if (!isObject(value) || typeof value.machine !== "string" || typeof value.address !== "string") return undefined
  const address = MACHINE_ADDRESS.exec(value.address)
  if (!address || address[1] !== value.machine || address[2] !== name) return undefined
  if (value.ref !== undefined && (typeof value.ref !== "string" || !RUNNER_REF.test(value.ref))) return undefined
  if (value.attach !== undefined && (typeof value.attach !== "string" || !RUNNER_ATTACH.test(value.attach))) return undefined
  const ref = typeof value.ref === "string" && !findSecret(value.ref) ? value.ref : undefined
  const attach = typeof value.attach === "string" && !findSecret(value.attach) ? value.attach : undefined
  return { address: value.address, machine: value.machine, ...(ref ? { ref } : {}), ...(attach ? { attach } : {}) }
}

export interface ViaRecord {
  spawner: string
  name: string
  runner: string
  address: string | null
  machine: string | null
  ref: string | null
  attach: string | null
  created_at: number
  ended_at: number | null
}
