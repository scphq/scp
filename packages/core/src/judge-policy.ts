import { JUDGE_EFFORTS, type JudgeEffort, judgeModel, type JudgeProvider } from "./judge-provider"
import { matches, type PolicySubject, type Selector, validSelector } from "./policy"
import { RelayError } from "./protocol"
import { findSecret } from "./scrub"

export interface JudgeModelConfig {
  /** `provider/name` */
  id: string
  effort: JudgeEffort
  /** the broker environment's variable holding the key */
  key_env?: string
  /** an absolute path the key is read from at each call */
  key_file?: string
}

/** where the judge runs: `from` anchored on the recipient, `to` on the sender; `across: tree` only between scoped ends of different trees */
export interface JudgeBoundary {
  from: Selector
  to: Selector
  across?: "tree"
}

/** judged sends across the whole broker, every sender together */
export interface JudgeBudget {
  per_minute: number
  per_hour: number
}

export const DEFAULT_JUDGE_BUDGET: JudgeBudget = { per_minute: 120, per_hour: 1200 }

export interface JudgePolicy {
  mode: "off" | "shadow" | "enforce"
  fail: "open" | "closed"
  timeout_s: number
  model?: JudgeModelConfig
  /** absent: DEFAULT_JUDGE_BUDGET */
  budget?: JudgeBudget
  boundaries: JudgeBoundary[]
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const refuse = (message: string) => new RelayError("invalid_params", `judge: ${message}`)

function unknownFields(rest: Record<string, unknown>, where: string): void {
  if (Object.keys(rest).length) throw refuse(`unknown ${where} fields: ${Object.keys(rest).join(", ")}`)
}

/**
 * a policy's `judge` section checked field by field, `model.id` against `providers`; keys are only referenced (key_env, key_file), never
 * written into the policy
 */
export function parseJudgePolicy(value: unknown, providers?: Readonly<Record<string, JudgeProvider>>): JudgePolicy {
  if (!isObject(value)) throw refuse("the judge section is an object")
  const secret = findSecret(JSON.stringify(value))
  if (secret) throw refuse(`the section holds a credential (${secret}): reference it with model.key_env or model.key_file`)
  const { mode, fail, timeout_s, model, budget, boundaries, ...rest } = value
  unknownFields(rest, "judge")
  if (mode !== undefined && mode !== "off" && mode !== "shadow" && mode !== "enforce") throw refuse("mode is off, shadow or enforce")
  if (fail !== undefined && fail !== "open" && fail !== "closed") throw refuse("fail is open or closed")
  if (timeout_s !== undefined && (typeof timeout_s !== "number" || !Number.isInteger(timeout_s) || timeout_s < 1 || timeout_s > 30)) throw refuse("timeout_s is 1 to 30 seconds")
  if (!Array.isArray(boundaries) || boundaries.length < 1 || boundaries.length > 64) throw refuse("boundaries is a list of 1 to 64 boundaries")
  const judge: JudgePolicy = {
    mode: mode ?? "shadow",
    fail: fail ?? "open",
    timeout_s: timeout_s ?? 12,
    boundaries: boundaries.map((boundary, index) => {
      if (!isObject(boundary)) throw refuse(`boundary ${index} is not an object`)
      const { from, to, across, ...extra } = boundary
      unknownFields(extra, `boundary ${index}`)
      for (const [key, sel] of [["from", from], ["to", to]] as const) {
        if (sel !== undefined && !validSelector(sel)) throw refuse(`boundary ${index} ${key}: ${JSON.stringify(sel)} is not a selector`)
      }
      if (across !== undefined && across !== "tree") throw refuse(`boundary ${index} across is tree`)
      return { from: (from as Selector | undefined) ?? "*", to: (to as Selector | undefined) ?? "*", ...(across ? { across } : {}) }
    }),
  }
  if (budget !== undefined) {
    if (!isObject(budget)) throw refuse("budget is {per_minute, per_hour}")
    const { per_minute, per_hour, ...extra } = budget
    unknownFields(extra, "budget")
    const count = (n: unknown, max: number, name: string): number => {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max) throw refuse(`budget.${name} is 1 to ${max}`)
      return n
    }
    judge.budget = {
      per_minute: per_minute === undefined ? DEFAULT_JUDGE_BUDGET.per_minute : count(per_minute, 10_000, "per_minute"),
      per_hour: per_hour === undefined ? DEFAULT_JUDGE_BUDGET.per_hour : count(per_hour, 100_000, "per_hour"),
    }
  }
  if (model !== undefined) {
    if (!isObject(model)) throw refuse("model is {id, effort, key_env | key_file}")
    const { id, effort, key_env, key_file, ...extra } = model
    unknownFields(extra, "model")
    if (typeof id !== "string") throw refuse("model.id is provider/name")
    try {
      judgeModel(id, providers)
    } catch (error) {
      throw refuse((error as Error).message)
    }
    if (effort !== undefined && !JUDGE_EFFORTS.includes(effort as JudgeEffort)) throw refuse(`model.effort is one of ${JUDGE_EFFORTS.join(", ")}`)
    if ((key_env === undefined) === (key_file === undefined)) throw refuse("model needs exactly one of key_env or key_file")
    if (key_env !== undefined && (typeof key_env !== "string" || !ENV_NAME.test(key_env))) throw refuse("model.key_env is an environment variable name")
    if (key_file !== undefined && (typeof key_file !== "string" || !key_file.startsWith("/") || key_file.length > 1024)) throw refuse("model.key_file is an absolute path")
    judge.model = { id, effort: (effort as JudgeEffort | undefined) ?? "medium", ...(key_env !== undefined ? { key_env: key_env as string } : { key_file: key_file as string }) }
  }
  return judge
}

/** the label of the first boundary a message from `from` to `to` crosses, or null when the judge is off or none matches */
export function judgeBoundary(judge: JudgePolicy | undefined, from: PolicySubject, to: PolicySubject): string | null {
  if (!judge || judge.mode === "off") return null
  for (const b of judge.boundaries) {
    if (!matches(b.from, from, to) || !matches(b.to, to, from)) continue
    if (b.across === "tree" && !(from.scope && to.scope && from.scope.tree !== to.scope.tree)) continue
    return `${b.from} to ${b.to}${b.across ? " (across trees)" : ""}`
  }
  return null
}
