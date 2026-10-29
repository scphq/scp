import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { privateDir, relayDir } from "@scp-dev/broker"
import { CLI_NAME, validHandle } from "@scp-dev/core"
import { type AttributeDeps, attribute, attributed, validateUnder, underText, type Attribution } from "./attribute"
import { CHANNELS_ENV, CLAUDE_SESSION_ENV, RelayUsage } from "./common"
import { deriveHandle } from "./identity"
import { joinMode } from "./relay"
import { entryArgv, mcpFile, mountedEntry, whichOnPath } from "./setup"
import { SELF } from "./term"
import { safeCwd } from "./cwd"
import type { ClaudeBgDeps } from "./claude-bg"

export const CHANNEL_FLAGS = ["--dangerously-load-development-channels", "server:scp"]

type Env = Record<string, string | undefined>

/** `swarm claude [--bg] [--name N | --as N] [--root] [--under ADDR] [--] [claude args...]`: the handle, whether it runs in the background or as a root, and the arguments passed through to claude */
export function claudeArgv(argv: string[]): { name?: string; bg?: true; root?: true; under?: string; args: string[] } {
  let name: string | undefined
  let bg = false
  let under: string | undefined
  let root = false
  let i = 0
  for (;;) {
    const arg = argv[i]
    if (arg === "--bg" || arg === "--background") {
      bg = true
      i++
    } else if (arg === "--under" || arg?.startsWith("--under=")) {
      under = arg === "--under" ? argv[++i] : arg.slice(8)
      if (under === undefined) throw new RelayUsage("--under takes an address")
      i++
    } else if (arg === "--root") {
      root = true
      i++
    } else if (arg === "--name" || arg === "--as") {
      if (argv[i + 1] === undefined) throw new RelayUsage(`${CLI_NAME} claude ${arg} takes a handle`)
      name = argv[i + 1]
      i += 2
    } else if (arg?.startsWith("--name=") || arg?.startsWith("--as=")) {
      name = arg.slice(arg.indexOf("=") + 1)
      i++
    } else break
  }
  if (argv[i] === "--") i++
  validateUnder(under, root)
  name = name?.replace(/^me\//, "")
  if (name !== undefined && !validHandle(name)) throw new RelayUsage(`--name ${JSON.stringify(name)} is not a valid agent handle`)
  const args = argv.slice(i)
  if (!bg) bg = optionsOf(args).some((arg) => arg === "--bg" || arg === "--background")
  return {
    ...(under !== undefined ? { under } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(bg ? { bg: true as const } : {}),
    ...(root ? { root: true as const } : {}),
    args,
  }
}

/** claude's options: its arguments before any `--` */
const optionsOf = (args: string[]): string[] => (args.includes("--") ? args.slice(0, args.indexOf("--")) : args)

/** `added` placed before any `--`, after the user's own arguments so a variadic option of ours never takes their prompt */
function beforeDashes(args: string[], added: string[]): string[] {
  const at = optionsOf(args).length
  return [...args.slice(0, at), ...added, ...args.slice(at)]
}

/** claude's arguments with the scp channel and what SCP adds placed before any `--` */
export function claudeLaunchArgs(args: string[], added: string[]): string[] {
  const channels = optionsOf(args).some((arg) => arg === "server:scp" || arg === `${CHANNEL_FLAGS[0]}=server:scp`) ? [] : CHANNEL_FLAGS
  return beforeDashes(args, [...channels, ...added])
}

/** a launcher's own identity, which claude's daemon must not keep for the sessions it starts later */
export const LAUNCHER_IDENTITY = [
  ...CLAUDE_SESSION_ENV,
  "SCP_NAME",
  "SCP_GRANT",
  "SCP_SESSION",
  "SCP_PARENT",
  "SCP_UNDER",
  "SCP_HARNESS",
  "SCP_SHIM_BINDING",
  "SCP_SPAWN_RUNNER",
  CHANNELS_ENV,
]
/** where the shim finds the broker and its labels, passed on since a background session's environment is the daemon's */
const SHIM_VARS = ["SCP_LABELS", "SCP_DIR", "XDG_STATE_HOME"]

/** the MCP configs `swarm claude --bg` writes, and `<short id>.json` links to the one each session runs with */
export const bgDir = (env: Env): string => join(relayDir(env as NodeJS.ProcessEnv), "claude-bg")

/**
 * the scp server of a background session: the user's mount with `--channels`, else this CLI's, with the name, parent request and grant in its env. It has the
 * mount's name, so it replaces the mount for that session; the grant is set even when empty, so one in the daemon's environment never applies
 */
export function bgMount(env: Env, name: string | undefined): Record<string, unknown> {
  let entry: Record<string, unknown> | undefined
  try {
    entry = mountedEntry("claude", mcpFile("claude", env))
  } catch {}
  const mounted = entry ? entryArgv("claude", entry) : []
  const argv = mounted.includes("--channels") ? mounted : [...SELF, "mcp", "--harness", "claude", "--channels"]
  const base = entry?.env && typeof entry.env === "object" ? (entry.env as Record<string, string>) : {}
  const vars = Object.fromEntries(SHIM_VARS.flatMap((key) => (env[key] ? [[key, env[key]]] : [])))
  return {
    type: "stdio",
    command: argv[0],
    args: argv.slice(1),
    env: { ...base, ...vars, ...(name !== undefined ? { SCP_NAME: name } : {}), SCP_UNDER: env.SCP_UNDER ?? "", SCP_GRANT: env.SCP_GRANT ?? "" },
  }
}

const STRICT_HINT = `${CLI_NAME} claude: --strict-mcp-config without --mcp-config drops the scp mount, so messages cannot wake this session`

/** whether claude will mount an MCP server named scp from somewhere this launcher cannot see: a config passed on the command line */
function externalMcp(args: string[]): boolean {
  return args.some((arg) => arg === "--mcp-config" || arg.startsWith("--mcp-config="))
}

/** without --name, the line that asks the session to name itself, unless it does not join at start or the arguments set a system prompt */
export function namePrompt(name: string | undefined, args: string[], env: Env, cwd: string): string[] {
  if (name !== undefined || joinMode(env) === "manual" || args.some((arg) => /^--(append-)?system-prompt/.test(arg))) return []
  const handle = env.SCP_NAME || deriveHandle("claude-code", cwd)
  return [
    "--append-system-prompt",
    `You are on the SCP network as ${handle}. Pick a short descriptive name for yourself with \`${CLI_NAME} name <name>\` when you know what you're working on.`,
  ]
}

/** why Claude Code's scp mount cannot wake this session, with the fix, else undefined; user, local and project scopes count */
export function mountHint(env: Env, cwd: string = safeCwd()): string | undefined {
  const file = mcpFile("claude", env)
  const entries: Record<string, unknown>[] = []
  try {
    const user = mountedEntry("claude", file)
    if (user) entries.push(user)
    const config = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { projects?: Record<string, { mcpServers?: Record<string, unknown> }> }) : {}
    const local = config.projects?.[cwd]?.mcpServers?.scp
    if (local && typeof local === "object") entries.push(local as Record<string, unknown>)
  } catch {
    return `${CLI_NAME} claude: ${file} is unreadable, so the scp mount is unchecked; fix it or run ${CLI_NAME} setup --write`
  }
  const project = join(cwd, ".mcp.json")
  try {
    const entry = existsSync(project) ? mountedEntry("claude", project) : undefined
    if (entry) entries.push(entry)
  } catch {}
  if (!entries.length) return `${CLI_NAME} claude: Claude Code has no scp MCP mount, so messages cannot wake this session; run ${CLI_NAME} setup --write`
  if (!entries.some((entry) => entryArgv("claude", entry).includes("--channels")))
    return `${CLI_NAME} claude: the scp mount lacks --channels, so messages cannot wake this session; run ${CLI_NAME} setup --write`
  return undefined
}

type Agent = { id: string; sessionId?: string; name?: string; pid?: number; state?: string }

export type ClaudeDeps = {
  out?: (line: string) => void
  /** renames a local agent endpoint, as `swarm name --endpoint <from> <to>`; resolves with the exit code */
  rename?: (from: string, to: string) => Promise<number>
  attribute?: AttributeDeps
  bg?: ClaudeBgDeps
}

const SHORT_ID = /^[0-9a-f]{8}$/
const BACKGROUNDED = /backgrounded\s*\S\s*([0-9a-f]{8})/

/** claude's live background sessions, from `claude agents --json` */
function liveAgents(bin: string, env: Env): Agent[] {
  const run = spawnSync(bin, ["agents", "--json"], { env, encoding: "utf8", timeout: 15_000 })
  try {
    const listed = JSON.parse(run.stdout) as unknown
    return Array.isArray(listed) ? (listed as Agent[]).filter((agent) => typeof agent?.id === "string" && agent.state !== "failed") : []
  } catch {
    return []
  }
}

/**
 * the name, grant and parent request the scp mount of the background session `--resume` names ran with, from `<short id>.json`: a resumed
 * session, or a fork of it under a new id, claims them again rather than the caller's
 */
function priorMount(args: string[], env: Env): Record<"SCP_NAME" | "SCP_GRANT" | "SCP_UNDER", string> | undefined {
  const short = /^[0-9a-f]{8}/.exec(resumeTarget(args) ?? "")?.[0]
  if (!short) return undefined
  try {
    const vars = JSON.parse(readFileSync(join(bgDir(env), `${short}.json`), "utf8"))?.mcpServers?.scp?.env
    if (!vars || typeof vars !== "object") return undefined
    const of = (key: string) => (typeof vars[key] === "string" ? (vars[key] as string) : "")
    return { SCP_NAME: of("SCP_NAME"), SCP_GRANT: of("SCP_GRANT"), SCP_UNDER: of("SCP_UNDER") }
  } catch {
    return undefined
  }
}

/** whether claude's options resume or continue a stored session */
export const resumes = (args: string[]): boolean =>
  optionsOf(args).some((arg) => ["-c", "--continue", "-r", "--resume", "--from-pr"].includes(arg) || arg.startsWith("--resume="))

/** the session `--resume`/`-r` names among claude's options */
export function resumeTarget(args: string[]): string | undefined {
  const options = optionsOf(args)
  for (const [i, arg] of options.entries()) {
    if (arg.startsWith("--resume=")) return arg.slice("--resume=".length)
    if ((arg === "--resume" || arg === "-r") && options[i + 1] && !options[i + 1]!.startsWith("-")) return options[i + 1]
  }
  return undefined
}

/** runs claude with the terminal passed through; resolves with its exit code */
async function runClaude(
  bin: string,
  args: string[],
  env: Env,
  cwd: string,
  stdout: "inherit" | "pipe" = "inherit",
  onOut?: (text: string) => void,
): Promise<number> {
  const child = spawn(bin, args, { cwd, stdio: ["inherit", stdout, "inherit"], env })
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk)
    onOut?.(chunk.toString("utf8"))
  })
  const forward = (signal: NodeJS.Signals) => () => void child.kill(signal)
  const handlers = (["SIGTERM", "SIGHUP"] as const).map((signal) => [signal, forward(signal)] as const)
  const ignore = () => {}
  process.on("SIGINT", ignore)
  for (const [signal, handler] of handlers) process.on(signal, handler)
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve(code ?? (signal ? 128 + (signalNumber(signal) ?? 1) : 1)))
    })
  } finally {
    process.off("SIGINT", ignore)
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
}

/** `swarm claude --bg`: claude in the background with an scp mount that claims the name and the caller's grant, since the session's env is the daemon's */
async function backgroundCommand(
  name: string | undefined,
  args: string[],
  env: Env,
  cwd: string,
  bin: string,
  out: (line: string) => void,
  attribution?: Attribution,
): Promise<number> {
  const handle = name ?? (env.SCP_NAME || undefined)
  const dir = privateDir(bgDir(env))
  const file = join(dir, `${randomBytes(8).toString("hex")}.json`)
  writeFileSync(file, `${JSON.stringify({ mcpServers: { scp: bgMount(env, handle) } }, null, 2)}\n`, { mode: 0o600 })
  const options = optionsOf(args)
  const added = [
    ...(options.includes("--bg") || options.includes("--background") ? [] : ["--bg"]),
    ...(handle !== undefined && !options.some((arg) => arg === "-n" || arg === "--name" || arg.startsWith("--name=")) ? ["--name", handle] : []),
    ...namePrompt(handle, args, env, cwd),
    "--mcp-config",
    file,
  ]
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !LAUNCHER_IDENTITY.includes(key)))
  let printed = ""
  const code = await runClaude(bin, beforeDashes(args, added), clean, cwd, "pipe", (text) => {
    printed += text
  })
  const id = BACKGROUNDED.exec(printed)?.[1]
  if (!id) {
    unlinkSync(file)
    return code || 1
  }
  try {
    unlinkSync(join(dir, `${id}.json`))
  } catch {}
  symlinkSync(basename(file), join(dir, `${id}.json`))
  const address = `me/${handle ?? deriveHandle("claude-code", cwd)}`
  out(
    `${CLI_NAME} claude: background session ${id} is ${address} on SCP${underText(attribution)}; messages wake it through its inbox. ${CLI_NAME} claude attach ${id} opens it`,
  )
  return code
}

/** `swarm claude attach <id|name> [--name N]`: `claude attach`, renaming the session's endpoint first */
async function attachCommand(argv: string[], env: Env, err: (line: string) => void, cwd: string, bin: string, deps: ClaudeDeps): Promise<number> {
  let target: string | undefined
  let rename: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--name" || arg === "--as") {
      rename = argv[++i]
      if (rename === undefined) throw new RelayUsage(`${CLI_NAME} claude attach ${arg} takes a handle`)
    } else if (arg.startsWith("--name=") || arg.startsWith("--as=")) rename = arg.slice(arg.indexOf("=") + 1)
    else if (target === undefined) target = arg
    else throw new RelayUsage(`${CLI_NAME} claude attach takes one session: <id|name> [--name N]`)
  }
  if (target === undefined) throw new RelayUsage(`${CLI_NAME} claude attach takes a background session: <id|name> [--name N]`)
  rename = rename?.replace(/^me\//, "")
  if (rename !== undefined) {
    if (!validHandle(rename)) throw new RelayUsage(`--name ${JSON.stringify(rename)} is not a valid agent handle`)
    await renameBackground(target, rename, env, err, bin, deps)
  }
  return runClaude(bin, ["attach", target], env, cwd)
}

/** renames the endpoint of the background session `target` (its short id, or its name) to `to`, and the name its scp mount claims on resume */
async function renameBackground(target: string, to: string, env: Env, err: (line: string) => void, bin: string, deps: ClaudeDeps): Promise<void> {
  const agent = SHORT_ID.test(target) ? undefined : liveAgents(bin, env).find((a) => a.name === target || a.sessionId === target)
  const id = SHORT_ID.test(target) ? target : agent?.id
  const link = id ? join(bgDir(env), `${id}.json`) : undefined
  let config: { mcpServers?: { scp?: { env?: Record<string, string> } } } | undefined
  try {
    config = link ? JSON.parse(readFileSync(link, "utf8")) : undefined
  } catch {}
  const from = config?.mcpServers?.scp?.env?.SCP_NAME ?? (SHORT_ID.test(target) ? undefined : target)
  if (!link || !config?.mcpServers?.scp?.env || from === undefined) {
    err(`${CLI_NAME} claude: ${target} was not started by ${CLI_NAME} claude --bg --name, so its name is unknown; run ${CLI_NAME} name ${to} in it`)
    return
  }
  if (from === to) return
  const code = await (deps.rename ?? renameEndpoint)(from, to)
  if (code !== 0) {
    err(`${CLI_NAME} claude: me/${from} keeps its name`)
    return
  }
  config.mcpServers.scp.env.SCP_NAME = to
  writeFileSync(link, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

async function renameEndpoint(from: string, to: string): Promise<number> {
  return (await import("./main")).relayMain(["name", "--endpoint", `me/${from}`, to])
}

/** runs claude with the scp channel loaded and the terminal passed through, or in the background, or attached; resolves with its exit code */
export async function claudeCommand(
  argv: string[],
  env: Env = process.env,
  err: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
  cwd: string = safeCwd(),
  deps: ClaudeDeps = {},
): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(CLAUDE_HELP)
    return 0
  }
  const out = deps.out ?? ((line: string) => void process.stdout.write(`${line}\n`))
  const bin = whichOnPath("claude", env)
  if (argv[0] === "attach") {
    if (!bin) throw new RelayUsage("claude is not on PATH")
    return attachCommand(argv.slice(1), env, err, cwd, bin, deps)
  }
  if (argv[0] === "ls" || argv[0] === "prune") return (await import("./claude-bg")).claudeBgCommand(argv[0], argv.slice(1), env, out, deps.bg)
  const { name, bg, root, under, args } = claudeArgv(argv)
  if (!bin) throw new RelayUsage("claude is not on PATH")
  if (bg) {
    const attribution = await attribute("claude", { name, root, under, resume: resumes(args) }, env, cwd, err, deps.attribute)
    const prior = attribution || root ? undefined : priorMount(args, env)
    if (prior) return backgroundCommand(name ?? (prior.SCP_NAME || undefined), args, { ...env, ...prior }, cwd, bin, out)
    return backgroundCommand(name, args, attributed(env, attribution), cwd, bin, out, attribution)
  }
  const resume = resumeTarget(args)
  const live = resume === undefined ? undefined : liveAgents(bin, env).find((agent) => agent.id === resume || agent.sessionId === resume)
  if (live) {
    err(`${CLI_NAME} claude: ${resume} is a live background session, already woken through claude-inbox; attaching to it (claude attach ${live.id})`)
    return runClaude(bin, ["attach", live.id], env, cwd)
  }
  const external = externalMcp(args)
  const hint = external ? undefined : args.includes("--strict-mcp-config") ? STRICT_HINT : mountHint(env, cwd)
  if (hint) throw new RelayUsage(hint)
  if (external) err(`${CLI_NAME} claude: using your --mcp-config; it needs the scp server with --channels for messages to wake this session`)
  const launchEnv = attributed(env, await attribute("claude", { name, root, under, resume: resumes(args) }, env, cwd, err, deps.attribute))
  return runClaude(
    bin,
    claudeLaunchArgs(args, namePrompt(name, args, launchEnv, cwd)),
    {
      ...Object.fromEntries(Object.entries(launchEnv).filter(([key]) => !CLAUDE_SESSION_ENV.includes(key))),
      ...(name !== undefined ? { SCP_NAME: name } : {}),
      [CHANNELS_ENV]: String(process.pid),
    },
    cwd,
  )
}

const CLAUDE_HELP = `${CLI_NAME} claude [--name N | --as N] [--root] [--under ADDR] [--] [claude args...]   start Claude Code with the scp channel loaded, so peer messages wake it
${CLI_NAME} claude --bg [--name N] [--root] [--under ADDR] [--] [claude args...]   start it in the background (claude --bg) with an scp mount that claims N and
                                                 a grant, so it links under you; messages wake it through its inbox. Prints its short id and address
  --under ADDR links through the session claim to a local or cross-machine parent, without a grant; conflicts with --root.
  Run from an agent's shell, it links under that agent by itself, as under env $(${CLI_NAME} spawn-env --name N); a grant minted for
  it in $SCP_GRANT applies instead (your own spent grant is replaced), a resumed session keeps its place, --root starts it as a root
${CLI_NAME} claude attach <id|name> [--name N]    claude attach, renaming its endpoint to N first
  --resume <id> of a live background session attaches to it: it is already woken through claude-inbox
${CLI_NAME} claude ls [--all] [--json]          the background sessions (--all: stopped ones too), orchestrators first, with their SCP role
                                                 (orchestrator: a root or one with workers; worker; unknown: no endpoint), endpoint, policy
                                                 (kept: why, or due: stop or remove) and cwd
${CLI_NAME} claude prune [--dry-run] [--stop-only] [--older-than <dur>]   stop the idle workers ${CLI_NAME} claude --bg started
                                                 now, then remove the historic ones: never a root, the caller's own session, one with live
                                                 workers or subagents, or one claude attach holds, that is not exactly
                                                 idle or that still runs a Bash tool command (kept: running a background
                                                 command), though a session busy only polling its inbox in a loop counts as idle,
                                                 and never claude rm --discard-unpushed or --force-remove-worktree. --older-than
                                                 (30m, 2h, 1d) replaces the thresholds; --stop-only removes nothing. Needs the broker
${CLI_NAME} claude prune --unhibernate-unrecorded [--dry-run]   clear the claude-bg hibernation of the endpoints of the
                                                 sessions ${CLI_NAME} claude --bg did not start; stops, removes and respawns nothing
  The broker does the same on its own, for the workers ${CLI_NAME} claude --bg started: idle without work one stops after
  $SCP_CLAUDE_BG_IDLE_AFTER_S (config.json claude_bg.idle_after_s), else the shared $SCP_IDLE_AFTER_S (lifecycle.idle_after_s;
  600 s, Infinity never), a done (or handed back) one after
  $SCP_CLAUDE_BG_STOP_AFTER_S (120 s) when sooner, and it is removed once historic unless
  $SCP_CLAUDE_BG_REMOVE=0; config.json claude_bg {stop_after_s, remove} sets those. $SCP_HISTORIC_AFTER_S (historic_after_s) sets
  when an agent turns historic.
  A stopped or removed worker keeps its endpoint and mail: a message that arrives after the stop respawns it (unread mail
  it already had does not), or resumes it in its directory after a removal
`

const SIGNALS: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }
const signalNumber = (signal: NodeJS.Signals): number | undefined => SIGNALS[signal]
