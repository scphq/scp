import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "../packages/core/src/mcp-tools";

/** the native MCP server's copy of TOOLS: one tool per line, in TOOLS order, so a tool can be left out without reordering the rest */
export const toolsFile = join(import.meta.dir, "../crates/scp-mcp/tools.json");

export function toolsJson(): string {
  return `[\n${TOOLS.map((tool) => JSON.stringify(tool)).join(",\n")}\n]\n`;
}

/** throws when crates/scp-mcp/tools.json is not what TOOLS generates */
export function checkTools(): void {
  if (readFileSync(toolsFile, "utf8") !== toolsJson()) throw new Error(`${toolsFile} is stale: run bun scripts/mcp-tools.ts`);
}

if (import.meta.main) writeFileSync(toolsFile, toolsJson());
