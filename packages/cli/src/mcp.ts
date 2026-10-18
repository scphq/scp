import { CLI_NAME, validHandle } from "@scp-dev/core"
import { connectBroker, relayDir } from "@scp-dev/broker"
import { runRelayMcp } from "@scp-dev/mcp"
import { RelayUsage, startDaemon } from "./common"
import { mcpInstall } from "./install"
import { harnessPid, relayIdentity } from "./identity"

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
    log: (line) => void process.stderr.write(`${line}\n`),
  })
  return 0
}
