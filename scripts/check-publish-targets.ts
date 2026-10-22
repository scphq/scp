// Trusted publishing cannot create a package, so without NPM_TOKEN every public package must already exist on npm.
// Run before the first upload: `changeset publish` uploads each package on its own, and a half-published release
// leaves dependents live on npm that point at a name that 404s.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nativeNames } from "./native-version";
import { relayAnchor } from "./relay-version";

type Manifest = { name: string; private?: boolean };
const manifest = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Manifest;

// Native packages publish before the non-private workspace members.
export function publishTargets(root = resolve(import.meta.dir, "..")): string[] {
  const anchor = manifest(join(root, relayAnchor));
  if (anchor.private !== true) throw new Error(`${relayAnchor} must stay private: the relay publishes from release-relay.yml`);
  const workspaces: string[] = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces;
  return [
    ...nativeNames,
    ...workspaces
      .flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: false })])
      .map((dir) => join(root, dir, "package.json"))
      .filter((path) => existsSync(path))
      .map(manifest)
      .filter((entry) => entry.private !== true)
      .map((entry) => entry.name),
  ].sort();
}

if (import.meta.main) {
  const names = publishTargets();
  const missing: string[] = [];
  for (const name of names) {
    const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" } });
    if (response.status === 404) missing.push(name);
    else if (!response.ok) throw new Error(`npm registry lookup for ${name} failed: HTTP ${response.status}`);
  }
  if (names.length === 0) console.log("No public packages: nothing to publish.");
  else if (missing.length === 0) console.log(`All ${names.length} public package(s) exist on npm.`);
  else if (process.env.NPM_TOKEN) console.log(`Not on npm yet, will be created with NPM_TOKEN: ${missing.join(", ")}`);
  else {
    console.error(`Not on npm yet: ${missing.join(", ")}. Trusted publishing cannot create a package; see docs/RELEASING.md.`);
    process.exit(1);
  }
}
