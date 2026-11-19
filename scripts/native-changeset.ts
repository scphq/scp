import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const nativeCrates = ["swarm", "scp-broker", "scp-cli", "scp-core", "scp-hook", "scp-mcp"] as const;

export type Change = { status: string; path: string };

export function nativeChanges(changes: Change[]): string[] {
  return changes
    .map((change) => change.path)
    .filter((path) =>
      nativeCrates.some((crate) => path.startsWith(`crates/${crate}/src/`) || path === `crates/${crate}/Cargo.toml` || path === `crates/${crate}/build.rs`),
    );
}

export function cliBumpers(manifests: { name: string; dependencies?: Record<string, string> }[]): Set<string> {
  const deps = new Map(manifests.map((m) => [m.name, Object.keys(m.dependencies ?? {})]));
  const found = new Set<string>();
  const visit = (name: string) => {
    if (found.has(name) || !deps.has(name)) return;
    found.add(name);
    for (const dep of deps.get(name) ?? []) visit(dep);
  };
  visit("@scp-dev/cli");
  return found;
}

export function bumped(changeset: string): string[] {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(changeset)?.[1] ?? "";
  return [...front.matchAll(/^\s*["']?([^"':\s]+)["']?\s*:\s*(?:patch|minor|major)\s*$/gm)].map((match) => match[1] as string);
}

export function missingCliBump(changes: Change[], read: (path: string) => string, bumpers: Set<string>): string[] {
  const native = nativeChanges(changes);
  if (!native.length) return [];
  const added = changes.filter(
    (change) => change.status.startsWith("A") && /^\.changeset\/[^/]+\.md$/.test(change.path) && change.path !== ".changeset/README.md",
  );
  return added.some((change) => bumped(read(change.path)).some((name) => bumpers.has(name))) ? [] : native;
}

function changesSince(base: string): Change[] {
  const diff = spawnSync("git", ["diff", "--name-status", "--no-renames", base, "HEAD"], { encoding: "utf8" });
  if (diff.status !== 0) throw new Error(`git diff against ${base} failed: ${diff.stderr.trim()}`);
  return diff.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", path = ""] = line.split("\t");
      return { status, path };
    });
}

function workspaceManifests(root: string) {
  return readdirSync(resolve(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return [JSON.parse(readFileSync(resolve(root, "packages", entry.name, "package.json"), "utf8"))];
      } catch {
        return [];
      }
    });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--base") throw new Error("Usage: bun scripts/native-changeset.ts --base <commit>");
  if ((process.env.GITHUB_HEAD_REF ?? "").startsWith("changeset-release/")) process.exit(0);
  const root = process.cwd();
  const bumpers = cliBumpers(workspaceManifests(root));
  const missing = missingCliBump(changesSince(args[1] as string), (path) => readFileSync(resolve(root, path), "utf8"), bumpers);
  if (missing.length) {
    console.error(
      [
        "These changes ship in the @scp-dev/native-* packages, which take the @scp-dev/cli version:",
        ...missing.slice(0, 10).map((path) => `  ${path}`),
        ...(missing.length > 10 ? [`  … and ${missing.length - 10} more`] : []),
        `Add a changeset that bumps @scp-dev/cli or a package it depends on (${[...bumpers].sort().join(", ")}), or the release publishes nothing new for them.`,
      ].join("\n"),
    );
    process.exit(1);
  }
}
