import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  closeSync,
  existsSync,
  constants as files,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs"
import { constants, homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import {
  CLI_NAME,
  type EndpointView,
  type Envelope,
  PEEK,
  findSecret,
  HANDBACK_CUT,
  handbackOutput,
  keepLast,
  LIMITS,
  redactSecrets,
  steerNote,
  stripControl,
} from "@scp-dev/core"
import {
  type Identity,
  type Option,
  OPTIONS,
  SPAWN_OPTIONS,
  type Values,
  type Walk,
  grantParams,
  localClient,
  open,
  RelayUsage,
  selectorList,
  SPAWN_RUNNER,
  spawnEnvironment,
  walkNow,
} from "./common"
import {
  firstRun,
  framed,
  type Held,
  type HoldRef,
  holdClaim,
  holdEndpoint,
  holdLoop,
  idleSeconds,
  refProblem,
  type Resumable,
  resumable,
  resumeBase,
  resumeSession,
  SPAWN_IDLE_S,
  watchSignals,
  wokeBy,
} from "./hold"
import { steerPrompt } from "./hooks"
import { CODEX_VALUED, detectHarness, type MuseLaunch, processKey, spawnerKey, writeMuseLaunch } from "./identity"
import { readConversation } from "./resume"
import { agyRules, agySettingsFile, mcpFile, mountedEntry, whichOnPath } from "./setup"
import { SELF, note } from "./term"

export { SPAWN_HELP } from "./help-spawn"
export { SPAWN_RUNNER, spawnEnvironment } from "./common"
import { safeCwd } from "./cwd"

type Env = Record<string, string | undefined>
type Json = Record<string, unknown>

const SERVER = "scp"

/** what the relay MCP shim reads to claim its endpoint and find the broker; codex hands an MCP server only these when named in env_vars */
const SHIM_ENV = [
  "SCP_GRANT",
  "SCP_NAME",
  "SCP_UNDER",
  "SCP_LABELS",
  "SCP_DIR",
  "XDG_STATE_HOME",
  "SCP_SHIM_BINDING",
  "SCP_SESSION",
  "SCP_HARNESS_PID",
  "SCP_CODEX_THREAD",
]

/** codex's scp entry in its user config, if it has one */
export function codexMount(env: Env): Json | undefined {
  try {
    return mountedEntry("codex", mcpFile("codex", env))
  } catch {
    return undefined
  }
}

export function toml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value).replaceAll("\u007f", "\\u007f")
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`
  if (value && typeof value === "object")
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`)
      .join(", ")} }`
  return JSON.stringify(value)
}

/** Pass shim variables by name to keep the grant out of argv. Headless Codex needs tool approval unless the mount sets it. */
export function codexOverrides(env: Env, mount: Json | undefined, self: string[]): string[] {
  const kept = Array.isArray(mount?.env_vars) ? (mount.env_vars as unknown[]) : []
  const names = SHIM_ENV.filter((name) => env[name] !== undefined && !kept.includes(name))
  const key = (field: string) => `mcp_servers.${SERVER}.${field}`
  const set = (field: string, value: unknown) => ["-c", `${key(field)}=${toml(value)}`]
  return [
    ...(mount ? [] : [...set("command", self[0]), ...set("args", [...self.slice(1), "mcp", "--harness", "codex"])]),
    ...set("env_vars", [...kept, ...names]),
    ...set("enabled", true),
    ...(mount && "default_tools_approval_mode" in mount ? [] : set("default_tools_approval_mode", "approve")),
  ]
}

/** codex subcommands that start a session and take their own `-c`, which replaces the top-level ones */
const CODEX_SESSIONS = new Set(["exec", "e", "review", "resume", "fork"])

/** where in codex's arguments `-c` overrides go: first, and again after a session subcommand (and after exec's own resume or review, past exec's options) */
export function codexOverrideAt(args: string[]): number[] {
  let i = 0
  while (i < args.length && args[i]!.startsWith("-") && args[i] !== "--") i += CODEX_VALUED.has(args[i]!) ? 2 : 1
  if (i >= args.length || !CODEX_SESSIONS.has(args[i]!)) return [0]
  const at = [0, i + 1]
  if (args[i] === "exec" || args[i] === "e") {
    let j = i + 1
    while (j < args.length && args[j]!.startsWith("-") && args[j] !== "--") j += CODEX_EXEC_VALUED.has(args[j]!) ? 2 : 1
    if (args[j] === "resume" || args[j] === "review") at.push(j + 1)
  }
  return at
}

const ENV_VALUED = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])
const TIMEOUT_VALUED = new Set(["-s", "--signal", "-k", "--kill-after"])

/** where the program of a command starts, past `VAR=value` words and the wrappers env (and its flags), timeout [flags] N, nohup and nice [-n N] */
export function programAt(command: string[]): number {
  let i = 0
  const skipFlags = (valued: Set<string>) => {
    while (i < command.length && command[i]!.startsWith("-") && command[i] !== "--") i += valued.has(command[i]!) ? 2 : 1
    if (command[i] === "--") i++
  }
  while (i < command.length) {
    const word = command[i]!
    const name = basename(word)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) i++
    else if (name === "env") {
      i++
      skipFlags(ENV_VALUED)
    } else if (name === "nohup") i++
    else if (name === "nice") {
      i++
      skipFlags(new Set(["-n", "--adjustment"]))
    } else if (name === "timeout") {
      i++
      skipFlags(TIMEOUT_VALUED)
      i++
    } else break
  }
  return i
}

/** the relay tools a spawned worker messages with, as allow rules: never peek settings, groups or rules */
export const MESSAGING = [
  "relay_send",
  "relay_ask",
  "relay_ask_wait",
  "relay_reply",
  "relay_inbox",
  "relay_list",
  "relay_peers",
  "relay_whoami",
  "relay_set_status",
  "relay_set_now",
  "relay_set_title",
].map((tool) => `mcp__${SERVER}__${tool}`)

/** a headless run of a harness that refuses the relay tools without an allow rule, and the flags with which the user decides that instead */
const PRESETS: Record<string, { headless: string[]; own: string[]; allow: string[] }> = {
  claude: {
    headless: ["-p", "--print"],
    own: ["--allowedTools", "--allowed-tools", "--dangerously-skip-permissions", "--permission-mode"],
    allow: ["--allowedTools", ...MESSAGING],
  },
  grok: {
    headless: ["-p", "--single", "--prompt-file", "--prompt-json"],
    own: ["--allow", "--allowedTools", "--allowed-tools", "--always-approve", "--permission-mode"],
    allow: MESSAGING.flatMap((tool) => ["--allow", tool]),
  },
}

/** the allow rules for the relay messaging tools that a headless `harness` needs, unless `args` hold a flag with which the user decides that */
export function messagingAllow(harness: string, args: string[]): string[] {
  const preset = PRESETS[harness]
  return preset && !hasFlag(args, preset.own) ? preset.allow : []
}

/** muse's top-level options that take a value */
const MUSE_VALUED = new Set([
  "--agents",
  "--provider",
  "--preset",
  "--model",
  "--contributor-mode",
  "-c",
  "--config",
  "--reasoning-effort",
  "--effort",
  "--base-url",
  "--image",
  "--workspace",
  "--worktree-base",
  "--worktree-existing",
  "--approval-mode",
  "--permission-profile",
  "--approval-judge",
  "--sandbox-network",
  "--echo-delay-ms",
  "--prompt-file",
  "--session-id",
  "--context-compaction-strategy",
  "--context-compaction-soft-threshold",
  "--context-compaction-hard-threshold",
  "--output-schema",
  "--max-model-steps",
  "--max-tool-output-bytes",
])
export const MUSE_MODE = "--contributor-mode"

/** muse's options whose value is optional: the next word is theirs only when it is one of their values */
const MUSE_OPTIONAL: Record<string, Set<string>> = { "-w": new Set(["off", "create", "existing"]), "--worktree": new Set(["off", "create", "existing"]) }
const MUSE_CONFIG = new Set(["-c", "--config"])

/** the contributor modes a spawned muse may name: off, its default, or on, passed explicitly */
export const MUSE_MODES_ALLOWED: ReadonlySet<string> = new Set(["off", "on"])

/** where muse's options from `start` end: the index of its subcommand, its prompt or a `--` */
function museOptionsEnd(args: string[], start = 0): number {
  let i = start
  while (i < args.length && args[i]!.startsWith("-") && args[i] !== "--") {
    const word = args[i]!
    i += word.includes("=") ? 1 : MUSE_VALUED.has(word) || MUSE_OPTIONAL[word]?.has(args[i + 1] ?? "") ? 2 : 1
  }
  return i
}

const MUSE_SESSION = "--session-id"
/** muse exec's options a resume leaves out: the first prompt's file and images, the session id it sets itself, and a new worktree */
const MUSE_FIRST_ONLY = new Set(["--prompt-file", "--image", MUSE_SESSION, "-w", "--worktree", "--worktree-base", "--worktree-existing"])

/** one of muse's options, or its exec subcommand: where it is, how many words it takes, its flag and value */
type MuseOption = { at: number; size: number; flag: string; value?: string }

/** a headless `muse [opts] exec [opts] [prompt]` that logs its session: where exec is, where its options end, them read by arity, the session it names */
function museExec(args: string[]): { exec: number; end: number; options: MuseOption[]; session?: string } | undefined {
  const exec = museOptionsEnd(args)
  if (args[exec] !== "exec") return undefined
  const end = museOptionsEnd(args, exec + 1)
  const operands = args[end] === "--" ? args.slice(end + 1) : args.slice(end)
  if (operands.length > 1) return undefined
  const options: MuseOption[] = []
  for (let i = 0; i < end; ) {
    const word = args[i]!
    const eq = word.startsWith("-") ? word.indexOf("=") : -1
    const size = i === exec || eq > 0 ? 1 : MUSE_VALUED.has(word) || MUSE_OPTIONAL[word]?.has(args[i + 1] ?? "") ? 2 : 1
    const flag = eq > 0 ? word.slice(0, eq) : word
    options.push({ at: i, size, flag, ...(eq > 0 ? { value: word.slice(eq + 1) } : size === 2 ? { value: args[i + 1]! } : {}) })
    i += size
  }
  if (options.some((option) => option.flag === "--no-session-log" || option.flag === "--api-key-stdin")) return undefined
  const session = options.findLast((option) => option.flag === MUSE_SESSION)?.value
  return { exec, end, options, ...(session !== undefined ? { session } : {}) }
}

/** a muse exec spawn may resume: with its own session id, else with `--session-id <uuid>` after exec, the session returned */
export function museFirstRun(command: string[], uuid: () => string): { command: string[]; session: string } | undefined {
  const at = programAt(command)
  const run = museExec(command.slice(at + 1))
  if (!run) return undefined
  if (run.session !== undefined) return { command, session: run.session }
  const session = uuid()
  const exec = at + 1 + run.exec + 1
  return { command: [...command.slice(0, exec), MUSE_SESSION, session, ...command.slice(exec)], session }
}

/** a resumed muse exec's words before its prompt: its options without {@link MUSE_FIRST_ONLY}, then `--session-id <session>` */
export function museResumeBase(command: string[], session: string): string[] | undefined {
  const at = programAt(command)
  const args = command.slice(at + 1)
  const run = museExec(args)
  if (!run) return undefined
  const kept = run.options.flatMap((option) => (MUSE_FIRST_ONLY.has(option.flag) ? [] : args.slice(option.at, option.at + option.size)))
  return [...command.slice(0, at + 1), ...kept, MUSE_SESSION, session]
}

/** where muse's contributor mode goes: after exec, which takes its own, else right after the program */
function museModeAt(args: string[]): number {
  const i = museOptionsEnd(args)
  return args[i] === "exec" ? i + 1 : 0
}

/** a `-c` setting's JSON value as a mode: false is off, true on, a string itself, anything else its text */
function configMode(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed === false ? "off" : parsed === true ? "on" : typeof parsed === "string" ? parsed : value
  } catch {
    return value
  }
}

/** every contributor mode muse's words up to a `--` set, by --contributor-mode or a `-c` setting whose key names contributor mode; undefined for a bare flag */
export function museModes(args: string[]): (string | undefined)[] {
  const end = args.indexOf("--")
  const words = end < 0 ? args : args.slice(0, end)
  const modes: (string | undefined)[] = []
  for (const [i, word] of words.entries()) {
    if (word === MUSE_MODE) modes.push(words[i + 1])
    else if (word.startsWith(`${MUSE_MODE}=`)) modes.push(word.slice(MUSE_MODE.length + 1))
    const eq = word.indexOf("=")
    const setting = MUSE_CONFIG.has(word) ? words[i + 1] : eq > 0 && MUSE_CONFIG.has(word.slice(0, eq)) ? word.slice(eq + 1) : undefined
    const split = setting?.indexOf("=") ?? -1
    if (setting !== undefined && split > 0 && /contributor/i.test(setting.slice(0, split))) modes.push(configMode(setting.slice(split + 1)))
  }
  return modes
}

/** why `command` cannot run: a muse that sets its contributor mode to one {@link MUSE_MODES_ALLOWED} lacks; null for every other command */
export function contributorRefusal(command: string[]): string | null {
  const at = programAt(command)
  if (command[at] === undefined || basename(command[at]!) !== "muse") return null
  for (const mode of museModes(command.slice(at + 1))) {
    if (mode === undefined || !MUSE_MODES_ALLOWED.has(mode))
      return `${CLI_NAME} spawn: muse runs with ${MUSE_MODE} off or on, not ${mode === undefined ? "a bare flag" : JSON.stringify(mode)}`
  }
  return null
}

/** whether `args`, up to a `--`, hold one of `flags`, alone or as `--flag=value` */
function hasFlag(args: string[], flags: string[]): boolean {
  const end = args.indexOf("--")
  return (end < 0 ? args : args.slice(0, end)).some((arg) => flags.some((flag) => arg === flag || (flag.startsWith("--") && arg.startsWith(`${flag}=`))))
}

const SKIP_GIT = "--skip-git-repo-check"
/** how long spawn waits for `codex exec --help` */
const PROBE_MS = 3000
const probes = new Map<string, boolean>()

/** whether the codex at `program` lists --skip-git-repo-check in `codex exec --help`, asked once per program; false when it cannot tell in time */
export function codexSkipsGitCheck(program: string, env: Env): boolean {
  let takes = probes.get(program)
  if (takes === undefined) {
    const help = spawnSync(program, ["exec", "--help"], { env, encoding: "utf8", timeout: PROBE_MS, stdio: ["ignore", "pipe", "ignore"] })
    takes = help.status === 0 && help.stdout.includes(SKIP_GIT)
    probes.set(program, takes)
  }
  return takes
}

/** whether `dir` or a directory above it holds a .git, a repository's directory or a worktree's file */
function inGit(dir: string): boolean {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return true
    if (dirname(at) === at) return false
  }
}

/** Locate exec, its subcommand and operands, tracking the last working-directory override. */
function codexExec(args: string[]): { exec: number; sub?: { name: "resume" | "review"; at: number }; operands: string[]; cd?: string } | undefined {
  let cd: string | undefined
  const options = (from: number, valued: Set<string>) => {
    let i = from
    while (i < args.length && args[i]!.startsWith("-") && args[i] !== "--" && args[i] !== "-") {
      const word = args[i]!
      if (word === "-C" || word === "--cd") cd = args[i + 1]
      else if (word.startsWith("--cd=")) cd = word.slice(5)
      i += valued.has(word) ? 2 : 1
    }
    return i
  }
  const exec = options(0, CODEX_VALUED)
  if (args[exec] !== "exec" && args[exec] !== "e") return undefined
  let i = options(exec + 1, CODEX_EXEC_VALUED)
  const word = args[i]
  const sub: { name: "resume" | "review"; at: number } | undefined = word === "resume" || word === "review" ? { name: word, at: i } : undefined
  const operands: string[] = []
  for (i = sub ? i + 1 : i; i < args.length; i++) {
    i = options(i, CODEX_EXEC_VALUED)
    if (i >= args.length) break
    if (args[i] === "--") {
      operands.push(...args.slice(i + 1))
      break
    }
    operands.push(args[i]!)
  }
  return { exec, ...(sub ? { sub } : {}), operands, ...(cd !== undefined ? { cd } : {}) }
}

/** Codex exec reads stdin for absent or "-" prompts; argv prompts accept context through harnessStdin. */
export function closedStdin(command: string[]): boolean {
  const at = programAt(command)
  if (command[at] === undefined || basename(command[at]!) !== "codex") return false
  const args = command.slice(at + 1)
  const run = codexExec(args)
  if (!run || run.operands.includes("-")) return false
  if (run.sub?.name === "resume") return run.operands.length >= (hasFlag(args, ["--last"]) ? 1 : 2)
  return run.sub !== undefined || run.operands.length > 0
}

/** Time for an agent shell's pipe to provide data before falling back to /dev/null. */
export const STDIN_WAIT_MS = 300

/** The first chunk consumed while probing stdin, followed by the remaining stream. */
export type PipedStdin = { first: Buffer; rest: NodeJS.ReadableStream }

/** Inherit a nonempty file, forward a pipe with data, or use /dev/null for empty or idle input. */
export async function harnessStdin(waitMs?: number): Promise<"inherit" | "ignore" | PipedStdin> {
  if (process.stdin.isTTY === true) return "ignore"
  let stat: Stats
  try {
    stat = fstatSync(0)
  } catch {
    return "ignore"
  }
  if (stat.isFile()) return stat.size > 0 ? "inherit" : "ignore"
  if (!stat.isFIFO() && !stat.isSocket()) return "ignore"
  const input = process.stdin
  return new Promise((resolve) => {
    const settle = (result: "ignore" | PipedStdin) => {
      clearTimeout(timer)
      input.off("data", data)
      input.off("end", ended)
      input.off("error", ended)
      input.pause()
      resolve(result)
    }
    const data = (chunk: Buffer) => settle({ first: chunk, rest: input })
    const ended = () => settle("ignore")
    const timer = waitMs === undefined ? undefined : setTimeout(ended, waitMs)
    input.on("data", data)
    input.once("end", ended)
    input.once("error", ended)
  })
}

/** Add grant forwarding and messaging permissions while preserving wrappers and explicit harness permissions. */
export function harnessArgv(
  command: string[],
  env: Env,
  self: string[] = SELF,
  mount: (env: Env) => Json | undefined = codexMount,
  cwd: string = safeCwd(),
  probe: (program: string, env: Env) => boolean = codexSkipsGitCheck,
): string[] {
  const at = programAt(command)
  const program = command[at]
  const name = program === undefined ? undefined : basename(program)
  const args = command.slice(at + 1)
  const preset = name === undefined ? undefined : PRESETS[name]
  if (preset) {
    if (!hasFlag(args, preset.headless) || hasFlag(args, preset.own)) return command
    const end = args.indexOf("--")
    return end < 0 ? [...command, ...preset.allow] : [...command.slice(0, at + 1 + end), ...preset.allow, ...command.slice(at + 1 + end)]
  }
  if (name === "muse") {
    if (museModes(args).length) return command
    const mode = at + 1 + museModeAt(args)
    return [...command.slice(0, mode), MUSE_MODE, "off", ...command.slice(mode)]
  }
  if (name !== "codex") return command
  const run = codexExec(args)
  const skip = run && run.sub?.name !== "review" && !hasFlag(args, [SKIP_GIT]) && !inGit(resolve(cwd, run.cd ?? ".")) && probe(program!, env)
  const after = run && (run.sub?.at ?? run.exec) + 1
  const words = skip && after ? [...args.slice(0, after), SKIP_GIT, ...args.slice(after)] : args
  const overrides = codexOverrides(env, mount(env), self)
  const points = codexOverrideAt(words)
  return [
    ...command.slice(0, at + 1),
    ...words.flatMap((arg, i) => (points.includes(i) ? [...overrides, arg] : [arg])),
    ...(points.includes(words.length) ? overrides : []),
  ]
}

/** claude's options that take a value, so the word after one is no prompt */
const CLAUDE_VALUED = new Set([
  "--model",
  "--fallback-model",
  "--output-format",
  "--input-format",
  "--permission-mode",
  "--settings",
  "--setting-sources",
  "--mcp-config",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--tools",
  "--add-dir",
  "--append-system-prompt",
  "--system-prompt",
  "--session-id",
  "--resume",
  "-r",
  "--max-turns",
  "--agents",
  "--agent",
  "--plugin-dir",
  "--permission-prompt-tool",
  "--effort",
  "--betas",
])
/** codex exec's options that take a value */
const CODEX_EXEC_VALUED = new Set([...CODEX_VALUED, "--output-schema", "--color", "-o", "--output-last-message"])

/** Locate Claude print's last operand or Codex exec's first, skipping flag values and stdin prompts. */
function promptAt(command: string[]): { at: number; from?: number } | undefined {
  const at = programAt(command)
  const name = command[at] === undefined ? undefined : basename(command[at]!)
  const args = command.slice(at + 1)
  const end = args.indexOf("--")
  if (name === "claude") {
    if (!hasFlag(args, PRESETS.claude!.headless)) return undefined
    if (end >= 0) return end + 1 < args.length ? { at: at + args.length, from: at + end + 2 } : undefined
    for (let i = args.length - 1; i >= 0; i--)
      if (!args[i]!.startsWith("-") && !CLAUDE_VALUED.has(args[i - 1] ?? "")) return args[i] ? { at: at + 1 + i } : undefined
    return undefined
  }
  if (name !== "codex") return undefined
  let i = 0
  while (i < args.length && args[i]!.startsWith("-")) i += CODEX_VALUED.has(args[i]!) ? 2 : 1
  if (args[i] !== "exec" && args[i] !== "e") return undefined
  for (i++; i < args.length; i++) {
    const word = args[i]!
    if (word === "--") return args[i + 1] === "-" || !args[i + 1] ? undefined : { at: at + 2 + i }
    if (word.startsWith("-")) {
      if (CODEX_EXEC_VALUED.has(word)) i++
      continue
    }
    return word === "-" || word === "resume" || word === "review" || !word ? undefined : { at: at + 1 + i }
  }
  return undefined
}

/** codex exec's options that `codex exec resume` takes as well */
const RESUME_TAKES = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--strict-config",
  "-m",
  "--model",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
  "--output-schema",
  "--json",
  "-o",
  "--output-last-message",
])
/** codex exec's options a resume leaves out: images belong to the first prompt, and a new worktree or thread source to a new session */
const RESUME_DROPS = new Set(["-i", "--image", "--worktree", "--thread-source"])

/** Resume Codex exec with its existing options where resume accepts them; ephemeral sessions cannot resume. */
export function resumeArgv(command: string[], session: string, prompt: string): string[] | undefined {
  const found = promptAt(command)
  const at = programAt(command)
  if (!found || command[at] === undefined || basename(command[at]!) !== "codex") return undefined
  let exec = at + 1
  while (exec < command.length && command[exec]!.startsWith("-")) exec += CODEX_VALUED.has(command[exec]!) ? 2 : 1
  const before: string[] = []
  const after: string[] = []
  for (let i = exec + 1; i < command.length; i++) {
    const word = command[i]!
    if (i === found.at || word === "--") continue
    const eq = word.startsWith("--") ? word.indexOf("=") : -1
    const flag = eq > 0 ? word.slice(0, eq) : word
    const valued = eq < 0 && CODEX_EXEC_VALUED.has(flag)
    const value = eq > 0 ? word.slice(eq + 1) : valued ? command[i + 1] : undefined
    const words = valued ? command.slice(i, i + 2) : [word]
    if (valued) i++
    if (flag === "--ephemeral") return undefined
    if (flag === "-s" || flag === "--sandbox") after.push("-c", `sandbox_mode=${JSON.stringify(value ?? "")}`)
    else if (!RESUME_DROPS.has(flag)) (RESUME_TAKES.has(flag) ? after : before).push(...words)
  }
  return [...command.slice(0, exec + 1), ...before, "resume", ...after, session, prompt]
}

/** the prompt a headless harness starts with ({@link promptAt}): claude -p's words past `--` joined */
export function spawnPrompt(command: string[]): string | undefined {
  const found = promptAt(command)
  return found ? command.slice(found.from ?? found.at, found.at + 1).join(" ") || undefined : undefined
}

const STEER_KEY = /^[0-9a-z]{6}$/

/** the command with the broker's steer note appended to its prompt's word; unchanged without a prompt ({@link promptAt}) or a valid steer */
export function steerArgv(command: string[], steer: { key?: unknown; parent?: unknown } | undefined): string[] {
  const found = promptAt(command)
  if (!found || typeof steer?.key !== "string" || !STEER_KEY.test(steer.key) || typeof steer.parent !== "string" || !/^[^\s\]]+$/.test(steer.parent))
    return command
  return command.map((word, i) => (i === found.at ? `${word}${steerNote(steer.parent as string, steer.key as string)}` : word))
}

/** the title cap the broker enforces */
const TITLE_CHARS = 64

/** Redact the prompt's first nonempty line before clipping on a character boundary. */
export function spawnTitle(command: string[]): string | undefined {
  const first = spawnPrompt(command)
    ?.split("\n")
    .map((text) => stripControl(text).replace(/\s+/g, " ").trim())
    .find(Boolean)
  if (!first) return undefined
  const line = redactSecrets(first)
  const end = line.length > TITLE_CHARS && /[\ud800-\udbff]/.test(line[TITLE_CHARS - 1]!) ? TITLE_CHARS - 1 : TITLE_CHARS
  const title = line.slice(0, end).trim()
  return findSecret(title) ? undefined : title
}

const NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

function nameSuffix(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), (byte) => NAME_ALPHABET[byte % NAME_ALPHABET.length]).join("")
}

/** a worker's handle without --name: `<harness>-<5 random characters>`, the harness its program's basename as a valid handle */
export function workerName(command: string[], random: () => string = nameSuffix): string {
  const program = command[programAt(command)]
  const harness = (program === undefined ? "" : basename(program))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 57)
  return `${harness || "worker"}-${random()}`
}

/** a note for a headless agy whose settings lack the permission rules `swarm setup` writes: it denies the relay tools without them */
export function agyNote(command: string[], env: Env, verb = "spawn"): string | null {
  const at = programAt(command)
  const args = command.slice(at + 1)
  if (
    command[at] === undefined ||
    basename(command[at]!) !== "agy" ||
    !hasFlag(args, ["-p", "--print", "--prompt"]) ||
    hasFlag(args, ["--dangerously-skip-permissions"])
  )
    return null
  let allow: unknown
  try {
    allow = (JSON.parse(readFileSync(agySettingsFile(env), "utf8")) as { permissions?: { allow?: unknown } } | null)?.permissions?.allow
  } catch {}
  if (Array.isArray(allow) && agyRules().every((rule) => allow.includes(rule))) return null
  return `${CLI_NAME} ${verb}: headless agy denies the relay tools without the permission rules ${CLI_NAME} setup writes to ${agySettingsFile(env)}; run ${CLI_NAME} setup`
}

const FORWARDED = ["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP"] as const
/** how much of the harness's latest output a run keeps for its handback */
const TAIL_BYTES = 16 * 1024
/** how long after the harness exits its output may still drain, from a process it left holding the pipe */
const DRAIN_MS = 2000

export interface HarnessRun {
  code: number
  /** the last TAIL_BYTES bytes the harness wrote to stdout, empty unless captured */
  tail: Uint8Array
  /** whether output before the tail was dropped */
  cut: boolean
  /** the last TAIL_BYTES bytes the harness wrote to stderr, empty unless captured */
  err: Uint8Array
  /** whether stderr before its tail was dropped */
  errCut: boolean
  /** whether the harness started at all */
  started: boolean
}

/** a pipe's last TAIL_BYTES bytes, as it writes them on to `to` unchanged, pausing for `to` to drain */
function tee(from: NodeJS.ReadableStream, to: NodeJS.WritableStream): { bytes: () => Uint8Array; cut: () => boolean } {
  let tail = Buffer.alloc(0)
  let cut = false
  from.on("data", (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk])
    if (tail.length > TAIL_BYTES) {
      tail = tail.subarray(tail.length - TAIL_BYTES)
      cut = true
    }
    if (!to.write(chunk)) {
      from.pause()
      to.once("drain", () => from.resume())
    }
  })
  return { bytes: () => new Uint8Array(tail), cut: () => cut }
}

/** for a muse process `pid`, whose shim and hooks Muse starts without SCP_* variables: a launch file with the run's identity, and its remover */
function museLaunchFile(argv: string[], env: Record<string, string>, pid: number | undefined): () => void {
  const program = argv[programAt(argv)]
  if (!pid || program === undefined || basename(program) !== "muse" || (!env.SCP_NAME && !env.SCP_GRANT)) return () => {}
  const launcher = Number(env.SCP_HARNESS_PID)
  const launch: MuseLaunch = {
    ...(env.SCP_NAME ? { name: env.SCP_NAME } : {}),
    ...(env.SCP_GRANT ? { grant: env.SCP_GRANT } : {}),
    ...(env.SCP_SESSION ? { session: env.SCP_SESSION } : {}),
    ...(Number.isInteger(launcher) && launcher > 1 ? { launcher: processKey(launcher) } : {}),
  }
  try {
    return writeMuseLaunch(processKey(pid), launch, env)
  } catch {
    return () => {}
  }
}

/** Tee captured output, retain its tail and forward signals. Detached harnesses lead a process group; terminal Ctrl-C already reaches it. */
export function runHarness(
  argv: string[],
  env: Record<string, string>,
  options: {
    capture?: boolean
    out?: NodeJS.WritableStream
    captureErr?: boolean
    err?: NodeJS.WritableStream
    stdin?: "inherit" | "ignore" | PipedStdin
    started?: (failed?: { message: string; code: number }) => void
    group?: boolean
  } = {},
): Promise<HarnessRun> {
  const capture = options.capture ?? process.stdout.isTTY !== true
  const captureErr = options.captureErr ?? process.stderr.isTTY !== true
  const out = options.out ?? process.stdout
  return new Promise((resolve) => {
    const tty = process.stdin.isTTY === true
    const group = options.group === true && !tty && process.stdout.isTTY !== true && process.stderr.isTTY !== true
    const input = options.stdin ?? "inherit"
    const piped = typeof input === "object" ? input : undefined
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: [typeof input === "object" ? "pipe" : input, capture ? "pipe" : "inherit", captureErr ? "pipe" : "inherit"],
      env,
      detached: group,
    })
    const unlaunch = museLaunchFile(argv, env, child.pid)
    if (piped && child.stdin) {
      child.stdin.on("error", () => {})
      child.stdin.write(piped.first)
      piped.rest.pipe(child.stdin)
    }
    const pipes = [child.stdout, child.stderr].filter((pipe) => pipe !== null)
    const stdout = child.stdout ? tee(child.stdout, out) : undefined
    const stderr = child.stderr ? tee(child.stderr, options.err ?? process.stderr) : undefined
    let open = pipes.length
    let settled = false
    let started = false
    const drained: (() => void)[] = []
    for (const pipe of pipes) {
      pipe.once("close", () => {
        if (--open === 0) for (const fn of drained.splice(0)) fn()
      })
    }
    const handlers = FORWARDED.map((signal) => {
      const handler = () => {
        if (tty && (signal === "SIGINT" || signal === "SIGQUIT")) return
        if (child.exitCode !== null || child.signalCode !== null) return
        try {
          if (group && child.pid) process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch {}
      }
      process.on(signal, handler)
      return [signal, handler] as const
    })
    const done = async (code: number) => {
      if (settled) return
      settled = true
      unlaunch()
      if (open > 0) {
        const timer = setTimeout(() => {
          for (const pipe of pipes) pipe.destroy()
        }, DRAIN_MS)
        await new Promise<void>((next) => (open === 0 ? next() : drained.push(next)))
        clearTimeout(timer)
      }
      if (capture) await new Promise<void>((next) => out.write("", () => next()))
      for (const [signal, handler] of handlers) process.off(signal, handler)
      resolve({
        code,
        tail: stdout?.bytes() ?? new Uint8Array(),
        cut: stdout?.cut() ?? false,
        err: stderr?.bytes() ?? new Uint8Array(),
        errCut: stderr?.cut() ?? false,
        started,
      })
    }
    child.once("spawn", () => {
      started = true
      options.started?.()
    })
    child.once("error", (error: NodeJS.ErrnoException) => {
      const failed = {
        message: `${CLI_NAME} spawn: ${argv[0]}: ${error.code === "ENOENT" ? "command not found" : error.message}`,
        code: error.code === "ENOENT" ? 127 : 126,
      }
      if (options.started) options.started(failed)
      else note(failed.message)
      void done(failed.code)
    })
    child.once("exit", (code, signal) => void done(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)))
  })
}

/** Decode from a whole UTF-8 character, then clean, redact and cap the output tail. */
export function harnessOutput(run: Pick<HarnessRun, "tail" | "cut">, bytes?: number): string {
  let start = 0
  if (run.cut) while (start < run.tail.length && (run.tail[start]! & 0xc0) === 0x80) start++
  return handbackOutput(new TextDecoder().decode(run.tail.subarray(start)), run.cut, bytes)
}

const EARLIER_STDERR = "[earlier stderr cut]"

/** Keep the cleaned stderr tail from a line or character boundary, marking earlier output that was cut. */
export function stderrOutput(run: Pick<HarnessRun, "err" | "errCut">, bytes: number = LIMITS.stderrBytes): string {
  let start = 0
  if (run.errCut) while (start < run.err.length && (run.err[start]! & 0xc0) === 0x80) start++
  const text = new TextDecoder().decode(run.err.subarray(start))
  const clean = handbackOutput(run.errCut ? text.slice(text.indexOf("\n") + 1) : text, false, Number.MAX_SAFE_INTEGER)
  const encoded = new TextEncoder().encode(clean)
  if (encoded.length <= bytes) return run.errCut && clean ? `${EARLIER_STDERR}\n${clean}` : clean
  let from = encoded.length - bytes
  const line = encoded.indexOf(0x0a, from - 1)
  if (line >= 0 && line + 1 < encoded.length) from = line + 1
  else while (from < encoded.length && (encoded[from]! & 0xc0) === 0x80) from++
  return `${EARLIER_STDERR}\n${new TextDecoder().decode(encoded.subarray(from))}`
}

/** how much of a transcript's end spawn reads */
const TRANSCRIPT_BYTES = 4 * 1024 * 1024
/** what follows a reply the model's output limit cut off */
const LIMIT_CUT = "[reply cut at the model's output limit]"

/** whether a transcript's user entry is a prompt: text from the user, not a tool result, hook feedback or a compaction summary */
function prompted(entry: Json, content: unknown): boolean {
  if (entry.isMeta === true || entry.isCompactSummary === true || entry.toolUseResult !== undefined) return false
  const blocks = Array.isArray(content) ? content : [content]
  if (blocks.some((block) => (block as Json | null)?.type === "tool_result")) return false
  const texts = blocks.map((block) => (typeof block === "string" ? block : (block as Json | null)?.type === "text" ? (block as Json).text : undefined))
  return texts.some((text) => typeof text === "string" && text.trim() !== "" && !text.startsWith("Stop hook feedback"))
}

/** where Claude Code keeps its transcripts: projects/ under $CLAUDE_CONFIG_DIR, else ~/.claude */
export function claudeTranscripts(env: Env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "projects")
}

/** Read the last transcript bytes from a regular, unlinked session file under root. Keep assistant replies since its last prompt. */
export function transcriptReplies(path: string, session: string, root: string, bytes = TRANSCRIPT_BYTES): string[] {
  if (!isAbsolute(path) || basename(path) !== `${session}.jsonl`) return []
  try {
    if (!realpathSync(path).startsWith(realpathSync(root) + sep)) return []
  } catch {
    return []
  }
  let text: string
  let start: number
  let fd: number | undefined
  try {
    fd = openSync(path, files.O_RDONLY | files.O_NOFOLLOW | files.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile()) return []
    start = Math.max(0, stat.size - bytes)
    const buffer = Buffer.alloc(stat.size - start)
    text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, start)).toString("utf8")
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  let replies: string[] = start > 0 ? [HANDBACK_CUT] : []
  for (const line of text.split("\n").slice(start > 0 ? 1 : 0)) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== "object" || (entry as Json).isSidechain === true || (entry as Json).sessionId !== session) continue
    const message = (entry as Json).message
    const content = message && typeof message === "object" ? (message as Json).content : undefined
    if ((entry as Json).type === "user" && prompted(entry as Json, content)) replies = []
    if ((entry as Json).type !== "assistant") continue
    const before = replies.length
    for (const block of Array.isArray(content) ? content : [content]) {
      const reply = typeof block === "string" ? block : (block as Json | null)?.type === "text" ? (block as Json).text : undefined
      if (typeof reply === "string" && reply.trim()) replies.push(reply)
    }
    if (replies.length > before && (message as Json).stop_reason === "max_tokens") replies.push(`${replies.pop()}\n${LIMIT_CUT}`)
  }
  return replies
}

/** Drop restated reports, keep the newest whole replies within the byte cap, and return empty for marker-only output. */
export function repliesOutput(replies: string[], bytes: number = LIMITS.handbackBytes): string {
  const lines = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  const all = replies.map((reply) => handbackOutput(reply.replace(/\r\n?/g, "\n"), false, Number.MAX_SAFE_INTEGER)).filter(Boolean)
  const restated = (text: string, later: string) => lines(text).length >= 2 && lines(text).every((line) => lines(later).includes(line))
  const clean = all.filter((text, i) => text === HANDBACK_CUT || !all.slice(i + 1).some((later) => restated(text, later)))
  if (clean.every((text) => text === HANDBACK_CUT)) return ""
  const size = (text: string) => new TextEncoder().encode(text).length
  const framed = (from: number) => {
    const text = clean.slice(from).join("\n\n")
    return from > 0 ? `${HANDBACK_CUT}\n\n${text}` : text
  }
  let fit: string | undefined
  for (let from = clean.length - 1; from >= 0 && size(framed(from)) <= bytes; from--) fit = framed(from)
  if (fit !== undefined) return fit
  return keepLast(clean.at(-1)!, bytes, clean.length > 1)
}

/** `swarm spawn`'s words: its flags, then the harness command after `--` or, without one, from the first word that is no flag or flag value */
export function splitSpawn(args: string[]): { flags: string[]; command: string[] } {
  let i = 0
  while (i < args.length && args[i]!.startsWith("-") && args[i] !== "--") {
    const flag = args[i]!
    const option = flag.startsWith("--") && !flag.includes("=") ? OPTIONS[flag.slice(2) as Option] : undefined
    i += option?.type === "string" ? 2 : 1
  }
  return { flags: args.slice(0, i), command: args.slice(args[i] === "--" ? i + 1 : i) }
}

/** Default to parent reach, retaining access to the spawner under --under and to each group unless scope flags override it. */
export function spawnDefaults(values: Values, command: string[], random?: () => string, spawner?: string): Values {
  const scoped = (["scope", "rules", "in", "out", "allow"] as const).some((key) => values[key] !== undefined)
  const under = typeof values.under === "string" ? values.under : undefined
  const reach = [
    ...(spawner && under && under.replace(/^me\//, "") !== spawner ? [`ep:${spawner}`] : []),
    ...(selectorList(values.group) ?? []).map((group) => `group:${group}`),
  ]
  const title = values.title === undefined ? spawnTitle(command) : undefined
  return {
    ...values,
    ...(scoped ? {} : { scope: "parent", ...(reach.length ? { allow: reach } : {}) }),
    ...(title ? { title } : {}),
    ...(values.name === undefined ? { name: workerName(command, random) } : {}),
  }
}

/** `--handback-bytes <n>`: whole bytes, 1 to ${LIMITS.handbackBytes} */
function handbackBytes(value: string): number {
  const bytes = /^\d+$/.test(value) ? Number(value) : 0
  if (bytes < 1 || bytes > LIMITS.handbackBytes) throw new RelayUsage(`--handback-bytes takes whole bytes, 1 to ${LIMITS.handbackBytes}`)
  return bytes
}

/** how many times spawn resumes a codex exec worker that exited 0 for its parent's messages that came after its last step */
const STEER_RESUMES = 2

/** what a detached spawn's runner tells the spawn that started it, once: the worker started, or why it did not */
type Handshake = { name: string; pid: number } | { error: string; usage?: true; code?: number }

/** Mint a process-bound grant, run or detach the harness, apply late steers and hand its result back. */
export async function spawnCommand(args: string[], cwd: string): Promise<number> {
  const parsed = parseSpawn(args)
  let values = parsed.values
  const { command } = parsed
  const bytes = values["handback-bytes"] === undefined ? undefined : handbackBytes(values["handback-bytes"] as string)
  if (!values.help) durableCheck(values, command, cwd)
  const runner = process.env[SPAWN_RUNNER]
  delete process.env[SPAWN_RUNNER]
  if (typeof values.via === "string") return (await import("./remote-spawn")).viaSpawn(values, command, cwd)
  if (
    runner === undefined &&
    (values.bg === true || (values.fg !== true && (process.stdout.isTTY !== true || (process.stdin.isTTY !== true && agentShell(process.env)))))
  )
    return detachSpawn(args, cwd)
  const channel = runner === undefined ? undefined : handshakeChannel()
  const handshake =
    channel === undefined
      ? undefined
      : once((reply: Handshake) => {
          try {
            writeSync(channel, `${JSON.stringify(reply)}\n`)
            closeSync(channel)
          } catch {}
        })
  if (typeof values.under === "string") {
    const remote = await import("./remote-spawn")
    let plan: Awaited<ReturnType<typeof remote.linkedPlan>>
    try {
      plan = await remote.linkedPlan(values, command)
    } catch (error) {
      handshake?.({ error: error instanceof Error ? error.message : String(error), ...(error instanceof RelayUsage ? { usage: true as const } : {}) })
      throw error
    }
    if (plan) {
      const name = plan.name
      const started =
        handshake &&
        ((failed?: { message: string; code: number }) => handshake(failed ? { error: failed.message, code: failed.code } : { name, pid: process.pid }))
      return remote.linkedSpawn(plan, command, cwd, { group: runner !== undefined, ...(started ? { started } : {}), ...(bytes !== undefined ? { bytes } : {}) })
    }
  }
  const bound = spawnerKey()
  const prompt = values.peek === undefined ? undefined : spawnPrompt(command)?.slice(0, PEEK.rawChars)
  const walk = runner === undefined ? walkNow() : (JSON.parse(runner) as Walk)
  let grant: Record<string, string>
  let steer: { key?: unknown; parent?: unknown } | undefined
  try {
    const opened = await open("spawn", values as Identity, cwd, false, walk)
    const { me } = opened
    const client = localClient(opened.client, opened.broker, "spawn")
    try {
      values = spawnDefaults(values, command, undefined, me?.kind === "agent" && me.address.startsWith("me/") ? me.address.slice(3) : undefined)
      const params = { ttl_s: SPAWN_GRANT_TTL_S, ...grantParams(values), ...(bound ? { bind_process: bound } : {}), spawn: true, ...(prompt ? { prompt } : {}) }
      const granted = await client.grant(params)
      grant = granted.env
      steer = granted.steer
    } finally {
      client.close()
    }
  } catch (error) {
    handshake?.({ error: error instanceof Error ? error.message : String(error), ...(error instanceof RelayUsage ? { usage: true as const } : {}) })
    throw error
  }
  const name = values.name as string
  const env = spawnEnvironment(process.env, grant, values.labels as string | undefined)
  const agy = agyNote(command, process.env)
  if (agy) note(agy)
  const started =
    handshake && ((failed?: { message: string; code: number }) => handshake(failed ? { error: failed.message, code: failed.code } : { name, pid: process.pid }))
  const launch = (argv: string[], extra: Parameters<typeof runHarness>[2] = {}, runEnv: Record<string, string> = env) =>
    runHarness(harnessArgv(argv, runEnv), runEnv, { group: runner !== undefined, ...(closedStdin(argv) ? { stdin: "ignore" as const } : {}), ...extra })
  const idleS = spawnIdle(values, runner !== undefined)
  const harness = idleS > 0 ? resumable(command) : undefined
  const signals = harness ? watchSignals() : undefined
  const agyDir = harness === "agy" ? mkdtempSync(join(tmpdir(), "scp-spawn-agy-")) : undefined
  if (agyDir) env.SCP_AGY_CONVERSATION_FILE = join(agyDir, "conversation")
  try {
    const opening = harness ? firstRun(command) : { command }
    const first = steerArgv(opening.command, steer)
    const stdin = closedStdin(first) ? await harnessStdin(agentShell(process.env) ? STDIN_WAIT_MS : undefined) : undefined
    let run = await launch(first, { ...(started ? { started } : {}), ...(stdin ? { stdin } : {}) })
    if (!run.started) {
      await spawnExit(values, cwd, grant.SCP_GRANT!, run.code, name, "", walk, [], [], false)
      return run.code
    }
    const exits = [Date.now()]
    let unapplied: string[] = []
    for (let round = 0; round < STEER_RESUMES && run.code === 0 && resumeArgv(command, "", ""); round++) {
      const pending = await spawnSteers(values, cwd, grant.SCP_GRANT!, walk, true)
      if (!pending?.session || !pending.steers.length) break
      const resumed = await launch(resumeArgv(command, pending.session, steerPrompt(pending.steers))!)
      exits.push(Date.now())
      if (resumed.code !== 0) {
        unapplied = pending.steers.map((message) => message.id)
        break
      }
      run = resumed
    }
    const worker = await spawnSteers(values, cwd, grant.SCP_GRANT!, walk, false)
    const replies =
      worker?.session && worker.transcript ? repliesOutput(transcriptReplies(worker.transcript, worker.session, claudeTranscripts(process.env)), bytes) : ""
    const session =
      harness && worker?.joined && !signals?.caught()
        ? resumeSession(
            command,
            harness === "agy" ? readConversation(env.SCP_AGY_CONVERSATION_FILE) : harness === "grok" || harness === "muse" ? opening.session : worker.session,
          )
        : undefined
    const held = session
      ? await holdWorker({ command, harness: harness!, session, name, cwd, walk, grant: grant.SCP_GRANT!, env, idleS, durable: values.durable === true })
      : undefined
    await spawnExit(values, cwd, grant.SCP_GRANT!, run.code, name, replies || harnessOutput(run, bytes), walk, unapplied, exits, true, stderrOutput(run))
    if (held && signals) {
      let n = 1
      await holdLoop(held.held, {
        idleS,
        signals,
        resume: async (messages) => {
          const resumed = await launch([...held.base, framed(messages)], { stdin: "ignore" }, held.env)
          const woke = wokeBy(messages)
          await spawnExit(values, cwd, grant.SCP_GRANT!, resumed.code, name, harnessOutput(resumed, bytes), walk, [], [], true, stderrOutput(resumed), {
            run: ++n,
            ...(woke ? { reply_to: woke } : {}),
          })
        },
      })
    }
    return run.code
  } finally {
    signals?.stop()
    if (agyDir) rmSync(agyDir, { recursive: true, force: true })
  }
}

/** how long spawn holds a worker it can resume: --idle, else ${SPAWN_IDLE_S} s when detached or --durable, else (in the foreground) not at all */
function spawnIdle(values: Values, detached: boolean): number {
  if (typeof values.idle === "string") return idleSeconds(values.idle)
  return detached || values.durable === true ? SPAWN_IDLE_S : 0
}

/** holds a worker's endpoint for resumed runs of its harness session, durably with `durable`: the held connection, the resume's words and environment */
async function holdWorker(options: {
  command: string[]
  harness: Resumable
  session: string
  name: string
  cwd: string
  walk: Walk
  grant: string
  env: Record<string, string>
  idleS: number
  durable: boolean
}): Promise<{ held: Held; base: string[]; env: Record<string, string> } | undefined> {
  const base = resumeBase(options.command, options.session)
  if (!base) return undefined
  const cwd = resolve(options.cwd)
  const durable = (endpoint: EndpointView) => {
    if (!options.durable || !endpoint.parent) return undefined
    const ref = durableRef(options.harness, options.session, cwd, base, options.idleS, endpoint.parent, options.env)
    const problem = refProblem(ref)
    if (problem) note(`${CLI_NAME} spawn: ${options.name} is held, not durably: ${problem}`)
    return problem ? undefined : ref
  }
  const key = randomBytes(16).toString("hex")
  const claim = holdClaim({
    name: options.name,
    harness: options.harness,
    cwd,
    session: key,
    lineage: options.walk.keys,
    grant: options.grant,
    env: options.env,
  })
  const held = await holdEndpoint(claim, durable, note)
  return held ? { held, base, env: { ...options.env, SCP_SESSION: key, SCP_HARNESS_PID: String(process.pid) } } : undefined
}

/** a durable spawn's hibernation ref ({@link HoldRef}), its program found on PATH so the broker's waker runs the same binary */
function durableRef(
  harness: Resumable,
  session: string,
  cwd: string,
  base: string[],
  idleS: number,
  parent: string,
  env: Record<string, string | undefined>,
): string {
  const at = programAt(base)
  const program = base[at]!.includes("/") ? resolve(cwd, base[at]!) : (whichOnPath(base[at]!, env) ?? base[at]!)
  const argv = base.map((word, i) => (i === at ? program : word))
  return JSON.stringify({ harness, session, cwd, argv, idle_s: Number.isFinite(idleS) ? idleS : null, parent } satisfies HoldRef)
}

/** `--durable`: a command spawn can resume whose resume fits a hibernation ref, and an idle timeout that holds it at all */
function durableCheck(values: Values, command: string[], cwd: string): void {
  if (typeof values.idle === "string") idleSeconds(values.idle)
  if (values.durable !== true) return
  if (typeof values.idle === "string" && idleSeconds(values.idle) === 0) throw new RelayUsage("--durable holds the worker: it does not go with --idle 0")
  const harness = resumable(command)
  const base = harness ? resumeBase(command, "0".repeat(64)) : undefined
  if (!harness || !base)
    throw new RelayUsage(
      "--durable resumes a headless session: codex exec, agy -p, grok -p with its prompt in the command (codex not --ephemeral), or muse exec with a session log",
    )
  const problem = refProblem(durableRef(harness, "0".repeat(64), resolve(cwd), base, SPAWN_IDLE_S, `me/${"x".repeat(63)}`, process.env))
  if (problem) throw new RelayUsage(`--durable cannot keep this worker: ${problem}`)
}

/** Validate spawn flags and the harness command before starting a runner. */
function parseSpawn(args: string[]): { values: Values; command: string[] } {
  const split = splitSpawn(args)
  let values: Values
  try {
    values = parseArgs({ args: split.flags, options: OPTIONS, strict: true }).values as Values
  } catch (error) {
    throw new RelayUsage(error instanceof Error ? error.message : String(error))
  }
  if (values.help) return { values, command: split.command }
  for (const key of Object.keys(values) as Option[])
    if (!SPAWN_OPTIONS.includes(key) && !(key === "json" && values.via !== undefined)) throw new RelayUsage(`${CLI_NAME} spawn does not take --${key}`)
  if (values.bg && values.fg) throw new RelayUsage("--bg and --fg: pick one")
  const command = split.command
  if (!command.length)
    throw new RelayUsage(`${CLI_NAME} spawn runs a harness command: ${CLI_NAME} spawn [flags] [--] <harness cmd...>, e.g. ${CLI_NAME} spawn codex exec "..."`)
  const refusal = contributorRefusal(command)
  if (refusal) throw new RelayUsage(refusal)
  if (values["handback-bytes"] !== undefined) handbackBytes(values["handback-bytes"] as string)
  return { values, command }
}

/** Start a detached worker for a caller such as MCP, returning its name and runner pid after the harness starts. */
export async function spawnDetached(args: string[], cwd: string): Promise<{ name: string; pid: number }> {
  const { values } = parseSpawn(args)
  if (values.help || values.fg) throw new RelayUsage("a detached spawn takes no --help or --fg")
  const reply = await detachedRunner(args, cwd)
  if ("error" in reply) throw new Error(reply.error)
  return reply
}

/** an agent's shell: a harness's environment markers or a relay identity in the environment (spawn also needs stdin not a terminal) */
export function agentShell(env: NodeJS.ProcessEnv): boolean {
  return detectHarness(env) !== undefined || ["SCP_NAME", "SCP_GRANT", "SCP_SESSION"].some((key) => env[key])
}

/** the runner's handshake fd: fd 3 reopened close-on-exec and the inherited one closed, so no harness inherits it; fd 3 where that fails */
function handshakeChannel(): number {
  try {
    const fd = openSync("/dev/fd/3", "w")
    closeSync(3)
    return fd
  } catch {
    return 3
  }
}

/** `fn` that runs only on its first call */
function once<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let done = false
  return (...args) => {
    if (done) return
    done = true
    fn(...args)
  }
}

/** Re-exec with the caller's walk and no caller stdio. Return once the private handshake confirms the harness started. */
async function detachSpawn(args: string[], cwd: string): Promise<number> {
  const reply = await detachedRunner(args, cwd)
  if ("error" in reply) {
    note(reply.error)
    return reply.code
  }
  console.log(
    `${reply.name} started (pid ${reply.pid}) and runs in the background: its result arrives as a relay message by itself; steer it with ${CLI_NAME} send ${reply.name} <text>`,
  )
  return 0
}

/** The runner handshake, shared by shell and MCP spawns. */
async function detachedRunner(args: string[], cwd: string): Promise<{ name: string; pid: number } | { error: string; code: number }> {
  const walk = walkNow()
  const child = spawn(SELF[0]!, [...SELF.slice(1), "spawn", ...args], {
    cwd,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe"],
    env: { ...process.env, [SPAWN_RUNNER]: JSON.stringify(walk) },
  })
  const channel = child.stdio[3] as NodeJS.ReadableStream & { destroy(): void }
  const line = await new Promise<string>((resolve) => {
    let text = ""
    channel.on("data", (chunk: Buffer) => {
      text += chunk.toString()
      if (text.includes("\n")) resolve(text.slice(0, text.indexOf("\n")))
    })
    channel.once("end", () => resolve(text))
    child.once("error", () => resolve(""))
  })
  channel.destroy()
  child.unref()
  let reply: Handshake | undefined
  try {
    reply = JSON.parse(line) as Handshake
  } catch {}
  if (!reply) throw new Error(`${CLI_NAME} spawn: the detached runner ended before the harness started`)
  if ("error" in reply) {
    if (reply.usage) throw new RelayUsage(reply.error)
    if (reply.code === undefined) throw new Error(reply.error)
    return { error: reply.error, code: reply.code }
  }
  return reply
}

/** a worker's harness session, its transcript and its spawner's unread steers to it, with `take` taken; undefined from a broker without spawn_steers or on a failure */
async function spawnSteers(
  values: Values,
  cwd: string,
  token: string,
  walk: Walk,
  take: boolean,
): Promise<{ session: string | null; steers: Envelope[]; transcript?: string | null; joined?: boolean } | undefined> {
  try {
    const opened = await open("spawn", values as Identity, cwd, false, walk)
    const client = localClient(opened.client, opened.broker, "spawn")
    try {
      return await client.spawnSteers({ grant: token, take })
    } finally {
      client.close()
    }
  } catch {
    return undefined
  }
}

/** Report exit, unapplied steers and output using the original walk, even after the caller's shell exits. */
async function spawnExit(
  values: Values,
  cwd: string,
  token: string,
  code: number,
  name: string,
  output: string,
  walk: Walk,
  unapplied: string[] = [],
  exits: number[] = [],
  started = true,
  stderr = "",
  later: { run?: number; reply_to?: string } = {},
): Promise<void> {
  try {
    const opened = await open("spawn", values as Identity, cwd, false, walk)
    const client = localClient(opened.client, opened.broker, "spawn")
    try {
      await client.spawnExit({
        ...later,
        grant: token,
        code: Math.min(code, 255),
        ...(output ? { output } : {}),
        ...(stderr ? { stderr } : {}),
        ...(unapplied.length ? { unapplied } : {}),
        ...(exits.length ? { exits } : {}),
        ...(started ? {} : { started: false }),
      })
    } finally {
      client.close()
    }
  } catch (error) {
    note(`${CLI_NAME} spawn: could not mark ${name} as exited: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const SPAWN_GRANT_TTL_S = 3600
