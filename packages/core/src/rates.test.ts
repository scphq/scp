import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { parseLimits, RATE_DURATIONS, RATE_LIMITS, wireLimits } from "./protocol"

const keys = Object.keys(RATE_LIMITS)

describe("rate configuration", () => {
  test("positive integers enable caps and null or zero disables caps", () => {
    expect(parseLimits({ pairBurst: 3, userPerDay: null, pairPerHour: 0 }, keys, "test")).toEqual({ pairBurst: 3, userPerDay: Infinity, pairPerHour: Infinity })
    expect(parseLimits({ treePauseS: null }, keys, "test")).toEqual({})
    expect(parseLimits({ treePauseS: 0 }, keys, "test")).toEqual({})
    expect(parseLimits({ treePauseS: 20 }, keys, "test")).toEqual({ treePauseS: 20 })
    expect(parseLimits({}, keys, "test")).toEqual({})
    expect(parseLimits({ hopMax: 64, threadMax: null, pingPongAlternations: 0, pingPongWindowS: 0, pingPongBlockS: 30 }, keys, "test")).toEqual({
      hopMax: 64,
      threadMax: Infinity,
      pingPongAlternations: Infinity,
      pingPongBlockS: 30,
    })
  })

  test("duration keys keep defaults when null or zero", () => {
    const keys = ["httpWaitS", "treePauseS", "callsPerMinute"]
    const durations = ["httpWaitS", "treePauseS"]
    for (const value of [null, 0]) {
      expect(parseLimits({ httpWaitS: value, treePauseS: value, callsPerMinute: value }, keys, "hub", durations)).toEqual({ callsPerMinute: Infinity })
    }
    expect(parseLimits({ httpWaitS: 10 }, keys, "hub", durations)).toEqual({ httpWaitS: 10 })
    expect(parseLimits({ treePauseS: null }, keys, "hub", [])).toEqual({ treePauseS: Infinity })
  })

  test("invalid shapes and values fail with their source and key", () => {
    for (const value of [null, [], "{}", 2]) expect(() => parseLimits(value, keys, "test")).toThrow("test")
    for (const value of [-1, 1.5, "3", true, undefined, Infinity, Number.NaN]) {
      expect(() => parseLimits({ pairBurst: value }, keys, "test")).toThrow("test: pairBurst")
    }
    expect(() => parseLimits({ unknown: 1 }, keys, "test")).toThrow("test: unknown limit unknown")
  })

  test("defaults allow sustained sends and report disabled rates as null", () => {
    const db = new Database(":memory:")
    const core = new RelayCore(
      { all: <T>(query: string, ...params: (string | number | null)[]) => db.query(query).all(...params) as T[] },
      { hash: (v) => v, now: () => 1_800_000_000_000 },
    )
    core.migrate()
    const a = core.claim({ handle: "a" }).endpoint.id
    const b = core.claim({ handle: "b" }).endpoint.id
    for (let i = 0; i < 2100; i++) {
      core.send(a, { to: "b", body: String(i) })
      const inbox = core.inbox(b)
      core.ack(
        b,
        inbox.map((m) => m.seq!),
      )
    }
    expect(wireLimits(core.rates)).toEqual(Object.fromEntries(keys.map((key) => [key, (RATE_DURATIONS as readonly string[]).includes(key) ? 600 : null])))
    db.close()
  }, 120_000)
})
