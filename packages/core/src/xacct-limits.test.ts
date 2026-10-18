import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { XCounters, type XContact, XLIMITS, xlimits } from "./xacct"

const contact: XContact = { peerId: "acc_bob", peerHandle: "bob", allow: [], dir: "both", limits: null }

function counters(limits: ConstructorParameters<typeof XCounters>[2] = {}) {
  const db = new Database(":memory:")
  db.run("CREATE TABLE xcounters (contact TEXT PRIMARY KEY, day INTEGER, sent INTEGER, at INTEGER)")
  const sql = { all: <T>(query: string, ...params: (string | number | null)[]) => db.query(query).all(...params) as T[] }
  return new XCounters(sql, () => 1_000_000, limits)
}

describe("cross-account limits", () => {
  test("the defaults, lowered by a contact's own and the declared limits", () => {
    expect(xlimits(null)).toEqual({ perMinute: XLIMITS.pairPerMinute, perHour: XLIMITS.pairPerHour, perDay: XLIMITS.accountPerDay })
    expect(xlimits({ per_minute: 3, per_day: 5000 }, { per_hour: 7 })).toEqual({ perMinute: 3, perHour: 7, perDay: XLIMITS.accountPerDayMax })
  })

  test("a deployment's caps replace the defaults", () => {
    const xc = counters({ pairPerMinute: 2 })
    for (let i = 0; i < 2; i++) {
      xc.check(contact, "me/a", "desk/b", "t1")
      xc.sent(contact, "me/a", "desk/b", "t1")
    }
    expect(() => xc.check(contact, "me/a", "desk/b", "t1")).toThrow("2 messages to desk/b a minute")
  })

  test("Infinity lifts a count cap", () => {
    const xc = counters({ pairPerMinute: Infinity, pairPerHour: Infinity, accountPerDay: Infinity, threadMax: Infinity })
    for (let i = 0; i < 500; i++) {
      xc.check(contact, "me/a", "desk/b", "t1")
      xc.sent(contact, "me/a", "desk/b", "t1")
    }
  })
})
