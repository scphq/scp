import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// No test may reach the developer's real broker, policy or harness configs.
const home = mkdtempSync(join(tmpdir(), "scp-cli-test-"))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, ".config")
process.env.XDG_STATE_HOME = join(home, ".local", "state")
process.env.XDG_DATA_HOME = join(home, ".local", "share")
process.env.CLAUDE_CONFIG_DIR = join(home, ".claude")
process.env.CODEX_HOME = join(home, ".codex")
process.env.GEMINI_CLI_HOME = home
for (const key of Object.keys(process.env)) if (key.startsWith("SCP_")) delete process.env[key]
process.env.SCP_HARNESS_DETECT = "0"
process.on("exit", () => rmSync(home, { recursive: true, force: true }))
