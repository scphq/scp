import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { capture } from "./term"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import type { Claim } from "@scp-dev/core"
import { privateDir, relayDir, shortHostname } from "@scp-dev/broker"
import { GENERIC_HARNESSES, LIMITS, validHandle, validHarness } from "@scp-dev/core"

/**
 * The fleet-agent convention the MCP shim and the hooks share: a harness session's shim and hooks
 * compute the same handle, harness and session key, so they land on one endpoint.
 */

type Env = Record<string, string | undefined>

const SHORT: Record<string, string> = { "claude-code": "claude" }
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"])
const LABEL_KEY = /^[a-z0-9][a-z0-9._-]{0,31}$/

/** the harness this process runs under, from the markers each harness puts in its children's environment (agy before Claude Code) */
export function detectHarness(env: Env): string | undefined {
  if (env.GROK_SESSION_ID || env.GROK_HOOK_EVENT) return "grok"
  if (env.MUSE_SESSION_ID) return "muse"
  if (env.OPENCODE === "1") return "opencode"
  if (env.ANTIGRAVITY_AGENT === "1" || env.ANTIGRAVITY_CONVERSATION_ID) return "agy"
  if (env.CLAUDECODE === "1") return "claude-code"
  if (env.CODEX_THREAD_ID) return "codex"
  if (inferring(env) && (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED)) return "codex"
  return undefined
}

type ShimBinding = { process: string; handle: string; harness: string }
const BINDING_KEY = /^[0-9a-f]{1,128}$/
const BINDING_PROCESS = /^pid:([1-9][0-9]*):[A-Za-z0-9:-]{1,64}$/

/** whether this shell may recover its hidden codex harness from a shim binding */
export function codexShell(env: Env): boolean {
  return env.SCP_HARNESS === "codex" || (inferring(env) && detectHarness(env) === "codex")
}

/** publish the codex shim's harness key for shells whose sandbox hides its process */
export function writeShimBinding(claim: ShimBinding, env: Env): () => void {
  const pid = BINDING_PROCESS.exec(claim.process)?.[1]
  if (claim.harness !== "codex" || !pid) return () => {}
  const text = JSON.stringify({ process: claim.process, handle: claim.handle, harness: claim.harness })
  const names = [`pid-${pid}`, ...(BINDING_KEY.test(env.SCP_SHIM_BINDING ?? "") ? [`key-${env.SCP_SHIM_BINDING}`] : [])]
  const paths: string[] = []
  for (const name of names) {
    try {
      const path = join(privateDir(join(relayDir(env), "bindings")), `${name}.json`)
      writeFileSync(path, text, { mode: 0o600 })
      chmodSync(path, 0o600)
      paths.push(path)
    } catch {}
  }
  return () => {
    for (const path of paths) {
      try {
        if (readFileSync(path, "utf8") === text) rmSync(path)
      } catch {}
    }
  }
}

/** a shim binding by launch key, else the first ancestor pid missing from the sandbox's process table */
export function readShimBinding(env: Env, pid: number, table: PsCommTable | undefined): ShimBinding | undefined {
  const read = (name: string, expectedPid?: number): ShimBinding | undefined => {
    try {
      const binding = JSON.parse(readFileSync(join(relayDir(env), "bindings", `${name}.json`), "utf8")) as ShimBinding
      const match = typeof binding.process === "string" ? BINDING_PROCESS.exec(binding.process) : null
      if (
        match &&
        Number(match[1]) > 1 &&
        (expectedPid === undefined || Number(match[1]) === expectedPid) &&
        binding.harness === "codex" &&
        typeof binding.handle === "string" &&
        validHandle(binding.handle)
      )
        return binding
    } catch {}
    return undefined
  }
  if (BINDING_KEY.test(env.SCP_SHIM_BINDING ?? "")) {
    const binding = read(`key-${env.SCP_SHIM_BINDING}`)
    if (binding) return binding
  }
  const seen = new Set<number>()
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid)
    const entry = table?.get(pid)
    if (!entry) return read(`pid-${pid}`, pid)
    pid = entry.ppid
  }
  return undefined
}

/** a harness name the relay accepts: lowercase, invalid characters to `-`; `fallback` when nothing is left */
export function normalizeHarness(raw: string | undefined, fallback: string): string {
  const name = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "")
  if (name === "claude") return "claude-code"
  return validHarness(name) ? name : fallback
}

/** a hook's harness: its argument, except that a Claude Code hook Grok runs is grok; without an argument, the detected harness or `hook` */
export function hookHarness(argument: string | undefined, env: Env): string {
  if (!argument) return detectHarness(env) ?? "hook"
  const named = normalizeHarness(argument, "hook")
  return named === "claude-code" && (env.GROK_SESSION_ID || env.GROK_HOOK_EVENT) ? "grok" : named
}

/** `--harness` or $SCP_HARNESS, else the detected harness, else `fallback` */
export function resolveHarness(explicit: string | undefined, env: Env, fallback: string): string {
  const named = explicit ?? env.SCP_HARNESS
  return named ? normalizeHarness(named, fallback) : (detectHarness(env) ?? normalizeHarness(fallback, "mcp"))
}

/** the directory holding `.git` (a repository or a linked worktree) at or above `cwd` */
export function gitToplevel(cwd: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir
    if (dirname(dir) === dir) return undefined
  }
}

/** a valid handle from free text: lowercased, invalid characters to `-`, trimmed, reserved names suffixed `-agent` */
export function toHandle(raw: string): string {
  let handle = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63)
    .replace(/[-.]+$/, "")
  if (!handle) handle = "agent"
  if (!validHandle(handle)) handle = `${handle.slice(0, 56)}-agent`
  return handle
}

/** `<harness short>-<worktree>`: the worktree is the git toplevel's directory name, else the cwd's */
export function deriveHandle(harness: string, cwd: string): string {
  const top = gitToplevel(cwd) ?? resolve(cwd)
  return toHandle(`${SHORT[harness] ?? harness}-${basename(top) || "root"}`)
}

/** `k=v,k=v` with invalid keys dropped */
export function parseLabels(value: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const pair of (value ?? "").split(",")) {
    const eq = pair.indexOf("=")
    const key = pair.slice(0, eq).trim()
    if (eq > 0 && LABEL_KEY.test(key)) labels[key] = pair.slice(eq + 1).trim()
  }
  return labels
}

export { shortHostname }

/** $SCP_LABELS plus `machine=<short hostname>` unless it names a machine itself */
export function labelsFor(env: Env, host = shortHostname()): Record<string, string> {
  const labels = parseLabels(env.SCP_LABELS)
  labels.machine ??= host
  return labels
}

/** `pid:<harness pid>:<its start time>`, so a recycled pid is a new key; `pid:<harness pid>` when the start time is unknown */
export function processKey(harnessPid: number, startOf: (pid: number) => string | undefined = psStart): string {
  const started = startOf(harnessPid)
  return started ? `pid:${harnessPid}:${started}` : `pid:${harnessPid}`
}

/** `env:<$SCP_SESSION>`, never shaped like a process key, else the process key */
export function sessionKey(env: Env, harnessProcess: string): string {
  return env.SCP_SESSION ? `env:${env.SCP_SESSION}` : harnessProcess
}

/** when `pid` started, as ps prints it in the C locale, with spaces as `-` */
export function psStart(pid: number): string | undefined {
  try {
    const started = (capture(["ps", "-o", "lstart=", "-p", String(pid)], { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" }) ?? "")
      .trim()
      .replace(/\s+/g, "-")
    return /^[A-Za-z0-9:-]{1,64}$/.test(started) ? started : undefined
  } catch {
    return undefined
  }
}

/** every process's parent pid and start time (as {@link psStart} prints it), by pid */
export type PsTable = Map<number, { ppid: number; start: string }>

/** the output of `ps -axo pid=,ppid=,lstart=` as a table */
export function parsePsTable(text: string): PsTable {
  const table: PsTable = new Map()
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line)
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), start: match[3]!.replace(/\s+/g, "-") })
  }
  return table
}

/** a {@link PsTable} that also holds each process's command line */
export type PsCommTable = Map<number, { ppid: number; start: string; args: string }>

/** the output of `ps -axo pid=,ppid=,lstart=,args=` in the C locale, where lstart is five words */
export function parsePsCommTable(text: string): PsCommTable {
  const table: PsCommTable = new Map()
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S.*?)\s*$/.exec(line)
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), start: match[3]!.replace(/\s+/g, "-"), args: match[4]! })
  }
  return table
}

/** one ps call for the whole process table, in the C locale; undefined when ps cannot run */
export function readPsTable(): PsCommTable | undefined {
  try {
    const table = capture(["ps", "-ww", "-axo", "pid=,ppid=,lstart=,args="], { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" })
    return table === undefined ? undefined : parsePsCommTable(table)
  } catch {
    return undefined
  }
}

const PASS_THROUGH = new Set([
  ...SHELLS,
  "ash",
  "ksh",
  "env",
  "timeout",
  "nohup",
  "nice",
  "time",
  "stdbuf",
  "xargs",
  "script",
  "caffeinate",
  "flock",
  "sandbox-exec",
  "bwrap",
  "codex-linux-sandbox",
  "codex-linux-san",
])
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "ruby", "perl"])
const RUNNERS = new Set(["npm", "pnpm", "yarn"])
/** package runners that fetch and start an installed tool: a helper only when that tool runs a script of the agent's (`npx tsx agent.ts`) */
const FETCHERS = new Set(["npx", "bunx", "pnpx", "uvx"])
const SCRIPT_RUNNERS = new Set(["tsx", "ts-node", "vite-node", "esno"])
/** inline code: what follows is the code and its arguments, not a program */
const INLINE = new Set(["-c", "-e", "--eval", "-p", "--print", "-"])
/** interpreter flags whose value is a file it loads first: that file counts like the script */
const VALUED = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-I", "-M", "-W", "-X", "-C", "--conditions", "--preload"])
const HARNESSES = new Set([
  "claude",
  "claude-code",
  "codex",
  "opencode",
  "opencode-ai",
  "grok",
  "grok-cli",
  "muse",
  "agy",
  "antigravity",
  "gemini",
  "gemini-cli",
  "pi-coding-agent",
])
/** where installed tools live: a script from one of these is a program in its own right, possibly a harness, never a helper */
const INSTALLED =
  /(^|\/)(node_modules|site-packages|dist-packages|\.npm|\.bun|\.cache|\.local|\.cargo|\.volta|\.nvm|\.pyenv|\.rbenv|Cellar|Applications)(\/|$)|^\/(opt|usr|Library|nix)\//

/** the executable's name from a ps command line, lowercased, without a login shell's `-` */
function command(args: string): string {
  return basename(args.split(/\s+/)[0]!.replace(/^-/, "")).toLowerCase()
}

const namesHarness = (words: string[]): boolean =>
  words.some((word) => !word.startsWith("-") && word.split("/").some((part) => HARNESSES.has(part.toLowerCase().replace(/\..*$/, ""))))

/** harness ids by the program or package name a harness process runs as */
const HARNESS_IDS = new Map([
  ["claude", "claude-code"],
  ["claude-code", "claude-code"],
  ["codex", "codex"],
  ["opencode", "opencode"],
  ["opencode-ai", "opencode"],
  ["grok", "grok"],
  ["grok-cli", "grok"],
  ["muse", "muse"],
  ["agy", "agy"],
  ["antigravity", "agy"],
  ["gemini", "gemini"],
  ["gemini-cli", "gemini"],
  ["pi", "pi"],
  ["pi-coding-agent", "pi"],
])
const harnessId = (name: string): string | undefined => HARNESS_IDS.get(name.toLowerCase().replace(/\..*$/, ""))

/** the harness a command line runs: its program's name, else, for an interpreter or package runner, a later word naming one */
export function harnessOf(args: string | undefined): string | undefined {
  if (!args) return undefined
  const name = command(args)
  const own = harnessId(name)
  if (own) return own
  if (!INTERPRETERS.has(name) && !RUNNERS.has(name) && !FETCHERS.has(name) && !/^python[0-9.]*$/.test(name)) return undefined
  for (const word of args.split(/\s+/).slice(1)) {
    if (word.startsWith("-")) continue
    for (const part of word.split("/").reverse()) {
      const id = part === "pi" ? undefined : harnessId(part)
      if (id) return id
    }
  }
  return undefined
}

/** whether claims may infer an unnamed harness: off with $SCP_HARNESS_DETECT=0, as the test suite runs */
export const inferring = (env: Env): boolean => env.SCP_HARNESS_DETECT !== "0"

/** the harness process `pid` runs, from the ps table */
export function harnessAt(pid: number, table: PsCommTable | undefined = readPsTable()): string | undefined {
  return inferring(process.env) ? harnessOf(table?.get(pid)?.args) : undefined
}

let roots: string[] | undefined

/** where an agent's own scripts live: this shell's cwd, its git toplevel and the temp dirs, real paths */
function workspaceRoots(): string[] {
  if (roots) return roots
  const real = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  const found = [process.cwd(), tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
  try {
    const top = capture(["git", "rev-parse", "--show-toplevel"])
    if (top !== undefined) found.push(top.trim())
  } catch {}
  roots = [...new Set(found.filter(Boolean).map(real))]
  return roots
}

/**
 * a script operand of the agent's own: no `scheme:` (npm:, jsr:, https:), nothing under a place tools are installed, and either relative
 * (run from the agent's workspace) or under this shell's cwd, its git toplevel or a temp dir. Anything else is a program in its own right.
 */
function ownScript(operand: string | undefined): boolean {
  if (operand === undefined || operand === "-") return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(operand) || operand.startsWith("~") || INSTALLED.test(operand)) return false
  if (!isAbsolute(operand)) return !operand.split("/").includes("..")
  let path = operand
  try {
    path = realpathSync(operand)
  } catch {}
  if (INSTALLED.test(path)) return false
  return workspaceRoots().some((root) => path === root || path.startsWith(`${root}/`))
}

/**
 * an interpreter running a helper script: no operand under a place tools are installed and no word naming a harness; `uv run` and
 * `npm|pnpm|yarn run` of the same. Package runners that fetch or start installed tools (npx, bunx, uvx, `npm exec`,
 * `python -m`) and scripts under node_modules, site-packages, ~/.local and the like end the walk: an unrecognized harness there is not passed
 */
function helper(args: string): boolean {
  const words = args.split(/\s+/)
  if (namesHarness(words.slice(1))) return false
  const name = command(args)
  let rest = words.slice(1)
  if (FETCHERS.has(name)) {
    while (rest[0]?.startsWith("-")) rest = rest.slice(1)
    return SCRIPT_RUNNERS.has(rest[0] ?? "") && rest.slice(1).every((word) => word.startsWith("-") || ownScript(word))
  }
  if (name === "uv" || RUNNERS.has(name)) {
    if (rest[0] !== "run") return false
    if (name === "uv") {
      rest = rest.slice(1)
      while (rest[0]?.startsWith("-")) rest = rest.slice(1)
      if (rest[0] === undefined) return true
      const inner = rest.join(" ")
      return /^python[0-9.]*$/.test(command(inner)) || INTERPRETERS.has(command(inner)) ? helper(inner) : ownScript(rest[0])
    }
    return true
  }
  if (!INTERPRETERS.has(name) && !/^python[0-9.]*$/.test(name)) return false
  if (name === "bun" && rest[0] === "x") return false
  if ((name === "bun" || name === "deno") && rest[0] === "run") {
    rest = rest.slice(1)
    if (name === "deno") while (rest[0]?.startsWith("-")) rest = rest.slice(1)
    const target = rest.find((word) => !word.startsWith("-"))
    if (target !== undefined && !/[/.]/.test(target)) return false
  }
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!
    if (word === "-m") return false
    if (INLINE.has(word)) return true
    if (VALUED.has(word)) {
      if (!ownScript(rest[++i])) return false
      continue
    }
    if (!word.startsWith("-")) return ownScript(word)
  }
  return true
}

/**
 * the {@link lineage} of `pid` up to and including its nearest harness: the first process, `pid` itself or an ancestor, that is not a shell,
 * a wrapper or a helper script's interpreter; with no harness above the helpers, the whole lineage; empty when there is none
 */
export function harnessLineage(pid: number, table: PsCommTable | undefined = readPsTable()): string[] {
  const keys = lineage(pid, table)
  let first = -1
  for (let i = 0, at = pid; i < keys.length; i++, at = table!.get(at)!.ppid) {
    const args = table!.get(at)!.args
    if (PASS_THROUGH.has(command(args))) continue
    if (!helper(args)) return keys.slice(0, i + 1)
    if (first < 0) first = i
  }
  return first < 0 ? [] : keys
}

const INITS = new Set(["init", "systemd", "launchd"])

/** whether `pid` has no harness on its walk and the walk ends at a pid 1 that is not init, as inside bwrap --unshare-pid, which hides the harness */
export function hiddenHarness(pid: number, table: PsCommTable | undefined = readPsTable()): boolean {
  if (!table || harnessLineage(pid, table).length) return false
  const seen = new Set<number>()
  let at = pid
  while (at > 1 && !seen.has(at)) {
    seen.add(at)
    const entry = table.get(at)
    if (!entry) return false
    at = entry.ppid
  }
  const init = table.get(1)
  return at === 1 && init !== undefined && !INITS.has(command(init.args))
}

/** process keys of `harnessPid` and then its ancestors, nearest first, at most 16, stopping at pid 1 or a pid ps does not know */
export function lineage(harnessPid: number, table: PsTable | undefined = readPsTable()): string[] {
  const keys: string[] = []
  const seen = new Set<number>()
  for (let pid = harnessPid; pid > 1 && keys.length < LIMITS.lineageMax && !seen.has(pid); ) {
    const entry = table?.get(pid)
    if (!entry) break
    seen.add(pid)
    keys.push(/^[A-Za-z0-9:-]{1,64}$/.test(entry.start) ? `pid:${pid}:${entry.start}` : `pid:${pid}`)
    pid = entry.ppid
  }
  return keys
}

/** `pid`'s own key as its children's {@link lineage} spells it, from the same ps table; undefined without a start time */
export function spawnerKey(pid = process.pid, table: PsTable | undefined = readPsTable()): string | undefined {
  const key = lineage(pid, table)[0]
  return key?.startsWith(`pid:${pid}:`) ? key : undefined
}

/** the parent pid and command name of `pid`, from one ps call */
export function psParent(pid: number): { ppid: number; comm: string } | undefined {
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(capture(["ps", "-o", "ppid=,comm=", "-p", String(pid)], { PATH: process.env.PATH ?? "/usr/bin:/bin" }) ?? "")
  return match ? { ppid: Number(match[1]), comm: match[2]! } : undefined
}

/** the harness pid behind a parent process: the parent, or the parent's parent when the parent is a shell (`sh -c`) */
export function harnessPid(ppid = process.ppid, parentOf = psParent): number {
  const parent = parentOf(ppid)
  if (parent && parent.ppid > 1 && SHELLS.has(basename(parent.comm.replace(/^-/, "")))) return parent.ppid
  return ppid
}

/** a hook's harness pid: $CLAUDE_PID for a Claude Code hook, $OPENCODE_PID for an OpenCode one, else {@link harnessPid} */
export function hookHarnessPid(env: Env, harness: string, ppid = process.ppid, parentOf = psParent): number {
  const named = harness === "claude-code" ? env.CLAUDE_PID : harness === "opencode" ? env.OPENCODE_PID : undefined
  const pid = Number(named)
  if (Number.isInteger(pid) && pid > 1) return pid
  return harnessPid(ppid, parentOf)
}

/** $SCP_HARNESS_PID when it is the parent of the harness process: `swarm agy` and `swarm grok` hold the endpoint across their per-turn harness processes */
export function launcherPid(env: Env, harness: () => number = harnessPid, parentOf = psParent): number | undefined {
  const pid = Number(env.SCP_HARNESS_PID)
  if (!Number.isInteger(pid) || pid <= 1) return undefined
  return parentOf(harness())?.ppid === pid ? pid : undefined
}

export interface IdentityInput {
  as?: string
  harness?: string
  /** the harness when none is named or detected */
  fallbackHarness: string
  cwd: string
  env: Env
  harnessPid: (harness: string) => number
  /** the harness the harness process runs, for a claim that names none and detects none (e.g. {@link harnessAt}) */
  inferHarness?: (pid: number) => string | undefined
  startOf?: (pid: number) => string | undefined
  /** process keys of the harness and its ancestors (default {@link lineage}) */
  lineageOf?: (pid: number) => string[]
  /** a Claude Code hook's payload session id, over $CLAUDE_CODE_SESSION_ID */
  harnessSession?: string
}

const HARNESS_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** the claim a shim or hook makes for this harness session */
export function relayIdentity(input: IdentityInput): Claim & { handle: string; harness: string; session: string; process: string; cwd: string } {
  const resolved = resolveHarness(input.harness, input.env, input.fallbackHarness)
  const pid = input.harnessPid(resolved)
  const harness = (GENERIC_HARNESSES.has(resolved) && input.inferHarness?.(pid)) || resolved
  const cwd = isAbsolute(input.cwd) ? input.cwd : resolve(input.cwd)
  const handle = input.as ?? input.env.SCP_NAME ?? deriveHandle(harness, cwd)
  const harnessProcess = processKey(pid, input.startOf)
  const keys = input.lineageOf ? input.lineageOf(pid) : lineage(pid)
  const harnessSession =
    harness === "claude-code" ? [input.harnessSession, input.env.CLAUDE_CODE_SESSION_ID].find((id) => id !== undefined && HARNESS_SESSION.test(id)) : undefined
  return {
    handle,
    harness,
    cwd,
    session: sessionKey(input.env, harnessProcess),
    process: harnessProcess,
    labels: labelsFor(input.env),
    ...(input.env.SCP_PARENT ? { parent: input.env.SCP_PARENT } : {}),
    ...(keys.length ? { lineage: keys } : {}),
    ...(input.env.SCP_GRANT ? { grant: input.env.SCP_GRANT } : {}),
    ...(harnessSession ? { harness_session: harnessSession } : {}),
  }
}
