import { spawn } from "node:child_process"
import { CLI_NAME, validHandle } from "@scp-dev/core"
import { CHANNELS_ENV, RelayUsage } from "./common"
import { entryArgv, mcpFile, mountedEntry, whichOnPath } from "./setup"

export const CHANNEL_FLAGS = ["--dangerously-load-development-channels", "server:scp"]

type Env = Record<string, string | undefined>

/** `swarm claude [--name N] [--] [claude args...]`: the handle and the arguments passed through to claude */
export function claudeArgv(argv: string[]): { name?: string; args: string[] } {
  let name: string | undefined
  let i = 0
  if (argv[0] === "--name") {
    if (argv[1] === undefined) throw new RelayUsage(`${CLI_NAME} claude --name takes a handle`)
    name = argv[1]
    i = 2
  } else if (argv[0]?.startsWith("--name=")) {
    name = argv[0].slice("--name=".length)
    i = 1
  }
  if (argv[i] === "--") i++
  if (name !== undefined && !validHandle(name)) throw new RelayUsage(`--name ${JSON.stringify(name)} is not a valid agent handle`)
  return { ...(name !== undefined ? { name } : {}), args: argv.slice(i) }
}

/** a one-line hint when Claude Code's scp mount is missing or cannot push, else undefined */
export function mountHint(env: Env): string | undefined {
  const file = mcpFile("claude", env)
  let entry: ReturnType<typeof mountedEntry>
  try {
    entry = mountedEntry("claude", file)
  } catch {
    return `${CLI_NAME} claude: ${file} is unreadable, so the scp mount is unchecked`
  }
  if (!entry) return `${CLI_NAME} claude: Claude Code has no scp MCP mount; run ${CLI_NAME} setup --write`
  if (!entryArgv("claude", entry).includes("--channels"))
    return `${CLI_NAME} claude: the scp mount lacks --channels, so messages will not wake this session; re-run ${CLI_NAME} setup --write`
  return undefined
}

/** runs claude with the scp channel loaded and the terminal passed through; resolves with its exit code */
export async function claudeCommand(
  argv: string[],
  env: Env = process.env,
  err: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${CLI_NAME} claude [--name N] [--] [claude args...]   start Claude Code with the scp channel loaded, so peer messages wake it\n`)
    return 0
  }
  const { name, args } = claudeArgv(argv)
  const bin = whichOnPath("claude", env)
  if (!bin) throw new RelayUsage("claude is not on PATH")
  const hint = mountHint(env)
  if (hint) err(hint)
  const child = spawn(bin, [...CHANNEL_FLAGS, ...args], {
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
