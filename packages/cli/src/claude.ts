import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CLI_NAME, validHandle } from "@scp-dev/core"
import { CHANNELS_ENV, RelayUsage } from "./common"
import { deriveHandle } from "./identity"
import { joinMode } from "./relay"
import { entryArgv, mcpFile, mountedEntry, whichOnPath } from "./setup"

export const CHANNEL_FLAGS = ["--dangerously-load-development-channels", "server:scp"]

type Env = Record<string, string | undefined>

/** `swarm claude [--name N | --as N] [--] [claude args...]`: the handle and the arguments passed through to claude */
export function claudeArgv(argv: string[]): { name?: string; args: string[] } {
  let name: string | undefined
  let i = 0
  for (;;) {
    const arg = argv[i]
    if (arg === "--name" || arg === "--as") {
      if (argv[i + 1] === undefined) throw new RelayUsage(`${CLI_NAME} claude ${arg} takes a handle`)
      name = argv[i + 1]
      i += 2
    } else if (arg?.startsWith("--name=") || arg?.startsWith("--as=")) {
      name = arg.slice(arg.indexOf("=") + 1)
      i++
    } else break
  }
  if (argv[i] === "--") i++
  name = name?.replace(/^me\//, "")
  if (name !== undefined && !validHandle(name)) throw new RelayUsage(`--name ${JSON.stringify(name)} is not a valid agent handle`)
  return { ...(name !== undefined ? { name } : {}), args: argv.slice(i) }
}

/** claude's arguments with what SCP adds placed before any `--`, after the user's own so a variadic option of ours never takes their prompt */
export function claudeLaunchArgs(args: string[], added: string[]): string[] {
  const end = args.indexOf("--")
  const at = end < 0 ? args.length : end
  const channels = args.some((arg, i) => i < at && (arg === "server:scp" || arg === `${CHANNEL_FLAGS[0]}=server:scp`)) ? [] : CHANNEL_FLAGS
  return [...args.slice(0, at), ...channels, ...added, ...args.slice(at)]
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
export function mountHint(env: Env, cwd: string = process.cwd()): string | undefined {
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

/** runs claude with the scp channel loaded and the terminal passed through; resolves with its exit code */
export async function claudeCommand(
  argv: string[],
  env: Env = process.env,
  err: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
  cwd: string = process.cwd(),
): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(
      `${CLI_NAME} claude [--name N | --as N] [--] [claude args...]   start Claude Code with the scp channel loaded, so peer messages wake it\n`,
    )
    return 0
  }
  const { name, args } = claudeArgv(argv)
  const bin = whichOnPath("claude", env)
  if (!bin) throw new RelayUsage("claude is not on PATH")
  const external = externalMcp(args)
  const hint = external ? undefined : args.includes("--strict-mcp-config") ? STRICT_HINT : mountHint(env, cwd)
  if (hint) throw new RelayUsage(hint)
  if (external) err(`${CLI_NAME} claude: using your --mcp-config; it needs the scp server with --channels for messages to wake this session`)
  const child = spawn(bin, claudeLaunchArgs(args, namePrompt(name, args, env, cwd)), {
    cwd,
    stdio: "inherit",
    env: { ...env, ...(name !== undefined ? { SCP_NAME: name } : {}), [CHANNELS_ENV]: String(process.pid) },
  })
  const forward = (signal: NodeJS.Signals) => () => void child.kill(signal)
  const handlers = (["SIGTERM", "SIGHUP"] as const).map((signal) => [signal, forward(signal)] as const)
  const ignore = () => {}
  process.on("SIGINT", ignore)
  for (const [signal, handler] of handlers) process.on(signal, handler)
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + (signalNumber(signal) ?? 1) : 1)))
    })
  } finally {
    process.off("SIGINT", ignore)
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
}

const SIGNALS: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }
const signalNumber = (signal: NodeJS.Signals): number | undefined => SIGNALS[signal]
