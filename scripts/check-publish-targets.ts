// Trusted publishing cannot create a package, so without NPM_TOKEN every public package must already exist on npm.
// Run before the first upload: `changeset publish` uploads each package on its own, and a half-published release
// leaves dependents live on npm that point at a name that 404s.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const names = readdirSync("packages")
  .map((dir) => join("packages", dir, "package.json"))
  .filter((path) => existsSync(path))
  .map((path) => JSON.parse(readFileSync(path, "utf8")) as { name: string; private?: boolean })
  .filter((manifest) => manifest.private !== true)
  .map((manifest) => manifest.name);

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
