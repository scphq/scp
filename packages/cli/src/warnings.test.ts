import { expect, test } from "bun:test"
import { quietSqliteWarning } from "./warnings"

test("only node:sqlite's experimental warning is dropped", () => {
  const original = process.emitWarning
  const seen: string[] = []
  process.emitWarning = ((warning: string | Error) => void seen.push(String(warning))) as typeof process.emitWarning
  try {
    quietSqliteWarning()
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning")
    process.emitWarning("SQLite is an experimental feature", { type: "ExperimentalWarning" })
    process.emitWarning("something else is experimental", "ExperimentalWarning")
    process.emitWarning("sqlite deprecated", "DeprecationWarning")
    expect(seen).toEqual(["something else is experimental", "sqlite deprecated"])
  } finally {
    process.emitWarning = original
  }
})
