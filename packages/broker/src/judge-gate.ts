import { accessSync, constants, readFileSync } from "node:fs"
import {
  applyRedactions,
  DEFAULT_JUDGE_BUDGET,
  findSecret,
  HttpJudgeClient,
  JUDGE_PROMPT_VERSION,
  type JudgeAuditDetail,
  judgeBoundary,
  type JudgeClient,
  type JudgeModelConfig,
  type JudgePolicy,
  LIMITS,
  mergeVerdicts,
  newId,
  newJudgeStats,
  one,
  RelayError,
  runJudge,
  type SendParams,
  type SendResult,
  sha256Hex,
  type Sql,
  type Verdict,
  VerdictCache,
} from "@scp-dev/core"
import type { FederatedCore } from "@scp-dev/hub"

export type JudgeClientFactory = (model: JudgeModelConfig, key: () => Promise<string>) => JudgeClient
type Origin = { tty?: boolean; unverified?: boolean }
/** sends as `from` through the same path an unjudged send takes, waking recipients */
export type Deliver = (from: string, params: SendParams, origin: Origin) => Promise<SendResult>

export interface JudgeGateOptions {
  sql: Sql
  core: FederatedCore
  now: () => number
  /** where key_env is read */
  env: Record<string, string | undefined>
  client?: JudgeClientFactory | undefined
  log: (line: string) => void
  /** an endpoint got a notice */
  wake: (endpoint: string) => void
}

interface HoldRow {
  id: string
  from_ep: string
  params: string
  origin: string
  verdict: string
  created_at: number
  expires_at: number
  state: "held" | "releasing" | "released" | "refused" | "expired"
  by: string | null
  resolved_at: number | null
}

type StoredVerdict = Verdict & { boundary: string; to: string[] }

/** a hold as the human's review lists it: never the body */
export interface HoldView {
  id: string
  from: string
  to: string[]
  state: HoldRow["state"]
  created_at: string
  expires_at: string
  categories: string[]
  reason: string
  boundary: string
  source: Verdict["source"]
  bytes: number
  by: string | null
  resolved_at: string | null
}

/** held sends never reach the send's rate limits, so a sender's waiting holds are capped */
const HELD_PER_SENDER = 100

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

/**
 * the broker's local judge (policy `judge`): shadow judges after delivery and only audits; enforce judges before delivery and passes,
 * redacts, refuses or holds. Holds wait in `judge_holds` for the human at a terminal; their body is purged once resolved or expired
 */
export class JudgeGate {
  readonly stats = newJudgeStats()
  private policy: JudgePolicy | undefined
  private version = ""
  private client: JudgeClient | null = null
  private readonly cache = new VerdictCache()
  private readonly shadows = new Set<Promise<void>>()
  /** judged sends in the last hour per budget: `ep:<id>`, `tree:<root id>` and `*` for the whole broker */
  private readonly spent = new Map<string, number[]>()

  constructor(private readonly o: JudgeGateOptions) {
    o.sql.all(
      `CREATE TABLE IF NOT EXISTS judge_holds (id TEXT PRIMARY KEY, from_ep TEXT NOT NULL, params TEXT NOT NULL, origin TEXT NOT NULL, verdict TEXT NOT NULL,
       created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, by TEXT, resolved_at INTEGER)`,
    )
    o.sql.all(
      `CREATE TABLE IF NOT EXISTS judge_sent (from_ep TEXT NOT NULL, client_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL,
       PRIMARY KEY (from_ep, client_id))`,
    )
    o.sql.all(`UPDATE judge_holds SET state = 'held' WHERE state = 'releasing'`)
  }

  /** the policy's judge section; a model client only when its key is readable, else the prefilter alone */
  configure(policy: JudgePolicy | undefined): void {
    this.policy = policy
    this.version = policy ? sha256Hex(JSON.stringify(policy)) : ""
    this.client = null
    const model = policy?.model
    if (!policy || policy.mode === "off" || !model) return
    const key = this.keyReader(model)
    if (!key) {
      this.o.log(
        `relay broker: the judge model's key (${model.key_env ? `key_env ${model.key_env}` : `key_file ${model.key_file}`}) is not readable; judging with the prefilter only`,
      )
      return
    }
    this.client = (this.o.client ?? ((m, k) => new HttpJudgeClient({ model: m.id, effort: m.effort, key: k })))(model, key)
  }

  private keyReader(model: JudgeModelConfig): (() => Promise<string>) | null {
    if (model.key_env) {
      const name = model.key_env
      return this.o.env[name] ? async () => this.o.env[name] ?? "" : null
    }
    const file = model.key_file!
    try {
      accessSync(file, constants.R_OK)
    } catch {
      return null
    }
    return async () => readFileSync(file, "utf8").trim()
  }

  /** resolves once every shadow judgement started so far finished */
  async settled(): Promise<void> {
    await Promise.all([...this.shadows])
  }

  /** a send or ask through the judge; an unjudged one goes straight to `deliver` */
  async send(from: string, params: SendParams, origin: Origin, deliver: Deliver): Promise<SendResult> {
    const policy = this.policy
    const body = params.body
    if (!policy || policy.mode === "off" || typeof body !== "string" || new TextEncoder().encode(body).length > LIMITS.bodyBytes || findSecret(body))
      return deliver(from, params, origin)
    const targets = Array.isArray(params.to) ? params.to : [params.to]
    if (targets.some((to) => this.o.core.foreignAccount(to) !== null)) {
      if (policy.mode === "enforce") {
        this.o.core.auditJudge("judge_skipped", from, null, {
          side: "local",
          boundary: "other account",
          prompt_version: JUDGE_PROMPT_VERSION,
          categories: [],
          sha256: sha256Hex(body),
          verdict: "skipped",
          reason: "other_account_judged_by_hub",
          to: targets.map(String),
        })
      }
      return deliver(from, params, origin)
    }
    if (policy.mode === "shadow") {
      const result = await deliver(from, params, origin)
      if (!result.duplicate) this.shadow(policy, from, params, origin, result.id)
      return result
    }
    const { groups, tree } = this.boundaries(policy, from, params, origin)
    if (!groups.size) return deliver(from, params, origin)
    const ttl = params.ttl_s ?? LIMITS.ttlDefaultS
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > LIMITS.ttlMaxS) throw new RelayError("invalid_params", `ttl_s must be 1 to ${LIMITS.ttlMaxS}`)
    const seen = params.client_id === undefined ? undefined : this.seen(from, params)
    if (seen) return seen
    const waiting = one<{ n: number }>(this.o.sql, `SELECT COUNT(*) AS n FROM judge_holds WHERE from_ep = ? AND state IN ('held', 'releasing')`, from)!.n
    if (waiting >= HELD_PER_SENDER)
      throw new RelayError("rate_limited", `${waiting} of your messages wait for review by your human; send more once they released or refused some`, 3600)
    this.spend(policy, from, tree)
    const verdict = await this.judge(policy, from, body, groups)
    const detail = this.detail(verdict, body, groups)
    switch (verdict.verdict) {
      case "refuse":
        this.o.core.auditJudge("judge_refuse", from, null, detail)
        throw new RelayError(
          "judge_refused",
          `the relay judge refused this message (local; ${verdict.categories.join(", ") || "no category"}): ${verdict.reason}`,
          undefined,
          {
            side: "local",
            categories: verdict.categories,
            reason: verdict.reason,
          },
        )
      case "hold":
        return this.hold(from, params, origin, verdict, groups, detail)
      case "redact": {
        const applied = applyRedactions(body, verdict.redactions)
        const result = await deliver(from, { ...params, body: applied.text }, origin)
        const redacted = { n: applied.n, kinds: applied.kinds }
        this.o.core.auditJudge(verdict.source === "error" ? "judge_skipped" : "judge_redact", from, result.id, { ...detail, redacted })
        return this.remember(from, params, { ...result, redacted })
      }
      case "pass": {
        const result = await deliver(from, params, origin)
        if (verdict.source === "error") this.o.core.auditJudge("judge_skipped", from, result.id, detail)
        return this.remember(from, params, result)
      }
    }
  }

  /** an earlier judged send or waiting hold under the send's client_id: the same message is answered as before, another one refused as core refuses it */
  private seen(from: string, params: SendParams): SendResult | undefined {
    const clientId = params.client_id!
    const held = one<{ id: string; params: string }>(
      this.o.sql,
      `SELECT id, params FROM judge_holds WHERE from_ep = ? AND json_extract(params, '$.client_id') = ? AND state IN ('held', 'releasing')`,
      from,
      clientId,
    )
    const sent = held
      ? undefined
      : one<{ fingerprint: string; result: string }>(
          this.o.sql,
          `SELECT fingerprint, result FROM judge_sent WHERE from_ep = ? AND client_id = ? AND created_at > ?`,
          from,
          clientId,
          this.o.now() - LIMITS.idempotencyS * 1000,
        )
    const before = held ? fingerprint(JSON.parse(held.params) as SendParams) : sent?.fingerprint
    if (before === undefined) return undefined
    if (before !== fingerprint(params)) throw new RelayError("invalid_params", `client_id ${clientId} was already used for a different message`)
    return held ? heldResult(held.id, params) : { ...(JSON.parse(sent!.result) as SendResult), duplicate: true }
  }

  private remember(from: string, params: SendParams, result: SendResult): SendResult {
    if (params.client_id !== undefined && !result.duplicate) {
      this.o.sql.all(
        `INSERT OR REPLACE INTO judge_sent (from_ep, client_id, fingerprint, result, created_at) VALUES (?, ?, ?, ?, ?)`,
        from,
        params.client_id,
        fingerprint(params),
        JSON.stringify(result),
        this.o.now(),
      )
    }
    return result
  }

  /**
   * a judged send counts before any model call against its sender's, its lineage tree's and the whole broker's budget, since refused and
   * held sends never reach the send's own limits, and a new handle or a helper process must not bring a fresh budget
   */
  private spend(policy: JudgePolicy, from: string, tree: string): void {
    const now = this.o.now()
    const global = policy.budget ?? DEFAULT_JUDGE_BUDGET
    const budgets: [key: string, perMinute: number, perHour: number, what: string][] = [
      [`ep:${from}`, LIMITS.pairPerMinute, LIMITS.pairPerHour, "from this endpoint"],
      [`tree:${tree}`, LIMITS.pairPerMinute * 2, LIMITS.pairPerHour * 2, "from this lineage tree"],
      ["*", global.per_minute, global.per_hour, "on this broker"],
    ]
    const recent = budgets.map(([key]) => (this.spent.get(key) ?? []).filter((at) => at > now - 3_600_000))
    budgets.forEach(([key, perMinute, perHour, what], i) => {
      for (const [limit, windowS] of [
        [perMinute, 60],
        [perHour, 3600],
      ] as const) {
        const inWindow = recent[i]!.filter((at) => at > now - windowS * 1000)
        if (inWindow.length >= limit) {
          this.spent.set(key, recent[i]!)
          throw new RelayError(
            "rate_limited",
            `${limit} judged messages ${what} in ${windowS} s`,
            Math.max(1, Math.ceil((inWindow[0]! + windowS * 1000 - now) / 1000)),
          )
        }
      }
    })
    for (const [i, [key]] of budgets.entries()) this.spent.set(key, [...recent[i]!, now])
  }

  /** how many budgets are tracked (idle ones are evicted by the sweep) */
  budgetKeys(): number {
    return this.spent.size
  }

  /** the held messages, newest first, without bodies */
  holds(state?: string): HoldView[] {
    const rows = state
      ? this.o.sql.all<HoldRow>(`SELECT * FROM judge_holds WHERE state = ? ORDER BY created_at DESC, rowid DESC LIMIT 200`, state)
      : this.o.sql.all<HoldRow>(`SELECT * FROM judge_holds ORDER BY created_at DESC, rowid DESC LIMIT 200`)
    return rows.map((row) => this.view(row))
  }

  /** one hold with its body and the judge's redactions while it waits */
  show(id: string): HoldView & { body?: string; redactions?: { quote?: string; kind: string }[] } {
    const row = this.row(id)
    const params = JSON.parse(row.params) as Partial<SendParams>
    const verdict = JSON.parse(row.verdict) as StoredVerdict
    return { ...this.view(row), ...(typeof params.body === "string" ? { body: params.body } : {}), redactions: verdict.redactions }
  }

  /** delivers a held message as its sender, as stored or redacted: scope, policy and limits are checked again by the send itself */
  async release(id: string, options: { redacted?: boolean; by: string }, deliver: Deliver): Promise<SendResult> {
    const row = one<HoldRow>(
      this.o.sql,
      `UPDATE judge_holds SET state = 'releasing' WHERE id = ? AND state = 'held' AND expires_at > ? RETURNING *`,
      id,
      this.o.now(),
    )
    if (!row) throw new RelayError("not_found", `no held message ${id}`)
    const params = JSON.parse(row.params) as SendParams
    const verdict = JSON.parse(row.verdict) as StoredVerdict
    let sent = params
    let redacted: { n: number; kinds: string[] } | undefined
    if (options.redacted) {
      const applied = applyRedactions(params.body, verdict.redactions)
      if (!applied.n) {
        this.o.sql.all(`UPDATE judge_holds SET state = 'held' WHERE id = ?`, id)
        throw new RelayError("invalid_params", `hold ${id} has no redactions: release it as it is or refuse it`)
      }
      sent = { ...params, body: applied.text }
      redacted = { n: applied.n, kinds: applied.kinds }
    }
    let result: SendResult
    try {
      result = await deliver(row.from_ep, sent, JSON.parse(row.origin) as Origin)
    } catch (error) {
      this.o.sql.all(`UPDATE judge_holds SET state = 'held' WHERE id = ?`, id)
      throw error
    }
    this.remember(row.from_ep, params, { ...result, ...(redacted ? { redacted } : {}) })
    this.resolve(row, "released", options.by)
    this.o.core.auditJudge("judge_override", row.from_ep, id, {
      ...this.storedDetail(row, verdict),
      by: options.by,
      action: redacted ? "release_redacted" : "release",
      ...(redacted ? { redacted } : {}),
    })
    this.tell(
      row.from_ep,
      `relay: your message held for review as ${id} was released by your human${redacted ? " with redactions" : ""} and delivered as ${result.id}`,
    )
    return { ...result, ...(redacted ? { redacted } : {}) }
  }

  /** refuses a held message: it is never delivered, and its sender hears the human's reason */
  refuse(id: string, reason: string, by: string): HoldView {
    this.expire(this.o.now())
    const row = one<HoldRow>(this.o.sql, `SELECT * FROM judge_holds WHERE id = ? AND state = 'held'`, id)
    if (!row) throw new RelayError("not_found", `no held message ${id}`)
    const verdict = JSON.parse(row.verdict) as StoredVerdict
    this.resolve(row, "refused", by)
    this.o.core.auditJudge("judge_override", row.from_ep, id, { ...this.storedDetail(row, verdict), by, action: "refuse", reason })
    this.tell(row.from_ep, `relay: your message held for review as ${id} was refused by your human: ${reason}`)
    return this.view(this.row(id))
  }

  /** expires holds past their message TTL (body purged, sender told) and drops resolved ones past the audit window */
  sweep(): void {
    const now = this.o.now()
    this.expire(now)
    this.o.sql.all(`DELETE FROM judge_holds WHERE state IN ('released', 'refused', 'expired') AND resolved_at <= ?`, now - LIMITS.auditKeepS * 1000)
    this.o.sql.all(`DELETE FROM judge_sent WHERE created_at <= ?`, now - LIMITS.idempotencyS * 1000)
    for (const [key, times] of this.spent) if (!times.length || times[times.length - 1]! <= now - 3_600_000) this.spent.delete(key)
  }

  private expire(now: number): void {
    for (const row of this.o.sql.all<HoldRow>(`SELECT * FROM judge_holds WHERE state = 'held' AND expires_at <= ?`, now)) {
      const verdict = JSON.parse(row.verdict) as StoredVerdict
      this.resolve(row, "expired", null)
      this.o.core.auditJudge("judge_expire", row.from_ep, row.id, this.storedDetail(row, verdict))
      this.tell(row.from_ep, `relay: your message held for review as ${row.id} expired without review and was not delivered`)
    }
  }

  /** the recipients by the boundary their message crosses; throws as send does for a target the sender cannot reach */
  private boundaries(policy: JudgePolicy, from: string, params: SendParams, origin: Origin): { groups: Map<string, string[]>; tree: string } {
    const { sender, recipients, tree } = this.o.core.judgeSubjects(from, params, origin)
    const groups = new Map<string, string[]>()
    for (const recipient of recipients) {
      const label = judgeBoundary(policy, sender, recipient)
      if (label !== null) groups.set(label, [...(groups.get(label) ?? []), recipient.address])
    }
    return { groups, tree }
  }

  private async judge(policy: JudgePolicy, from: string, body: string, groups: Map<string, string[]>): Promise<Verdict> {
    const verdicts = await Promise.all(
      [...groups].map(([boundary, to]) =>
        runJudge({
          body,
          side: "local",
          boundary,
          configVersion: this.version,
          client: this.client,
          cache: this.cache,
          timeoutMs: policy.timeout_s * 1000,
          failMode: policy.fail,
          ...(this.client && policy.model ? { model: policy.model.id } : {}),
          from: this.o.core.addressOf(from),
          to,
          now: this.o.now,
          stats: this.stats,
        }),
      ),
    )
    return mergeVerdicts(verdicts)
  }

  private shadow(policy: JudgePolicy, from: string, params: SendParams, origin: Origin, ref: string): void {
    const task = (async () => {
      try {
        const { groups, tree } = this.boundaries(policy, from, params, origin)
        if (!groups.size) return
        this.spend(policy, from, tree)
        const body = params.body
        const verdict = await this.judge(policy, from, body, groups)
        this.o.core.auditJudge("judge_shadow", from, ref, this.detail(verdict, body, groups))
      } catch (error) {
        this.o.log(`relay broker: a shadow judgement failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    this.shadows.add(task)
    void task.finally(() => this.shadows.delete(task))
  }

  private hold(from: string, params: SendParams, origin: Origin, verdict: Verdict, groups: Map<string, string[]>, detail: JudgeAuditDetail): SendResult {
    const now = this.o.now()
    const id = newId("hold", now)
    const stored: SendParams = { ...params, client_id: params.client_id ?? id }
    const to = [...groups.values()].flat()
    const record: StoredVerdict = { ...verdict, boundary: [...groups.keys()].join(" | "), to }
    this.o.sql.all(
      `INSERT INTO judge_holds (id, from_ep, params, origin, verdict, created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'held')`,
      id,
      from,
      JSON.stringify(stored),
      JSON.stringify(origin),
      JSON.stringify(record),
      now,
      now + (params.ttl_s ?? LIMITS.ttlDefaultS) * 1000,
    )
    this.o.core.auditJudge("judge_hold", from, id, detail)
    return heldResult(id, params)
  }

  private detail(verdict: Verdict, body: string, groups: Map<string, string[]>): JudgeAuditDetail {
    return {
      side: "local",
      boundary: [...groups.keys()].join(" | "),
      prompt_version: verdict.prompt_version,
      categories: verdict.categories,
      sha256: sha256Hex(body),
      verdict: verdict.verdict,
      source: verdict.source,
      reason: verdict.reason,
      to: [...groups.values()].flat(),
      ...(verdict.model ? { model: verdict.model } : {}),
      ...(verdict.ms !== undefined ? { ms: verdict.ms } : {}),
    }
  }

  private storedDetail(row: HoldRow, verdict: StoredVerdict): JudgeAuditDetail {
    const params = JSON.parse(row.params) as { body?: string; sha256?: string }
    return {
      side: "local",
      boundary: verdict.boundary,
      prompt_version: verdict.prompt_version,
      categories: verdict.categories,
      sha256: params.sha256 ?? sha256Hex(params.body ?? ""),
      verdict: verdict.verdict,
      to: verdict.to,
      ...(verdict.model ? { model: verdict.model } : {}),
    }
  }

  /** marks a hold resolved and purges its body and the judge's quotes of it */
  private resolve(row: HoldRow, state: "released" | "refused" | "expired", by: string | null): void {
    const { body, ...params } = JSON.parse(row.params) as SendParams
    const verdict = JSON.parse(row.verdict) as StoredVerdict
    const purged = { ...params, bytes: new TextEncoder().encode(body).length, sha256: sha256Hex(body) }
    const kinds = { ...verdict, redactions: verdict.redactions.map((r) => ({ kind: r.kind })) }
    this.o.sql.all(
      `UPDATE judge_holds SET state = ?, by = ?, resolved_at = ?, params = ?, verdict = ? WHERE id = ?`,
      state,
      by,
      this.o.now(),
      JSON.stringify(purged),
      JSON.stringify(kinds),
      row.id,
    )
  }

  private tell(endpoint: string, text: string): void {
    try {
      this.o.core.judgeNotice(endpoint, text)
      this.o.wake(endpoint)
    } catch (error) {
      if (!(error instanceof RelayError)) throw error
    }
  }

  private row(id: string): HoldRow {
    const row = one<HoldRow>(this.o.sql, `SELECT * FROM judge_holds WHERE id = ?`, id)
    if (!row) throw new RelayError("not_found", `no held message ${id}`)
    return row
  }

  private view(row: HoldRow): HoldView {
    const params = JSON.parse(row.params) as Partial<SendParams> & { bytes?: number }
    const verdict = JSON.parse(row.verdict) as StoredVerdict
    return {
      id: row.id,
      from: this.o.core.addressOf(row.from_ep),
      to: verdict.to,
      state: row.state,
      created_at: iso(row.created_at)!,
      expires_at: iso(row.expires_at)!,
      categories: verdict.categories,
      reason: verdict.reason,
      boundary: verdict.boundary,
      source: verdict.source,
      bytes: params.bytes ?? new TextEncoder().encode(params.body ?? "").length,
      by: row.by,
      resolved_at: iso(row.resolved_at),
    }
  }
}

/** what makes two sends under one client_id the same message, close to what core's idempotency compares */
const fingerprint = (p: SendParams): string =>
  sha256Hex(
    JSON.stringify([
      [p.to].flat().map(String).sort(),
      p.body,
      p.kind ?? "message",
      p.thread ?? null,
      p.reply_to ?? null,
      p.data_class ?? "public",
      (p.attachments ?? []).map((a) => a?.path).sort(),
      p.mime ?? null,
      p.ttl_s ?? LIMITS.ttlDefaultS,
      p.require_reply ?? null,
    ]),
  )

function heldResult(id: string, params: SendParams): SendResult {
  return { id, thread: params.thread ?? "", hop: 0, deliveries: [], held: { hold_id: id, side: "local" } }
}
