"use client";

import { useEffect, useRef } from "react";
import { drawHarness, HARNESSES, type Harness } from "./harnesses";

export type Pt = { x: number; y: number };
type Kind = "hub" | "broker" | "root" | "sub" | "worker" | "gate";

interface N extends Pt {
  kind: Kind;
  parent: number;
  alive: boolean;
  a: number;
  ring: number;
  machine: number;
  harness?: Harness;
  sleep?: number;
  reply?: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface Pulse {
  pts: Pt[];
  cum: number[];
  d: number;
  speed: number;
  color: "fg" | "acc" | "dim";
  holdAt?: number;
  hold?: number;
  done?: () => void;
}

interface Scene {
  w: number;
  h: number;
  wide: boolean;
  rail: number;
  nodes: N[];
  boxes: Box[];
  hub: number;
  gate: number;
}

export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FLEETS: number[][][] = [
  [
    [4, 3],
    [3, 4, 3],
    [3, 4],
  ],
  [
    [3, 4, 3],
    [4, 3],
    [3, 3, 4],
  ],
];

const ROOT_HARNESS: Harness[][] = [
  ["claude", "codex", "opencode"],
  ["pi", "gemini", "claude"],
];

const AMBIENT = 2;
export const ICON = 12;
const AMBIENT_WORKERS = 4;
const AMBIENT_LABEL = "ambient swarm a";

function build(w: number, h: number, labelW: number): Scene {
  const r = rng(7);
  const wide = w / h > 1.2;
  const nodes: N[] = [];
  const add = (n: Omit<N, "a" | "ring">) => nodes.push({ ...n, a: n.alive ? 1 : 0, ring: 0 }) - 1;
  const rail = w * 0.025;

  const hubPt = wide ? { x: w * 0.5, y: h * 0.15 } : { x: w * 0.5, y: h * 0.06 };
  const hub = add({ ...hubPt, kind: "hub", parent: -1, alive: true, machine: -1 });

  let boxes: Box[];
  if (wide) {
    const margin = w * 0.03;
    const gap = w * 0.02;
    const aw = Math.max(w * 0.14, labelW + 28);
    const mw = (w - 2 * margin - 2 * gap - aw) / 2;
    const y = h * 0.34;
    const bh = h * 0.62;
    boxes = [
      { x: margin, y, w: mw, h: bh, label: "machine a · account a" },
      { x: margin + mw + gap * 2 + aw, y, w: mw, h: bh, label: "machine b · account b" },
      { x: margin + mw + gap, y, w: aw, h: bh, label: AMBIENT_LABEL },
    ];
  } else {
    const x = w * 0.07;
    const bw = w * 0.86;
    boxes = [
      { x, y: h * 0.13, w: bw, h: h * 0.3, label: "machine a · account a" },
      { x, y: h * 0.67, w: bw, h: h * 0.3, label: "machine b · account b" },
      { x, y: h * 0.48, w: bw, h: h * 0.14, label: AMBIENT_LABEL },
    ];
  }

  const gatePt = wide ? { x: hubPt.x + (boxes[1].x + boxes[1].w / 2 - hubPt.x) * 0.5, y: hubPt.y } : { x: w - rail, y: hubPt.y };
  const gate = add({ ...gatePt, kind: "gate", parent: hub, alive: true, machine: -1 });

  boxes.slice(0, 2).forEach((box, m) => {
    const corner = wide ? { x: box.x + box.w / 2, y: box.y } : { x: m === 0 ? box.x : box.x + box.w, y: box.y };
    const broker = add({ ...corner, kind: "broker", parent: m === 0 ? hub : gate, alive: true, machine: m });
    const fleets = FLEETS[m];
    const slot = box.w / fleets.length;
    const top = box.y + box.h * (wide ? 0.24 : 0.3);
    const step = wide ? Math.min(box.h * 0.32, 84) : Math.min(box.h * 0.29, 54);
    fleets.forEach((subs, f) => {
      const fx = box.x + slot * f;
      const root = add({ x: fx + slot / 2, y: top, kind: "root", parent: broker, alive: true, machine: m, harness: ROOT_HARNESS[m][f] });
      const subSlot = (slot * 0.86) / subs.length;
      const sx0 = fx + slot * 0.07;
      subs.forEach((count, s) => {
        const sx = sx0 + subSlot * (s + 0.5);
        const sub = add({ x: sx, y: top + step, kind: "sub", parent: root, alive: true, machine: m });
        const gap = Math.min(subSlot / (count + 0.4), 14);
        for (let k = 0; k < count; k++) {
          const x = sx + (k - (count - 1) / 2) * gap;
          add({ x, y: top + step * 2, kind: "worker", parent: sub, alive: r() > 0.18, machine: m });
        }
      });
    });
  });

  const ab = boxes[AMBIENT];
  const atop = wide ? ab.y + ab.h * 0.24 : ab.y + ab.h * 0.42;
  const astep = wide ? Math.min(ab.h * 0.32, 84) : ab.h * 0.4;
  const root = add({ x: ab.x + ab.w / 2, y: atop, kind: "root", parent: hub, alive: true, machine: AMBIENT, harness: "codex" });
  const spacing = Math.min((ab.w * 0.8) / AMBIENT_WORKERS, 26);
  for (let k = 0; k < AMBIENT_WORKERS; k++) {
    add({ x: ab.x + ab.w / 2 + (k - (AMBIENT_WORKERS - 1) / 2) * spacing, y: atop + astep, kind: "worker", parent: root, alive: false, machine: AMBIENT });
  }

  return { w, h, wide, rail, nodes, boxes, hub, gate };
}

export function elbow(a: Pt, b: Pt): Pt[] {
  if (Math.abs(a.y - b.y) < 0.5) return [a, b];
  const mid = (a.y + b.y) / 2;
  return [a, { x: a.x, y: mid }, { x: b.x, y: mid }, b];
}

function link(scene: Scene, i: number): Pt[] {
  const n = scene.nodes[i];
  const p = scene.nodes[n.parent];
  if (!scene.wide && p.kind === "gate") return [p, { x: p.x, y: n.y }, n];
  if (!scene.wide && p.kind === "hub" && n.kind !== "gate") return [p, { x: scene.rail, y: p.y }, { x: scene.rail, y: n.y }, n];
  return elbow(p, n);
}

function ancestors(nodes: N[], i: number): number[] {
  const out = [i];
  while (nodes[out[out.length - 1]].parent >= 0) out.push(nodes[out[out.length - 1]].parent);
  return out;
}

function route(scene: Scene, from: number, to: number): Pt[] {
  const nodes = scene.nodes;
  const up = ancestors(nodes, from);
  const down = ancestors(nodes, to);
  const lca = up.find((n) => down.includes(n));
  if (lca === undefined) return [nodes[from], nodes[to]];
  const pts: Pt[] = [];
  const push = (seg: Pt[]) => {
    for (const p of seg) {
      const last = pts[pts.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) pts.push({ x: p.x, y: p.y });
    }
  };
  for (let k = 0; up[k] !== lca; k++) push(link(scene, up[k]).reverse());
  const tail = down.slice(0, down.indexOf(lca)).reverse();
  for (const n of tail) push(link(scene, n));
  return pts;
}

export function pulse(pts: Pt[], color: Pulse["color"], speed: number, extra: Partial<Pulse> = {}): Pulse {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, d: 0, speed, color, ...extra };
}

export function at(p: Pulse, d: number): Pt {
  const { pts, cum } = p;
  if (d <= 0) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (d <= cum[i]) {
      const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
  }
  return pts[pts.length - 1];
}

export interface Palette {
  fg: string;
  dim: string;
  faint: string;
  line: string;
  acc: string;
  bg: string;
  mono: string;
  h: Record<Harness, string>;
}

export function palette(el: HTMLElement): Palette {
  const s = getComputedStyle(el);
  const v = (name: string) => s.getPropertyValue(name).trim();
  const h = Object.fromEntries(HARNESSES.map((k) => [k, v(`--h-${k}`) || v("--fg")])) as Record<Harness, string>;
  return { fg: v("--fg"), dim: v("--dim"), faint: v("--faint"), line: v("--line"), acc: v("--acc"), bg: v("--surface"), mono: s.fontFamily, h };
}

export function Swarm({ status }: { status: React.RefObject<HTMLSpanElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const count = status;

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    let pal = palette(cv);
    let scene = build(1, 1, 0);
    let pulses: Pulse[] = [];
    let raf = 0;
    let last = 0;
    let visible = true;
    const timers = { local: 0, steer: 1.2, cross: 1.8, wake: 0.6, life: 0.8, count: 0 };
    const r = rng(42);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];

    const font = () => {
      ctx.font = `10px ${pal.mono}`;
      ctx.textBaseline = "middle";
      if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "1.4px";
    };

    const resize = () => {
      const rect = cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(rect.width * dpr);
      cv.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      font();
      scene = build(rect.width, rect.height, ctx.measureText(AMBIENT_LABEL.toUpperCase()).width);
      pulses = [];
      if (reduced.matches) seedStill();
      timers.count = 0;
      step(0);
      draw();
    };

    const of = (kind: Kind, alive?: boolean, machines: number[] = [0, 1]) =>
      scene.nodes
        .map((n, i) => [n, i] as const)
        .filter(([n]) => n.kind === kind && machines.includes(n.machine) && (alive === undefined || n.alive === alive))
        .map(([, i]) => i);

    const descendants = (root: number) => {
      const out: number[] = [];
      scene.nodes.forEach((n, i) => {
        if (n.kind === "worker" && n.alive && ancestors(scene.nodes, i).includes(root)) out.push(i);
      });
      return out;
    };

    const send = (from: number, to: number, color: Pulse["color"], speed: number, done?: () => void) => {
      const p = pulse(route(scene, from, to), color, speed, { done });
      const g = scene.nodes[scene.gate];
      const k = p.pts.findIndex((q) => q.x === g.x && q.y === g.y);
      if (k > 0) {
        p.holdAt = p.cum[k];
        p.hold = 0.5 + r() * 0.7;
      }
      pulses.push(p);
    };

    const spawnLocal = () => {
      const w = pick(of("worker", true));
      if (w !== undefined) send(w, scene.nodes[scene.nodes[w].parent].parent, "fg", 70);
    };

    const spawnSteer = () => {
      const root = pick(of("root"));
      const target = pick(descendants(root));
      if (target !== undefined) send(root, target, "acc", 80, () => (scene.nodes[target].ring = 1));
    };

    const spawnCross = () => {
      const a = pick(of("worker", true, [0]));
      const b = pick(of("root", true, [1]));
      if (a === undefined || b === undefined) return;
      const [from, to] = r() > 0.5 ? [a, b] : [b, a];
      send(from, to, "fg", 120);
    };

    const spawnWake = () => {
      const target = pick(of("worker", false, [AMBIENT]).filter((i) => scene.nodes[i].reply === undefined));
      const from = pick([...of("root"), ...of("worker", true)]);
      if (target === undefined || from === undefined) return;
      const n = scene.nodes[target];
      n.reply = from;
      send(from, target, "dim", 110, () => {
        n.alive = true;
        n.ring = 1;
        n.sleep = 1.6 + r() * 2.2;
      });
    };

    const tickAmbient = (dt: number) => {
      scene.nodes.forEach((n, i) => {
        if (n.machine !== AMBIENT || n.kind !== "worker" || !n.alive) return;
        n.sleep = (n.sleep ?? 0) - dt;
        if (n.sleep > 0) return;
        n.alive = false;
        send(i, n.reply ?? n.parent, "dim", 110, () => (n.reply = undefined));
      });
    };

    const life = () => {
      const alive = of("worker", true);
      const done = of("worker", false);
      if (r() < 0.5 && alive.length > done.length) {
        const w = pick(alive);
        const n = scene.nodes[w];
        send(w, n.parent, "fg", 60);
        n.alive = false;
      } else if (done.length) {
        const w = pick(done);
        const n = scene.nodes[w];
        send(n.parent, w, "fg", 60, () => (n.alive = true));
      }
    };

    const seedStill = () => {
      for (let i = 0; i < 4; i++) spawnLocal();
      spawnSteer();
      spawnCross();
      spawnWake();
      for (const p of pulses) {
        p.d = p.cum[p.cum.length - 1] * (0.35 + r() * 0.4);
        p.done = undefined;
        p.holdAt = undefined;
      }
    };

    const step = (dt: number) => {
      const every = (key: keyof typeof timers, period: number, fn: () => void) => {
        timers[key] -= dt;
        if (timers[key] <= 0) {
          timers[key] += period * (0.6 + r() * 0.8);
          fn();
        }
      };
      every("local", 0.42, spawnLocal);
      every("steer", 2.6, spawnSteer);
      every("cross", 2.8, spawnCross);
      every("wake", 1.5, spawnWake);
      every("life", 1.4, life);
      tickAmbient(dt);
      for (const n of scene.nodes) {
        const target = n.alive ? 1 : 0;
        n.a += (target - n.a) * Math.min(1, dt * 3);
        n.ring = Math.max(0, n.ring - dt * 1.3);
      }
      for (const p of pulses) {
        if (p.holdAt !== undefined && p.d >= p.holdAt && (p.hold ?? 0) > 0) {
          p.d = p.holdAt;
          p.hold! -= dt;
          scene.nodes[scene.gate].ring = 1;
          continue;
        }
        p.d += p.speed * dt;
      }
      pulses = pulses.filter((p) => {
        const end = p.cum[p.cum.length - 1];
        if (p.d < end) return true;
        p.done?.();
        return false;
      });
      timers.count -= dt;
      if (timers.count <= 0 && count.current) {
        timers.count = 1;
        const agents = scene.nodes.filter((n) => (n.kind === "worker" || n.kind === "root" || n.kind === "sub") && n.alive).length;
        count.current.textContent = `${agents} agents, 2 machines`;
      }
    };

    const square = (x: number, y: number, s: number) => ctx.fillRect(Math.round(x - s / 2), Math.round(y - s / 2), s, s);
    const hollow = (x: number, y: number, s: number) => ctx.strokeRect(Math.round(x - s / 2) + 0.5, Math.round(y - s / 2) + 0.5, s - 1, s - 1);
    const crisp = (v: number) => Math.round(v) + 0.5;

    const label = (text: string, x: number, y: number, align: CanvasTextAlign = "left", color = pal.dim) => {
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.fillText(text.toUpperCase(), x, y);
    };

    const draw = () => {
      const { w, h, wide, nodes, boxes } = scene;
      ctx.clearRect(0, 0, w, h);
      font();

      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      nodes.forEach((n, i) => {
        if (n.parent < 0) return;
        const pts = link(scene, i);
        ctx.moveTo(crisp(pts[0].x), crisp(pts[0].y));
        for (const p of pts.slice(1)) ctx.lineTo(crisp(p.x), crisp(p.y));
      });
      ctx.stroke();

      boxes.forEach((box, m) => {
        ctx.strokeStyle = pal.line;
        ctx.strokeRect(crisp(box.x), crisp(box.y), Math.round(box.w), Math.round(box.h));
        label(box.label, box.x + 12, box.y + 16);
        const alive = nodes.filter((n) => n.machine === m && n.kind !== "broker" && n.alive).length;
        const text = m === AMBIENT ? `${alive - 1} of ${AMBIENT_WORKERS} awake` : `${FLEETS[m].length} fleets, ${alive} agents`;
        if (m === AMBIENT && wide) label(text, box.x + 12, box.y + box.h - 16, "left", pal.faint);
        else if (wide) label(text, box.x + box.w - 12, box.y + box.h - 16, "right", pal.faint);
        else if (ctx.measureText(`${box.label}${text}`.toUpperCase()).width + 48 <= box.w) label(text, box.x + box.w - 12, box.y + 16, "right", pal.faint);
      });

      for (const n of nodes) {
        if (n.kind === "worker" || n.kind === "sub" || n.kind === "root") {
          const s = n.kind === "root" ? 7 : n.kind === "sub" ? 5 : 4;
          if (n.harness) {
            ctx.fillStyle = pal.bg;
            square(n.x, n.y, ICON + 4);
            drawHarness(ctx, n.harness, n.x, n.y, ICON, pal.h[n.harness]);
          } else {
            ctx.fillStyle = pal.faint;
            square(n.x, n.y, s);
            ctx.globalAlpha = n.a;
            ctx.fillStyle = pal.fg;
            square(n.x, n.y, s);
            ctx.globalAlpha = 1;
          }
          if (n.ring > 0) {
            ctx.strokeStyle = pal.acc;
            ctx.globalAlpha = n.ring;
            hollow(n.x, n.y, (n.harness ? ICON : s) + 6 + (1 - n.ring) * 4);
            ctx.globalAlpha = 1;
          }
        }
      }

      for (const n of nodes) {
        if (n.kind === "broker") {
          ctx.fillStyle = pal.bg;
          square(n.x, n.y, 11);
          ctx.strokeStyle = pal.fg;
          hollow(n.x, n.y, 11);
          ctx.fillStyle = pal.fg;
          square(n.x, n.y, 3);
          if (!wide && n.x > w / 2) label("broker", n.x - 12, n.y - 10, "right");
          else label("broker", n.x + 12, n.y - 10);
        }
      }

      const hub = nodes[scene.hub];
      ctx.fillStyle = pal.bg;
      square(hub.x, hub.y, 21);
      ctx.strokeStyle = pal.fg;
      hollow(hub.x, hub.y, 21);
      ctx.fillStyle = pal.fg;
      square(hub.x, hub.y, 11);
      label("hub", hub.x + 18, hub.y - 12);

      const gate = nodes[scene.gate];
      ctx.save();
      ctx.translate(Math.round(gate.x), Math.round(gate.y));
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = pal.bg;
      ctx.fillRect(-4.5, -4.5, 9, 9);
      ctx.strokeStyle = pal.fg;
      ctx.strokeRect(-4, -4, 8, 8);
      if (gate.ring > 0) {
        ctx.globalAlpha = Math.min(1, gate.ring * 1.5);
        ctx.fillStyle = pal.acc;
        ctx.fillRect(-2.5, -2.5, 5, 5);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      if (wide) {
        label("judge", gate.x, gate.y - 15, "center");
        label("contact", (hub.x + gate.x) / 2 + 6, hub.y + 12, "center", pal.faint);
      } else {
        label("judge", gate.x - 12, gate.y - 12, "right");
      }

      for (const p of pulses) {
        const head = at(p, p.d);
        const color = p.color === "acc" ? pal.acc : p.color === "dim" ? pal.dim : pal.fg;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        const trail = 22;
        const n = 6;
        for (let i = 0; i <= n; i++) {
          const q = at(p, Math.max(0, p.d - (trail * i) / n));
          if (i === 0) ctx.moveTo(q.x, q.y);
          else ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
        ctx.fillStyle = color;
        square(head.x, head.y, p.color === "dim" ? 2 : 3);
      }
    };

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000 || 0);
      last = now;
      step(dt);
      draw();
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      if (reduced.matches || !visible || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) start();
      else cancelAnimationFrame(raf);
    });
    io.observe(cv);
    const onScheme = () => {
      pal = palette(cv);
      draw();
    };
    const onVis = () => (document.hidden ? cancelAnimationFrame(raf) : start());
    const onMotion = () => {
      resize();
      start();
    };
    dark.addEventListener("change", onScheme);
    reduced.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onVis);
    if (document.fonts)
      document.fonts.ready.then(() => {
        pal = palette(cv);
        resize();
      });
    resize();
    start();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      dark.removeEventListener("change", onScheme);
      reduced.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return <canvas ref={canvas} className="swarm-canvas" aria-hidden="true" />;
}
