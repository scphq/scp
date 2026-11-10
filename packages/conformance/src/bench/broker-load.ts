/**
 * Broker load bench: one broker engine over a copy of a relay database, N session clients reconnecting at once, then a steady mix of
 * hook runs, inbox, list, status, send and whoami calls. Reports connect and per-method latency percentiles, refused connects, and the
 * broker's CPU and RSS.
 *
 *   bun packages/conformance/src/bench/broker-load.ts --engine rust --bin crates/target/release/scp-broker --db relay.db
 *   bun packages/conformance/src/bench/broker-load.ts --engine ts --db relay.db --clients 80 --seconds 60 --json out.json
 *
 * Without --db the broker starts on a database seeded with --seed endpoint rows. The database is always copied into a scratch home.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { cli, socketPath } from "../broker/target";
import { terminate } from "../targets";

const { values: opts } = parseArgs({
  options: {
    engine: { type: "string", default: "ts" },
    bin: { type: "string" },
    db: { type: "string" },
    seed: { type: "string", default: "0" },
    clients: { type: "string", default: "80" },
    seconds: { type: "string", default: "45" },
    think: { type: "string", default: "1000" },
    timeout: { type: "string", default: "30000" },
    json: { type: "string" },
    keep: { type: "boolean", default: false },
    log: { type: "string" },
  },
});

const engine = opts.engine!;
if (engine !== "ts" && engine !== "rust") throw new Error("--engine is ts or rust");
if (engine === "rust" && !opts.bin) throw new Error("--engine rust needs --bin <scp-broker or swarm>");
const clients = Number(opts.clients);
const seconds = Number(opts.seconds);
const think = Number(opts.think);
const callTimeout = Number(opts.timeout);

type Frame = { id?: number; method?: string; result?: unknown; error?: { message: string; data?: { code?: string } } };

class Conn {
  private next = 0;
  private buffer = "";
  private waiting = new Map<number, (frame: Frame) => void>();
  closed = false;
  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Frame;
        if (frame.method !== undefined || typeof frame.id !== "number") continue;
        this.waiting.get(frame.id)?.(frame);
        this.waiting.delete(frame.id);
      }
    });
    const fail = () => {
      this.closed = true;
      for (const resolve of this.waiting.values()) resolve({ error: { message: "closed", data: { code: "closed" } } });
      this.waiting.clear();
    };
    socket.on("close", fail);
    socket.on("error", fail);
  }
  static open(path: string): Promise<Conn> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => resolve(new Conn(socket)));
      socket.once("error", reject);
    });
  }
  call(method: string, params: Record<string, unknown> = {}): Promise<Frame> {
    const id = ++this.next;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ error: { message: "timeout", data: { code: "timeout" } } });
      }, callTimeout);
      this.waiting.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  close() {
    this.socket.end();
  }
}

const samples = new Map<string, number[]>();
const failures = new Map<string, Map<string, number>>();
const record = (name: string, ms: number, error?: string) => {
  if (error) {
    const by = failures.get(name) ?? new Map<string, number>();
    by.set(error, (by.get(error) ?? 0) + 1);
    failures.set(name, by);
    return;
  }
  const list = samples.get(name) ?? [];
  list.push(ms);
  samples.set(name, list);
};

async function timed(name: string, conn: Conn, method: string, params: Record<string, unknown> = {}): Promise<Frame> {
  const began = performance.now();
  const frame = await conn.call(method, params);
  record(name, performance.now() - began, frame.error ? (frame.error.data?.code ?? frame.error.message) : undefined);
  return frame;
}

async function connect(socket: string): Promise<Conn | undefined> {
  const began = performance.now();
  try {
    const conn = await Conn.open(socket);
    record("connect", performance.now() - began);
    return conn;
  } catch (error) {
    record("connect", 0, (error as NodeJS.ErrnoException).code ?? String(error));
    return undefined;
  }
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
function summary() {
  const names = [...new Set([...samples.keys(), ...failures.keys()])].sort();
  return Object.fromEntries(
    names.map((name) => {
      const list = (samples.get(name) ?? []).sort((a, b) => a - b);
      const round = (n: number) => Math.round(n * 10) / 10;
      return [
        name,
        {
          n: list.length,
          p50: round(quantile(list, 0.5)),
          p95: round(quantile(list, 0.95)),
          p99: round(quantile(list, 0.99)),
          max: round(list.at(-1) ?? 0),
          errors: Object.fromEntries(failures.get(name) ?? []),
        },
      ];
    }),
  );
}

/** the CPU seconds and RSS of `pid` */
function usage(pid: number): { cpu: number; rss: number } | undefined {
  const out = spawnSync("ps", ["-o", "time=,rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  if (!out) return undefined;
  const [time, rss] = out.split(/\s+/);
  const parts = time!.split(/[:-]/).map(Number);
  const cpu = parts.reduce((total, part) => total * 60 + part, 0);
  return { cpu, rss: Number(rss) / 1024 };
}

function seeded(path: string, rows: number) {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  if (!db.query("SELECT 1 FROM pragma_table_info('endpoints')").get())
    throw new Error("--seed needs a migrated database: run the broker on it once, or pass --db");
  const insert = db.prepare(
    "INSERT OR IGNORE INTO endpoints (id, handle, kind, harness, created_at, last_seen, connections) VALUES (?, ?, 'agent', 'claude-code', ?, ?, 0)",
  );
  const now = Date.now();
  db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(`seed-${i}`, `seed-${i}`, now - i * 60_000, now - i * 60_000);
  })();
  db.close();
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "scp-load-"));
  const dir = join(home, "state", "scp");
  mkdirSync(dir, { recursive: true });
  const socket = socketPath(dir);
  const policy = join(home, "config", "scp", "policy.json");
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SCP_")));
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_DATA_HOME: join(home, "data"),
    SCP_DIR: dir,
    SCP_HARNESS_DETECT: "0",
    CODEX_HOME: join(home, "codex"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    GEMINI_CLI_HOME: home,
  });
  if (opts.db) {
    for (const suffix of ["", "-wal"]) if (existsSync(`${opts.db}${suffix}`)) copyFileSync(`${opts.db}${suffix}`, join(dir, `relay.db${suffix}`));
  }
  const command =
    engine === "rust"
      ? [resolve(opts.bin!), "daemon", "--idle", "600", "--policy", policy]
      : [process.execPath, "--no-env-file", cli, "daemon", "--idle", "600", "--policy", policy];
  let child: Subprocess<"ignore", "ignore", "pipe"> | undefined;
  let stderr = "";
  const launch = async () => {
    const began = performance.now();
    child = Bun.spawn(command, { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    void (async () => {
      for await (const chunk of child!.stderr) stderr += new TextDecoder().decode(chunk);
    })();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`broker exited (${child.exitCode}): ${stderr.slice(-2000)}`);
      const conn = existsSync(socket) ? await Conn.open(socket).catch(() => undefined) : undefined;
      if (conn) {
        const hello = await conn.call("hello", { protocol: "scp/1", observe: true });
        conn.close();
        if (!hello.error) return performance.now() - began;
      }
      if (performance.now() - began > 600_000) throw new Error("broker did not start within 600 s");
      await Bun.sleep(50);
    }
  };
  if (Number(opts.seed) > 0) {
    await launch();
    await terminate(child!);
    seeded(join(dir, "relay.db"), Number(opts.seed));
  }
  const startMs = await launch();
  const pid = Number(readFileSync(join(dir, "broker.lock"), "utf8").split(":")[0]) || child!.pid;
  const procs = [{ pid: process.pid, ppid: process.ppid, start: "bench", args: "bun bench", comm: "bun" }];
  const sessions: { handle: string; conn?: Conn; address?: string }[] = Array.from({ length: clients }, (_, i) => ({ handle: `load-${i}` }));

  const cpu: number[] = [];
  const rss: number[] = [];
  let last = usage(pid);
  let lastAt = performance.now();
  const sampler = setInterval(() => {
    const now = usage(pid);
    const at = performance.now();
    if (now && last) {
      cpu.push((100 * (now.cpu - last.cpu)) / ((at - lastAt) / 1000));
      rss.push(now.rss);
    }
    last = now;
    lastAt = at;
  }, 1000);

  const claim = async (session: (typeof sessions)[number]) => {
    const conn = await connect(socket);
    if (!conn) return;
    const hello = await timed("hello_claim", conn, "hello", {
      protocol: "scp/1",
      claim: { handle: session.handle, harness: "claude-code", session: `load:${session.handle}`, cwd: home },
    });
    if (hello.error) return conn.close();
    session.conn = conn;
    session.address = (hello.result as { endpoint: { address: string } }).endpoint.address;
    await timed("status", conn, "status", { state: "working" });
  };

  const stormBegan = performance.now();
  await Promise.all(sessions.map(claim));
  const stormMs = performance.now() - stormBegan;

  const hook = async (session: (typeof sessions)[number], event: string) => {
    const conn = await connect(socket);
    if (!conn) return;
    try {
      const hello = await timed("hello_observe", conn, "hello", { protocol: "scp/1", observe: true });
      if (hello.error) return;
      const origin = Date.now();
      const ran = await timed("hook", conn, "hook", {
        args: ["claude"],
        payload: { hook_event_name: event, session_id: `load-${session.handle}`, cwd: home, tool_name: "Bash" },
        cwd: home,
        env: { CLAUDECODE: "1", SCP_SESSION: `load:${session.handle}`, SCP_NAME: session.handle, SCP_TLDR_EVERY: "0", SCP_DIR: dir, HOME: home },
        origin,
        ends: origin + 3500,
        ppid: process.pid,
        procs,
      });
      const result = ran.result as { stdout?: string; commit?: string } | undefined;
      if (result?.stdout && result.commit) await timed("hook_commit", conn, "hook_commit", { commit: result.commit });
    } finally {
      conn.close();
    }
  };

  const ops: [number, (session: (typeof sessions)[number]) => Promise<unknown>][] = [
    [30, (s) => hook(s, "PostToolUse")],
    [10, (s) => hook(s, "UserPromptSubmit")],
    [18, (s) => timed("inbox", s.conn!, "inbox", {})],
    [15, (s) => timed("status", s.conn!, "status", { state: Math.random() < 0.5 ? "working" : "waiting", note: "load" })],
    [15, (s) => timed("whoami", s.conn!, "whoami")],
    [
      8,
      (s) => {
        const to = sessions[Math.floor(Math.random() * sessions.length)]!;
        return timed("send", s.conn!, "send", { to: to.address ?? to.handle, body: "load", kind: "message" });
      },
    ],
    [1, (s) => timed("list", s.conn!, "list", {})],
    [1, (s) => timed("peers", s.conn!, "peers", {})],
  ];
  const weight = ops.reduce((total, [w]) => total + w, 0);
  const pick = () => {
    let roll = Math.random() * weight;
    for (const [w, op] of ops) {
      roll -= w;
      if (roll < 0) return op;
    }
    return ops[0]![1];
  };
  const steadyEnd = performance.now() + seconds * 1000;
  let calls = 0;
  await Promise.all(
    sessions.map(async (session) => {
      while (performance.now() < steadyEnd) {
        await Bun.sleep(-Math.log(1 - Math.random()) * think);
        if (performance.now() >= steadyEnd) break;
        if (!session.conn || session.conn.closed) {
          await claim(session);
          continue;
        }
        await pick()(session);
        calls++;
      }
    }),
  );
  clearInterval(sampler);
  for (const session of sessions) session.conn?.close();
  await terminate(child!);
  const mean = (list: number[]) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
  const report = {
    engine,
    db: opts.db ? resolve(opts.db) : `seed:${opts.seed}`,
    clients,
    seconds,
    think_ms: think,
    load: spawnSync("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" }).stdout.trim(),
    start_ms: Math.round(startMs),
    storm_ms: Math.round(stormMs),
    steady_calls: calls,
    cpu_pct: { mean: Math.round(mean(cpu)), max: Math.round(Math.max(0, ...cpu)) },
    rss_mb: { max: Math.round(Math.max(0, ...rss)), last: Math.round(rss.at(-1) ?? 0) },
    methods: summary(),
    stderr_tail: stderr.split("\n").filter(Boolean).slice(-5),
  };
  const { methods, stderr_tail, ...head } = report;
  console.log(JSON.stringify(head));
  console.log("method          n      p50      p95      p99      max  errors");
  for (const [name, m] of Object.entries(methods))
    console.log(
      `${name.padEnd(14)}${String(m.n).padStart(5)}${[m.p50, m.p95, m.p99, m.max].map((v) => v.toFixed(1).padStart(9)).join("")}  ${JSON.stringify(m.errors)}`,
    );
  if (stderr_tail.length) console.log(stderr_tail.join("\n"));
  if (opts.json) writeFileSync(opts.json, JSON.stringify(report, null, 2));
  if (opts.log) writeFileSync(opts.log, stderr);
  if (!opts.keep) rmSync(home, { recursive: true, force: true });
}

await main();
