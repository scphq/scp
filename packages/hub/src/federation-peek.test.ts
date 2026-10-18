import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayError, type ScopeActor, type SqlValue } from "@scp-dev/core"
import { FederatedCore } from "./federation"

const TTY: ScopeActor = { kind: "human", tty: true }

function failure(fn: () => unknown): RelayError {
  try {
    fn()
  } catch (error) {
    if (error instanceof RelayError) return error
    throw error
  }
  throw new Error("expected a RelayError")
}

describe("peek across machines", () => {
  test("another machine's mirrored rows are never peekable, even with a level set", () => {
    const db = new Database(":memory:")
    const core = new FederatedCore(
      { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] },
      {
        hash: (value: string) => value,
        transaction: <T>(fn: () => T): T => db.transaction(fn)(),
        machine: "laptop",
        aliases: ["ada"],
      },
    )
    core.migrate()
    core.mirror("desk", [{ address: "ada/desk/app-main", kind: "agent", harness: "claude-code", presence: "online" }], { full: true })
    db.query(`UPDATE endpoints SET peek = 'local' WHERE kind = 'agent'`).run()
    const remote = core.list({ all: true }).find((row) => row.address === "me/desk/app-main")!
    expect(failure(() => core.peek(TTY, { endpoint: "desk/app-main" })).code).toBe("not_found")
    expect(core.peekTurn(remote.id, { role: "user", text: "x" })).toEqual({ stored: false })
    expect(core.list({ all: true, peekable: true }).some((row) => row.peekable)).toBe(false)
    expect(core.peers(core.humanId()).some((row) => row.peekable)).toBe(false)
  })
})
