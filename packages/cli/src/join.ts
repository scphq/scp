import { CLI_NAME } from "@scp-dev/core"
import { connectBroker, readSessionMarker, relayDir } from "@scp-dev/broker"
import { localHandle, RelayUsage, startDaemon, walkNow } from "./common"
import { codexShell, harnessAt, relayIdentity, sessionKey } from "./identity"

type Values = { harness?: unknown; json?: unknown; under?: unknown }

/**
 * `swarm join [<handle>]`: puts the harness session that runs this shell on the relay, as its hooks would claim it, and takes `handle` when
 * given (renaming it in place when it already joined), and with `--under` links it under that agent. Works for a session started before the
 * hooks were installed too
 */
export async function joinCommand(values: Values, positionals: string[], cwd: string, out: (line: string) => void): Promise<number> {
  if (positionals.length > 1) throw new RelayUsage(`${CLI_NAME} join takes one handle, or none to keep the session's name`)
  const handle = positionals[0] === undefined ? undefined : localHandle(positionals[0])
  const { keys, self } = walkNow()
  const key = self.at(-1)
  const match = key === undefined ? null : /^pid:(\d+):(.+)$/.exec(key)
  if (!match) {
    if (codexShell(process.env)) throw new RelayUsage(`${CLI_NAME} join: the codex sandbox hides the harness; use relay_join (MCP) instead`)
    throw new RelayUsage(`${CLI_NAME} join runs in an agent session's shell: no harness process runs this shell`)
  }
  const dir = relayDir()
  const known = readSessionMarker(dir, sessionKey(process.env, key!))?.handle
  const claim = relayIdentity({
    ...(known ? { as: known } : {}),
    ...(typeof values.harness === "string" ? { harness: values.harness } : {}),
    fallbackHarness: "cli",
    cwd,
    env: process.env,
    harnessPid: () => Number(match[1]),
    inferHarness: (pid) => harnessAt(pid),
    startOf: () => match[2],
    lineageOf: () => keys.slice(Math.max(0, keys.indexOf(key!))),
  })
  const client = await connectBroker(dir, () => startDaemon(dir))
  try {
    const under = typeof values.under === "string" ? values.under : undefined
    const hello = await client.hello({ transient: true, claim, join: { ...(handle ? { handle } : {}), ...(under ? { under } : {}) } })
    const view = hello.endpoint!
    if (values.json === true) out(JSON.stringify(view, null, 2))
    else
      out(`joined as ${view.address}${view.parent ? ` under ${view.parent}` : ""}: peers can message it, and its hooks hand it new messages at turn boundaries`)
  } finally {
    client.close()
  }
  return 0
}
