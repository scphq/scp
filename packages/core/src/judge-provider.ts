import type { JudgeClient } from "./judge"

export type JudgeEffort = "low" | "medium" | "high" | "xhigh"
export const JUDGE_EFFORTS: readonly JudgeEffort[] = ["low", "medium", "high", "xhigh"]
export const DEFAULT_JUDGE_EFFORT: JudgeEffort = "medium"

/**
 * a provider's chat endpoint: OpenAI's chat shape with `reasoning_effort`, or Anthropic's messages API with `output_config.effort`;
 * `cap` names the OpenAI-shaped field that bounds the answer (OpenAI's reasoning models take only `max_completion_tokens`)
 */
export interface JudgeProvider {
  url: string
  shape: "openai" | "anthropic"
  cap?: "max_tokens" | "max_completion_tokens"
}

/** the public endpoints a judge model id may name without further config; a deployment passes its own table to add or replace them */
export const JUDGE_PROVIDERS: Readonly<Record<string, JudgeProvider>> = {
  openai: { url: "https://api.openai.com/v1/chat/completions", shape: "openai", cap: "max_completion_tokens" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", shape: "openai", cap: "max_tokens" },
  anthropic: { url: "https://api.anthropic.com/v1/messages", shape: "anthropic" },
}

/** the most output tokens, reasoning included, a judge answer may take on any provider */
export const JUDGE_MAX_OUTPUT_TOKENS = 4096

const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,128}$/
const MAX_RESPONSE_CHARS = 256 * 1024

export interface HttpJudgeOptions {
  fetch?: typeof fetch
  /** `provider/name`, the name as the provider's API takes it; there is no default model */
  model: string
  /** the providers `model` may name, {@link JUDGE_PROVIDERS} when absent */
  providers?: Readonly<Record<string, JudgeProvider>>
  effort?: JudgeEffort
  /** the API key, or a function read at each call (a key file) */
  key: string | (() => string | Promise<string>)
  timeoutMs?: number
}

/** the provider and model name of `provider/name`, or a thrown error for a provider not in `providers` */
export function judgeModel(
  id: string,
  providers: Readonly<Record<string, JudgeProvider>> = JUDGE_PROVIDERS,
): { provider: string; name: string; endpoint: JudgeProvider } {
  const slash = id.indexOf("/")
  const provider = slash === -1 ? "" : id.slice(0, slash)
  const name = id.slice(slash + 1)
  const endpoint = Object.hasOwn(providers, provider) ? providers[provider] : undefined
  if (!endpoint || !MODEL_NAME.test(name)) throw new Error(`a judge model is provider/name with provider one of ${Object.keys(providers).join(", ")}`)
  return { provider, name, endpoint }
}

/** statuses with which a provider refuses this input (too large, filtered, unprocessable): the body can provoke them, so they never count as an outage */
const INPUT_REJECTED = new Set([400, 413, 422])

/**
 * a provider call that failed: `rejected` when the provider answered but refused or emptied this input, which the message's content
 * can cause; `no_key` when there is no key to call with; `outage` when it is unreachable, timed out or answered any other status
 */
export class JudgeProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "outage" | "rejected" | "no_key",
  ) {
    super(message)
    this.name = "JudgeProviderError"
  }
}

/** one prompt to a provider's API over HTTPS; its errors name the provider and the status only, never the key or the response */
export class HttpJudgeClient implements JudgeClient {
  private readonly provider: string
  private readonly name: string
  private readonly endpoint: JudgeProvider
  private readonly effort: JudgeEffort
  private readonly fetch: typeof fetch

  constructor(private readonly options: HttpJudgeOptions) {
    ;({ provider: this.provider, name: this.name, endpoint: this.endpoint } = judgeModel(options.model, options.providers))
    this.effort = options.effort ?? DEFAULT_JUDGE_EFFORT
    this.fetch = options.fetch ?? fetch
  }

  async judge(prompt: string, opts: { signal: AbortSignal }): Promise<{ text: string; usage?: { input: number; output: number } }> {
    const { url, shape, cap } = this.endpoint
    const fail = (what: string, kind: JudgeProviderError["kind"] = "outage") => new JudgeProviderError(`judge provider ${this.provider} ${what}`, kind)
    let key: string
    try {
      key = typeof this.options.key === "function" ? await this.options.key() : this.options.key
    } catch {
      throw fail("has no readable key", "no_key")
    }
    if (!key) throw fail("has no key", "no_key")
    const message = [{ role: "user", content: prompt }]
    const body =
      shape === "anthropic"
        ? { model: this.name, max_tokens: JUDGE_MAX_OUTPUT_TOKENS, messages: message, output_config: { effort: this.effort } }
        : { model: this.name, messages: message, reasoning_effort: this.effort, [cap ?? "max_tokens"]: JUDGE_MAX_OUTPUT_TOKENS }
    const headers: Record<string, string> =
      shape === "anthropic"
        ? { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { "content-type": "application/json", authorization: `Bearer ${key}` }
    const signal = this.options.timeoutMs ? AbortSignal.any([opts.signal, AbortSignal.timeout(this.options.timeoutMs)]) : opts.signal
    let response: Response
    try {
      response = await this.fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal })
    } catch {
      throw fail(signal.aborted ? "timed out" : "is unreachable")
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw fail(`answered ${response.status}`, INPUT_REJECTED.has(response.status) ? "rejected" : "outage")
    }
    let parsed: Record<string, unknown>
    try {
      const raw = await response.text()
      if (raw.length > MAX_RESPONSE_CHARS) throw new Error()
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw fail("sent an unreadable answer", "rejected")
    }
    const text = shape === "anthropic" ? anthropicText(parsed) : openaiText(parsed)
    if (typeof text !== "string" || !text) throw fail("sent no text", "rejected")
    const usage = parsed.usage as Record<string, unknown> | undefined
    const input = Number(shape === "anthropic" ? usage?.input_tokens : usage?.prompt_tokens)
    const output = Number(shape === "anthropic" ? usage?.output_tokens : usage?.completion_tokens)
    return { text, ...(Number.isFinite(input) && Number.isFinite(output) ? { usage: { input, output } } : {}) }
  }
}

function openaiText(parsed: Record<string, unknown>): string | undefined {
  const content = (parsed.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content.map((part: { type?: string; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("")
  return undefined
}

function anthropicText(parsed: Record<string, unknown>): string | undefined {
  const content = parsed.content
  if (!Array.isArray(content)) return undefined
  return content.map((block: { type?: string; text?: unknown }) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("")
}
