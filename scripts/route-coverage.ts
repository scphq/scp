// Checks a SCP_ROUTE_LOG: every verb the native swarm registers ran natively at least once, and nothing stayed on TypeScript but what a test forced.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [log, bin] = process.argv.slice(2);
if (!log || !bin) throw new Error("usage: bun scripts/route-coverage.ts <route log> <swarm>");
const registry = JSON.parse(spawnSync(bin, ["__verbs", "--json"], { encoding: "utf8" }).stdout) as { verbs: string[] };
const lines = readFileSync(log, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split(" "));
const counts = new Map<string, number>();
for (const [verb, engine, reason] of lines) counts.set(`${verb} ${engine} ${reason}`, (counts.get(`${verb} ${engine} ${reason}`) ?? 0) + 1);
for (const [key, count] of [...counts].sort()) console.log(`${String(count).padStart(6)} ${key}`);
const unrouted = registry.verbs.filter((verb) => !lines.some(([v, engine]) => v === verb && engine === "native"));
const declines = lines.filter(([, engine, reason]) => engine === "ts" && reason !== "forced");
if (unrouted.length) console.error(`never routed native: ${unrouted.join(", ")}`);
if (declines.length) console.error(`${declines.length} commands stayed on TypeScript unforced`);
if (unrouted.length || declines.length) process.exit(1);
