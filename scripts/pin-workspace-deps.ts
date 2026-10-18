// Neither `changeset version` nor `changeset publish` rewrites the `workspace:` protocol in a Bun
// workspace, so pin those ranges to concrete versions on the publish path only (an ephemeral CI checkout).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Manifest = { name?: string; version?: string } & Partial<Record<(typeof FIELDS)[number], Record<string, string>>>;

const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

const manifests = readdirSync("packages")
  .map((dir) => join("packages", dir, "package.json"))
  .filter((path) => existsSync(path))
  .map((path) => ({ path, json: JSON.parse(readFileSync(path, "utf8")) as Manifest }));

const versions = new Map(manifests.flatMap(({ json }) => (json.name && json.version ? [[json.name, json.version] as const] : [])));

function pin(dep: string, range: string): string {
  const version = versions.get(dep);
  if (!version) throw new Error(`${dep} is not a workspace package`);
  const suffix = range.slice("workspace:".length);
  if (suffix === "*" || suffix === "") return version;
  if (suffix === "^" || suffix === "~") return suffix + version;
  return suffix;
}

let pinned = 0;
for (const { path, json } of manifests) {
  for (const field of FIELDS) {
    for (const [dep, range] of Object.entries(json[field] ?? {})) {
      if (!range.startsWith("workspace:")) continue;
      json[field] = { ...json[field], [dep]: pin(dep, range) };
      pinned++;
    }
  }
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

console.log(`Pinned ${pinned} workspace dependency range(s) for publish.`);
