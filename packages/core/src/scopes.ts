import { matches, type PolicySubject } from "./policy"
import { CLI_NAME, RelayError, type ScopeCap, type ScopeDirection, type ScopeEntry, type ScopePreset, validHandle } from "./protocol"

/** an endpoint's own lists, its noise preferences; a direction absent has no own rule */
export interface ScopeRules {
  in?: string[]
  out?: string[]
  /** per direction, the identity of the group each `group:<name>` named when it was set */
  groups?: Partial<Record<ScopeDirection, Record<string, string>>>
}

/** the caps stored on an endpoint, and its allowances into caps stored elsewhere (group caps), keyed by {@link groupCapKey} */
export interface ScopeCaps {
  caps: ScopeCap[]
  allow: Record<string, ScopeEntry[]>
  /** the directions whose inherited cap the human lifted */
  lifted?: ScopeDirection[]
}

/** a group an endpoint is in, with the group's rules: a cap on every member */
export interface ScopeGroupRules {
  name: string
  /** an endpoint id, or `policy` for a group from the policy file */
  owner: string
  in?: ScopeEntry[]
  out?: ScopeEntry[]
}

/** a policy `scope` cap matching an endpoint */
export interface ScopePolicyCap {
  dir: ScopeDirection
  match: string
  sels: ScopeEntry[]
}

/** an endpoint as the check sees it: plain data, so a local row and a mirrored proxy row are checked the same way */
export interface ScopeNode {
  id: string
  address: string
  subject: PolicySubject
  /** the account's own human endpoint, always reachable under `human_always`; another machine's human row is not */
  human?: boolean
  rules: ScopeRules
  caps: ScopeCaps
  groups: ScopeGroupRules[]
  policy: ScopePolicyCap[]
}

export interface ScopeWorld {
  /** an endpoint by id; undefined once it is released */
  node(id: string): ScopeNode | undefined
  /** whether endpoint `w` is an admin of `x`'s tree or of a group `x` is in */
  administers(w: string, x: ScopeNode): boolean
  /** how a reason names widener `id`, when not by its address */
  label?(id: string): string | undefined
  /** the endpoint id the reasons are written for: they call it `you` */
  viewer?: string
  /** the group of that name now: its identity, and whether the policy defines it or the human pinned it */
  group(name: string): ScopeGroupIdentity | undefined
}

export interface ScopeGroupIdentity {
  id: string
  policy: boolean
  pinned: boolean
}

/** one selector list that applies to a direction: lists are ANDed, the entries of one list ORed */
export interface ScopeList {
  source: string
  /** who set the list: an endpoint id, `human`, `policy` or `inherited`; an entry with `via` was set by its widener */
  by: string
  entries: ScopeEntry[]
  /** the group whose rules these are: `group:self` stands for it */
  group?: string
  /** the stored cap's id */
  cap?: string
}

export interface Admission {
  ok: boolean
  why: string
  /** the selectors that admitted, each with its widener */
  by?: string[]
}

export interface ScopeDecision {
  allowed: boolean
  /** the direction that refused */
  dir?: ScopeDirection
  reasons: string[]
  /** when both directions' lists decided, the selectors that admitted */
  admitted?: string[]
}

export const PRESET_LISTS: Record<Exclude<ScopePreset, "open">, string[]> = { tree: ["tree:parent", "tree:descendants"], parent: ["tree:parent"], none: [] }

export const groupCapKey = (group: string, dir: ScopeDirection): string => `group:${group}:${dir}`

const LEAVING = /^(\*$|ep:|fleet:|machine:|org:|group:|acct:)/

/** a selector that may admit an endpoint of another fleet */
export function isLeaving(sel: string): boolean {
  return LEAVING.test(sel)
}

/** the selector an entry stands for in a list: `group:self` in a group's rules is that group */
export function effectiveSelector(list: ScopeList, entry: ScopeEntry): string {
  return entry.sel === "group:self" && list.group ? `group:${list.group}` : entry.sel
}

/** every list of a direction: own rules, stored caps, group caps (with this endpoint's allowances into them) and policy caps */
export function scopeLists(node: ScopeNode, dir: ScopeDirection): ScopeList[] {
  const lists: ScopeList[] = []
  const own = node.rules[dir]
  const bound = node.rules.groups?.[dir] ?? {}
  if (own) lists.push({ source: "own rules", by: node.id, entries: own.map((sel) => (bound[sel] ? { sel, group: bound[sel] } : { sel })) })
  for (const cap of node.caps.caps)
    if (cap.dir === dir) lists.push({ source: cap.by === "inherited" ? "inherited cap" : `cap ${cap.id}`, by: cap.by, entries: cap.sels, cap: cap.id })
  for (const group of node.groups) {
    const rules = group[dir]
    if (rules)
      lists.push({
        source: `group:${group.name}`,
        by: group.owner,
        group: group.name,
        entries: [...rules, ...(node.caps.allow[groupCapKey(group.name, dir)] ?? [])],
      })
  }
  for (const cap of node.policy) if (cap.dir === dir) lists.push({ source: `policy (${cap.match})`, by: "policy", entries: cap.sels })
  return lists
}

/** whether anything scopes the endpoint, in either direction; an endpoint with nothing has the default reach ({@link admits}) */
export function hasScope(node: ScopeNode): boolean {
  return scopeLists(node, "in").length > 0 || scopeLists(node, "out").length > 0
}

/** whether `x` is a root of this account: a placed agent with no parent here; another machine's row only when its machine mirrored it so */
export function isRoot(x: ScopeNode): boolean {
  const scope = x.subject.scope
  return x.subject.account === undefined && !!scope && scope.ancestors.length === 0 && scope.root !== false
}

/**
 * what an agent with no list reaches out to: its own tree, every root of its account, the endpoints of contacts (their allowlist is the
 * widening) and every endpoint that is not an agent; a human, the relay or a contact's endpoint with no list reaches everything
 */
function defaultReach(e: ScopeNode, x: ScopeNode): boolean {
  if (e.subject.kind !== "agent" || !e.subject.scope || e.subject.account !== undefined) return true
  return !crossFleet(e, x) || x.subject.account !== undefined || x.subject.kind !== "agent" || !x.subject.scope || isRoot(x)
}

/**
 * whether a list's admitting entry may take an agent past its default reach: a widened entry (its via clip bounds it by the widener's own
 * reach), or a list the human or the policy set; an agent's own rules, an agent's group and an agent's plain cap only narrow within it
 */
function widens(world: ScopeWorld, list: ScopeList, entry: ScopeEntry): boolean {
  if (entry.via !== undefined || list.by === "human" || list.by === "policy") return true
  if (list.group !== undefined && world.group(list.group)?.policy === true) return true
  return world.node(list.by)?.subject.kind === "human"
}

const BEYOND = "has the default reach: its own tree and the roots; only the human, the policy or a widening reaches further"

/** whether `x` sits in another fleet than `e`: another tree, or not local; the human and the system endpoint are in none */
export function crossFleet(e: ScopeNode, x: ScopeNode): boolean {
  if (e.subject.account !== undefined || x.subject.account !== undefined) return true
  const a = e.subject.scope
  const b = x.subject.scope
  if (!b) return false
  return !a?.local || !b.local || a.tree !== b.tree
}

type Memo = Map<string, boolean>

/**
 * whether a widening `via` endpoint `via` may admit `x`: the human's never clip; a released widener's lapse, and the base entry of a
 * released parent's inherited cap keeps only the parent's subtree; otherwise `x` is the widener, in its subtree or in what it administers, or the widener's own effective
 * scope in `dir` admits `x` (recursively clipped). A cycle denies.
 */
export function clipPasses(world: ScopeWorld, via: string, x: ScopeNode, dir: ScopeDirection, memo: Memo = new Map(), base = false): boolean {
  if (via === "human") return true
  const w = world.node(via)
  if (!w) return base && !!x.subject.scope?.ancestors.includes(via)
  if (x.id === w.id || x.subject.scope?.ancestors.includes(w.id) || world.administers(w.id, x)) return true
  const key = `${w.id}|${dir}|${x.id}`
  const seen = memo.get(key)
  if (seen !== undefined) return seen
  memo.set(key, false)
  const ok = admits(world, w, dir, x, memo).ok
  memo.set(key, ok)
  return ok
}

function entryAdmits(world: ScopeWorld, e: ScopeNode, list: ScopeList, entry: ScopeEntry, dir: ScopeDirection, x: ScopeNode, memo: Memo): boolean {
  const sel = effectiveSelector(list, entry)
  if (!matches(sel, x.subject, e.subject)) return false
  if (sel.startsWith("group:") && entry.sel !== "group:self") {
    const group = world.group(sel.slice("group:".length))
    if (entry.group === undefined ? !group?.policy : group?.id !== entry.group) return false
  }
  return entry.via === undefined || clipPasses(world, entry.via, x, dir, memo, entry.base === true)
}

/**
 * whether an admitting entry may take its list out of the fleet: a leaving selector, and for `group:` one the human or the policy set, one
 * naming a policy group, or one bound to a group the human pinned (a group's own `group:self` is bound to it): any endpoint makes runtime
 * groups, so an endpoint's `group:` admits only its own fleet's members
 */
export function leavesFleet(world: ScopeWorld, list: ScopeList, entry: ScopeEntry): boolean {
  const sel = effectiveSelector(list, entry)
  if (!isLeaving(sel)) return false
  if (!sel.startsWith("group:")) return true
  const setter = entry.via ?? list.by
  if (setter === "human" || setter === "policy") return true
  const group = world.group(sel.slice("group:".length))
  return !!group && (group.policy || (group.pinned && (entry.group === group.id || entry.sel === "group:self")))
}

/**
 * whether direction `dir` of `e` admits `x`: every list admits it, and another fleet only through a leaving selector in every list; past an
 * agent's default reach, out only through an entry that {@link widens} in every list
 */
export function admits(world: ScopeWorld, e: ScopeNode, dir: ScopeDirection, x: ScopeNode, memo: Memo = new Map()): Admission {
  const side = `${dir}(${e.address})`
  const lists = scopeLists(e, dir)
  if (!hasScope(e)) {
    if (dir === "in") return { ok: true, why: `${side} is open`, by: [] }
    return defaultReach(e, x) ? { ok: true, why: `${side} has the default reach`, by: [] } : { ok: false, why: `${side} ${BEYOND}` }
  }
  const cross = crossFleet(e, x)
  if (!lists.length) return cross ? { ok: false, why: `${side} admits only its own fleet` } : { ok: true, why: `${side} has no list`, by: [] }
  const bounded = dir === "out" && !defaultReach(e, x)
  const hits: string[] = []
  const by: string[] = []
  for (const list of lists) {
    const admitting = list.entries.filter((entry) => entryAdmits(world, e, list, entry, dir, x, memo))
    if (!admitting.length) return { ok: false, why: limitText(world, e, list, dir, x, false) }
    const leaving = admitting.filter((entry) => leavesFleet(world, list, entry))
    if (cross && !leaving.length) return { ok: false, why: limitText(world, e, list, dir, x, true) }
    const candidates = cross ? leaving : admitting
    const entry = bounded ? candidates.find((candidate) => widens(world, list, candidate)) : candidates[0]!
    if (!entry) return { ok: false, why: `${side} ${BEYOND}` }
    const via = entry.via === undefined ? "" : entry.via === "human" ? "the human" : (world.label?.(entry.via) ?? world.node(entry.via)?.address ?? entry.via)
    const sel = `${effectiveSelector(list, entry)}${via ? ` via ${via}` : ""}`
    by.push(sel)
    hits.push(`by ${sel} (${listName(world, e, list)})`)
  }
  return { ok: true, why: `${side} admits ${x.address} ${hits.join(", ")}`, by }
}

/** an endpoint's address without the local `me/` */
function short(e: ScopeNode): string {
  return e.address.startsWith("me/") ? e.address.slice(3) : e.address
}

/** how a reason names endpoint `id` to the viewer: `you`, the label that hides it, or its address with what it is to `e` */
function nameOf(world: ScopeWorld, id: string, e: ScopeNode): string {
  if (id === "human") return "the human"
  if (id === world.viewer) return "you"
  const label = world.label?.(id)
  if (label) return label
  const node = world.node(id)
  if (!node) return "a released endpoint"
  const ancestors = e.subject.scope?.ancestors ?? []
  const relation = ancestors[0] === id ? "parent" : ancestors.includes(id) ? "ancestor" : undefined
  return relation ? `${node.address} (${world.viewer === e.id ? "your" : `${short(e)}'s`} ${relation})` : node.address
}

/** who set a list, in words */
function listName(world: ScopeWorld, e: ScopeNode, list: ScopeList): string {
  if (list.source === "own rules") return world.viewer === e.id ? "your own rules" : `${short(e)}'s own rules`
  if (list.source.startsWith("policy")) return `the ${list.source}`
  if (list.group) return `group ${list.group}'s rules`
  if (list.by === "inherited") return "an inherited limit"
  return `a limit set by ${nameOf(world, list.by, e)}`
}

/** a selector that names `x` alone, for the widening hint */
function selectorFor(x: ScopeNode): string {
  const scope = x.subject.scope
  if (scope && !scope.local && scope.machine) return `machine:${scope.machine}`
  if (x.subject.kind === "agent" && validHandle(x.subject.handle)) return `ep:${x.subject.handle}`
  return `kind:${x.subject.kind}`
}

/**
 * a refusal in words: who set the list that refuses `x` in `dir` of `e`, what it limits to, and the command that widens it; `cross`: it admits
 * `x` only within its own fleet
 */
function limitText(world: ScopeWorld, e: ScopeNode, list: ScopeList, dir: ScopeDirection, x: ScopeNode, cross: boolean): string {
  const you = world.viewer === e.id
  const whose = dir === "out" ? `${you ? "your" : `${short(e)}'s`} messages` : `who may message ${you ? "you" : short(e)}`
  const sels = [...new Set(list.entries.map((entry) => effectiveSelector(list, entry)))]
  const to = `${sels.join(",") || "nobody"}${cross ? " only within its own fleet" : ""}`
  const add = selectorFor(x)
  const widen = `widen with ${CLI_NAME} rules widen ${short(e)} --${dir} ${add}`
  if (list.source === "own rules") {
    const set = `${CLI_NAME} rules set --${dir} ${[...sels, add].join(",")}`
    return you
      ? `your own rules limit ${whose} to ${to}; widen them with ${set}`
      : `${short(e)}'s own rules limit ${whose} to ${to}; ${short(e)} widens them with ${set}`
  }
  if (list.source.startsWith("policy"))
    return `the ${list.source.replace(/^policy \((.*)\)$/, "policy rule for $1")} limits ${whose} to ${to}; change it in the policy file (${CLI_NAME} policy path)`
  if (list.group)
    return `group ${list.group}'s rules (set by ${list.by === "policy" ? "the policy file" : nameOf(world, list.by, e)}) limit ${whose} to ${to}; ${widen}`
  if (list.by === "inherited") {
    const parent = e.subject.scope?.ancestors[0]
    const reach = parent ? `what ${nameOf(world, parent, e)} reaches` : "what its parent reached"
    return `${dir === "out" ? `${whose} reach only ${reach}` : `only ${reach} may message ${you ? "you" : short(e)}`}, an inherited limit; ${widen}`
  }
  const setter = nameOf(world, list.by, e)
  return `${setter} ${setter === "you" ? "limit" : "limits"} ${whose} to ${to}; ${widen}`
}

/** what `peer` is to `me`, in words */
export function relationText(peer: PolicySubject, me: PolicySubject): string {
  const rel = relation(peer, me)
  if (rel === undefined) return "on the relay"
  if (rel === "human") return "the human"
  if (rel === "tree") return "in your tree"
  if (rel.startsWith("group:")) return `in group ${rel.slice("group:".length)} with you`
  if (rel.startsWith("fleet:")) return `in fleet ${rel.slice("fleet:".length)}`
  return `your ${rel}`
}

/**
 * The scope check for a message from `a` to `b`: `out(a)` admits `b` and `in(b)` admits `a`. Either side the account's human (with `humanAlways`)
 * or the system endpoint passes, except an `unverified` human sender (one without a terminal), which is checked like any unplaced sender; an
 * ancestor of `b` (unless `strict`), a solicited reply and a parent and child `linked` across machines pass both.
 */
export function scopeDecision(
  world: ScopeWorld,
  a: ScopeNode,
  b: ScopeNode,
  options: { humanAlways: boolean; solicited?: boolean; linked?: boolean; unverified?: boolean; strict?: boolean },
): ScopeDecision {
  const kinds = [a.subject.kind, b.subject.kind]
  if (kinds.includes("system")) return { allowed: true, reasons: ["the relay itself"] }
  if (options.humanAlways && (b.human || (a.human && !options.unverified))) return { allowed: true, reasons: ["the human is always reachable"] }
  if (!options.strict && isAncestor(a, b)) return { allowed: true, reasons: [`${a.address} is an ancestor of ${b.address}: scopes never stop it`] }
  if (options.solicited) return { allowed: true, reasons: [`a reply to ${b.address}'s message in its thread`] }
  if (options.linked) return { allowed: true, reasons: [`${a.address} and ${b.address} are parent and child across machines`] }
  const memo: Memo = new Map()
  const out = admits(world, a, "out", b, memo)
  if (!out.ok) return { allowed: false, dir: "out", reasons: [out.why] }
  const into = admits(world, b, "in", a, memo)
  if (!into.ok) return { allowed: false, dir: "in", reasons: [out.why, into.why] }
  return { allowed: true, reasons: [out.why, into.why], admitted: [...(out.by ?? []), ...(into.by ?? [])] }
}

/**
 * The static clip of a selector widener `via` adds to `anchor` in `dir`: clipped when it matches at least one of `candidates` and none of them
 * passes the clip. A selector matching nothing yet is kept.
 */
export function clipped(world: ScopeWorld, via: string, sel: string, anchor: ScopeNode, dir: ScopeDirection, candidates: ScopeNode[]): boolean {
  const matching = candidates.filter((x) => x.id !== anchor.id && matches(sel, x.subject, anchor.subject))
  return matching.length > 0 && !matching.some((x) => clipPasses(world, via, x, dir))
}

/**
 * A preset and allowances, or explicit lists, as own rules per direction: a list sets it, null clears it, absent leaves it. A preset (and
 * `allow`, which appends to it; alone it appends to `none`) sets both directions under symmetric presets, else `out`; `in` and `out` win for theirs.
 */
export function expandRules(
  params: { scope?: ScopePreset; allow?: string[]; in?: string[]; out?: string[] },
  symmetric: boolean,
): Partial<Record<ScopeDirection, string[] | null>> {
  const result: Partial<Record<ScopeDirection, string[] | null>> = {}
  if (params.scope !== undefined || params.allow !== undefined) {
    if (params.scope === "open" && params.allow?.length) throw new RelayError("invalid_params", "allow adds to a preset with a list: tree, parent or none")
    const list = params.scope === "open" ? null : unique([...(params.scope ? PRESET_LISTS[params.scope] : []), ...(params.allow ?? [])])
    for (const dir of symmetric ? (["in", "out"] as const) : (["out"] as const)) result[dir] = list
  }
  if (params.in !== undefined) result.in = unique(params.in)
  if (params.out !== undefined) result.out = unique(params.out)
  return result
}

/**
 * the preset an endpoint's lists amount to: open with none, a preset when each direction is exactly that list, else custom. An inherited limit
 * beside other lists is left out: every preset stays within the parent's reach
 */
export function presetOf(node: ScopeNode, symmetric: boolean): ScopePreset | "custom" {
  const set = (dir: ScopeDirection) => {
    const lists = scopeLists(node, dir)
    const own = lists.filter((list) => list.by !== "inherited")
    return own.length ? own : lists
  }
  const ins = set("in")
  const outs = set("out")
  if (!ins.length && !outs.length) return "open"
  for (const [preset, list] of Object.entries(PRESET_LISTS) as [ScopePreset, string[]][]) {
    const is = (lists: ScopeList[]) =>
      lists.length === 1 &&
      sameSet(
        lists[0]!.entries.map((entry) => effectiveSelector(lists[0]!, entry)),
        list,
      )
    if (symmetric ? is(ins) && is(outs) : is(outs) && !ins.length) return preset
  }
  return "custom"
}

/** whether `next` is no wider than `prev`: a subset (a relative `tree:` selector is within `tree:self`), or a list where none was; clearing a list widens */
export function narrower(next: string[] | null | undefined, prev: string[] | undefined): boolean {
  if (prev === undefined) return true
  if (!next) return false
  return next.every((sel) => prev.includes(sel) || (sel.startsWith("tree:") && prev.includes("tree:self")))
}

/** whether `a` is a local ancestor of `b` */
export function isAncestor(a: ScopeNode, b: ScopeNode): boolean {
  const x = b.subject.scope
  return a.subject.kind === "agent" && !!x?.local && !!a.subject.scope?.local && x.tree === a.subject.scope.tree && x.ancestors.includes(a.id)
}

/** how the recipient sees the sender: parent, child, ancestor, descendant, sibling, group:<name>, tree, fleet:<root handle> or human */
export function relation(sender: PolicySubject, recipient: PolicySubject): string | undefined {
  if (sender.kind === "human") return "human"
  const s = sender.scope
  const r = recipient.scope
  if (!s || !r) return undefined
  if (!s.local || !r.local || s.tree !== r.tree) return `fleet:${s.rootHandle}`
  if (r.ancestors[0] === s.id) return "parent"
  if (s.ancestors[0] === r.id) return "child"
  if (r.ancestors.includes(s.id)) return "ancestor"
  if (s.ancestors.includes(r.id)) return "descendant"
  if (s.ancestors[0] !== undefined && s.ancestors[0] === r.ancestors[0]) return "sibling"
  const shared = s.groups.find((group) => r.groups.includes(group))
  if (shared) return `group:${shared}`
  return "tree"
}

function unique(list: string[]): string[] {
  return [...new Set(list)]
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((sel) => b.includes(sel))
}
