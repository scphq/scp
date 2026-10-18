/**
 * whether a judge's model is down for everyone rather than failing on one message: outage-class failures (unreachable, an outage
 * status, a timeout) on `threshold` distinct messages within `windowMs` open it for `openMs`; then one message probes the model, and
 * its success closes the breaker while its failure keeps it open for another `openMs`. A scope is one provider and key. In memory only.
 */
export interface JudgeBreakerOptions {
  threshold?: number
  windowMs?: number
  openMs?: number
  /** scopes kept at most; the oldest is dropped past it */
  maxScopes?: number
  onChange?: (scope: string, state: "open" | "closed") => void
}

export const JUDGE_BREAKER_DEFAULTS = { threshold: 3, windowMs: 60_000, openMs: 30_000, maxScopes: 256 } as const

/** `call` the model as usual, `probe` it as the one message testing an open breaker, or skip it while `open` */
export type BreakerAdmission = "call" | "probe" | "open"

interface ScopeState {
  /** message hash to the time its call last failed as an outage, while closed */
  failures: Map<string, number>
  until: number | null
  probing: boolean
}

export class JudgeBreaker {
  private readonly scopes = new Map<string, ScopeState>()
  private readonly o: Required<Omit<JudgeBreakerOptions, "onChange">> & Pick<JudgeBreakerOptions, "onChange">

  constructor(options: JudgeBreakerOptions = {}) {
    this.o = { ...JUDGE_BREAKER_DEFAULTS, ...options }
  }

  admit(scope: string, now: number): BreakerAdmission {
    const s = this.scopes.get(scope)
    if (!s || s.until === null) return "call"
    if (now < s.until || s.probing) return "open"
    s.probing = true
    return "probe"
  }

  /** the model answered */
  success(scope: string, admission: BreakerAdmission): void {
    if (admission !== "probe") return
    this.scopes.delete(scope)
    this.o.onChange?.(scope, "closed")
  }

  /** the call for the message hashed `hash` failed as an outage */
  failure(scope: string, admission: BreakerAdmission, hash: string, now: number): void {
    const s = this.scopes.get(scope) ?? this.track(scope)
    if (admission === "probe") {
      s.probing = false
      s.until = now + this.o.openMs
      return
    }
    if (s.until !== null) return
    for (const [key, at] of s.failures) if (at <= now - this.o.windowMs) s.failures.delete(key)
    s.failures.delete(hash)
    s.failures.set(hash, now)
    while (s.failures.size > this.o.threshold) s.failures.delete(s.failures.keys().next().value!)
    if (s.failures.size < this.o.threshold) return
    s.failures.clear()
    s.until = now + this.o.openMs
    this.o.onChange?.(scope, "open")
  }

  /** the call ended some other way: a probe's turn passes to the next message */
  release(scope: string, admission: BreakerAdmission): void {
    const s = this.scopes.get(scope)
    if (s && admission === "probe") s.probing = false
  }

  state(scope: string, now: number): "closed" | "open" | "half_open" {
    const s = this.scopes.get(scope)
    if (!s || s.until === null) return "closed"
    return now < s.until ? "open" : "half_open"
  }

  private track(scope: string): ScopeState {
    const s: ScopeState = { failures: new Map(), until: null, probing: false }
    this.scopes.set(scope, s)
    while (this.scopes.size > this.o.maxScopes) this.scopes.delete(this.scopes.keys().next().value!)
    return s
  }
}
