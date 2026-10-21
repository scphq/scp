import { platformKeys } from "./relay-version";

const names = ["@scp-dev/dashboard", "@scp-dev/relay-server", ...platformKeys.map((key) => `@scp-dev/relay-server-${key}`)];
const missing: string[] = [];
for (const name of names) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (response.status === 404) missing.push(name);
  else if (!response.ok) throw new Error(`npm lookup for ${name} failed: HTTP ${response.status}`);
}
if (missing.length && !process.env.NPM_TOKEN) {
  throw new Error(
    `Not on npm yet: ${missing.join(", ")}. Trusted publishing cannot create packages; bootstrap with NPM_TOKEN or manual first publishes. See docs/RELEASING.md.`,
  );
}
console.log(missing.length ? `Bootstrap packages: ${missing.join(", ")}` : "All eight relay packages exist on npm.");
