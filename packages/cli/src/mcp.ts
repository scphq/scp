import { CLI_NAME, validHandle } from "@scp-dev/core"
import { connectBroker, relayDir } from "@scp-dev/broker"
import { runRelayMcp, type SpawnRequest } from "@scp-dev/mcp"
import { CHANNELS_ENV, RelayUsage, startDaemon } from "./common"
import { spawnDetached } from "./spawn"
import { mcpInstall } from "./install"
import { harnessPid, psParent, relayIdentity } from "./identity"

type Values = { as?: string; harness?: string; human?: boolean; channels?: boolean }

/** `swarm mcp`: the stdio MCP shim for this harness session, or `mcp install` */
export async function relayMcpCommand(values: Values, positionals: string[]): Promise<number> {
  if (positionals[0] === "install") {
    if (positionals.length > 1 || values.human || values.channels) throw new RelayUsage(`${CLI_NAME} mcp install takes --harness H and optionally --as NAME`)
    return mcpInstall(values.harness, values.as, (line) => process.stdout.write(`${line}\n`))
  }
  if (positionals.length) throw new RelayUsage(`${CLI_NAME} mcp takes no arguments (did you mean ${CLI_NAME} mcp install?)`)
  if (values.human) throw new RelayUsage("the relay MCP shim is always an agent: --human is not available to it")
  const claim = relayIdentity({
    ...(values.as !== undefined ? { as: values.as } : {}),
    ...(values.harness !== undefined ? { harness: values.harness } : {}),
    fallbackHarness: "mcp",
    cwd: process.cwd(),
    env: process.env,
    harnessPid: () => harnessPid(),
  })
  if (!validHandle(claim.handle)) throw new RelayUsage(`${JSON.stringify(claim.handle)} is not a valid agent handle (me, user and relay are reserved)`)
  const dir = relayDir()
  await runRelayMcp({
    connect: () => connectBroker(dir, () => startDaemon(dir)),
    claim,
    input: process.stdin,
    output: (line) => void process.stdout.write(line),
    env: process.env,
    channels: values.channels === true,
    launchedWithChannels: values.channels === true && launchedWithChannels(process.env),
    spawn: (request) => spawnDetached(spawnWords(request), request.cwd ?? claim.cwd),
    log: (line) => void process.stderr.write(`${line}\n`),
  })
  return 0
}

/** relay_spawn's request as `swarm spawn --bg` words, acting as the shim's own agent */
export function spawnWords(request: SpawnRequest): string[] {
  return [
    "--bg",
    "--as",
    request.as,
    ...(request.harness !== undefined ? ["--harness", request.harness] : []),
    ...(request.name !== undefined ? ["--name", request.name] : []),
    ...(request.title !== undefined ? ["--title", request.title] : []),
    ...(request.no_push ? ["--no-push"] : []),
    ...(request.handback_bytes !== undefined ? ["--handback-bytes", String(request.handback_bytes)] : []),
    "--",
    ...request.command,
  ]
}

/** whether this shim's harness is the process `swarm claude` started with channels loaded: its parent is the launcher named in the environment */
export function launchedWithChannels(env: NodeJS.ProcessEnv, harness = harnessPid, parentOf = psParent): boolean {
  const launcher = Number(env[CHANNELS_ENV])
  return Number.isInteger(launcher) && launcher > 1 && parentOf(harness())?.ppid === launcher
}
