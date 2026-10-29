import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const relayRoot = resolve(import.meta.dir, "..");
export const relayAnchor = "crates/package.json";
export const relayCrates = ["scp-dev-core", "scp-relay-server", "scp-relay-store"] as const;
const pins = [
  ["crates/scp-relay/Cargo.toml", "scp-relay-store"],
  ["crates/scp-relay/Cargo.toml", "scp-core"],
  ["crates/scp-relay-store/Cargo.toml", "scp-core"],
] as const;
const pinEntry = (dep: string) => new RegExp(`^(${dep} = .*version = ")([^"]+)`, "m");
export const platformKeys = ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu", "linux-x64-musl", "win32-x64"] as const;
const semver = /^\d+\.\d+\.\d+$/;
const read = (root: string, path: string) => readFileSync(resolve(root, path), "utf8");
const json = (root: string, path: string) => JSON.parse(read(root, path));
const write = (root: string, path: string, text: string) => writeFileSync(resolve(root, path), text);
const lockEntry = (name: string) => new RegExp(`(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")([^"]+)`);

export function relayVersion(root = relayRoot): string {
  const version = json(root, relayAnchor).version;
  if (typeof version !== "string" || !semver.test(version)) throw new Error(`Expected ${relayAnchor} version X.Y.Z`);
  return version;
}
export function checkVersion(root = relayRoot): void {
  const version = relayVersion(root);
  const workspace = read(root, "crates/Cargo.toml")
    .match(/\[workspace\.package\]([\s\S]*?)(?=\n\[|$)/)?.[1]
    .match(/^version = "([^"]+)"/m)?.[1];
  const lock = read(root, "crates/Cargo.lock");
  const wrapper = json(root, "crates/npm/relay-server/package.json");
  const dashboard = json(root, "packages/dashboard/package.json");
  if (
    workspace !== version ||
    pins.some(([path, dep]) => read(root, path).match(pinEntry(dep))?.[2] !== `=${version}`) ||
    relayCrates.some((name) => lock.match(lockEntry(name))?.[2] !== version) ||
    wrapper.version !== version ||
    dashboard.version !== version
  )
    throw new Error(`Relay versions disagree with ${relayAnchor}: run bun scripts/relay-version.ts sync && bun install --lockfile-only`);
  const expected = Object.fromEntries(platformKeys.map((key) => [`@scp-dev/relay-server-${key}`, version]));
  if (JSON.stringify(Object.entries(wrapper.optionalDependencies).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
    throw new Error(`Relay optionalDependencies disagree with ${relayAnchor}`);
  }
}
export function syncVersion(root = relayRoot): string {
  const version = relayVersion(root);
  const cargo = read(root, "crates/Cargo.toml");
  write(root, "crates/Cargo.toml", cargo.replace(/(\[workspace\.package\][\s\S]*?^version = ")[^"]+/m, `$1${version}`));
  for (const [path, dep] of pins) write(root, path, read(root, path).replace(pinEntry(dep), `$1=${version}`));
  const lock = relayCrates.reduce((text, name) => text.replace(lockEntry(name), `$1${version}`), read(root, "crates/Cargo.lock"));
  write(root, "crates/Cargo.lock", lock);
  const wrapper = json(root, "crates/npm/relay-server/package.json");
  wrapper.version = version;
  wrapper.optionalDependencies = Object.fromEntries(platformKeys.map((key) => [`@scp-dev/relay-server-${key}`, version]));
  write(root, "crates/npm/relay-server/package.json", `${JSON.stringify(wrapper, null, 2)}\n`);
  const dashboard = json(root, "packages/dashboard/package.json");
  dashboard.version = version;
  write(root, "packages/dashboard/package.json", `${JSON.stringify(dashboard, null, 2)}\n`);
  checkVersion(root);
  return version;
}
if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const usage = "Usage: bun scripts/relay-version.ts [--check | sync]";
  if (rest.length) throw new Error(usage);
  if (!command) console.log(relayVersion());
  else if (command === "--check") checkVersion();
  else if (command === "sync") console.log(syncVersion());
  else throw new Error(usage);
}
