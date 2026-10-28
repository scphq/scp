/**
 * broker load benchmark: a broker in a temp dir over a seeded (or copied) relay.db, `--clients` concurrent clients doing what MCP shims and
 * hooks do, then the latency of each request type and the time of each periodic pass. Not run in CI.
 *
 *   bun packages/broker/bench/broker-perf.ts [--seconds 20] [--clients 40] [--endpoints 6600] [--db <relay.db to copy>]
 *   bun run --filter @scp-dev/broker build && node packages/broker/bench/broker-perf.ts ...
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"

type Value = string | number | null

interface Seeder {
  run(sql: string, ...params: Value[]): void
  exec(sql: string): void
  close(): void
}

function arg(name: string, fallback: number): number
function arg(name: string): string | undefined
function arg(name: string, fallback?: number): number | string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  const text = at < 0 ? undefined : process.argv[at + 1]
  if (fallback === undefined) return text
  return text === undefined ? fallback : Number(text)
}

function openSeeder(path: string): Seeder {
  const load = createRequire(import.meta.url)
  if (typeof process.versions.bun === "string") {
    const { Database } = load("bun:sqlite") as typeof import("bun:sqlite")
    const db = new Database(path)
    return { run: (sql, ...params) => void db.query(sql).run(...params), exec: (sql) => void db.run(sql), close: () => db.close() }
  }
  const { DatabaseSync } = load("node:sqlite") as typeof import("node:sqlite")
  const db = new DatabaseSync(path)
  const cache = new Map<string, ReturnType<typeof db.prepare>>()
  const prepared = (sql: string) => cache.get(sql) ?? cache.set(sql, db.prepare(sql)).get(sql)!
  return { run: (sql, ...params) => void prepared(sql).run(...params), exec: (sql) => db.exec(sql), close: () => db.close() }
}

/** rows shaped like a machine after weeks of fleets: mostly offline workers in shallow trees, a long audit, unread mail */
function seed(path: string, endpoints: number): void {
  const db = openSeeder(path)
  const now = Date.now()
  const day = 86_400_000
  db.exec("BEGIN")
  for (let i = 0; i < endpoints; i++) {
    const root = i % 20 === 0
    const tree = `ep_bench${i - (i % 20)}`
    const hibernate = i % 4 === 1 ? "spawn" : i % 9 === 2 ? "claude-bg" : null
    db.run(
      `INSERT INTO endpoints (id, handle, kind, harness, labels, created_at, last_seen, parent_ep, tree, depth, process, harness_session, hibernate, spawned_at)
       VALUES (?, ?, 'agent', 'claude-code', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `ep_bench${i}`,
      `old-${i}`,
      now - 10 * day + i,
      now - (i % 10) * day,
      root ? null : tree,
      root ? null : tree,
      root ? 0 : 1,
      `pid:${900_000 + i}:Mon-Oct-19-10:00:00-2026`,
      `session-${i}`,
      hibernate,
      now - 10 * day,
    )
    if (!root)
      db.run(
        `INSERT INTO grants (token_hash, issuer, under, name, created_at, expires_at, used_by, spawn, bound_process) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        `grant${i}`,
        tree,
        tree,
        `old-${i}`,
        now - 9 * day,
        now - 8 * day,
        `ep_bench${i}`,
        `pid:${800_000 + i}:Mon-Oct-19-10:00:00-2026`,
      )
  }
  for (let i = 0; i < endpoints * 2.5; i++) {
    const from = `ep_bench${i % endpoints}`
    const to = `ep_bench${(i * 7) % endpoints}`
    const at = now - (i % 10) * day
    db.run(
      `INSERT INTO messages (id, thread, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at)
       VALUES (?, ?, 'note', ?, ?, ?, 'text/plain', 'internal', '[]', 0, ?, ?)`,
      `msg_bench${i}`,
      `msg_bench${i - (i % 3)}`,
      from,
      `me/old-${(i * 7) % endpoints}`,
      `body ${i}`,
      at,
      at + 7 * day,
    )
    db.run(
      `INSERT INTO deliveries (message_id, endpoint, acked_at, expires_at) VALUES (?, ?, ?, ?)`,
      `msg_bench${i}`,
      to,
      i % 4 ? at + 1000 : null,
      at + 7 * day,
    )
  }
  for (let i = 0; i < endpoints * 30; i++)
    db.run(
      `INSERT INTO audit (at, event, endpoint, detail) VALUES (?, 'scope_refused', ?, '{"reason":"bench"}')`,
      now - (i % 10) * day,
      `ep_bench${i % endpoints}`,
    )
  db.exec("COMMIT")
  db.close()
}

class Stats {
  private readonly samples = new Map<string, number[]>()
  private readonly failures = new Map<string, number>()
  add(name: string, ms: number): void {
    const list = this.samples.get(name) ?? []
    list.push(ms)
    this.samples.set(name, list)
  }
  fail(name: string): void {
    this.failures.set(name, (this.failures.get(name) ?? 0) + 1)
  }
  async time<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    const started = performance.now()
    try {
      const result = await fn()
      this.add(name, performance.now() - started)
      return result
    } catch {
      this.fail(name)
      return undefined
    }
  }
  report(): string[] {
    const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]!
    const names = [...new Set([...this.samples.keys(), ...this.failures.keys()])].sort()
    return names.map((name) => {
      const sorted = [...(this.samples.get(name) ?? [])].sort((a, b) => a - b)
      const cols = sorted.length
        ? `p50 ${pct(sorted, 50).toFixed(1)} ms  p99 ${pct(sorted, 99).toFixed(1)} ms  max ${sorted.at(-1)!.toFixed(1)} ms`
        : "no samples"
      return `${name.padEnd(16)} n=${String(sorted.length).padEnd(6)} ${cols}  errors ${this.failures.get(name) ?? 0}`
    })
  }
}

function timeSync(stats: Stats, name: string, fn: () => unknown): void {
  const started = performance.now()
  fn()
  stats.add(name, performance.now() - started)
}

async function worker(broker: Broker, root: string, index: number, peers: number, until: number, stats: Stats): Promise<void> {
  const claim = { handle: `bench-${index}`, harness: "claude-code", cwd: root, session: `bench:${index}`, process: `pid:${process.pid}` }
  const shim = await RelayClient.connect(broker.socket)
  try {
    await stats.time("hello", () => shim.hello({ claim }))
    let turn = 0
    while (performance.now() < until) {
      turn++
      const to = `me/bench-${(index + 1 + (turn % 3)) % peers}`
      await stats.time("send", () => shim.request("send", { to, body: `turn ${turn} from ${index}` }))
      const page = await stats.time("inbox", () => shim.request<{ messages: { seq: number }[] }>("inbox", {}))
      const seqs = page?.messages.map((message) => message.seq) ?? []
      if (seqs.length) await stats.time("ack", () => shim.request("ack", { seqs }))
      await stats.time("whoami", () => shim.request("whoami", {}))
      if (turn % 4 === 0) await stats.time("list", () => shim.request("list", {}))
      if (turn % 8 === 0) await stats.time("list_all", () => shim.request("list", { all: true }))
      const hook = await stats.time("connect", () => RelayClient.connect(broker.socket))
      if (hook) {
        await stats.time("hook_hello", () => hook.hello({ transient: true, claim }))
        await stats.time("event", () => hook.request("event", { kind: "tool", name: "Bash" }))
        await stats.time("inject", () => hook.request("inject", {}))
        hook.close()
      }
    }
  } finally {
    shim.close()
  }
}

async function main(): Promise<void> {
  const seconds = arg("seconds", 20)
  const clients = arg("clients", 40)
  const endpoints = arg("endpoints", 6600)
  const source = arg("db")
  const root = mkdtempSync(join(tmpdir(), "scp-broker-perf-"))
  const dir = join(root, "state")
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const options = { dir, policyPath: join(root, "policy.json"), idleMs: 0, presenceEveryMs: 1_000_000, wakers: {} }
    if (source) {
      for (const suffix of ["", "-wal"]) if (existsSync(source + suffix)) copyFileSync(source + suffix, join(dir, `relay.db${suffix}`))
    } else {
      const fresh = await startBroker(options)
      await fresh.stop()
      seed(join(dir, "relay.db"), endpoints)
    }
    const startup = performance.now()
    const broker = await startBroker(options)
    const stats = new Stats()
    stats.add("startup", performance.now() - startup)
    const lag = monitorEventLoopDelay({ resolution: 10 })
    lag.enable()
    const until = performance.now() + seconds * 1000
    const periodic = (async () => {
      while (performance.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        timeSync(stats, "pass:endExited", () => broker.core.endExited())
        timeSync(stats, "pass:snapshot", () => broker.core.snapshot({ all: true }))
        timeSync(stats, "pass:localAgents", () => broker.core.localAgents())
        timeSync(stats, "pass:sweep", () => broker.core.sweep())
        timeSync(stats, "pass:judgeSweep", () => broker.judge.sweep())
      }
    })()
    await Promise.all([...Array.from({ length: clients }, (_, i) => worker(broker, root, i, clients, until, stats)), periodic])
    lag.disable()
    await broker.stop()
    const runtime = typeof process.versions.bun === "string" ? `bun ${process.versions.bun}` : `node ${process.versions.node}`
    console.log(`${runtime}, ${clients} clients, ${seconds} s, ${source ? `copy of ${source}` : `${endpoints} seeded endpoints`}`)
    for (const line of stats.report()) console.log(line)
    console.log(
      `event loop delay  p50 ${(lag.percentile(50) / 1e6).toFixed(1)} ms  p99 ${(lag.percentile(99) / 1e6).toFixed(1)} ms  max ${(lag.max / 1e6).toFixed(1)} ms`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await main()
