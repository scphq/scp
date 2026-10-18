"use client";

import { useEffect, useRef } from "react";

export type Pt = { x: number; y: number };
type Kind = "hub" | "broker" | "root" | "sub" | "worker" | "peer" | "gate";

interface N extends Pt {
  kind: Kind;
  parent: number;
  alive: boolean;
  a: number;
  ring: number;
  machine: number;
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

interface Mote {
  bx: number;
  by: number;
  r1: number;
  r2: number;
  w1: number;
  w2: number;
  p1: number;
  p2: number;
  c: number;
  big: boolean;
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
  peer: number;
  motes: Mote[];
  clusters: Pt[];
  peerMotes: Mote[];
  band: { x: number; y: number; w: number; h: number };
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

function build(w: number, h: number): Scene {
  const r = rng(7);
  const wide = w / h > 1.2;
  const nodes: N[] = [];
  const add = (n: Omit<N, "a" | "ring">) => nodes.push({ ...n, a: n.alive ? 1 : 0, ring: 0 }) - 1;

  const hubPt = wide ? { x: w * 0.5, y: h * 0.4 } : { x: w * 0.5, y: h * 0.255 };
  const hub = add({ ...hubPt, kind: "hub", parent: -1, alive: true, machine: -1 });

  const boxes: Box[] = wide
    ? [
        { x: w * 0.035, y: h * 0.53, w: w * 0.445, h: h * 0.43, label: "machine a" },
        { x: w * 0.52, y: h * 0.53, w: w * 0.445, h: h * 0.43, label: "machine b" },
      ]
    : [
        { x: w * 0.07, y: h * 0.335, w: w * 0.9, h: h * 0.3, label: "machine a" },
        { x: w * 0.07, y: h * 0.675, w: w * 0.9, h: h * 0.3, label: "machine b" },
      ];

  boxes.forEach((box, m) => {
    const broker = add({ x: wide ? box.x + box.w / 2 : box.x, y: box.y, kind: "broker", parent: hub, alive: true, machine: m });
    const fleets = FLEETS[m];
    const slot = box.w / fleets.length;
    const top = box.y + box.h * 0.3;
    const step = Math.min(box.h * 0.29, 54);
    fleets.forEach((subs, f) => {
      const fx = box.x + slot * f;
      const root = add({ x: fx + slot / 2, y: top, kind: "root", parent: broker, alive: true, machine: m });
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

  const peerPt = wide ? { x: w * 0.965, y: hubPt.y } : { x: w * 0.93, y: hubPt.y };
  const gatePt = { x: hubPt.x + (peerPt.x - hubPt.x) * 0.55, y: hubPt.y };
  const gate = add({ ...gatePt, kind: "gate", parent: hub, alive: true, machine: -1 });
  const peer = add({ ...peerPt, kind: "peer", parent: gate, alive: true, machine: -1 });

  const band = wide ? { x: w * 0.08, y: h * 0.05, w: w * 0.84, h: h * 0.25 } : { x: w * 0.06, y: h * 0.035, w: w * 0.88, h: h * 0.165 };
  const clusterCount = wide ? 7 : 4;
  const clusters: Pt[] = [];
  for (let c = 0; c < clusterCount; c++) {
    clusters.push({
      x: band.x + band.w * ((c + 0.5) / clusterCount) + (r() - 0.5) * band.w * 0.06,
      y: band.y + band.h * (0.3 + r() * 0.45),
    });
  }
  const motes: Mote[] = [];
  const total = wide ? 560 : 230;
  const gauss = () => (r() + r() + r() - 1.5) / 1.5;
  for (let i = 0; i < total; i++) {
    const c = i % clusterCount;
    const spreadX = (band.w / clusterCount) * 0.55;
    const spreadY = band.h * 0.42;
    motes.push({
      bx: clusters[c].x + gauss() * spreadX,
      by: clusters[c].y + gauss() * spreadY,
      r1: 3 + r() * 9,
      r2: 2 + r() * 5,
      w1: 0.12 + r() * 0.3,
      w2: 0.12 + r() * 0.3,
      p1: r() * 6.28,
      p2: r() * 6.28,
      c,
      big: i < clusterCount,
    });
  }
  for (let c = 0; c < clusterCount; c++) {
    motes[c].bx = clusters[c].x;
    motes[c].by = clusters[c].y;
    motes[c].r1 = 1.5;
    motes[c].r2 = 1;
  }
  const peerMotes: Mote[] = [];
  for (let i = 0; i < (wide ? 40 : 18); i++) {
    peerMotes.push({
      bx: peerPt.x + gauss() * (wide ? 14 : 9),
      by: peerPt.y - 20 - Math.abs(gauss()) * (wide ? 44 : 22),
      r1: 1 + r() * 3,
      r2: 1 + r() * 3,
      w1: 0.1 + r() * 0.2,
      w2: 0.1 + r() * 0.2,
      p1: r() * 6.28,
      p2: r() * 6.28,
      c: -1,
      big: false,
    });
  }

  return { w, h, wide, rail: w * 0.025, nodes, boxes, hub, gate, peer, motes, clusters, peerMotes, band };
}

export function elbow(a: Pt, b: Pt): Pt[] {
  if (Math.abs(a.y - b.y) < 0.5) return [a, b];
  const mid = (a.y + b.y) / 2;
  return [a, { x: a.x, y: mid }, { x: b.x, y: mid }, b];
}

function link(scene: Scene, i: number): Pt[] {
  const n = scene.nodes[i];
  const p = scene.nodes[n.parent];
  if (!scene.wide && n.kind === "broker") return [p, { x: scene.rail, y: p.y }, { x: scene.rail, y: n.y }, n];
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

function motePos(m: Mote, t: number): Pt {
  const drift = m.c >= 0 ? Math.sin(t * 0.05 + m.c * 1.7) * 14 : 0;
  return { x: m.bx + drift + Math.sin(t * m.w1 + m.p1) * m.r1, y: m.by + Math.cos(t * m.w2 + m.p2) * m.r2 };
}

export interface Palette {
  fg: string;
  dim: string;
  faint: string;
  line: string;
  acc: string;
  bg: string;
  mono: string;
}

export function palette(el: HTMLElement): Palette {
  const s = getComputedStyle(el);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return { fg: v("--fg"), dim: v("--dim"), faint: v("--faint"), line: v("--line"), acc: v("--acc"), bg: v("--surface"), mono: s.fontFamily };
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
    let scene = build(1, 1);
    let pulses: Pulse[] = [];
    let raf = 0;
    let last = 0;
    let t = 0;
    let visible = true;
    const timers = { local: 0, steer: 1.2, cross: 1.8, ambient: 0.4, contact: 3.5, life: 0.8, count: 0 };
    const r = rng(42);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];

    const resize = () => {
      const rect = cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(rect.width * dpr);
      cv.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene = build(rect.width, rect.height);
      pulses = [];
      if (reduced.matches) seedStill();
      timers.count = 0;
      step(0);
      draw();
    };

    const of = (kind: Kind, alive?: boolean) =>
      scene.nodes
        .map((n, i) => [n, i] as const)
        .filter(([n]) => n.kind === kind && (alive === undefined || n.alive === alive))
        .map(([, i]) => i);

    const descendants = (root: number) => {
      const out: number[] = [];
      scene.nodes.forEach((n, i) => {
        if (n.kind === "worker" && n.alive && ancestors(scene.nodes, i).includes(root)) out.push(i);
      });
      return out;
    };

    const spawnLocal = () => {
      const w = pick(of("worker", true));
      if (w !== undefined) pulses.push(pulse(route(scene, w, scene.nodes[scene.nodes[w].parent].parent), "fg", 70));
    };

    const spawnSteer = () => {
      const root = pick(of("root"));
      const target = pick(descendants(root));
      if (target === undefined) return;
      pulses.push(
        pulse(route(scene, root, target), "acc", 80, {
          done: () => (scene.nodes[target].ring = 1),
        }),
      );
    };

    const spawnCross = () => {
      const a = pick(of("worker", true).filter((i) => scene.nodes[i].machine === 0));
      const b = pick(of("root").filter((i) => scene.nodes[i].machine === 1));
      if (a === undefined || b === undefined) return;
      const [from, to] = r() > 0.5 ? [a, b] : [b, a];
      pulses.push(pulse(route(scene, from, to), "fg", 120));
    };

    const spawnAmbient = () => {
      const m = pick(scene.motes);
      const from = motePos(m, t);
      const hub = scene.nodes[scene.hub];
      if (r() < 0.55) {
        pulses.push(pulse([from, hub], "dim", 90));
      } else {
        const root = pick(of("root"));
        pulses.push(pulse([from, ...route(scene, scene.hub, root)], "dim", 120));
      }
    };

    const spawnContact = () => {
      const { nodes, hub, gate, peer } = scene;
      const out = r() > 0.4;
      const pts = out ? [nodes[hub], nodes[gate], nodes[peer]] : [nodes[peer], nodes[gate], nodes[hub]];
      const p = pulse(pts, "fg", 90);
      p.holdAt = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      p.hold = 0.5 + r() * 0.7;
      pulses.push(p);
    };

    const life = () => {
      const alive = of("worker", true);
      const done = of("worker", false);
      if (r() < 0.5 && alive.length > done.length) {
        const w = pick(alive);
        const n = scene.nodes[w];
        pulses.push(pulse(route(scene, w, n.parent), "fg", 60));
        n.alive = false;
      } else if (done.length) {
        const w = pick(done);
        const n = scene.nodes[w];
        pulses.push(pulse(route(scene, n.parent, w), "fg", 60, { done: () => (n.alive = true) }));
      }
    };

    const seedStill = () => {
      t = 12;
      for (let i = 0; i < 4; i++) spawnLocal();
      spawnSteer();
      spawnCross();
      spawnAmbient();
      spawnAmbient();
      spawnContact();
      for (const p of pulses) {
        p.d = p.cum[p.cum.length - 1] * (0.35 + r() * 0.4);
        p.done = undefined;
        p.holdAt = undefined;
      }
    };

    const step = (dt: number) => {
      t += dt;
      const every = (key: keyof typeof timers, period: number, fn: () => void) => {
        timers[key] -= dt;
        if (timers[key] <= 0) {
          timers[key] += period * (0.6 + r() * 0.8);
          fn();
        }
      };
      every("local", 0.42, spawnLocal);
      every("steer", 2.6, spawnSteer);
      every("cross", 3.2, spawnCross);
      every("ambient", 0.5, spawnAmbient);
      every("contact", 5.5, spawnContact);
      every("life", 1.4, life);
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
        count.current.textContent = `${agents + scene.motes.length} agents, 2 machines`;
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
      const { w, h, nodes, boxes } = scene;
      ctx.clearRect(0, 0, w, h);
      ctx.font = `10px ${pal.mono}`;
      ctx.textBaseline = "middle";
      if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "1.4px";

      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      nodes.forEach((n, i) => {
        if (n.parent < 0 || n.kind === "gate" || n.kind === "peer") return;
        const pts = link(scene, i);
        ctx.moveTo(crisp(pts[0].x), crisp(pts[0].y));
        for (const p of pts.slice(1)) ctx.lineTo(crisp(p.x), crisp(p.y));
      });
      const hub = nodes[scene.hub];
      const peer = nodes[scene.peer];
      ctx.moveTo(hub.x, crisp(hub.y));
      ctx.lineTo(peer.x, crisp(peer.y));
      ctx.stroke();

      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(crisp(hub.x), hub.y);
      ctx.lineTo(crisp(hub.x), scene.band.y + scene.band.h);
      ctx.stroke();
      ctx.setLineDash([]);

      for (const box of boxes) {
        ctx.strokeStyle = pal.line;
        ctx.strokeRect(crisp(box.x), crisp(box.y), Math.round(box.w), Math.round(box.h));
        label(box.label, box.x + 12, box.y + 16);
        const m = boxes.indexOf(box);
        const fleets = FLEETS[m].length;
        const alive = nodes.filter((n) => n.machine === m && n.alive && (n.kind === "worker" || n.kind === "sub" || n.kind === "root")).length;
        label(`${fleets} fleets, ${alive} agents`, box.x + box.w - 12, box.y + 16, "right", pal.faint);
      }

      ctx.strokeStyle = pal.line;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      scene.motes.forEach((m, i) => {
        if (m.big || i % 5 !== 0) return;
        const lead = motePos(scene.motes[m.c], t);
        const p = motePos(m, t);
        ctx.moveTo(lead.x, lead.y);
        ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
      for (const m of scene.motes) {
        const p = motePos(m, t);
        ctx.fillStyle = m.big ? pal.dim : pal.faint;
        square(p.x, p.y, m.big ? 3 : 2);
      }
      for (const m of scene.peerMotes) {
        const p = motePos(m, t);
        ctx.fillStyle = pal.faint;
        square(p.x, p.y, 2);
      }
      label("ambient swarm", scene.band.x, scene.band.y - 2);

      for (const n of nodes) {
        if (n.kind === "worker" || n.kind === "sub" || n.kind === "root") {
          const s = n.kind === "root" ? 7 : n.kind === "sub" ? 5 : 4;
          ctx.fillStyle = pal.faint;
          square(n.x, n.y, s);
          ctx.globalAlpha = n.a;
          ctx.fillStyle = pal.fg;
          square(n.x, n.y, s);
          ctx.globalAlpha = 1;
          if (n.ring > 0) {
            ctx.strokeStyle = pal.acc;
            ctx.globalAlpha = n.ring;
            hollow(n.x, n.y, s + 6 + (1 - n.ring) * 4);
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
          label("broker", n.x + 12, n.y - 10);
        }
      }

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
      label("judge", gate.x, gate.y - 15, "center");
      if (scene.wide) label("contact", (hub.x + gate.x) / 2 + 6, hub.y + 12, "center", pal.faint);

      ctx.fillStyle = pal.bg;
      square(peer.x, peer.y, 13);
      ctx.strokeStyle = pal.fg;
      hollow(peer.x, peer.y, 13);
      label("another account", peer.x + 6, peer.y + 18, "right");

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
    if (document.fonts) document.fonts.ready.then(onScheme);
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
