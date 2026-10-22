import { CLI_NAME, validHandle } from "@scp-dev/core"
import { connectBroker, relayDir } from "@scp-dev/broker"
import { runRelayMcp, sessionInboxOf, type SpawnRequest } from "@scp-dev/mcp"
import { CHANNELS_ENV, RelayUsage, startDaemon } from "./common"
import { cloudWithoutBroker, coworkLive } from "./hook-fast"
import { spawnDetached } from "./spawn"
import { mcpInstall } from "./install"
import { harnessAt, harnessPid, launcherPid, psParent, relayIdentity, writeShimBinding } from "./identity"
import { membership } from "./session"

/** how often the shim checks that the harness that started it still runs: one reparented away from it exits, freeing the endpoint */
const ORPHAN_CHECK_MS = 5000

type Values = { as?: string; harness?: string; human?: boolean; channels?: boolean; "cowork-only"?: boolean }

/** `swarm mcp`: the stdio MCP shim for this harness session, or `mcp install` */
export async function relayMcpCommand(values: Values, positionals: string[]): Promise<number> {
  if (positionals[0] === "install") {
    if (positionals.length > 1 || values.human || values.channels) throw new RelayUsage(`${CLI_NAME} mcp install takes --harness H and optionally --as NAME`)
    return mcpInstall(values.harness, values.as, (line) => process.stdout.write(`${line}\n`))
  }
  if (positionals.length) throw new RelayUsage(`${CLI_NAME} mcp takes no arguments (did you mean ${CLI_NAME} mcp install?)`)
  if (values.human) throw new RelayUsage("the relay MCP shim is always an agent: --human is not available to it")
  if (await coworkMcpGuard(values, { env: process.env, input: process.stdin, output: (line) => void process.stdout.write(line) })) return 0
  const claim = relayIdentity({
    ...(values.as !== undefined ? { as: values.as } : {}),
    ...(values.harness !== undefined ? { harness: values.harness } : {}),
    fallbackHarness: "mcp",
    cwd: process.cwd(),
    env: process.env,
    harnessPid: () => launcherPid(process.env) ?? harnessPid(),
    inferHarness: (pid) => harnessAt(pid),
  })
  if (!validHandle(claim.handle)) throw new RelayUsage(`${JSON.stringify(claim.handle)} is not a valid agent handle (me, user and relay are reserved)`)
  const dir = relayDir(process.env)
  const unbind = writeShimBinding(claim, process.env)
  process.on("exit", unbind)
  const parent = process.ppid
  const orphaned = setInterval(() => {
    if (process.ppid !== parent) process.exit(0)
  }, ORPHAN_CHECK_MS)
  orphaned.unref()
  const inbox = sessionInboxOf(process.env)
  try {
    await runRelayMcp({
      connect: () => connectBroker(dir, () => startDaemon(dir)),
      claim,
      membership: () => membership(process.env, claim.session),
      input: process.stdin,
      output: (line) => void process.stdout.write(line),
      env: process.env,
      channels: values.channels === true,
      launchedWithChannels: values.channels === true && launchedWithChannels(process.env),
      ...(inbox ? { sessionInbox: inbox } : {}),
      spawn: (request) => spawnDetached(spawnWords(request), request.cwd ?? claim.cwd),
      log: (line) => void process.stderr.write(`${line}\n`),
    })
  } finally {
    clearInterval(orphaned)
    process.off("exit", unbind)
    unbind()
  }
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

/** the synced plugin remains connected without claiming a terminal session */
export async function coworkMcpGuard(
  values: Values,
  options: { env: Record<string, string | undefined>; input: AsyncIterable<string | Uint8Array>; output: (line: string) => void },
): Promise<boolean> {
  if (!values["cowork-only"]) return false
  if (cloudWithoutBroker(relayDir(options.env), options.env)) {
    await inertMcp(options.input, options.output, "SCP has no relay in this cloud session; use the SCP connector.")
    return true
  }
  if (coworkLive(options.env)) return false
  await inertMcp(options.input, options.output)
  return true
}

/** a newline-delimited MCP server with no tools or relay connection */
export async function inertMcp(
  input: AsyncIterable<string | Uint8Array>,
  output: (line: string) => void,
  instructions = "SCP is inactive outside Cowork.",
): Promise<void> {
  const decoder = new TextDecoder()
  let pending = ""
  const respond = (line: string) => {
    let request: { id?: string | number | null; method?: string; params?: { protocolVersion?: string } }
    try {
      request = JSON.parse(line)
    } catch {
      return
    }
    if (!request || request.id === undefined) return
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: request.params?.protocolVersion,
            capabilities: {},
            serverInfo: { name: "scp", version: "0.0.0" },
            instructions,
          }
        : request.method === "tools/list"
          ? { tools: [] }
          : request.method === "ping"
            ? {}
            : undefined
    output(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(result === undefined ? { error: { code: -32601, message: "Method not found" } } : { result }) })}\n`,
    )
  }
  for await (const chunk of input) {
    pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    for (;;) {
      const end = pending.indexOf("\n")
      if (end < 0) break
      respond(pending.slice(0, end))
      pending = pending.slice(end + 1)
    }
  }
  pending += decoder.decode()
  if (pending.trim()) respond(pending)
}
