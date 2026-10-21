import { chmod, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GRAPH_CSS, graphScript } from "../../../apps/relay/src/graph";
import { CSS, html, stamp } from "../../../apps/relay/src/html";
import { APP_JS } from "../../../apps/relay/src/overview";

const output = new URL("../dist/public/", import.meta.url);
const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/browser/main.ts", import.meta.url))],
  target: "browser",
  conditions: ["bun"],
  format: "iife",
  minify: true,
  splitting: false,
  sourcemap: "none",
});
if (!result.success) throw new AggregateError(result.logs, "Self-host dashboard build failed");
if (result.outputs.length !== 1) throw new Error("Expected one browser bundle");
const bundle = await result.outputs[0]!.text();
const shell = `<!doctype html>${html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>scp relay</title><link rel="stylesheet" href="/app.css?v=${stamp(CSS)}"><script src="/selfhost.js?v=${stamp(bundle)}" defer></script></head><body></body></html>`}\n`;
const assets: Record<string, string> = {
  "selfhost.js": bundle,
  "app.css": CSS,
  "app.js": APP_JS,
  "graph.css": GRAPH_CSS,
  "graph.js": graphScript(),
  "index.html": shell,
};

await mkdir(output, { recursive: true });
for (const [name, content] of Object.entries(assets)) await Bun.write(new URL(name, output), content);
const server = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/server.ts", import.meta.url))],
  target: "node",
  format: "esm",
  sourcemap: "none",
  define: { DASHBOARD_VERSION: JSON.stringify(JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()).version) },
});
if (!server.success) throw new AggregateError(server.logs, "Dashboard server build failed");
await Bun.write(new URL("../dist/server.js", import.meta.url), `#!/usr/bin/env node\n${await server.outputs[0]!.text()}`);
await chmod(new URL("../dist/server.js", import.meta.url), 0o755);
console.log(`selfhost.js: ${Buffer.byteLength(bundle)} bytes`);
