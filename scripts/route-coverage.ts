// Checks a SCP_ROUTE_LOG: every verb the native swarm registers ran natively at least once, and no verb fell back over a version mismatch.
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
const version = lines.filter(([, , reason]) => reason === "version");
if (unrouted.length) console.error(`never routed native: ${unrouted.join(", ")}`);
if (version.length) console.error(`${version.length} version declines: the native swarm and the CLI disagree on the version`);
if (unrouted.length || version.length) process.exit(1);
