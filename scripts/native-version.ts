import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const nativeRoot = resolve(import.meta.dir, "..");
export const nativeKeys = ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu", "linux-x64-musl"] as const;
export const nativeNames = nativeKeys.map((key) => `@scp-dev/native-${key}`);
const manifestPath = (root: string) => resolve(root, "packages/cli/package.json");
const manifest = (root: string) => JSON.parse(readFileSync(manifestPath(root), "utf8"));
export function nativeVersion(root = nativeRoot): string {
  const version = manifest(root).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Expected CLI semver version");
  return version;
}
export function checkVersion(root = nativeRoot): void {
  const deps = manifest(root).optionalDependencies ?? {};
  const expected = Object.fromEntries(nativeNames.map((name) => [name, nativeVersion(root)]));
  if (JSON.stringify(Object.entries(deps).sort()) !== JSON.stringify(Object.entries(expected).sort()))
    throw new Error("Native optionalDependencies disagree with CLI version: run bun scripts/native-version.ts sync");
}
export function syncVersion(root = nativeRoot): string {
  const cli = manifest(root);
  cli.optionalDependencies = Object.fromEntries(nativeNames.map((name) => [name, nativeVersion(root)]));
  writeFileSync(manifestPath(root), `${JSON.stringify(cli, null, 2)}\n`);
  checkVersion(root);
  return cli.version;
}
if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (rest.length) throw new Error("Usage: bun scripts/native-version.ts [sync | check]");
  if (command === "sync") console.log(syncVersion());
  else if (command === "check" || command === "--check") checkVersion();
  else if (!command) console.log(nativeVersion());
  else throw new Error("Usage: bun scripts/native-version.ts [sync | check]");
}
