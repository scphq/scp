import { Database } from "bun:sqlite"
import { writeFileSync } from "node:fs"
import { RelayCore } from "../../../../packages/core/src/core"

const db = new Database(":memory:")
const sql = { all: <T>(query: string, ...params: (string | number | null)[]): T[] => db.query(query).all(...params) as T[] }
const core = new RelayCore(sql, { now: () => 1_700_000_000_000, hash: (text) => text, transaction: (fn) => db.transaction(fn).immediate() })
core.migrate()
const schema = sql.all("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
writeFileSync(new URL("./ts-schema.json", import.meta.url), `${JSON.stringify(schema, null, 2)}\n`)
const data = Object.fromEntries(["endpoints", "relay_migrations"].map((table) => [table, sql.all(`SELECT * FROM ${table} ORDER BY rowid`)]))
writeFileSync(new URL("./ts-relay.json", import.meta.url), `${JSON.stringify(data, null, 2)}\n`)
const seed = [
  { query: "DELETE FROM relay_migrations", params: [] },
  { query: "INSERT INTO endpoints (id, handle, kind, created_at, rules, caps) VALUES (?, ?, 'agent', 0, ?, ?)", params: ["ep_old", "worker", JSON.stringify({ in: ["tree:self"], out: ["tree:self"] }), JSON.stringify({ caps: [{ id: "cap1", dir: "out", sels: [{ sel: "tree:self" }] }, { id: "cap2", dir: "in", sels: [{ sel: "tree:self", via: "ep_parent" }] }], allow: { empty: [], kept: [{ sel: "tree:self" }] }, lifted: ["cap3"], unused: true })] },
  { query: "INSERT INTO endpoints (id, handle, kind, created_at, rules) VALUES ('ep_mixed', 'mixed', 'agent', 0, ?)", params: [JSON.stringify({ in: ["tree:self", "tree:parent"], out: ["tree:self"] })] },
  ...[["live", "ep_old", null, null], ["missing", "ep_missing", null, null], ["used", "ep_old", "ep_old", null], ["revoked", "ep_old", null, 1]].map(([token, under, used, revoked]) => ({ query: "INSERT INTO grants (token_hash, issuer, under, caps, used_by, revoked_at, created_at, expires_at) VALUES (?, 'ep_old', ?, ?, ?, ?, 0, 9999999999999)", params: [token, under, JSON.stringify([{ dir: "in", sels: [{ sel: "tree:self" }] }]), used, revoked] })),
]
for (const { query, params } of seed) sql.all(query, ...params)
core.migrate()
const after = {
  endpoints: sql.all("SELECT id, rules, caps FROM endpoints WHERE kind = 'agent' ORDER BY rowid"),
  grants: sql.all("SELECT token_hash, caps FROM grants ORDER BY rowid"),
  audit: sql.all("SELECT at, event, endpoint, ref, detail FROM audit ORDER BY id"),
}
writeFileSync(new URL("./ts-tree.json", import.meta.url), `${JSON.stringify({ seed, after }, null, 2)}\n`)
db.close()
