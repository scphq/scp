import { createRequire } from "node:module"
import type { Sql, SqlValue } from "@scp-dev/core"

/** the broker's SQLite file: bun:sqlite under Bun, node:sqlite under Node, each loaded only by its own runtime */
export interface Database extends Sql {
  /** statements that bind nothing, such as pragmas */
  exec(statement: string): void
  /** runs `fn` in one IMMEDIATE transaction; a call inside one is a savepoint */
  transaction<T>(fn: () => T): T
  close(): void
}

interface Driver {
  exec(statement: string): void
  all(query: string, params: SqlValue[]): unknown[]
  close(): void
}

const STATEMENT_CACHE = 512

/** a require that bundlers leave alone, so neither runtime resolves the other's module, and node:sqlite keeps its prefix */
const load = createRequire(import.meta.url)

function bunDriver(path: string): Driver {
  const { Database } = load("bun:sqlite") as typeof import("bun:sqlite")
  const db = new Database(path, { create: true })
  return {
    exec: (statement) => void db.run(statement),
    all: (query, params) => db.query(query).all(...params),
    close: () => db.close(),
  }
}

function nodeDriver(path: string): Driver {
  const { DatabaseSync } = load("node:sqlite") as typeof import("node:sqlite")
  const db = new DatabaseSync(path)
  const statements = new Map<string, ReturnType<typeof db.prepare>>()
  return {
    exec: (statement) => db.exec(statement),
    all: (query, params) => {
      let statement = statements.get(query)
      if (!statement) {
        if (statements.size >= STATEMENT_CACHE) statements.clear()
        statement = db.prepare(query)
        statements.set(query, statement)
      }
      return statement.all(...params)
    },
    close: () => db.close(),
  }
}

export function openDatabase(path: string): Database {
  const driver = typeof process.versions.bun === "string" ? bunDriver(path) : nodeDriver(path)
  let depth = 0
  return {
    exec: (statement) => driver.exec(statement),
    all: <T>(query: string, ...params: SqlValue[]) => driver.all(query, params) as T[],
    close: () => driver.close(),
    transaction<T>(fn: () => T): T {
      const savepoint = depth ? `tx_${depth}` : undefined
      driver.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE")
      depth++
      let result: T
      try {
        result = fn()
      } catch (error) {
        depth--
        try {
          if (savepoint) {
            driver.exec(`ROLLBACK TO ${savepoint}`)
            driver.exec(`RELEASE ${savepoint}`)
          } else driver.exec("ROLLBACK")
        } catch {}
        throw error
      }
      depth--
      try {
        driver.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT")
      } catch (error) {
        if (!savepoint)
          try {
            driver.exec("ROLLBACK")
          } catch {}
        throw error
      }
      return result
    },
  }
}
