// Writes the help text the native CLI prints, byte for byte, from the TypeScript CLI's strings; --check fails when it drifted.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_HELP } from "../packages/cli/src/claude";
import { CODEX_HELP } from "../packages/cli/src/codex";
import { SPAWN_HELP } from "../packages/cli/src/help-spawn";
import { RELAY_BRIEF, RELAY_HELP } from "../packages/cli/src/main";
import { CLAUDE_DESKTOP_HELP } from "../packages/cli/src/mcpb";
import { MUSE_HELP } from "../packages/cli/src/muse";
import { OPENCODE_HELP } from "../packages/cli/src/opencode";
import { PI_HELP } from "../packages/cli/src/pi";
import { AGY_HELP, GROK_HELP } from "../packages/cli/src/resume";
import { SETUP_HELP } from "../packages/cli/src/setup";
import { T3CODE_HELP } from "../packages/cli/src/t3code";

const dir = join(import.meta.dir, "..", "crates/scp-cli/src/help");

const TEXTS: Record<string, string> = {
  "agy.txt": AGY_HELP,
  "brief.txt": RELAY_BRIEF,
  "claude-desktop.txt": CLAUDE_DESKTOP_HELP,
  "claude.txt": CLAUDE_HELP,
  "codex.txt": CODEX_HELP,
  "full.txt": RELAY_HELP,
  "grok.txt": GROK_HELP,
  "muse.txt": MUSE_HELP,
  "opencode.txt": OPENCODE_HELP,
  "pi.txt": PI_HELP,
  "setup.txt": SETUP_HELP,
  "spawn.txt": SPAWN_HELP,
  "t3code.txt": T3CODE_HELP,
};

const check = process.argv.includes("--check");
const drifted: string[] = [];
for (const [name, text] of Object.entries(TEXTS)) {
  const path = join(dir, name);
  if (!check) writeFileSync(path, text);
  else if (readFileSync(path, "utf8") !== text) drifted.push(name);
}
if (drifted.length) {
  console.error(`help text drifted from the TypeScript CLI: ${drifted.join(", ")}; run bun scripts/help-text.ts`);
  process.exit(1);
}
