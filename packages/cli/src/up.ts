import { CLI_NAME } from "@scp-dev/core"
import { RelayUsage } from "./common"
import { activeRelay, relayCredential } from "./relay"

type BridgeStatus = { enabled: boolean; connected?: boolean; url?: string; machine?: string; last_error?: string | null }

export interface UpValues {
  token?: string | undefined
  label?: string | undefined
  machine?: string | undefined
  "no-browser"?: boolean | undefined
}

/** `swarm up`: log in when needed (`--token` or $SCP_TOKEN headless), link the broker to the hub, install hooks and MCP mounts, start the broker */
export async function up(positionals: string[], values: UpValues, cwd: string, brokerStatus: () => Promise<BridgeStatus>): Promise<number> {
  if (positionals.length) throw new RelayUsage(`${CLI_NAME} up takes only flags`)
  const out = (line: string) => process.stdout.write(`${line}\n`)
  const { url } = activeRelay(process.env)
  const headless = values.token !== undefined || Boolean(process.env.SCP_TOKEN?.trim())
  if (headless || !relayCredential(process.env, url).token) {
    const code = await (await import("./login")).login({
      ...(values.token !== undefined ? { token: values.token } : {}),
      ...(values.label !== undefined ? { label: values.label } : {}),
      ...(values["no-browser"] ? { "no-browser": true } : {}),
    })
    if (code !== 0) return code
  } else out(`already logged in to ${url}`)
  const enabled = await (await import("./remote")).cloudMain(["enable"], values.machine !== undefined ? { machine: values.machine } : {}, brokerStatus)
  if (enabled !== 0) return enabled
  const setup = (await import("./setup")).relaySetupCommand(["--write"], cwd, out)
  if (setup !== 0) return setup
  const broker = await brokerStatus()
  if (!broker.enabled) out(`the broker that was already running stays local-only until it exits (it stops when idle); the next one links to ${url}`)
  else out(`broker linked to ${broker.url ?? url}${broker.connected ? "" : " (connecting)"}`)
  return 0
}
