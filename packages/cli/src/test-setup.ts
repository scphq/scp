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
/** a native `swarm` for the tests that run it, read before the SCP variables are cleared */
export const swarmBinary = process.env.SCP_SWARM_BIN
const nativeMcp = process.env.SCP_MCP_BIN
/** with SCP_CLI_NATIVE=1, every CLI the tests start routes the verbs the native `swarm` registers to it, logging to SCP_ROUTE_LOG */
export const nativeCli = process.env.SCP_CLI_NATIVE === "1" && swarmBinary !== undefined
const routeLog = process.env.SCP_ROUTE_LOG
for (const key of Object.keys(process.env)) if (key.startsWith("SCP_")) delete process.env[key]
process.env.SCP_HARNESS_DETECT = "0"
// With a native MCP server binary given, every `swarm mcp` the tests start runs on it.
if (nativeMcp) Object.assign(process.env, { SCP_NATIVE: "1", SCP_MCP_BIN: nativeMcp })
if (nativeCli) Object.assign(process.env, { SCP_NATIVE: "1", SCP_SWARM_BIN: swarmBinary, ...(routeLog ? { SCP_ROUTE_LOG: routeLog } : {}) })
process.on("exit", () => rmSync(home, { recursive: true, force: true }))
