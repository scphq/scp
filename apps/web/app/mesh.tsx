"use client";

import { useEffect, useRef } from "react";
import { drawHarness, type Harness } from "./harnesses";
import { at, elbow, ICON, judge, type Palette, type Pt, type Pulse, palette, pulse, rng } from "./swarm";

type Kind = "broker" | "judge" | "root" | "sub" | "worker";

interface N extends Pt {
  kind: Kind;
  parent: number;
  alive: boolean;
  a: number;
  ring: number;
  machine: number;
  harness?: Harness;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

interface Wire {
  a: number;
  b: number;
  pts: Pt[];
}

interface Scene {
  w: number;
  h: number;
  wide: boolean;
  nodes: N[];
  boxes: Box[];
  brokers: number[];
  judges: number[];
  wires: Wire[];
  top: number;
}

const FLEETS: number[][][] = [
  [
    [3, 4],
    [4, 3],
  ],
  [
    [4, 3],
    [3, 3, 3],
  ],
  [
    [3, 3],
    [4, 3],
  ],
  [
    [4, 3, 3],
    [3, 4],
  ],
];

const ROOT_HARNESS: Harness[][] = [
  ["claude", "codex"],
  ["pi", "agy"],
  ["grok", "muse"],
  ["codex", "opencode"],
];

/** every pair of machines, with the lane each direct link runs in; only the two middle links cross */
const LINKS: [number, number, number][] = [
  [0, 1, 0],
  [1, 2, 0],
  [2, 3, 0],
  [0, 2, 1],
  [1, 3, 2],
  [0, 3, 3],
];

function build(w: number, h: number): Scene {
  const r = rng(11);
  const wide = w / h > 1.2;
  const nodes: N[] = [];
  const add = (n: Omit<N, "a" | "ring">) => nodes.push({ ...n, a: n.alive ? 1 : 0, ring: 0 }) - 1;
  const at2 = (u: number, v: number): Pt => (wide ? { x: u, y: v } : { x: v, y: u });

  const count = FLEETS.length;
  const span = wide ? w : h;
  const gap = span * (wide ? 0.025 : 0.04);
  const start = span * 0.035;
  const size = (span * 0.93 - gap * (count - 1)) / count;
  const edge = wide ? h * 0.44 : w * 0.2;
  const lanes = wide ? [h * 0.36, h * 0.27, h * 0.185, h * 0.1] : [w * 0.155, w * 0.115, w * 0.075, w * 0.035];

  const boxes: Box[] = FLEETS.map((_, m) => {
    const u = start + (size + gap) * m;
    const label = `machine ${String.fromCharCode(97 + m)}`;
    return wide ? { x: u, y: edge, w: size, h: h * 0.52, label } : { x: edge, y: u, w: w * 0.77, h: size, label };
  });

  const judges: number[] = [];
  const brokers = boxes.map((box, m) => {
    const broker = add({ ...(wide ? { x: box.x + box.w / 2, y: box.y } : { x: box.x, y: box.y }), kind: "broker", parent: -1, alive: true, machine: m });
    const gate = add({
      ...(wide ? { x: box.x + box.w / 2, y: box.y + box.h * 0.16 } : { x: box.x + 22, y: box.y + box.h * 0.27 }),
      kind: "judge",
      parent: broker,
      alive: true,
      machine: m,
    });
    judges.push(gate);
    const fleets = FLEETS[m];
    const slot = box.w / fleets.length;
    const top = box.y + box.h * (wide ? 0.34 : 0.48);
    const step = Math.min(box.h * (wide ? 0.27 : 0.21), 54);
    fleets.forEach((subs, f) => {
      const fx = box.x + slot * f;
      const root = add({ x: fx + slot / 2, y: top, kind: "root", parent: gate, alive: true, machine: m, harness: ROOT_HARNESS[m][f] });
      const subSlot = (slot * 0.86) / subs.length;
      const sx0 = fx + slot * 0.07;
      subs.forEach((n, s) => {
        const sx = sx0 + subSlot * (s + 0.5);
        const sub = add({ x: sx, y: top + step, kind: "sub", parent: root, alive: true, machine: m });
        const spacing = Math.min(subSlot / (n + 0.4), 14);
        for (let k = 0; k < n; k++) {
          add({ x: sx + (k - (n - 1) / 2) * spacing, y: top + step * 2, kind: "worker", parent: sub, alive: r() > 0.18, machine: m });
        }
      });
    });
    return broker;
  });

  const offsets = new Map<string, number>();
  brokers.forEach((_, i) => {
    const mine = LINKS.filter(([a, b]) => a === i || b === i);
    const left = mine.filter(([a, b]) => Math.min(a, b) < i).sort((x, y) => x[2] - y[2]);
    const right = mine.filter(([a, b]) => Math.max(a, b) > i).sort((x, y) => y[2] - x[2]);
    const all = [...left, ...right];
    all.forEach(([a, b], k) => {
      offsets.set(`${i}:${a}-${b}`, (k - (all.length - 1) / 2) * 4);
    });
  });

  const uOf = (m: number) => (wide ? nodes[brokers[m]].x : nodes[brokers[m]].y);
  const wires = LINKS.map(([a, b, lane]) => {
    const ua = uOf(a) + offsets.get(`${a}:${a}-${b}`)!;
    const ub = uOf(b) + offsets.get(`${b}:${a}-${b}`)!;
    const v = lanes[lane];
    return { a, b, pts: [nodes[brokers[a]], at2(ua, edge), at2(ua, v), at2(ub, v), at2(ub, edge), nodes[brokers[b]]] };
  });

  return { w, h, wide, nodes, boxes, brokers, judges, wires, top: lanes[lanes.length - 1] };
}

function link(nodes: N[], i: number): Pt[] {
  const n = nodes[i];
  const p = nodes[n.parent];
  if (n.kind === "judge" && p.x !== n.x) return [p, { x: p.x, y: n.y }, n];
  return elbow(p, n);
}

function ancestors(nodes: N[], i: number): number[] {
  const out = [i];
  while (nodes[out[out.length - 1]].parent >= 0) out.push(nodes[out[out.length - 1]].parent);
  return out;
}

/** the path from one node to another in the same machine's tree */
function within(nodes: N[], from: number, to: number): Pt[] {
  const seg = (i: number) => link(nodes, i);
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
  for (let k = 0; up[k] !== lca; k++) push(seg(up[k]).reverse());
  for (const n of down.slice(0, down.indexOf(lca)).reverse()) push(seg(n));
  return pts;
}

export function Mesh({ status }: { status: React.RefObject<HTMLSpanElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    let pal: Palette = palette(cv);
    let scene = build(1, 1);
    let pulses: Pulse[] = [];
    let raf = 0;
    let last = 0;
    let visible = true;
    const timers = { local: 0, steer: 1.2, cross: 0.6, records: 0.3, handshake: 2.5, life: 0.8, count: 0 };
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

    const of = (kind: Kind, alive?: boolean, machine?: number) =>
      scene.nodes
        .map((n, i) => [n, i] as const)
        .filter(([n]) => n.kind === kind && (alive === undefined || n.alive === alive) && (machine === undefined || n.machine === machine))
        .map(([, i]) => i);

    const wireBetween = (a: number, b: number): Pt[] => {
      const wire = scene.wires.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a))!;
      return wire.a === a ? wire.pts : [...wire.pts].reverse();
    };

    const spawnLocal = () => {
      const w = pick(of("worker", true));
      if (w !== undefined) pulses.push(pulse(within(scene.nodes, w, scene.nodes[scene.nodes[w].parent].parent), "fg", 70));
    };

    const spawnSteer = () => {
      const root = pick(of("root"));
      const target = pick(of("worker", true).filter((i) => ancestors(scene.nodes, i).includes(root)));
      if (target === undefined) return;
      pulses.push(pulse(within(scene.nodes, root, target), "acc", 80, { done: () => (scene.nodes[target].ring = 1) }));
    };

    const spawnCross = () => {
      const ma = Math.floor(r() * scene.boxes.length);
      const mb = (ma + 1 + Math.floor(r() * (scene.boxes.length - 1))) % scene.boxes.length;
      const from = pick([...of("worker", true, ma), ...of("root", undefined, ma)]);
      const to = pick(of("root", undefined, mb));
      if (from === undefined || to === undefined) return;
      const out = within(scene.nodes, from, scene.brokers[ma]);
      const wire = wireBetween(ma, mb).slice(1);
      const inbound = within(scene.nodes, scene.brokers[mb], to).slice(1);
      const p = pulse([...out, ...wire, ...inbound], "fg", 150);
      p.holdAt = p.cum[out.length + wire.length];
      p.hold = 0.35 + r() * 0.5;
      p.gate = scene.judges[mb];
      pulses.push(p);
    };

    const spawnRecords = () => {
      const wire = pick(scene.wires);
      pulses.push(pulse(r() > 0.5 ? wire.pts : [...wire.pts].reverse(), "dim", 110));
    };

    const spawnHandshake = () => {
      const wire = pick(scene.wires);
      const ring = (m: number) => () => (scene.nodes[scene.brokers[m]].ring = 1);
      pulses.push(pulse(wire.pts, "acc", 130, { done: ring(wire.b) }));
      pulses.push(pulse([...wire.pts].reverse(), "acc", 130, { done: ring(wire.a) }));
    };

    const life = () => {
      const alive = of("worker", true);
      const done = of("worker", false);
      if (r() < 0.5 && alive.length > done.length) {
        const w = pick(alive);
        const n = scene.nodes[w];
        pulses.push(pulse(within(scene.nodes, w, n.parent), "fg", 60));
        n.alive = false;
      } else if (done.length) {
        const w = pick(done);
        const n = scene.nodes[w];
        pulses.push(pulse(within(scene.nodes, n.parent, w), "fg", 60, { done: () => (n.alive = true) }));
      }
    };

    const seedStill = () => {
      for (let i = 0; i < 4; i++) spawnLocal();
      spawnSteer();
      spawnCross();
      spawnCross();
      spawnRecords();
      spawnHandshake();
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
      every("cross", 1.1, spawnCross);
      every("records", 0.7, spawnRecords);
      every("handshake", 4.5, spawnHandshake);
      every("life", 1.4, life);
      for (const n of scene.nodes) {
        n.a += ((n.alive ? 1 : 0) - n.a) * Math.min(1, dt * 3);
        n.ring = Math.max(0, n.ring - dt * 1.3);
      }
      for (const p of pulses) {
        if (p.holdAt !== undefined && p.d >= p.holdAt && (p.hold ?? 0) > 0) {
          p.d = p.holdAt;
          p.hold! -= dt;
          if (p.gate !== undefined) scene.nodes[p.gate].ring = 1;
          continue;
        }
        p.d += p.speed * dt;
      }
      pulses = pulses.filter((p) => {
        if (p.d < p.cum[p.cum.length - 1]) return true;
        p.done?.();
        return false;
      });
      timers.count -= dt;
      if (timers.count <= 0 && status.current) {
        timers.count = 1;
        const agents = scene.nodes.filter((n) => n.kind !== "broker" && n.kind !== "judge" && n.alive).length;
        status.current.textContent = `${agents} agents, ${scene.boxes.length} machines`;
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

    const line = (pts: Pt[]) => {
      ctx.moveTo(crisp(pts[0].x), crisp(pts[0].y));
      for (const p of pts.slice(1)) ctx.lineTo(crisp(p.x), crisp(p.y));
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
        if (n.parent >= 0) line(link(nodes, i));
      });
      for (const wire of scene.wires) line(wire.pts.slice(1, -1));
      ctx.stroke();

      if (scene.wide) label("no central hub, every machine is its own", w / 2, scene.top - 14, "center");

      boxes.forEach((box, m) => {
        ctx.strokeStyle = pal.line;
        ctx.strokeRect(crisp(box.x), crisp(box.y), Math.round(box.w), Math.round(box.h));
        label(box.label, box.x + 12, box.y + 16);
        label("own hub", box.x + box.w - 12, box.y + 16, "right");
        const alive = nodes.filter((n) => n.machine === m && n.alive && n.kind !== "broker" && n.kind !== "judge").length;
        const text = `${FLEETS[m].length} fleets, ${alive} agents`;
        if (scene.wide) label(text, box.x + box.w - 12, box.y + box.h - 16, "right", pal.faint);
        else label(text, box.x + box.w - 12, nodes[scene.judges[m]].y, "right", pal.faint);
      });

      for (const n of nodes) {
        if (n.kind === "broker" || n.kind === "judge") continue;
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
          hollow(n.x, n.y, s + 6 + (1 - n.ring) * 4);
          ctx.globalAlpha = 1;
        }
      }

      for (const i of scene.brokers) {
        const n = nodes[i];
        ctx.fillStyle = pal.bg;
        square(n.x, n.y, 13);
        ctx.strokeStyle = pal.fg;
        hollow(n.x, n.y, 13);
        ctx.fillStyle = pal.fg;
        square(n.x, n.y, 5);
        if (n.ring > 0) {
          ctx.strokeStyle = pal.acc;
          ctx.globalAlpha = n.ring;
          hollow(n.x, n.y, 19 + (1 - n.ring) * 6);
          ctx.globalAlpha = 1;
        }
        label("broker", n.x + 12, n.y - 10);
      }

      for (const i of scene.judges) {
        const n = nodes[i];
        judge(ctx, n, pal);
        label("judge", n.x + 12, n.y);
      }

      for (const p of pulses) {
        const head = at(p, p.d);
        const color = p.color === "acc" ? pal.acc : p.color === "dim" ? pal.dim : pal.fg;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        for (let i = 0; i <= 6; i++) {
          const q = at(p, Math.max(0, p.d - (22 * i) / 6));
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
  }, [status]);

  return <canvas ref={canvas} className="swarm-canvas mesh-canvas" aria-hidden="true" />;
}
