export type SqlValue = string | number | null

/**
 * The one SQLite method the core needs: bun:sqlite locally, `ctx.storage.sql` in a Durable Object.
 * Calls stay synchronous, so every read-modify-write in the core is atomic between awaits.
 */
export interface Sql {
  all<T = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): T[]
}

export const one = <T>(sql: Sql, query: string, ...params: SqlValue[]): T | undefined => sql.all<T>(query, ...params)[0]
