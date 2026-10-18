import { describe, expect, test } from "bun:test"
import { DEFAULT_JUDGE_EFFORT, HttpJudgeClient, JUDGE_PROVIDERS, JudgeProviderError } from "./judge-provider"

const KEY = "sk-test-0123456789abcdefghijklmnopqrstuvwxyz"
const MODEL = "openai/judge-mini"

function fakeFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! })
    return response()
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const signal = () => new AbortController().signal
const chat = (text: string) =>
  Response.json({ choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 700, completion_tokens: 42 } })

describe("HttpJudgeClient", () => {
  test("no default model or provider: the model is required, the effort defaults to medium", () => {
    expect(DEFAULT_JUDGE_EFFORT).toBe("medium")
    expect(Object.keys(JUDGE_PROVIDERS).sort()).toEqual(["anthropic", "openai", "openrouter"])
    expect(() => new HttpJudgeClient({ key: KEY } as never)).toThrow()
  })

  test("OpenAI-shaped providers: endpoint, bearer key, model name, reasoning_effort, an output cap, no redirects", async () => {
    for (const [model, url, name, effort] of [
      ["openai/judge-mini", "https://api.openai.com/v1/chat/completions", "judge-mini", "high"],
      ["openrouter/anthropic/claude-haiku-5-5", "https://openrouter.ai/api/v1/chat/completions", "anthropic/claude-haiku-5-5", undefined],
    ] as const) {
      const { fetch, calls } = fakeFetch(() => chat('{"verdict":"pass"}'))
      const client = new HttpJudgeClient({ fetch, key: KEY, model, ...(effort ? { effort } : {}) })
      expect(await client.judge("the prompt", { signal: signal() })).toEqual({ text: '{"verdict":"pass"}', usage: { input: 700, output: 42 } })
      const [call] = calls
      expect(call!.url).toBe(url)
      expect(call!.init.method).toBe("POST")
      expect(call!.init.redirect).toBe("manual")
      expect((call!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
      const cap = model?.startsWith("openai/") ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }
      expect(JSON.parse(String(call!.init.body))).toEqual({
        model: name,
        messages: [{ role: "user", content: "the prompt" }],
        reasoning_effort: effort ?? "medium",
        ...cap,
      })
    }
  })

  test("a deployment's own provider table adds or replaces endpoints", async () => {
    const { fetch, calls } = fakeFetch(() => chat("{}"))
    const providers = { local: { url: "http://127.0.0.1:8080/v1/chat/completions", shape: "openai" as const } }
    await new HttpJudgeClient({ fetch, key: KEY, model: "local/judge", providers }).judge("p", { signal: signal() })
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/v1/chat/completions")
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: "judge", max_tokens: 4096 })
    expect(() => new HttpJudgeClient({ key: KEY, model: MODEL, providers })).toThrow()
  })

  test("anthropic: messages API with x-api-key and output_config effort", async () => {
    const { fetch, calls } = fakeFetch(() =>
      Response.json({
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "{}" },
        ],
        usage: { input_tokens: 9, output_tokens: 3 },
      }),
    )
    const client = new HttpJudgeClient({ fetch, key: () => KEY, model: "anthropic/claude-haiku-5-5", effort: "low" })
    expect(await client.judge("p", { signal: signal() })).toEqual({ text: "{}", usage: { input: 9, output: 3 } })
    const [call] = calls
    expect(call!.url).toBe("https://api.anthropic.com/v1/messages")
    const headers = call!.init.headers as Record<string, string>
    expect(headers["x-api-key"]).toBe(KEY)
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers.authorization).toBeUndefined()
    expect(JSON.parse(String(call!.init.body))).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: "p" }],
      output_config: { effort: "low" },
    })
  })

  test("non-2xx, redirects and network failures throw without the key or the body", async () => {
    for (const response of [
      () => new Response(`rate limited for ${KEY}`, { status: 429 }),
      () => new Response(`oops ${KEY}`, { status: 500 }),
      () => new Response(null, { status: 302, headers: { location: `https://evil.example/?k=${KEY}` } }),
      () => {
        throw new Error(`connect failed with ${KEY}`)
      },
      () => Response.json({ choices: [] }),
    ]) {
      const { fetch } = fakeFetch(response)
      const error = await new HttpJudgeClient({ fetch, key: KEY, model: MODEL }).judge("p", { signal: signal() }).then(
        () => new Error("resolved"),
        (e: unknown) => e as Error,
      )
      expect(error.message).toStartWith("judge provider openai ")
      expect(error.message).not.toContain(KEY)
      expect(error.message).not.toContain("oops")
      expect(error.message).not.toContain("evil")
    }
    const { fetch } = fakeFetch(() => new Response("x", { status: 429 }))
    await expect(new HttpJudgeClient({ fetch, key: KEY, model: MODEL }).judge("p", { signal: signal() })).rejects.toThrow("judge provider openai answered 429")
  })

  test("a failure is an outage, a rejection of this input, or a missing key", async () => {
    const kind = async (response: () => Response, key: string | (() => string) = KEY, timeoutMs?: number) => {
      const { fetch } = fakeFetch(response)
      const error = await new HttpJudgeClient({ fetch, key, model: MODEL, ...(timeoutMs ? { timeoutMs } : {}) })
        .judge("p", { signal: signal() })
        .catch((e: unknown) => e)
      return error instanceof JudgeProviderError ? error.kind : "not a provider error"
    }
    for (const status of [401, 403, 404, 429, 500, 502, 503, 529]) expect(await kind(() => new Response("x", { status }))).toBe("outage")
    expect(
      await kind(() => {
        throw new TypeError("network down")
      }),
    ).toBe("outage")
    for (const status of [400, 413, 422]) expect(await kind(() => new Response("x", { status }))).toBe("rejected")
    expect(await kind(() => new Response("not json"))).toBe("rejected")
    expect(await kind(() => chat(""))).toBe("rejected")
    expect(await kind(() => chat("{}"), "")).toBe("no_key")
    expect(
      await kind(
        () => chat("{}"),
        () => {
          throw new Error("no key")
        },
      ),
    ).toBe("no_key")
  })

  test("a call that outlasts its own timeout is an outage", async () => {
    const fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      )) as unknown as typeof globalThis.fetch
    const error = (await new HttpJudgeClient({ fetch, key: KEY, model: MODEL, timeoutMs: 20 })
      .judge("p", { signal: signal() })
      .catch((e: unknown) => e)) as JudgeProviderError
    expect([error.kind, error.message]).toEqual(["outage", "judge provider openai timed out"])
  })

  test("an unknown provider or a bad model id is refused up front", () => {
    expect(() => new HttpJudgeClient({ key: KEY, model: "acme/x" })).toThrow()
    expect(() => new HttpJudgeClient({ key: KEY, model: "openai" })).toThrow()
  })
})
