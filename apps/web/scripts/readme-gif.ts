// Renders .github/assets/example.gif, the animated README example: `bun run readme-gif`.
// Frames come from one headless Chrome over the DevTools protocol, then ffmpeg builds the GIF with its own palette.
// Set CHROME to the browser binary when it is not at the default path; ffmpeg must be on PATH.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const W = 1200;
const H = 660;
const SCALE = 2;
const FPS = 25;
const CPS = 48;
const C = { bg: "#090909", pane: "#0d0d0d", fg: "#f2f2f0", dim: "#9a9a96", faint: "#5e5e5a", edge: "#262624", acc: "#9d9cff" };

type Seg = [text: string, cls?: string];
type Line = Seg[];
type Item = { at: number; line: Line; chars?: number; prompt?: number; done?: number; msg?: boolean; dots?: number };
type Pane = "orch" | "parser";
type Status = "running" | "waiting" | "done";
type Worker = { name: string; harness: string; at: number; status: [number, Status][] };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function command(text: string): Line {
  const parts = text.match(/"[^"]*"|\S+|\s+/g) ?? [];
  return parts.map((p): Seg => [p, p.startsWith('"') ? "s" : p.startsWith("--") ? "d" : undefined]);
}

function attrs(from: string, relation: string): Line {
  return [
    ["<relay-message ", "d"],
    ["from=", "d"],
    [`"${from}"`, "a"],
    [" relation=", "d"],
    [`"${relation}"`, "a"],
    [">", "d"],
  ];
}

const items: Record<Pane, Item[]> = { orch: [], parser: [] };
const workers: Worker[] = [{ name: "me/orch", harness: "claude-code", at: 0, status: [[0, "running"]] }];
let t = 0.25;

const print = (pane: Pane, line: Line, extra: Partial<Item> = {}) => items[pane].push({ at: t, line, ...extra });
const relay = (pane: Pane, from: string, relation: string, lines: Line[], note: string) => {
  for (const line of [attrs(from, relation), ...lines, [["</relay-message>", "d"]] as Line, [[note, "f"]] as Line]) print(pane, line, { msg: true });
};

function type(text: string, idle: number) {
  const prompt = t;
  t += idle;
  const at = t;
  t += text.length / CPS + 0.18;
  items.orch.push({ at, line: command(text), chars: text.length, prompt, done: t });
}

function spawnWorker(name: string, pid: number, harness: string, task: string, idle: number): number {
  type(`swarm spawn --name ${name} -- ${task}`, idle);
  print("orch", [
    [name, "a"],
    [` started (pid ${pid}) and runs in the background`, "d"],
  ]);
  workers.push({ name, harness, at: t, status: [[t, "running"]] });
  const at = t;
  t += 0.3;
  return at;
}

const parserAt = spawnWorker("parser", 41822, "claude-code", 'claude -p "Fix the parser tests"', 0.45);
spawnWorker("docs", 41839, "codex", 'codex exec "Update the CLI reference"', 0.2);
spawnWorker("bench", 41857, "agy", 'agy -p "Benchmark the new parser"', 0.2);
type('swarm send parser "Also cover the empty-input case."', 0.2);
print("orch", [
  ["sent 7f3k to ", "d"],
  ["me/parser", "a"],
  [" (running)", "d"],
]);
const sentAt = t;
print("orch", []);
t += 0.5;
const stopAt = t;
const stopLine: Item = { at: t, line: [["stop: waiting on 3 workers", "d"]], dots: Infinity };
items.orch.push(stopLine);
workers[0].status.push([t, "waiting"]);

const parserDone = (() => {
  const save = t;
  t = parserAt + 0.15;
  const step = (gap: number, line: Line) => {
    t += gap;
    print("parser", line);
  };
  step(0, [
    ["> ", "f"],
    ["Fix the parser tests", "d"],
  ]);
  step(0.9, [
    ["● ", "a"],
    ["Read", "b"],
    [" test/parser.test.ts", "d"],
  ]);
  step(1.2, [
    ["● ", "a"],
    ["Bash", "b"],
    [" bun test parser", "d"],
  ]);
  step(0.6, [["  12 pass, 2 fail", "d"]]);
  t = Math.max(t + 0.8, sentAt + 0.7);
  step(0, [
    ["● ", "a"],
    ["Edit", "b"],
    [" src/parser.ts", "d"],
  ]);
  t += 0.6;
  relay(
    "parser",
    "me/orch",
    "parent",
    [[["Also cover the empty-input case."]]],
    "[from your parent me/orch, which started you and gave you your task: a new instruction from the same source as that task]",
  );
  step(2.4, [
    ["● ", "a"],
    ["Edit", "b"],
    [" test/parser.test.ts", "d"],
  ]);
  step(0.7, [
    ["● ", "a"],
    ["Bash", "b"],
    [" bun test parser", "d"],
  ]);
  step(0.6, [["  14 pass, 0 fail", "d"]]);
  const done = t + 0.4;
  t = Math.max(save, done + 0.5);
  return done;
})();
workers[1].status.push([parserDone, "done"]);
stopLine.dots = t;

relay(
  "orch",
  "me/parser",
  "child",
  [[["worker "], ["me/parser", "a"], [" finished (exit 0)"]], [], [["All 14 parser tests pass."]]],
  "[from your worker me/parser: for your information; reply only if useful]",
);
const END = t + 3.2;

const seg = ([text, cls]: Seg) => (cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text));
const row = (line: Line, extra = "") => `<div class="l">${line.map(seg).join("")}${extra}</div>`;

function cut(line: Line, n: number): Line {
  const out: Line = [];
  for (const [text, cls] of line) {
    if (n <= 0) break;
    out.push([text.slice(0, n), cls]);
    n -= text.length;
  }
  return out;
}

const CURSOR = `<span class="cur"></span>`;
const PROMPT: Seg = ["> ", "f"];

function item(it: Item, now: number): string | null {
  if (it.chars === undefined) {
    if (now < it.at) return null;
    if (it.dots !== undefined && now < it.dots) return row([...it.line, [".".repeat(1 + (Math.floor((now - it.at) * 2.5) % 3)), "d"]]);
    return row(it.line);
  }
  const prompt = it.prompt ?? it.at;
  if (now < prompt) return null;
  if (now < it.at) return row([PROMPT], Math.floor((now - prompt) * 2.2) % 2 === 0 ? CURSOR : "");
  const n = Math.min(it.chars, Math.floor((now - it.at) * CPS));
  return row([PROMPT, ...cut(it.line, n)], now < (it.done ?? 0) ? CURSOR : "");
}

function body(now: number, pane: Pane): string {
  let html = "";
  let open = false;
  for (const it of items[pane]) {
    const r = item(it, now);
    if (r === null) continue;
    if (!!it.msg !== open) {
      html += open ? "</div>" : `<div class="msg">`;
      open = !open;
    }
    html += r;
  }
  return open ? `${html}</div>` : html;
}

function statusAt(w: Worker, now: number): Status {
  let s: Status = "running";
  for (const [at, v] of w.status) if (now >= at) s = v;
  return s;
}

function tree(now: number): string {
  const live = workers.filter((w) => now >= w.at);
  return live
    .map((w, i) => {
      const glyph = i === 0 ? "" : i === live.length - 1 ? "└─ " : "├─ ";
      const s = statusAt(w, now);
      const dot = s === "running" ? `<span class="a">●</span>` : s === "done" ? `<span class="d">●</span>` : `<span class="f">○</span>`;
      const name = `<span class="f">${glyph}</span><span class="a">${w.name}</span>`;
      return `<div class="tr"><span class="n">${name}</span><span class="h">${w.harness}</span><span class="s">${dot} ${s}</span></div>`;
    })
    .join("");
}

function frame(now: number): string {
  const parserLive = now >= parserAt;
  const parserState = now >= parserDone ? "exited 0" : parserLive ? "running" : "";
  const orchState = now >= stopAt ? "at stop" : "running";
  return `<div class="win">
  <section class="pane orch">
    <header><span class="a">me/orch</span><span class="d">claude-code</span><span class="st">${orchState}</span></header>
    <div class="body">${body(now, "orch")}</div>
  </section>
  <div class="col">
    <section class="pane parser">
      <header><span class="${parserLive ? "a" : "f"}">me/parser</span><span class="${parserLive ? "d" : "f"}">claude-code</span><span class="st">${parserState}</span></header>
      <div class="body">${body(now, "parser")}</div>
    </section>
    <section class="pane tree">
      <header><span class="d">swarm list --tree</span></header>
      <div class="body">${tree(now)}</div>
    </section>
  </div>
</div>`;
}

function page(mono: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: GeistMono; src: url("${mono}") format("woff2"); font-weight: 100 900; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${C.bg}; color: ${C.fg}; }
body { font: 15px/1.6 GeistMono, monospace; -webkit-font-smoothing: antialiased; font-variant-ligatures: none; }
.win { position: absolute; inset: 20px; display: grid; grid-template-columns: 664px 1fr; gap: 12px; }
.col { display: grid; grid-template-rows: 1fr 166px; gap: 12px; min-height: 0; }
.pane { background: ${C.pane}; border: 1px solid ${C.edge}; border-radius: 10px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
header { display: flex; gap: 14px; padding: 10px 18px; border-bottom: 1px solid ${C.edge}; font-size: 13px; }
header .st { margin-left: auto; color: ${C.dim}; }
.body { padding: 14px 18px; flex: 1; min-height: 0; overflow: hidden; }
.l { white-space: pre-wrap; min-height: 1.6em; }
.msg { margin: 6px 0 6px -10px; padding: 4px 8px 4px 8px; border-left: 2px solid ${C.acc}; background: rgba(157, 156, 255, 0.06); border-radius: 0 6px 6px 0; }
.msg .l:last-child { margin-top: 2px; }
.a { color: ${C.acc}; }
.d { color: ${C.dim}; }
.f { color: ${C.faint}; }
.s { color: #cfcfca; }
.b { color: ${C.fg}; font-weight: 500; }
.cur { display: inline-block; width: 0.6em; height: 1.15em; vertical-align: -0.2em; background: ${C.fg}; }
.tr { display: grid; grid-template-columns: 180px 140px 1fr; }
.tr .h, .tr .s { color: ${C.dim}; }
</style></head><body><div id="app"></div></body></html>`;
}

type Cdp = { send: <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>) => Promise<T>; close: () => void };

async function connect(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message));
    else p.res(m.result);
  };
  return {
    send: <T>(method: string, params: Record<string, unknown> = {}) =>
      new Promise<T>((res, rej) => {
        const i = ++id;
        pending.set(i, { res: res as (v: unknown) => void, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
    close: () => ws.close(),
  };
}

function devtoolsPort(proc: ChildProcess): Promise<number> {
  return new Promise((res, rej) => {
    let err = "";
    proc.stderr?.on("data", (d) => {
      err += String(d);
      const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (m) res(Number(m[1]));
    });
    proc.on("exit", (code) => rej(new Error(`Chrome exited with ${code}`)));
  });
}

const require = createRequire(import.meta.url);
const mono = pathToFileURL(join(dirname(require.resolve("geist/package.json")), "dist/fonts/geist-mono/GeistMono-Variable.woff2")).href;
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) throw new Error(`no Chrome at ${chrome}; set CHROME`);
const out = process.env.OUT ?? join(import.meta.dirname, "../../../.github/assets/example.gif");

const dir = mkdtempSync(join(tmpdir(), "scp-gif-"));
const html = join(dir, "page.html");
writeFileSync(html, page(mono));
const proc = spawn(
  chrome,
  ["--headless=new", `--user-data-dir=${join(dir, "profile")}`, "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=0", pathToFileURL(html).href],
  {
    stdio: ["ignore", "ignore", "pipe"],
  },
);

try {
  const port = await devtoolsPort(proc);
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const target = targets.find((x) => x.type === "page");
  if (!target) throw new Error("no page target");
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  await cdp.send("Runtime.evaluate", {
    expression: `new Promise(r => { const go = () => document.fonts.load("15px GeistMono").then(() => document.fonts.ready).then(() => r(1)); document.readyState === "complete" ? go() : addEventListener("load", go); })`,
    awaitPromise: true,
  });

  const list: string[] = [];
  let last = "";
  let file = "";
  let held = 0;
  let n = 0;
  const frames = Math.round(END * FPS);
  for (let i = 0; i <= frames; i++) {
    const state = frame(i / FPS);
    if (state === last && i < frames) {
      held++;
      continue;
    }
    if (file) list.push(`file '${file}'`, `duration ${(held / FPS).toFixed(3)}`);
    if (i === frames) break;
    last = state;
    held = 1;
    file = join(dir, `f${String(n++).padStart(4, "0")}.png`);
    await cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("app").innerHTML = ${JSON.stringify(state)}; for (const b of document.querySelectorAll(".body")) b.scrollTop = b.scrollHeight`,
    });
    const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(shot.data, "base64"));
  }
  list.push(`file '${file}'`);
  writeFileSync(join(dir, "frames.txt"), `${list.join("\n")}\n`);
  cdp.close();

  const filter = `scale=${W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
  const ff = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "frames.txt"), "-filter_complex", filter, "-fps_mode", "vfr", "-loop", "0", out],
    {
      stdio: "inherit",
    },
  );
  if (ff.status !== 0) throw new Error(`ffmpeg exited with ${ff.status}`);
  console.log(`wrote ${out} (${n} frames, ${END.toFixed(1)} s)`);
} finally {
  proc.kill();
  if (process.env.GIF_KEEP) console.log(dir);
  else rmSync(dir, { recursive: true, force: true });
}
