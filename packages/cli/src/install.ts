import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { CLI_NAME, LIMITS, validHandle } from "@scp-dev/core"
import { RelayUsage } from "./common"
import {
  AGY_HOOK_SET,
  AGY_UNVERIFIED,
  agyHookSet,
  BLOCK_STOP,
  hasOurHooks,
  hookEntries,
  type HookHarness,
  mergeHooks,
  musePlugin,
  opencodePlugin,
  PUSH_WAIT,
  PUSH_WAIT_DEFAULT_S,
  type Scope,
} from "./hooks"
import { gitToplevel } from "./identity"

type Env = Record<string, string | undefined>
type Json = Record<string, unknown>

export interface InstallOptions {
  harness: string | undefined
  scope?: string | undefined
  write?: boolean
  blockStop?: boolean
  /** stop wait in seconds; defaults to 600, 0 disables it */
  pushWait?: number
  env: Env
  cwd: string
  out: (line: string) => void
  now?: Date
}

function home(env: Env): string {
  return env.HOME || homedir()
}

/** where `hooks install` writes for a harness and scope */
export function hooksTarget(harness: HookHarness, scope: Scope, env: Env, cwd: string): string {
  const project = gitToplevel(cwd) ?? cwd
  switch (harness) {
    case "claude":
      if (scope === "local") return join(project, ".claude", "settings.local.json")
      return scope === "user" ? join(env.CLAUDE_CONFIG_DIR || join(home(env), ".claude"), "settings.json") : join(project, ".claude", "settings.json")
    case "codex":
      return scope === "user" ? join(env.CODEX_HOME || join(home(env), ".codex"), "hooks.json") : join(project, ".codex", "hooks.json")
    case "opencode":
      return scope === "user"
        ? join(env.XDG_CONFIG_HOME || join(home(env), ".config"), "opencode", "plugin", "scp.ts")
        : join(project, ".opencode", "plugin", "scp.ts")
    case "agy":
      return scope === "user" ? join(home(env), ".gemini", "config", "hooks.json") : join(project, ".agents", "hooks.json")
    case "muse":
      return join(env.XDG_CONFIG_HOME || join(home(env), ".config"), "scp", "muse-plugin", ".muse-plugin", "plugin.json")
  }
}

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Writes `content` over `target` via a temp file and rename, keeping its mode and backing it up first (with that mode);
 * a symlinked target is written through to the file it points at. False when nothing changed.
 */
function writeAtomic(target: string, content: string, now: Date): { changed: boolean; backup?: string } {
  const file = existsSync(target) && lstatSync(target).isSymbolicLink() ? realpathSync(target) : target
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined
  if (existing === content) return { changed: false }
  mkdirSync(dirname(file), { recursive: true })
  let backup: string | undefined
  let mode = 0o644
  if (existing !== undefined) {
    mode = statSync(file).mode & 0o7777
    const stamped = `${file}.bak-${stamp(now)}`
    backup = stamped
    for (let n = 2; existsSync(backup); n++) backup = `${stamped}-${n}`
    copyFileSync(file, backup)
    chmodSync(backup, mode)
  }
  const temp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}`)
  try {
    writeFileSync(temp, content, { mode })
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {}
    throw error
  }
  return { changed: true, ...(backup ? { backup } : {}) }
}

/** `swarm hooks install`: prints the snippet and its target, and with `write` merges it in */
export function installHooks(options: InstallOptions): number {
  if (options.env.SCP_TRANSPORT === "cloud") {
    throw new RelayUsage(
      `relay hooks report to the local broker, and SCP_TRANSPORT=cloud bypasses it; link the broker instead (${CLI_NAME} cloud enable) and install the hooks without it`,
    )
  }
  const harness = options.harness
  if (harness === "grok") {
    throw new RelayUsage(
      "Grok runs the Claude Code hooks (install those with --harness claude) and is labelled grok by them; it drops a prompt hook's context, so new messages reach it after tools only",
    )
  }
  if (harness !== "claude" && harness !== "codex" && harness !== "opencode" && harness !== "agy" && harness !== "muse") {
    throw new RelayUsage("hooks install takes --harness claude, codex, opencode, agy or muse")
  }
  const scope = (options.scope ?? (harness === "claude" ? "local" : harness === "muse" ? "user" : "project")) as Scope
  if (scope !== "project" && scope !== "user" && !(scope === "local" && harness === "claude")) {
    throw new RelayUsage("--scope is project or user (and local for claude, its default: .claude/settings.local.json, the per-person file)")
  }
  const target = hooksTarget(harness, scope, options.env, options.cwd)
  const now = options.now ?? new Date()
  if (options.pushWait !== undefined && (!Number.isInteger(options.pushWait) || options.pushWait < 0 || options.pushWait > 3600)) {
    throw new RelayUsage(`${PUSH_WAIT} takes whole seconds, 0 to 3600`)
  }
  const blockStop = { blockStop: options.blockStop === true, ...(options.pushWait !== undefined ? { pushWait: options.pushWait } : {}) }
  let content: string
  if (harness === "opencode") content = opencodePlugin({ blockStop: blockStop.blockStop })
  else if (harness === "muse") content = `${JSON.stringify(musePlugin(blockStop), null, 2)}\n`
  else {
    let settings: unknown = {}
    if (options.write && existsSync(target)) {
      try {
        settings = JSON.parse(readFileSync(target, "utf8"))
      } catch (error) {
        throw new RelayUsage(`${target} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it or add the hooks by hand`)
      }
    }
    try {
      if (harness === "agy") {
        if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new Error("the hooks file is not a JSON object")
        content = `${JSON.stringify({ ...(settings as Json), [AGY_HOOK_SET]: agyHookSet({ blockStop: blockStop.blockStop }) }, null, 2)}\n`
      } else
        content = `${JSON.stringify(options.write ? mergeHooks(settings, hookEntries(harness, blockStop)) : { hooks: hookEntries(harness, blockStop) }, null, 2)}\n`
    } catch (error) {
      throw new RelayUsage(`${target}: ${error instanceof Error ? error.message : String(error)}; fix it or add the hooks by hand`)
    }
  }
  const shared = harness === "claude" && scope === "local" ? hooksTarget("claude", "project", options.env, options.cwd) : undefined
  if (shared && hasOurHooks(shared)) {
    options.out(`# ${shared} already runs the ${CLI_NAME} hooks; remove them there, or every event reports twice`)
  }
  if (!options.write) {
    options.out(`# ${harness === "opencode" || harness === "muse" ? "the plugin file" : "merge into"} ${target} (or rerun with --write)`)
    options.out(content.trimEnd())
  } else {
    const result = writeAtomic(target, content, now)
    options.out(result.changed ? `wrote ${target}${result.backup ? ` (backup ${result.backup})` : ""}` : `${target} already has the ${CLI_NAME} hooks`)
    if (result.changed) options.out("# restart sessions started before this install: harnesses read hooks only at session start")
  }
  for (const line of injectionNotes(harness, scope, target, options.blockStop === true, options.pushWait ?? PUSH_WAIT_DEFAULT_S)) options.out(`# ${line}`)
  return 0
}

/** how new relay messages reach each harness, and what it lacks */
function injectionNotes(harness: HookHarness, scope: Scope, target: string, blockStop: boolean, wait: number): string[] {
  const stop = `a stop names each request not yet answered once, and is held while a require_reply request waits (at most ${LIMITS.stopBlocks} times a session)`
  const held = `${stop}; ${blockStop ? `with ${BLOCK_STOP} it is also held while messages are unread` : `add ${BLOCK_STOP} to also hold it while messages are unread`}`
  const pushed =
    wait > 0
      ? `while workers you started with ${CLI_NAME} spawn still run, a stop waits up to ${wait} s for their next message or handback and hands it to the model, which goes on (on by default, since spawning is explicit; ${PUSH_WAIT} 0 turns it off, SCP_PUSH_WAIT=<s> lowers it per session, 0 opts out); spawn itself returns at once without a terminal, so the model never backgrounds it`
      : `the stop never waits on workers started with ${CLI_NAME} spawn (${PUSH_WAIT} 0); ${PUSH_WAIT} <s> lets it wait for their next message`
  switch (harness) {
    case "claude":
      return [
        `new relay messages reach the model after each tool call and with each prompt; ${held}`,
        pushed,
        "Grok runs these hooks too, but drops a prompt hook's context: it gets new messages after tools",
      ]
    case "codex":
      return [
        `new relay messages reach the model after each tool call and with each prompt; ${held}`,
        pushed,
        "Codex runs new hooks only after you review them in /hooks",
      ]
    case "agy":
      return [
        `agy reads nothing from a PostToolUse hook, so new relay messages go in before each model call (PreInvocation) as ephemeral steps; ${held}`,
        AGY_UNVERIFIED,
      ]
    case "opencode":
      return [
        "new relay messages are appended to tool results; a prompt gets only how many are unread",
        `OpenCode has no stop hook: when the session goes idle, the plugin starts a new turn instead of holding a stop; ${held}`,
      ]
    case "muse":
      return [
        `Muse loads hooks only from plugins: muse plugins install ${dirname(dirname(target))} --scope ${scope}`,
        `new relay messages reach the model after each tool call and with each prompt; ${held}`,
        pushed,
        "Muse hands plugin hooks no SCP_* variables: they key the session by the harness process, so set no SCP_SESSION for Muse's shim",
      ]
  }
}

function shellWord(word: string): string {
  return /^[A-Za-z0-9._/=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
}

/** `swarm mcp install`: the command (or config snippet) that mounts the shim in a harness; printed, never run */
export function mcpInstall(harness: string | undefined, as: string | undefined, out: (line: string) => void): number {
  if (as !== undefined && !validHandle(as)) throw new RelayUsage(`--as ${JSON.stringify(as)} is not a valid agent handle`)
  const tail = (extra: string[]) => [...extra, ...(as ? ["--as", as] : [])]
  const args = (extra: string[] = []) => ["mcp", ...tail(extra)]
  const line = (cli: string[], extra: string[] = []) => out([...cli, CLI_NAME, ...args(extra)].map(shellWord).join(" "))
  switch (harness) {
    case "claude":
      line(["claude", "mcp", "add", "scp", "--"])
      return 0
    case "codex":
      line(["codex", "mcp", "add", "scp", "--"], ["--harness", "codex"])
      return 0
    case "grok":
      line(["grok", "mcp", "add", "scp", "--"], ["--harness", "grok"])
      return 0
    case "opencode":
      line(["opencode", "mcp", "add", "scp", "--"], ["--harness", "opencode"])
      out("# that writes OpenCode's global config; for one project, add this to its opencode.json instead:")
      out(JSON.stringify({ mcp: { scp: { type: "local", command: [CLI_NAME, ...args(["--harness", "opencode"])], enabled: true } } }, null, 2))
      return 0
    case "agy":
      line(["agy", "mcp", "add", "scp", "--"], ["--harness", "agy"])
      out("# that always writes your user file ~/.gemini/config/mcp_config.json; for one project, add this to <repo>/.agents/mcp_config.json instead:")
      out(JSON.stringify({ mcpServers: { scp: { command: CLI_NAME, args: args(["--harness", "agy"]) } } }, null, 2))
      out(`# ${AGY_UNVERIFIED}`)
      return 0
    case "muse":
      out(
        "# Muse has no mcp add: merge this into ~/.config/muse/settings.json (never add a mcp_servers key next to mcpServers, Muse then drops every MCP server)",
      )
      out(JSON.stringify({ mcpServers: { scp: { type: "stdio", command: CLI_NAME, args: args(["--harness", "muse"]), mode: "optional" } } }, null, 2))
      return 0
  }
  throw new RelayUsage("mcp install takes --harness claude, codex, opencode, grok, muse or agy")
}
