import { type JudgePolicy, parseJudgePolicy } from "./judge-policy"
import type { JudgeProvider } from "./judge-provider"
import { RelayError, type ScopePreset, SCOPE_PRESETS } from "./protocol"
import { PRESET_LISTS } from "./scopes"

/**
 * `*`, `ep:<handle>` (that one agent), `handle:<glob>`, `harness:<name>`, `kind:<agent|human>` or `label:<key>=<value>`, plus the scope selectors: `tree:self|root|parent|siblings|children`,
 * `tree:ancestors[:N]`, `tree:descendants[:N]` (relative to the list's owner), `group:<name>`, `group:self` (in a group's rules), `fleet:<root handle>`,
 * `fleet:*`, `machine:<name>`, `acct:<handle>` and `acct:*` (endpoints of contacts, the only selectors that match them), and the reserved `org:<org>`, `org:*`, `group:<org>/<name>`. A glob is a handle with `*` for any run of characters.
 */
export type Selector = string

export interface PolicyRule {
  /** the endpoints this rule is about */
  match: Selector
  /** when present, only senders matching one of these may message them */
  accept_from?: Selector[]
  /** when present, they may message only recipients matching one of these */
  send_to?: Selector[]
  /** a cap by the policy on every matching endpoint, both directions under symmetric presets, else out only; a preset is stored as its list, `open` as no cap */
  scope?: Selector[]
}

/** a pinned static group: members by absolute selectors, owned by the policy */
export interface PolicyGroup {
  name: string
  members: Selector[]
  in?: Selector[]
  out?: Selector[]
  rules?: Selector[]
}

export interface PolicyDefaults {
  human_always?: boolean
  symmetric_presets?: boolean
  /** `inherit`: a child of a capped parent reaches only what the parent reaches; a preset caps every placed child without grant caps */
  child_default?: ScopePreset | "inherit"
  verify_lineage?: "spike" | boolean
  /** who may rename an agent besides the human at a terminal: `root` (default) only a root session itself, `self` any agent itself, spawned ones too */
  rename?: "root" | "self"
  /** who may unlink an agent from its parent besides the human at a terminal: `human` (default) nobody, `self` the agent itself */
  unlink?: "human" | "self"
}

export interface Policy {
  rules: PolicyRule[]
  groups?: PolicyGroup[]
  defaults?: PolicyDefaults
  /** where messages are judged, and how */
  judge?: JudgePolicy
}

/** the policy as text that ignores the order of rules, groups and selector lists, none of which changes what it allows */
export function canonicalPolicy(policy: Policy): string {
  const sorted = (list: Selector[] | undefined) => (list ? [...list].sort() : undefined)
  const rules = policy.rules
    .map((rule) => JSON.stringify({ ...rule, accept_from: sorted(rule.accept_from), send_to: sorted(rule.send_to), scope: sorted(rule.scope) }))
    .sort()
  const groups = (policy.groups ?? [])
    .map((group) => ({ ...group, members: sorted(group.members), in: sorted(group.in), out: sorted(group.out), rules: sorted(group.rules) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return JSON.stringify({ rules, groups, defaults: policy.defaults ?? {}, ...(policy.judge ? { judge: policy.judge } : {}) })
}

/** where an endpoint sits, for the scope selectors; local rows compute it, proxy rows mirror it */
export interface ScopeSubject {
  id: string
  /** the root endpoint's id */
  tree: string
  /** nearest first */
  ancestors: string[]
  groups: string[]
  rootHandle: string
  machine: string | null
  local: boolean
}

export interface PolicySubject {
  handle: string
  harness: string | null
  kind: string
  labels: Record<string, string>
  /** absent for the human and the system endpoint: such a subject matches no tree, group, fleet or machine selector */
  scope?: ScopeSubject
  /** the handle of the other account an endpoint of a contact belongs to: such a subject matches only `acct:` selectors */
  account?: string
}

const NAME = "[a-z0-9][a-z0-9._-]{0,62}"
const DEPTH = "(?::(?:[1-9]|1[0-6]))?"
const BASE = `\\*|ep:${NAME}|handle:[a-z0-9._*-]{1,63}|harness:[a-z0-9-]{1,32}|kind:(?:agent|human)|label:[a-z0-9._-]{1,32}=[^\\s]{0,128}`
const ABSOLUTE = `${BASE}|group:${NAME}|group:${NAME}/${NAME}|fleet:(?:\\*|${NAME})|machine:[A-Za-z0-9][A-Za-z0-9._-]{0,62}|org:(?:\\*|${NAME})|acct:(?:\\*|[a-z0-9][a-z0-9-]{0,63})`
const RELATIVE = `tree:(?:self|root|parent|siblings|children)|tree:ancestors${DEPTH}|tree:descendants${DEPTH}`
const SELECTOR = new RegExp(`^(?:${ABSOLUTE}|${RELATIVE})$`)
const ABSOLUTE_SELECTOR = new RegExp(`^(?:${ABSOLUTE})$`)
export const GROUP_NAME = new RegExp(`^${NAME}$`)

/**
 * whether `s` is a selector: `absolute` refuses the relative `tree:` ones (a rule's `match`, a group's members), and `group:self` is valid only
 * where `groupRules` allows it (a group's own rules)
 */
export function validSelector(s: unknown, options: { absolute?: boolean; groupRules?: boolean } = {}): s is Selector {
  if (typeof s !== "string") return false
  if (s === "group:self") return options.groupRules === true
  return (options.absolute ? ABSOLUTE_SELECTOR : SELECTOR).test(s)
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** a policy document checked field by field; anything unknown is refused so a typo never opens a hole silently */
export function parsePolicy(value: unknown, options: { judgeProviders?: Readonly<Record<string, JudgeProvider>> } = {}): Policy {
  if (!isObject(value)) throw new RelayError("invalid_params", "a policy is {rules: [...]}")
  const { rules, groups, defaults, judge, ...rest } = value
  if (Object.keys(rest).length) throw new RelayError("invalid_params", `unknown policy fields: ${Object.keys(rest).join(", ")}`)
  if (!Array.isArray(rules) || rules.length > 256) throw new RelayError("invalid_params", "rules must be a list of at most 256 rules")
  const list = (l: unknown, where: string, options: { absolute?: boolean; groupRules?: boolean } = {}): Selector[] | undefined => {
    if (l === undefined) return undefined
    if (!Array.isArray(l) || l.length > 64) throw new RelayError("invalid_params", `${where} must be a list`)
    return l.map((s) => {
      if (!validSelector(s, options)) throw new RelayError("invalid_params", `${where}: ${JSON.stringify(s)} is not a selector`)
      return s
    })
  }
  const policy: Policy = {
    rules: rules.map((rule, index) => {
      if (!isObject(rule)) throw new RelayError("invalid_params", `rule ${index} is not an object`)
      const { match, accept_from, send_to, scope, ...extra } = rule
      if (Object.keys(extra).length) throw new RelayError("invalid_params", `rule ${index} has unknown fields: ${Object.keys(extra).join(", ")}`)
      if (!validSelector(match, { absolute: true })) throw new RelayError("invalid_params", `rule ${index} match: ${JSON.stringify(match)} is not a selector`)
      const parsed: PolicyRule = { match }
      for (const [key, sels] of [
        ["accept_from", accept_from],
        ["send_to", send_to],
      ] as const) {
        const parsedList = list(sels, `rule ${index} ${key}`)
        if (parsedList) parsed[key] = parsedList
      }
      if (typeof scope === "string" && SCOPE_PRESETS.includes(scope as ScopePreset)) {
        if (scope !== "open") parsed.scope = [...PRESET_LISTS[scope as Exclude<ScopePreset, "open">]]
      } else {
        const parsedList = list(scope, `rule ${index} scope`)
        if (parsedList) parsed.scope = parsedList
      }
      return parsed
    }),
  }
  if (groups !== undefined) {
    if (!Array.isArray(groups) || groups.length > 64) throw new RelayError("invalid_params", "groups must be a list of at most 64 groups")
    const names = new Set<string>()
    policy.groups = groups.map((group, index) => {
      if (!isObject(group)) throw new RelayError("invalid_params", `group ${index} is not an object`)
      const { name, members, in: inList, out, rules: both, ...extra } = group
      if (Object.keys(extra).length) throw new RelayError("invalid_params", `group ${index} has unknown fields: ${Object.keys(extra).join(", ")}`)
      if (typeof name !== "string" || !GROUP_NAME.test(name) || name === "self" || names.has(name))
        throw new RelayError("invalid_params", `group ${index} needs a unique name`)
      names.add(name)
      const parsed: PolicyGroup = { name, members: list(members, `group ${name} members`, { absolute: true }) ?? [] }
      for (const [key, sels] of [
        ["in", inList],
        ["out", out],
        ["rules", both],
      ] as const) {
        const parsedList = list(sels, `group ${name} ${key}`, { groupRules: true })
        if (parsedList) parsed[key] = parsedList
      }
      return parsed
    })
  }
  if (defaults !== undefined) {
    if (!isObject(defaults)) throw new RelayError("invalid_params", "defaults is an object")
    const { human_always, symmetric_presets, child_default, verify_lineage, rename, unlink, ...extra } = defaults
    if (Object.keys(extra).length) throw new RelayError("invalid_params", `unknown defaults: ${Object.keys(extra).join(", ")}`)
    const parsed: PolicyDefaults = {}
    for (const [key, flag] of [
      ["human_always", human_always],
      ["symmetric_presets", symmetric_presets],
    ] as const) {
      if (flag === undefined) continue
      if (typeof flag !== "boolean") throw new RelayError("invalid_params", `defaults.${key} is true or false`)
      parsed[key] = flag
    }
    if (child_default !== undefined) {
      if (child_default !== "inherit" && !SCOPE_PRESETS.includes(child_default as ScopePreset)) {
        throw new RelayError("invalid_params", `defaults.child_default is inherit or one of ${SCOPE_PRESETS.join(", ")}`)
      }
      parsed.child_default = child_default as ScopePreset | "inherit"
    }
    if (verify_lineage !== undefined) {
      if (verify_lineage !== "spike" && typeof verify_lineage !== "boolean")
        throw new RelayError("invalid_params", "defaults.verify_lineage is spike, true or false")
      if (verify_lineage === true)
        throw new RelayError("invalid_params", "defaults.verify_lineage true needs the peer-pid check, which this relay does not have yet: use spike or false")
      parsed.verify_lineage = verify_lineage
    }
    if (rename !== undefined) {
      if (rename !== "root" && rename !== "self") throw new RelayError("invalid_params", "defaults.rename is root or self")
      parsed.rename = rename
    }
    if (unlink !== undefined) {
      if (unlink !== "human" && unlink !== "self") throw new RelayError("invalid_params", "defaults.unlink is human or self")
      parsed.unlink = unlink
    }
    policy.defaults = parsed
  }
  if (judge !== undefined) policy.judge = parseJudgePolicy(judge, options.judgeProviders)
  return policy
}

/**
 * whether `selector` matches `subject`; the relative `tree:` selectors need the list's owner as `anchor` and match nothing without it, and a
 * `group:<name>` matches only while `bound` holds for the name
 */
export function matches(selector: Selector, subject: PolicySubject, anchor?: PolicySubject, bound?: (name: string) => boolean): boolean {
  if (subject.account !== undefined) return selector === "acct:*" || selector === `acct:${subject.account}`
  if (selector === "*") return true
  const colon = selector.indexOf(":")
  const kind = selector.slice(0, colon)
  const value = selector.slice(colon + 1)
  const x = subject.scope
  switch (kind) {
    case "ep":
      return subject.kind === "agent" && subject.handle === value
    case "handle":
      return subject.kind === "agent" && new RegExp(`^${value.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`).test(subject.handle)
    case "harness":
      return subject.harness === value
    case "kind":
      return subject.kind === value
    case "label": {
      const eq = value.indexOf("=")
      return subject.labels[value.slice(0, eq)] === value.slice(eq + 1)
    }
    case "group":
      return !!x && !value.includes("/") && value !== "self" && x.groups.includes(value) && (bound?.(value) ?? true)
    case "fleet":
      return !!x && x.local && subject.kind === "agent" && (value === "*" || x.rootHandle === value)
    case "machine":
      return !!x && x.machine === value
    case "tree": {
      const a = anchor?.scope
      if (!x || !a || !x.local || !a.local || x.tree !== a.tree) return false
      const [relation, depth] = value.split(":") as [string, string | undefined]
      const n = depth === undefined ? Infinity : Number(depth)
      switch (relation) {
        case "self":
          return true
        case "root":
          return x.id === a.tree
        case "parent":
          return a.ancestors[0] === x.id
        case "ancestors": {
          const index = a.ancestors.indexOf(x.id)
          return index !== -1 && index < n
        }
        case "children":
          return x.ancestors[0] === a.id
        case "descendants": {
          const index = x.ancestors.indexOf(a.id)
          return index !== -1 && index < n
        }
        case "siblings":
          return x.id !== a.id && a.ancestors[0] !== undefined && x.ancestors[0] === a.ancestors[0]
      }
      return false
    }
  }
  return false
}

/**
 * null when the policy lets `from` message `to`, else why not; `send_to` is relative to the sender, `accept_from` to the recipient, and a
 * `group:<name>` matches only while `bound` holds for the name
 */
export function policyRefusal(policy: Policy | null, from: PolicySubject, to: PolicySubject, bound?: (name: string) => boolean): string | null {
  if (!policy) return null
  for (const rule of policy.rules) {
    if (rule.send_to && matches(rule.match, from, undefined, bound) && !rule.send_to.some((s) => matches(s, to, from, bound)))
      return `the relay policy (${rule.match}, send_to) does not let this endpoint message that one`
    if (rule.accept_from && matches(rule.match, to, undefined, bound) && !rule.accept_from.some((s) => matches(s, from, to, bound)))
      return `the relay policy (${rule.match}, accept_from) does not let that endpoint receive from this one`
  }
  return null
}
