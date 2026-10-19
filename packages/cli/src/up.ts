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

/** how each harness starts so peer messages wake it, not only reach it at its next turn boundary */
const WAKE_LAUNCH: [harness: string, line: string][] = [
  ["claude", `${CLI_NAME} claude --name <name>     Claude Code with the scp channel: messages wake it`],
  ["codex", `${CLI_NAME} codex --name <name>      messages start or steer its turns`],
  ["pi", `${CLI_NAME} pi --name <name>         messages arrive as turns`],
  ["opencode", "opencode                          its scp plugin wakes an idle session (on by default)"],
  ["agy", `${CLI_NAME} agy --name <name>        headless: each message resumes its conversation`],
  ["grok", `${CLI_NAME} grok --name <name>       headless: each message resumes its session`],
  ["t3code", `${CLI_NAME} t3code --thread <id>    T3 Code: messages start or steer the thread's turns`],
]

/** what `swarm up` prints last: the wake-enabled launch of each installed harness, and the fallback for a running session */
export function nextSteps(installed: ReadonlySet<string>): string[] {
  const launches = WAKE_LAUNCH.filter(([harness]) => installed.has(harness)).map(([, line]) => `  ${line}`)
  return [
    "next: start each agent session wake-enabled:",
    ...launches,
    `  ${CLI_NAME} join <name>                 in a session already running: it sees messages only at turn boundaries until relaunched as above`,
    `  ${CLI_NAME} setup                       checks the hooks and MCP mounts (it lists nothing to do once they are installed)`,
  ]
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
  if (!broker.enabled) out(`the broker is still local-only; run \`${CLI_NAME} daemon restart\` to link it to ${url}`)
  else out(`broker linked to ${broker.url ?? url}${broker.connected ? "" : " (connecting)"}`)
  const { detectHarnesses, detectT3, whichOnPath } = await import("./setup")
  const which = (name: string) => whichOnPath(name, process.env)
  const installed = new Set<string>(detectHarnesses(process.env, which).keys())
  if (which("pi")) installed.add("pi")
  if (detectT3(process.env, which)) installed.add("t3code")
  out("")
  for (const line of nextSteps(installed)) out(line)
  return 0
}
