import { spawnSync } from "node:child_process"
import { CLI_NAME } from "@scp-dev/core"
import { parse } from "smol-toml"
import { createHash } from "node:crypto"
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { TOOLS } from "@scp-dev/mcp"
import { RelayUsage } from "./common"
import {
  AGY_HOOK_SET,
  agyHookSet,
  BLOCK_STOP,
  claudeVersionFile,
  HOOK_COMMAND,
  hasOurHooks,
  hookEntries,
  mergeHooks,
  musePlugin,
  opencodePlugin,
} from "./hooks"
import { hooksTarget } from "./install"
import { gitToplevel } from "./identity"

type Env = Record<string, string | undefined>
type Json = Record<string, unknown>

export const SETUP_HARNESSES = ["claude", "codex", "opencode", "grok", "muse", "agy"] as const
export type SetupHarness = (typeof SETUP_HARNESSES)[number]
type Hooked = "claude" | "codex" | "opencode" | "agy" | "muse"

const SERVER = "scp"
const HOOKED = new Set<SetupHarness>(["claude", "codex", "opencode", "agy", "muse"])
const VERIFY_TIMEOUT_MS = 60_000

export const SETUP_HELP = `${CLI_NAME} setup [--write] [--no-hooks] [--block-stop-on-unread] [--undo] [--bin PATH] [--harness H]
  mounts the relay MCP shim in every installed harness (claude, codex, opencode, grok, muse, agy) at user scope, running
  the ${CLI_NAME} PATH finds (by that path) or --bin, and installs the relay hooks at user scope (Muse's as a plugin). Prints
  the plan; --write applies it (each file backed up next to itself as <file>.bak-<time>, its mode kept), then checks
  each harness's own MCP listing. Rerunning changes nothing.
  The hooks report activity and hand the model new messages after tools and with prompts; a stop names each request
  not yet answered once, and is held while a require_reply request waits. --block-stop-on-unread also holds it while
  messages are unread; without it a hooks file keeps the stop hook it has. ${CLI_NAME} spawn returns at once from an
  agent's shell; while the workers it started run, a stop waits up to 600 s for their next message or handback (hooks
  install --push-wait), so results arrive by themselves. --no-hooks mounts the MCP shim only.
  --undo removes only what setup added (it keeps a list in ~/.config/scp/setup.json), its hooks too unless --no-hooks.`

/** where a harness's binary was found, from PATH or its usual install location */
const KNOWN: Record<SetupHarness, string[]> = {
  claude: [".local/bin/claude", ".claude/local/claude"],
  codex: [".local/bin/codex"],
  opencode: [".opencode/bin/opencode", ".local/bin/opencode"],
  grok: [".grok/bin/grok", ".local/bin/grok"],
  muse: [".local/bin/muse"],
  agy: [".local/bin/agy"],
}

export interface RunResult {
  code: number
  output: string
}

export type Runner = (argv: string[], cwd?: string) => RunResult

export interface SetupOptions {
  write?: boolean
  undo?: boolean
  /** false: the MCP shim only (--no-hooks); the hooks are installed, or with `undo` removed, otherwise */
  hooks?: boolean
  blockStop?: boolean
  bin?: string
  harness?: string
}

export interface SetupDeps {
  env: Env
  cwd: string
  out: (line: string) => void
  now?: Date
  which?: (name: string) => string | undefined
  run?: Runner
}

function home(env: Env): string {
  return env.HOME || homedir()
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function whichOnPath(name: string, env: Env): string | undefined {
  for (const dir of (env.PATH ?? "").split(":")) if (dir && executable(join(dir, name))) return join(dir, name)
  return undefined
}

function runCommand(argv: string[], env: Env, cwd?: string): RunResult {
  try {
    const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: VERIFY_TIMEOUT_MS })
    return {
      code: result.status ?? ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? 124 : 127),
      output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? message(result.error) : ""}`,
    }
  } catch (error) {
    return { code: 127, output: error instanceof Error ? error.message : String(error) }
  }
}

/** the installed harnesses and the binary each one runs */
export function detectHarnesses(env: Env, which: (name: string) => string | undefined): Map<SetupHarness, string> {
  const found = new Map<SetupHarness, string>()
  for (const harness of SETUP_HARNESSES) {
    const path = which(harness) ?? KNOWN[harness].map((rel) => join(home(env), rel)).find(executable)
    if (path) found.set(harness, path)
  }
  return found
}

function configHome(env: Env): string {
  return env.XDG_CONFIG_HOME || join(home(env), ".config")
}

/** the user-level file that holds a harness's MCP servers */
export function mcpFile(harness: SetupHarness, env: Env): string {
  switch (harness) {
    case "claude":
      return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home(env), ".claude.json")
    case "codex":
      return join(env.CODEX_HOME || join(home(env), ".codex"), "config.toml")
    case "grok":
      return join(home(env), ".grok", "config.toml")
    case "muse":
      return join(configHome(env), "muse", "settings.json")
    case "agy":
      return join(home(env), ".gemini", "config", "mcp_config.json")
    case "opencode": {
      const dir = join(configHome(env), "opencode")
      const files = ["opencode.json", "opencode.jsonc", "config.json"].map((name) => join(dir, name)).filter((file) => existsSync(file))
      const unreadable = files.find((file) => {
        try {
          readJson(file)
          return false
        } catch {
          return true
        }
      })
      const mounted = files.find((file) => !unreadable && Boolean((readJson(file)?.mcp as Json | undefined)?.[SERVER]))
      return unreadable ?? mounted ?? files[0] ?? join(dir, "opencode.json")
    }
  }
}

export function agySettingsFile(env: Env): string {
  return join(home(env), ".gemini", "antigravity-cli", "settings.json")
}

/** what setup added, so --undo removes only that */
export function manifestFile(env: Env): string {
  return join(configHome(env), "scp", "setup.json")
}

function museInstalledFile(env: Env): string {
  return join(env.XDG_DATA_HOME || join(home(env), ".local", "share"), "muse", "plugins", "installed.json")
}

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/** a JSON object file: undefined when missing, {} when empty */
function readJson(file: string): Json | undefined {
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, "utf8")
  if (!text.trim()) return {}
  const parsed = JSON.parse(text) as unknown
  if (!isObject(parsed)) throw new Error("not a JSON object")
  return parsed
}

function readToml(file: string): Json | undefined {
  if (!existsSync(file)) return undefined
  return parse(readFileSync(file, "utf8")) as Json
}

/** the scp entry a harness has now */
export function mountedEntry(harness: SetupHarness, file: string): Json | undefined {
  const config = harness === "codex" || harness === "grok" ? readToml(file) : readJson(file)
  const table = config?.[harness === "codex" || harness === "grok" ? "mcp_servers" : harness === "opencode" ? "mcp" : "mcpServers"]
  const entry = isObject(table) ? table[SERVER] : undefined
  return isObject(entry) ? entry : undefined
}

export function entryArgv(harness: SetupHarness, entry: Json): string[] {
  if (harness === "opencode") return Array.isArray(entry.command) ? entry.command.map(String) : []
  return [String(entry.command ?? ""), ...(Array.isArray(entry.args) ? entry.args.map(String) : [])]
}

function entryEnabled(harness: SetupHarness, entry: Json): boolean {
  if (harness === "agy") return entry.disabled !== true
  return entry.enabled !== false
}

/** the type a local mount has in harnesses whose entries carry one */
const LOCAL_TYPE: Partial<Record<SetupHarness, string>> = { claude: "stdio", opencode: "local", muse: "stdio" }
/** keys of a remote server entry, dropped when a JSON entry becomes the local mount */
const REMOTE_KEYS = ["url", "httpUrl", "serverUrl", "headers", "oauth"]

/** whether `entry` is the local mount running `argv`, enabled */
function entryRight(harness: SetupHarness, entry: Json, argv: string[]): boolean {
  const type = LOCAL_TYPE[harness]
  const local = !["url", "httpUrl", "serverUrl"].some((key) => key in entry) && (entry.type === undefined || type === undefined || entry.type === type)
  return local && entryEnabled(harness, entry) && entryArgv(harness, entry).join("\0") === argv.join("\0")
}

const withoutRemote = (entry: Json): Json => Object.fromEntries(Object.entries(entry).filter(([key]) => !REMOTE_KEYS.includes(key)))

/** the command a harness's mount runs */
export function mountArgv(harness: SetupHarness, bin: string): string[] {
  return [bin, "mcp", "--harness", harness, ...(harness === "claude" ? ["--channels"] : [])]
}

export function agyRules(): string[] {
  return TOOLS.map((tool) => `mcp(${SERVER}/${tool.name})`)
}

function shellWord(word: string): string {
  return /^[A-Za-z0-9._/=@:<>-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
}

function tilde(text: string, env: Env): string {
  const prefix = home(env).replace(/\/+$/, "")
  return prefix.length > 1 ? text.replaceAll(`${prefix}/`, "~/") : text
}

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** the file a path's symlinks lead to, followed even when the last link dangles */
function resolved(file: string): string {
  let path = file
  for (let hops = 0; hops < 40; hops++) {
    let link: boolean
    try {
      link = lstatSync(path).isSymbolicLink()
    } catch {
      return path
    }
    if (!link) return path
    path = resolve(dirname(path), readlinkSync(path))
  }
  throw new Error(`${file}: too many levels of symlinks`)
}

/**
 * Why `file` cannot be written, if it cannot: a symlink whose target is missing is written through when the target's directory
 * exists, and refused when a harness CLI does the write, since the CLI would put a plain file where the link was.
 */
function linkProblem(file: string, byCli: boolean): string | undefined {
  let target: string
  try {
    target = resolved(file)
  } catch (error) {
    return message(error)
  }
  if (target === file || existsSync(target)) return undefined
  if (byCli) return `${file} is a symlink to ${target}, which does not exist, and the harness CLI would replace the link; create ${target} or remove the link`
  if (!existsSync(dirname(target))) return `${file} is a symlink to ${target}, whose directory does not exist; create it or remove the link`
  return undefined
}

/** a copy of `file` next to it as `<file>.bak-<time>`, with its mode */
function backup(file: string, now: Date): string {
  const stamped = `${file}.bak-${stamp(now)}`
  let path = stamped
  for (let n = 2; existsSync(path); n++) path = `${stamped}-${n}`
  copyFileSync(file, path)
  chmodSync(path, statSync(file).mode & 0o7777)
  return path
}

/**
 * `content` over `target` (through its symlinks) via a temp file and rename, after a backup unless `keep` is false, keeping its
 * mode (`mode` for a new file)
 */
function writeFile(target: string, content: string, now: Date, options: { keep?: boolean; mode?: number } = {}): string | undefined {
  const file = resolved(target)
  let saved: string | undefined
  let mode = options.mode ?? 0o600
  if (existsSync(file)) {
    mode = statSync(file).mode & 0o7777
    if (options.keep !== false) saved = backup(file, now)
  } else if (file !== target && !existsSync(dirname(file))) {
    throw new Error(`${target} is a symlink to ${file}, whose directory does not exist`)
  } else mkdirSync(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}`)
  try {
    writeFileSync(temp, content, { mode })
    chmodSync(temp, mode)
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {}
    throw error
  }
  return saved
}

/**
 * Runs harness CLI commands that edit `target`: backed up first, its mode put back afterwards whatever happens.
 * When a later command fails, `rollback` puts back what the earlier ones changed.
 */
function runEditing(target: string, now: Date, run: Runner, commands: string[][], rollback: string[][] = []): string | undefined {
  const file = resolved(target)
  const before = existsSync(file) ? statSync(file).mode & 0o7777 : undefined
  const saved = before === undefined ? undefined : backup(file, now)
  try {
    for (const [index, argv] of commands.entries()) {
      const result = run(argv)
      if (result.code === 0) continue
      const failed = `${basename(argv[0]!)} ${argv.slice(1, 3).join(" ")} exited ${result.code}: ${lastLine(result.output)}`
      if (index === 0 || !rollback.length) throw new Error(failed)
      const undone = rollback.every((step) => run(step).code === 0)
      throw new Error(`${failed}; ${undone ? "the previous mount is back" : `putting the previous mount back failed too, it is in ${saved}`}`)
    }
  } finally {
    if (before !== undefined && existsSync(file) && (statSync(file).mode & 0o7777) !== before) chmodSync(file, before)
  }
  return saved
}

function lastLine(text: string): string {
  return stripAnsi(text).trim().split("\n").filter(Boolean).at(-1) ?? "no output"
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\[[0-9;]*m/g, "")
}

function indentOf(text: string): string | number {
  return /\n([ \t]+)["}\]]/.exec(text)?.[1] ?? 2
}

function jsonText(original: string | undefined, value: Json): string {
  return `${JSON.stringify(value, null, original ? indentOf(original) : 2)}\n`
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const SECRET_KEYS = new Set(["env", "environment", "headers", "http_headers"])

/** `value` with the values of its env and header maps hidden, for printing */
function redacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redacted)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      SECRET_KEYS.has(key) && isObject(inner) ? Object.fromEntries(Object.keys(inner).map((name) => [name, "<kept>"])) : redacted(inner),
    ]),
  )
}

/** a harness command as the plan prints it: --env values and add-json's env hidden */
function shown(argv: string[]): string {
  const words = [basename(argv[0]!), ...argv.slice(1)].map((word, index, all) => {
    if (all[index - 1] === "--env") return `${word.split("=")[0]}=<kept>`
    if (all[2] === "add-json" && index === all.length - 1) return JSON.stringify(redacted(JSON.parse(word)))
    return word
  })
  return `$ ${words.map(shellWord).join(" ")}`
}

type Kind = "mcp" | "rules" | "hooks"

/** one thing setup added: a mount, agy rules, or a hooks file (whose hooks it merged in, or which it created) */
export interface Added {
  harness: SetupHarness
  kind: Kind
  file: string
  rules?: string[]
}

function readManifest(env: Env): Added[] {
  const config = readJson(manifestFile(env))
  if (config === undefined) return []
  if (!Array.isArray(config.added)) throw new Error("its added key is not a list")
  return config.added.filter(
    (item): item is Added => isObject(item) && typeof item.harness === "string" && typeof item.kind === "string" && typeof item.file === "string",
  )
}

const sameItem = (a: Added, b: Added) => a.harness === b.harness && a.kind === b.kind && a.file === b.file

function writeManifest(env: Env, now: Date, change: (added: Added[]) => Added[]) {
  const file = manifestFile(env)
  const next = change(readManifest(env))
  if (next.length) writeFile(file, `${JSON.stringify({ version: 1, added: next }, null, 2)}\n`, now, { keep: false })
  else if (existsSync(file)) unlinkSync(file)
}

const remember = (item: Added) => (added: Added[]) => {
  const existing = added.find((other) => sameItem(other, item))
  if (!existing) return [...added, item]
  if (item.rules) existing.rules = [...new Set([...(existing.rules ?? []), ...item.rules])]
  return added
}

const forget = (item: Added) => (added: Added[]) => added.filter((other) => !sameItem(other, item))

interface Step {
  harness: SetupHarness
  label: string
  file: string
  plan: string[]
  apply: () => string | undefined
  manifest?: ((added: Added[]) => Added[]) | undefined
  /** after a failed apply: what of the step is on disk anyway, which the manifest then records */
  landed?: () => string | undefined
}

/** the hooks a harness gets: the file, the installer it follows, and whether its stop is held */
interface HookTarget {
  kind: Hooked
  file: string
  blockStop: boolean
}

interface Plan {
  steps: Step[]
  lines: { harness: SetupHarness; text?: string; step?: Step }[]
  problems: number
  hooks: Map<SetupHarness, HookTarget>
}

interface Ctx {
  env: Env
  cwd: string
  now: Date
  run: Runner
  found: Map<SetupHarness, string>
  added: Added[]
  wanted: SetupHarness[]
  blockStop: boolean
}

function note(plan: Plan, harness: SetupHarness, text: string) {
  plan.lines.push({ harness, text })
}

/** a note for something setup could not do: the run then exits non-zero */
function problem(plan: Plan, harness: SetupHarness, text: string) {
  plan.problems++
  note(plan, harness, `! ${text}`)
}

function addStep(plan: Plan, step: Step) {
  plan.steps.push(step)
  plan.lines.push({ harness: step.harness, step })
}

/** the new text of a JSON file after `edit`, or undefined when it would not change */
function editedJson(file: string, edit: (config: Json) => Json | undefined): string | undefined {
  const target = resolved(file)
  const original = existsSync(target) ? readFileSync(target, "utf8") : undefined
  const next = edit(readJson(target) ?? {})
  if (!next) return undefined
  const content = jsonText(original, next)
  return content === original ? undefined : content
}

/** a planned JSON edit; applying it reads the file again, so a write made since the plan is kept */
function jsonEdit(file: string, edit: (config: Json) => Json | undefined, now: Date): { apply: () => string | undefined } | undefined {
  if (editedJson(file, edit) === undefined) return undefined
  return {
    apply: () => {
      const content = editedJson(file, edit)
      return content === undefined ? undefined : writeFile(file, content, now)
    },
  }
}

/** the keys of a mount each harness CLI's `mcp add` writes; it drops the others */
const CLI_KEEPS: Record<"codex" | "grok" | "agy", Set<string>> = {
  codex: new Set(["command", "args", "env", "enabled"]),
  grok: new Set(["command", "args", "env", "enabled"]),
  agy: new Set(["command", "args", "env", "disabled"]),
}

/** Claude's local-scope scp entries (in ~/.claude.json projects) and project-scope ones (a project's .mcp.json) */
function claudeShadows(file: string, cwd: string): string[] {
  const found: string[] = []
  let projects: unknown
  try {
    projects = readJson(resolved(file))?.projects
  } catch {
    return found
  }
  const dirs = new Set<string>([gitToplevel(cwd) ?? cwd])
  if (isObject(projects)) {
    for (const [dir, project] of Object.entries(projects)) {
      dirs.add(dir)
      if (isObject(project) && isObject(project.mcpServers) && project.mcpServers[SERVER] !== undefined)
        found.push(`a local-scope ${SERVER} for ${dir} (in ${file})`)
    }
  }
  for (const dir of dirs) {
    try {
      const servers = readJson(join(dir, ".mcp.json"))?.mcpServers
      if (isObject(servers) && servers[SERVER] !== undefined) found.push(`a project-scope ${SERVER} in ${join(dir, ".mcp.json")}`)
    } catch {}
  }
  return found
}

/** the mount step for one harness, or a note when it is already in place */
function planMount(plan: Plan, harness: SetupHarness, bin: string, ctx: Ctx) {
  const { now, run } = ctx
  const cli = ctx.found.get(harness)!
  const file = mcpFile(harness, ctx.env)
  const argv = mountArgv(harness, bin)
  const blocked = linkProblem(file, harness !== "opencode" && harness !== "muse")
  if (blocked) {
    problem(plan, harness, `mcp: skipped, ${blocked}`)
    return
  }
  let entry: Json | undefined
  try {
    entry = mountedEntry(harness, file)
  } catch (error) {
    problem(plan, harness, `mcp: skipped, ${file} is unreadable (${message(error)}); fix it or rerun after`)
    return
  }
  if (harness === "claude")
    for (const shadow of claudeShadows(file, ctx.cwd)) note(plan, harness, `mcp: warning, ${shadow}: in that project it is used instead of the user mount`)
  if (entry && entryRight(harness, entry, argv)) {
    note(plan, harness, `mcp: up to date in ${file}`)
    return
  }
  const current = entry ? entryArgv(harness, entry) : undefined
  const manifest = entry ? undefined : remember({ harness, kind: "mcp", file })
  const verb = entry
    ? `update ${SERVER} (now: ${current?.map(shellWord).join(" ") || "unparsed"}${entryEnabled(harness, entry) ? "" : ", disabled; setup enables it"})`
    : `add ${SERVER}`
  const dropped = REMOTE_KEYS.filter((key) => entry && key in entry)
  const landed = () => {
    try {
      return mountedEntry(harness, file) ? "the mount it wrote" : undefined
    } catch {
      return undefined
    }
  }
  const cliStep = (commands: string[][], rollback: string[][] = []) =>
    addStep(plan, {
      harness,
      label: "mcp",
      file,
      plan: [`${verb} in ${file}`, ...commands.map(shown)],
      apply: () => runEditing(file, now, run, commands, rollback),
      manifest,
      landed,
    })
  switch (harness) {
    case "claude": {
      if (!entry) {
        cliStep([[cli, "mcp", "add", "--scope", "user", SERVER, "--", ...argv]])
        return
      }
      const merged = { ...withoutRemote(entry), type: LOCAL_TYPE.claude, command: argv[0], args: argv.slice(1) }
      if (dropped.length) note(plan, harness, `mcp: the update drops ${dropped.join(", ")} from the entry; the backup keeps them`)
      cliStep(
        [
          [cli, "mcp", "remove", "--scope", "user", SERVER],
          [cli, "mcp", "add-json", "--scope", "user", SERVER, JSON.stringify(merged)],
        ],
        [[cli, "mcp", "add-json", "--scope", "user", SERVER, JSON.stringify(entry)]],
      )
      return
    }
    case "codex":
    case "grok":
    case "agy": {
      const vars = isObject(entry?.env) ? Object.entries(entry.env) : []
      const flags = vars.filter(([, value]) => typeof value === "string").flatMap(([key, value]) => ["--env", `${key}=${value}`])
      const lost = [
        ...Object.keys(entry ?? {}).filter((key) => !CLI_KEEPS[harness].has(key)),
        ...vars.filter(([, value]) => typeof value !== "string").map(([key]) => `env.${key}`),
      ]
      cliStep([[cli, "mcp", "add", ...(harness === "grok" ? ["--scope", "user"] : []), ...flags, SERVER, "--", ...argv]])
      if (lost.length) note(plan, harness, `mcp: ${harness} mcp add writes the entry anew and drops ${lost.join(", ")} from it; the backup keeps them`)
      if (harness === "grok" && existsSync(file) && /^\s*#/m.test(readFileSync(file, "utf8")))
        note(plan, harness, `mcp: grok mcp add rewrites ${file} without its comments; the backup keeps them`)
      return
    }
    case "opencode":
    case "muse": {
      const key = harness === "opencode" ? "mcp" : "mcpServers"
      const fresh: Json =
        harness === "opencode" ? { type: "local", command: argv, enabled: true } : { type: "stdio", command: argv[0], args: argv.slice(1), mode: "optional" }
      const type = entry && entry.type !== LOCAL_TYPE[harness] ? { type: LOCAL_TYPE[harness] } : {}
      const changed: Json =
        harness === "opencode"
          ? { ...type, command: argv, enabled: true }
          : { ...type, command: argv[0], args: argv.slice(1), ...(entry && "enabled" in entry ? { enabled: true } : {}) }
      let value = fresh
      let edit: ReturnType<typeof jsonEdit>
      try {
        edit = jsonEdit(
          file,
          (config) => {
            if (harness === "muse" && config.mcp_servers !== undefined)
              throw new Error("it has a mcp_servers key, and Muse drops every MCP server when both mcp_servers and mcpServers exist; merge them by hand first")
            const table = config[key] ?? {}
            if (!isObject(table)) throw new Error(`its ${key} key is not an object`)
            const existing = table[SERVER]
            value = isObject(existing) ? { ...withoutRemote(existing), ...changed } : fresh
            const base = Object.keys(config).length ? config : harness === "opencode" ? { $schema: "https://opencode.ai/config.json" } : { schema_version: 1 }
            return { ...base, [key]: { ...table, [SERVER]: value } }
          },
          now,
        )
      } catch (error) {
        problem(plan, harness, `mcp: skipped, ${file}: ${message(error)}`)
        return
      }
      if (!edit) return
      const detail = entry
        ? `${Object.entries(changed)
            .map(([name, inner]) => `${key}.${SERVER}.${name} = ${JSON.stringify(inner)}`)
            .join(", ")} (its other keys kept${dropped.length ? `, and ${dropped.join(", ")} dropped` : ""})`
        : `${key}.${SERVER} = ${JSON.stringify(redacted(value))}`
      addStep(plan, { harness, label: "mcp", file, plan: [`${verb} in ${file}`, detail], apply: edit.apply, manifest })
    }
  }
}

function planAgyRules(plan: Plan, ctx: Ctx, remove: boolean) {
  const file = agySettingsFile(ctx.env)
  const item: Added = { harness: "agy", kind: "rules", file }
  const ours = ctx.added.find((other) => sameItem(other, item))?.rules ?? []
  const wanted = remove ? ours : agyRules()
  const blocked = linkProblem(file, false)
  if (blocked) {
    problem(plan, "agy", `permissions: skipped, ${blocked}`)
    return
  }
  let changed: string[] = []
  let kept = 0
  let edit: ReturnType<typeof jsonEdit>
  try {
    edit = jsonEdit(
      file,
      (config) => {
        if (remove && config.permissions === undefined) return undefined
        const permissions = config.permissions ?? {}
        if (!isObject(permissions)) throw new Error("its permissions key is not an object")
        const allow = permissions.allow ?? []
        if (!Array.isArray(allow)) throw new Error("its permissions.allow is not a list")
        kept = remove ? allow.filter((rule) => typeof rule === "string" && agyRules().includes(rule) && !wanted.includes(rule)).length : 0
        const next = remove
          ? allow.filter((rule) => !(typeof rule === "string" && wanted.includes(rule)))
          : [...allow, ...wanted.filter((rule) => !allow.includes(rule))]
        changed = remove ? allow.filter((rule) => !next.includes(rule)).map(String) : next.slice(allow.length).map(String)
        return changed.length ? { ...config, permissions: { ...permissions, allow: next } } : undefined
      },
      ctx.now,
    )
  } catch (error) {
    problem(plan, "agy", `permissions: skipped, ${file}: ${message(error)}`)
    return
  }
  if (kept) note(plan, "agy", `permissions: keeps ${kept} relay tool rule${kept === 1 ? "" : "s"} in ${file} that setup did not add`)
  if (!edit) {
    if (!remove) note(plan, "agy", `permissions: ${wanted.length} relay tool rules already in ${file}`)
    else if (ours.length)
      addStep(plan, {
        harness: "agy",
        label: "permissions",
        file,
        plan: [`forget the rules setup added to ${file}, which are gone`],
        apply: () => undefined,
        manifest: forget(item),
      })
    return
  }
  addStep(plan, {
    harness: "agy",
    label: "permissions",
    file,
    plan: [
      `${remove ? "remove" : "add"} ${changed.length} permissions.allow rules ${remove ? "from" : "to"} ${file}${remove ? "" : " (headless agy denies MCP tools without them)"}`,
      changed.join(" "),
    ],
    apply: edit.apply,
    manifest: remove ? forget(item) : remember({ ...item, rules: changed }),
  })
}

function hookContent(kind: Hooked, existing: string | undefined, blockStop: boolean): string {
  const options = { blockStop }
  if (kind === "opencode") return opencodePlugin(options)
  if (kind === "muse") return `${JSON.stringify(musePlugin(options), null, 2)}\n`
  const settings = existing === undefined ? {} : (JSON.parse(existing) as unknown)
  if (kind === "agy") {
    if (!isObject(settings)) throw new Error("not a JSON object")
    return `${JSON.stringify({ ...settings, [AGY_HOOK_SET]: agyHookSet(options) }, null, 2)}\n`
  }
  return `${JSON.stringify(mergeHooks(settings, hookEntries(kind, options)), null, 2)}\n`
}

/** what `hooks install --scope user --write` would write, or undefined when the file already has it */
function desiredHooks(kind: Hooked, target: string, blockStop: boolean): string | undefined {
  const file = resolved(target)
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined
  const content = hookContent(kind, existing, blockStop)
  return content === existing ? undefined : content
}

/** whether a hooks file holds stops while messages are unread */
function holdsStops(kind: Hooked, target: string): boolean {
  try {
    const file = resolved(target)
    if (!existsSync(file)) return false
    const text = readFileSync(file, "utf8")
    if (kind === "opencode") return text.includes("const BLOCK_STOP = true")
    const config = JSON.parse(text) as unknown
    if (!isObject(config)) return false
    if (kind === "muse") return JSON.stringify(config).includes(BLOCK_STOP)
    if (kind === "agy") return JSON.stringify(config[AGY_HOOK_SET] ?? null).includes(BLOCK_STOP)
    return JSON.stringify(config.hooks ?? null).includes(`${HOOK_COMMAND} ${kind} ${BLOCK_STOP}`)
  } catch {
    return false
  }
}

/** whether a hooks file already has hooks of ours, whatever their version */
function hasHooks(kind: Hooked, target: string): boolean {
  try {
    const file = resolved(target)
    if (!existsSync(file)) return false
    if (kind === "opencode" || kind === "muse") return true
    if (kind !== "agy") return hasOurHooks(file)
    return AGY_HOOK_SET in (readJson(file) ?? {})
  } catch {
    return false
  }
}

/** identifies plugin files that setup may remove */
const OPENCODE_MARK = "// scp:"

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`

/** Muse's record of the scp plugin, from its installed.json */
function museInstalled(env: Env): Json | undefined {
  try {
    const plugins = readJson(museInstalledFile(env))?.plugins
    const record = isObject(plugins) ? plugins[SERVER] : undefined
    return isObject(record) ? record : undefined
  } catch {
    return undefined
  }
}

const installedFrom = (record: Json | undefined) => (record && isObject(record.source) ? String(record.source.path) : undefined)

function pluginDir(manifest: string): string {
  return dirname(dirname(manifest))
}

function planHooks(plan: Plan, harness: SetupHarness, ctx: Ctx) {
  const { env, cwd, now, run } = ctx
  let kind: Hooked
  if (harness === "grok") {
    if (ctx.found.has("claude")) {
      note(plan, harness, "hooks: Grok runs the Claude Code hooks from ~/.claude/settings.json and labels them grok")
      return
    }
    kind = "claude"
  } else if (HOOKED.has(harness)) kind = harness as Hooked
  else return
  const file = hooksTarget(kind, "user", env, cwd)
  const had = holdsStops(kind, file)
  const blockStop = ctx.blockStop || had
  plan.hooks.set(harness, { kind, file, blockStop })
  if (kind === "claude" || kind === "codex") {
    const others =
      kind === "claude" ? [hooksTarget("claude", "local", env, cwd), hooksTarget("claude", "project", env, cwd)] : [hooksTarget("codex", "project", env, cwd)]
    for (const other of new Set(others))
      if (other !== file && hasOurHooks(other))
        note(plan, harness, `hooks: warning, ${other} already runs the ${CLI_NAME} hooks: in that project every event reports twice; remove them there`)
  }
  const blocked = linkProblem(file, false)
  if (blocked) {
    problem(plan, harness, `hooks: skipped, ${blocked}`)
    return
  }
  let content: string | undefined
  try {
    content = desiredHooks(kind, file, blockStop)
  } catch (error) {
    problem(plan, harness, `hooks: skipped, ${file} is unreadable (${message(error)})`)
    return
  }
  const held = had && !ctx.blockStop ? ` (it keeps ${BLOCK_STOP}, which the file has)` : ctx.blockStop && !had ? `, with ${BLOCK_STOP}` : ""
  const manifest = hasHooks(kind, file) ? undefined : remember({ harness, kind: "hooks", file })
  if (kind === "muse") {
    const dir = pluginDir(file)
    const record = museInstalled(env)
    const from = installedFrom(record)
    const current = content ?? readFileSync(resolved(file), "utf8")
    const disabled = record?.enabled === false
    const install = content !== undefined || from !== dir || record?.manifest_sha256 !== sha256(current)
    if (!install && !disabled) {
      note(plan, harness, `hooks: up to date in ${file}${held}`)
      return
    }
    const cli = ctx.found.get("muse")!
    const commands = [...(install ? [[cli, "plugins", "install", dir, "--scope", "user"]] : []), ...(disabled ? [[cli, "plugins", "enable", SERVER]] : [])]
    const head = install
      ? `${content ? "write" : "install"} the ${CLI_NAME} plugin ${file}${held}${from && from !== dir ? `, replacing the scp plugin installed from ${from}` : ""}${disabled ? ", and enable it, which Muse has disabled" : ""}`
      : `enable the ${CLI_NAME} plugin ${file}, which Muse has disabled`
    addStep(plan, {
      harness,
      label: "hooks",
      file,
      plan: [head, ...commands.map(shown), ...(install ? ["Muse asks you to review a plugin's hooks before it runs them"] : [])],
      apply: () => {
        const next = install ? desiredHooks(kind, file, blockStop) : undefined
        const saved = next === undefined ? undefined : writeFile(file, next, now, { mode: 0o644 })
        for (const argv of commands) {
          const result = run(argv)
          if (result.code !== 0) throw new Error(`muse plugins ${argv[2]} exited ${result.code}: ${lastLine(result.output)}`)
        }
        return saved
      },
      manifest,
      landed: () => (existsSync(resolved(file)) ? "the plugin it wrote" : undefined),
    })
    return
  }
  if (!content) {
    note(plan, harness, `hooks: up to date in ${file}${held}`)
    return
  }
  const what = kind === "opencode" ? `write the ${CLI_NAME} plugin ${file}` : `merge the ${CLI_NAME} hooks into ${file}`
  const why =
    harness === "grok"
      ? " (Grok runs the Claude Code hooks; claude is not installed)"
      : kind === "codex"
        ? " (Codex runs them after you review them in /hooks)"
        : ""
  addStep(plan, {
    harness,
    label: "hooks",
    file,
    plan: [`${what}${why}${held}`],
    apply: () => {
      const next = desiredHooks(kind, file, blockStop)
      return next === undefined ? undefined : writeFile(file, next, now, { mode: 0o644 })
    },
    manifest,
  })
}

function planUnhooks(plan: Plan, harness: SetupHarness, ctx: Ctx) {
  const kind: Hooked | undefined = harness === "grok" ? "claude" : HOOKED.has(harness) ? (harness as Hooked) : undefined
  if (!kind) return
  const file = hooksTarget(kind, "user", ctx.env, ctx.cwd)
  const items = ctx.added.filter(
    (item) => item.kind === "hooks" && (kind === "claude" ? item.harness === "claude" || item.harness === "grok" : item.harness === harness),
  )
  if (harness === "grok" && items.length) {
    if (ctx.wanted.includes("claude")) return
    if (ctx.found.has("claude")) {
      note(plan, harness, `hooks: keeps the hooks in ${file}, which Claude Code runs too; undo them with --harness claude`)
      return
    }
  }
  if (!items.length) {
    if (harness !== "grok" && hasHooks(kind, file)) note(plan, harness, `hooks: keeps the hooks in ${file}, which setup did not add`)
    return
  }
  for (const path of new Set(items.map((item) => item.file)))
    planUnhook(
      plan,
      harness,
      kind,
      path,
      items.filter((item) => item.file === path),
      ctx,
    )
}

function planUnhook(plan: Plan, harness: SetupHarness, kind: Hooked, file: string, items: Added[], ctx: Ctx) {
  const { now, run } = ctx
  let target: string
  try {
    target = resolved(file)
  } catch (error) {
    problem(plan, harness, `hooks: skipped, ${message(error)}`)
    return
  }
  const forgotten = (added: Added[]) => added.filter((other) => !items.some((item) => sameItem(item, other)))
  const gone: Step = { harness, label: "hooks", file, plan: [`forget ${file}, which is gone`], apply: () => undefined, manifest: forgotten }
  if (kind === "muse") {
    const cli = ctx.found.get("muse")
    const installed = installedFrom(museInstalled(ctx.env)) === pluginDir(file)
    if (!existsSync(target) && !installed) {
      addStep(plan, gone)
      return
    }
    if (installed && !cli) {
      problem(plan, harness, "hooks: Muse still has the scp plugin, and muse is not installed to remove it")
      return
    }
    const remove = installed ? [cli!, "plugins", "remove", SERVER] : undefined
    addStep(plan, {
      harness,
      label: "hooks",
      file,
      plan: [`remove the ${CLI_NAME} plugin ${file}`, ...(remove ? [shown(remove)] : [])],
      apply: () => {
        if (remove) {
          const result = run(remove)
          if (result.code !== 0) throw new Error(`muse plugins remove exited ${result.code}: ${lastLine(result.output)}`)
        }
        if (!existsSync(target)) return undefined
        const saved = backup(target, now)
        unlinkSync(target)
        return saved
      },
      manifest: forgotten,
    })
    return
  }
  if (!existsSync(target)) {
    addStep(plan, gone)
    return
  }
  if (kind === "opencode") {
    const text = readFileSync(target, "utf8")
    if (!text.startsWith(OPENCODE_MARK) || !/^const BLOCK_STOP = (true|false)$/m.test(text)) {
      note(plan, harness, `hooks: ${file} is not a ${CLI_NAME} plugin any more; left in place`)
      return
    }
    addStep(plan, {
      harness,
      label: "hooks",
      file,
      plan: [`remove the plugin file ${file}`],
      apply: () => {
        const saved = backup(target, now)
        unlinkSync(target)
        return saved
      },
      manifest: forgotten,
    })
    return
  }
  let edit: ReturnType<typeof jsonEdit>
  try {
    edit = jsonEdit(
      file,
      (config) => {
        if (kind === "agy") {
          if (!(AGY_HOOK_SET in config)) return undefined
          const { [AGY_HOOK_SET]: _ours, ...rest } = config
          return rest
        }
        if (!isObject(config.hooks)) return undefined
        const merged = mergeHooks(config, {})
        return JSON.stringify(merged.hooks) === JSON.stringify(config.hooks) ? undefined : merged
      },
      now,
    )
  } catch (error) {
    problem(plan, harness, `hooks: skipped, ${file} is unreadable (${message(error)})`)
    return
  }
  addStep(
    plan,
    edit
      ? { harness, label: "hooks", file, plan: [`remove the ${CLI_NAME} hooks from ${file}`], apply: edit.apply, manifest: forgotten }
      : { ...gone, plan: [`forget ${file}, which has no ${CLI_NAME} hooks left`] },
  )
}

function planUnmount(plan: Plan, harness: SetupHarness, ctx: Ctx) {
  const { now, run } = ctx
  const cli = ctx.found.get(harness)
  const item = ctx.added.find((other) => other.harness === harness && other.kind === "mcp")
  const file = item?.file ?? mcpFile(harness, ctx.env)
  let entry: Json | undefined
  try {
    entry = mountedEntry(harness, file)
  } catch (error) {
    problem(plan, harness, `mcp: skipped, ${file} is unreadable (${message(error)})`)
    return
  }
  if (!item) {
    if (entry) note(plan, harness, `mcp: keeps the ${SERVER} in ${file}, which setup did not add`)
    return
  }
  if (!entry) {
    addStep(plan, { harness, label: "mcp", file, plan: [`forget ${SERVER} in ${file}, which is gone`], apply: () => undefined, manifest: forget(item) })
    return
  }
  if (harness !== "opencode" && harness !== "muse" && !cli) {
    problem(plan, harness, `mcp: ${file} still mounts ${SERVER}, and ${harness} is not installed to remove it; remove it by hand`)
    return
  }
  const command =
    harness === "claude" || harness === "grok"
      ? [cli!, "mcp", "remove", "--scope", "user", SERVER]
      : harness === "codex" || harness === "agy"
        ? [cli!, "mcp", "remove", SERVER]
        : undefined
  if (command) {
    addStep(plan, {
      harness,
      label: "mcp",
      file,
      plan: [`remove ${SERVER} from ${file}`, shown(command)],
      apply: () => runEditing(file, now, run, [command]),
      manifest: forget(item),
    })
    return
  }
  const key = harness === "opencode" ? "mcp" : "mcpServers"
  const edit = jsonEdit(
    file,
    (config) => {
      const { [SERVER]: _ours, ...rest } = config[key] as Json
      return { ...config, [key]: rest }
    },
    now,
  )
  if (edit) addStep(plan, { harness, label: "mcp", file, plan: [`remove ${key}.${SERVER} from ${file}`], apply: edit.apply, manifest: forget(item) })
}

const LISTING: Partial<Record<SetupHarness, string[]>> = {
  claude: ["mcp", "get", SERVER],
  codex: ["mcp", "list"],
  opencode: ["mcp", "list"],
  grok: ["mcp", "list"],
  agy: ["mcp", "list"],
}

/**
 * Whether a harness's own MCP listing shows the mount (`expected` is its argv) or, without `expected`, that it
 * is gone. Claude and OpenCode start the server and report it connected; Codex, Grok and agy only list it.
 */
export function verifyMount(
  harness: SetupHarness,
  cli: string,
  env: Env,
  run: (argv: string[]) => RunResult,
  expected?: string[],
): { ok: boolean; line: string } {
  const args = LISTING[harness]
  if (!args) {
    let entry: Json | undefined
    try {
      entry = mountedEntry(harness, mcpFile(harness, env))
    } catch {}
    const right = Boolean(entry) && (!expected || entryRight(harness, entry!, expected))
    const where = `in ${mcpFile(harness, env)} (Muse has no MCP listing command)`
    if (!expected) return { ok: !entry, line: `${entry ? "still configured" : "removed"} ${where}` }
    return { ok: right, line: `${right ? "configured" : entry ? "failed: a different scp is configured" : "failed: missing"} ${where}` }
  }
  const command = `${basename(cli)} ${args.join(" ")}`
  const result = run([cli, ...args])
  const text = stripAnsi(result.output)
  const lines = text.split("\n").map((line) => line.trim())
  const named = new RegExp(`(^|\\s)${SERVER}(:|\\s|$)`)
  const listed = harness === "claude" ? result.code === 0 && text.includes(`${SERVER}:`) : lines.some((line) => named.test(line))
  if (!expected) {
    const gone = harness === "claude" ? new RegExp(`No MCP server named "${SERVER}"`).test(text) : result.code === 0 && !listed
    return {
      ok: gone,
      line: gone ? `removed (${command})` : listed ? `still listed by ${command}` : `unknown: ${command} exited ${result.code}: ${lastLine(result.output)}`,
    }
  }
  if (!listed)
    return { ok: false, line: `failed: ${command} does not list ${SERVER}${result.code ? ` (exit ${result.code}: ${lastLine(result.output)})` : ""}` }
  if (harness === "claude") {
    const field = (name: string) =>
      lines
        .find((line) => line.startsWith(`${name}:`))
        ?.slice(name.length + 1)
        .trim()
    const runs = [field("Command"), field("Args")].filter(Boolean).join(" ")
    if (runs !== expected.join(" ")) return { ok: false, line: `failed (${command}: it runs ${runs || "an unlisted command"}, not ${expected.join(" ")})` }
  }
  if (harness === "opencode") {
    const file = mcpFile(harness, env)
    let entry: Json | undefined
    try {
      entry = mountedEntry(harness, file)
    } catch {}
    if (!entry || !entryRight(harness, entry, expected))
      return { ok: false, line: `failed: the ${SERVER} in ${file} is not this local one (${command} lists a ${SERVER})` }
  }
  if (harness === "claude" || harness === "opencode") {
    const status = harness === "claude" ? lines.find((line) => line.startsWith("Status:")) : lines.find((line) => named.test(line))
    const connected = /[✔✓]/.test(status ?? "") && /\bconnected\b/i.test(status ?? "") && !/disconnected|fail/i.test(status ?? "")
    return { ok: connected, line: `${connected ? "mounted" : "failed"} (${command}: ${status ?? "no status"})` }
  }
  const line = lines.find((entry) => named.test(entry))!
  const flat = line.replace(/\s+/g, " ")
  const right = ` ${flat} `.includes(` ${expected.join(" ")} `) && !/\bdisabled\b/i.test(flat)
  return { ok: right, line: right ? `configured (${command} lists it; ${basename(cli)} does not start servers to check them)` : `failed (${command}: ${line})` }
}

/** whether `muse plugins list --json` shows the scp plugin from `dir` at `manifest`'s hash; without `manifest`, that it is gone */
export function verifyMusePlugin(cli: string, dir: string, run: (argv: string[]) => RunResult, manifest?: string): { ok: boolean; line: string } {
  const result = run([cli, "plugins", "list", "--json"])
  let record: Json | undefined
  try {
    const plugins = (JSON.parse(result.output) as Json).plugins
    const found = Array.isArray(plugins) ? plugins.find((plugin) => isObject(plugin) && isObject(plugin.record) && plugin.record.id === SERVER) : undefined
    record = isObject(found) && isObject(found.record) ? found.record : undefined
  } catch {
    return { ok: false, line: `unknown: muse plugins list --json exited ${result.code}: ${lastLine(result.output)}` }
  }
  const ours = installedFrom(record) === dir
  if (manifest === undefined) return { ok: !ours, line: ours ? "still installed (muse plugins list)" : "removed (muse plugins list)" }
  if (!ours) return { ok: false, line: "failed: muse plugins list does not show the scp plugin from setup" }
  const current = record!.manifest_sha256 === sha256(manifest) && record!.enabled !== false
  return {
    ok: current,
    line: current ? "installed (muse plugins list)" : "failed: Muse has another version of the plugin, or it is disabled (muse plugins list)",
  }
}

/** `swarm setup`: the plan, and with `write` its application and a check per harness */
export function relaySetup(options: SetupOptions, deps: SetupDeps): number {
  const env = deps.env
  const now = deps.now ?? new Date()
  const which = deps.which ?? ((name: string) => whichOnPath(name, env))
  const run = deps.run ?? ((argv, cwd) => runCommand(argv, env, cwd))
  const out = (line: string) => deps.out(tilde(line, env))
  if (options.harness !== undefined && !(SETUP_HARNESSES as readonly string[]).includes(options.harness)) {
    throw new RelayUsage(`--harness is one of ${SETUP_HARNESSES.join(", ")}`)
  }
  if (options.blockStop && (options.hooks === false || options.undo)) throw new RelayUsage(`${BLOCK_STOP} goes with the hooks: not with --no-hooks or --undo`)
  let added: Added[]
  try {
    added = readManifest(env)
  } catch (error) {
    throw new RelayUsage(`${manifestFile(env)}, setup's list of what it added, is unreadable (${message(error)}); fix or remove it`)
  }
  const onPath = which(CLI_NAME)
  let bin: string
  if (options.bin !== undefined) {
    if (!isAbsolute(options.bin)) throw new RelayUsage(`--bin takes an absolute path to the ${CLI_NAME} binary`)
    if (!executable(options.bin)) throw new RelayUsage(`--bin ${options.bin} is not an executable file`)
    bin = options.bin
  } else if (onPath) bin = onPath
  else if (options.undo) bin = CLI_NAME
  else throw new RelayUsage(`${CLI_NAME} is not on PATH: pass --bin /absolute/path/to/${CLI_NAME} (the mounts then run that path)`)
  const found = detectHarnesses(env, which)
  const wanted = SETUP_HARNESSES.filter((harness) => options.harness === undefined || options.harness === harness)
  const selected = wanted.filter((harness) => found.has(harness))
  const missing = wanted.filter((harness) => !found.has(harness))
  out(`${CLI_NAME} setup${options.undo ? " --undo" : ""}: ${options.write ? "applying" : "dry run, nothing is written (add --write to apply)"}`)
  let hooks = options.hooks !== false
  let unresolved = 0
  if (options.hooks === false) out(`hooks: ${options.undo ? "kept (--no-hooks)" : "not installed (--no-hooks); only the MCP shim is mounted"}`)
  if (!options.undo) {
    if (options.bin !== undefined) out(`mounts run: ${bin} (from --bin; they break if that file moves)`)
    else {
      const target = resolved(bin)
      out(
        `mounts run: ${bin} (${CLI_NAME} on PATH, by that path${target !== bin ? ` and not its target ${target}` : ""}, so a harness started without your PATH finds it)`,
      )
    }
    const help = run([bin, "help", "--all"]).output
    if (!help.includes(`${CLI_NAME} mcp`)) {
      out(`! ${bin} has no \`${CLI_NAME} mcp\` (its \`help --all\` does not list it): update it, or pass --bin with a ${CLI_NAME} that has the relay`)
      if (options.write) return 1
    }
    if (hooks && env.SCP_TRANSPORT === "cloud") {
      out(
        `! the hooks report to the local broker, and SCP_TRANSPORT=cloud bypasses it: hooks are skipped; link the broker instead (${CLI_NAME} cloud enable), unset it and rerun`,
      )
      hooks = false
      unresolved++
    } else if (hooks && !onPath) {
      out(`! the hooks run \`${CLI_NAME} hook\` from PATH, where there is no ${CLI_NAME}: hooks are skipped until it is there`)
      hooks = false
      unresolved++
    } else if (hooks && !(options.bin === undefined ? help : run([onPath!, "help", "--all"]).output).includes(`${CLI_NAME} hook`)) {
      out(`! the hooks run \`${CLI_NAME} hook\` from PATH, and ${onPath} has no \`${CLI_NAME} hook\`: hooks are skipped until it does`)
      hooks = false
      unresolved++
    } else if (hooks) out(`hooks run: ${CLI_NAME} from each harness's PATH (${onPath} here${options.bin !== undefined ? ", not --bin" : ""})`)
  }
  out(`found: ${selected.map((harness) => `${harness} (${found.get(harness)})`).join(", ") || "none"}`)
  if (missing.length) out(`not installed: ${missing.join(", ")}`)

  const plan: Plan = { steps: [], lines: [], problems: 0, hooks: new Map() }
  const ctx: Ctx = { env, cwd: deps.cwd, now, run, found, added, wanted, blockStop: options.blockStop === true }
  for (const harness of options.undo ? wanted : selected) {
    if (options.undo) planUnmount(plan, harness, ctx)
    else planMount(plan, harness, bin, ctx)
    if (harness === "agy") planAgyRules(plan, ctx, options.undo === true)
    if (hooks) (options.undo ? planUnhooks : planHooks)(plan, harness, ctx)
  }
  for (const harness of wanted) {
    const mine = plan.lines.filter((line) => line.harness === harness)
    if (!found.has(harness) && !mine.length) continue
    out("")
    out(`${harness}${found.has(harness) ? "" : " (not installed)"}:`)
    for (const { text, step } of mine) {
      if (text) out(`  ${text}`)
      if (!step) continue
      const [head, ...rest] = step.plan
      out(`  ${step.label}: ${head}`)
      for (const line of rest) deps.out(`      ${line}`)
    }
    if (options.undo && !mine.length) out("  nothing setup added")
  }
  unresolved += plan.problems
  out("")
  if (!plan.steps.length) out(options.undo ? "nothing to remove" : "everything is in place; nothing to do")
  else if (!options.write) out(`${plan.steps.length} change${plan.steps.length === 1 ? "" : "s"} planned; rerun with --write to apply`)
  if (unresolved) out(`${unresolved} item${unresolved === 1 ? "" : "s"} marked ! ${options.write ? "need" : "will need"} a fix by hand or a rerun`)
  if (!options.write) return 0

  let failures = unresolved
  const applied = new Set<Step>()
  for (const step of plan.steps) {
    try {
      const saved = step.apply()
      applied.add(step)
      if (step.manifest) writeManifest(env, now, step.manifest)
      out(`${step.harness} ${step.label}: done${saved ? ` (backup ${saved})` : ""}`)
    } catch (error) {
      failures++
      let kept: string | undefined
      try {
        kept = step.manifest && step.landed?.()
        if (kept) writeManifest(env, now, step.manifest!)
      } catch {
        kept = undefined
      }
      out(`${step.harness} ${step.label}: FAILED, ${message(error)}${kept ? `; ${kept} is recorded, so --undo removes it` : ""}`)
    }
  }
  out("")
  out("verify:")
  const check = (ok: boolean, line: string) => {
    if (!ok) failures++
    out(`  ${line}`)
  }
  const scratch = mkdtempSync(join(tmpdir(), "scp-setup-"))
  const neutral = join(scratch, "relay-setup-check")
  mkdirSync(neutral)
  const runNeutral = (argv: string[]) => run(argv, neutral)
  try {
    for (const harness of selected) {
      const cli = found.get(harness)!
      if (options.undo) {
        if (plan.steps.some((step) => step.harness === harness && step.label === "mcp" && applied.has(step))) {
          const result = verifyMount(harness, cli, env, runNeutral)
          check(result.ok, `${harness}: ${result.line}`)
        }
        const plugin = plan.steps.find((step) => step.harness === harness && harness === "muse" && step.label === "hooks" && applied.has(step))
        if (plugin) {
          const result = verifyMusePlugin(cli, pluginDir(plugin.file), runNeutral)
          check(result.ok, `muse hooks: ${result.line}`)
        }
        continue
      }
      const result = verifyMount(harness, cli, env, runNeutral, mountArgv(harness, bin))
      check(result.ok, `${harness}: ${result.line}`)
      if (harness === "agy") {
        let allow: unknown
        try {
          allow = (readJson(agySettingsFile(env))?.permissions as Json | undefined)?.allow
        } catch {}
        const present = agyRules().filter((rule) => Array.isArray(allow) && allow.includes(rule)).length
        check(present === agyRules().length, `agy permissions: ${present} of ${agyRules().length} relay tool rules in ${agySettingsFile(env)}`)
      }
      const target = plan.hooks.get(harness)
      if (!target) continue
      let inPlace = false
      try {
        inPlace = desiredHooks(target.kind, target.file, target.blockStop) === undefined
      } catch {}
      check(inPlace, `${harness} hooks: ${inPlace ? "in place" : "missing"} in ${target.file}`)
      if (harness === "claude" && inPlace) cacheClaudeVersion(cli, env, runNeutral)
      if (target.kind === "muse" && inPlace) {
        const plugin = verifyMusePlugin(cli, pluginDir(target.file), runNeutral, readFileSync(resolved(target.file), "utf8"))
        check(plugin.ok, `muse hooks: ${plugin.line}`)
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (plan.steps.some((step) => step.label === "hooks" && applied.has(step))) {
    out("")
    out("restart sessions started before setup: harnesses read hooks only at session start")
  }
  return failures ? 1 : 0
}

/** keeps `claude --version` where the hooks read it ({@link claudeVersionFile}), so a stop of an older Claude Code blocks; a failure keeps the last one */
function cacheClaudeVersion(cli: string, env: Env, run: (argv: string[]) => RunResult): void {
  const result = run([cli, "--version"])
  const version = /\d+\.\d+\.\d+/.exec(result.output)?.[0]
  if (result.code !== 0 || !version) return
  try {
    const file = claudeVersionFile(env)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${version}\n`)
  } catch {}
}

/** setup's own flags: --hooks, the default, is accepted and changes nothing */
export function parseSetupArgs(args: string[]): SetupOptions | "help" {
  const options = {
    write: { type: "boolean" },
    undo: { type: "boolean" },
    hooks: { type: "boolean" },
    "no-hooks": { type: "boolean" },
    "block-stop-on-unread": { type: "boolean" },
    bin: { type: "string" },
    harness: { type: "string" },
    help: { type: "boolean", short: "h" },
  } as const
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options }>>
  try {
    parsed = parseArgs({
      args,
      options,
      allowPositionals: false,
      strict: true,
    })
  } catch (error) {
    throw new RelayUsage(message(error))
  }
  const { help, hooks, "no-hooks": noHooks, "block-stop-on-unread": blockStop, ...rest } = parsed.values
  if (help) return "help"
  if (hooks && noHooks) throw new RelayUsage("--hooks and --no-hooks contradict each other; the hooks are installed unless --no-hooks")
  return { ...rest, ...(noHooks ? { hooks: false } : {}), ...(blockStop ? { blockStop } : {}) }
}

/** parses setup flags before the shared command parser */
export function relaySetupCommand(args: string[], cwd: string, out: (line: string) => void): number {
  const options = parseSetupArgs(args)
  if (options === "help") {
    out(SETUP_HELP)
    return 0
  }
  return relaySetup(options, { env: process.env, cwd, out })
}
