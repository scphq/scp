import { CLI_NAME } from "@scp-dev/core"
import { connectBroker, readSessionMarker, relayDir } from "@scp-dev/broker"
import { localHandle, RelayUsage, startDaemon, walkNow } from "./common"
import { relayIdentity, sessionKey } from "./identity"

type Values = { harness?: unknown; json?: unknown }

/**
 * `swarm join [<handle>]`: puts the harness session that runs this shell on the relay, as its hooks would claim it, and takes `handle` when
 * given (renaming it in place when it already joined). Works for a session started before the hooks were installed too
 */
export async function joinCommand(values: Values, positionals: string[], cwd: string, out: (line: string) => void): Promise<number> {
  if (positionals.length > 1) throw new RelayUsage(`${CLI_NAME} join takes one handle, or none to keep the session's name`)
  const handle = positionals[0] === undefined ? undefined : localHandle(positionals[0])
  const { keys, self } = walkNow()
  const key = self.at(-1)
  const match = key === undefined ? null : /^pid:(\d+):(.+)$/.exec(key)
  if (!match) throw new RelayUsage(`${CLI_NAME} join runs in an agent session's shell: no harness process runs this shell`)
  const dir = relayDir()
  const known = readSessionMarker(dir, sessionKey(process.env, key!))?.handle
  const claim = relayIdentity({
    ...(known ? { as: known } : {}),
    ...(typeof values.harness === "string" ? { harness: values.harness } : {}),
    fallbackHarness: "cli",
    cwd,
    env: process.env,
    harnessPid: () => Number(match[1]),
    startOf: () => match[2],
    lineageOf: () => keys.slice(Math.max(0, keys.indexOf(key!))),
  })
  const client = await connectBroker(dir, () => startDaemon(dir))
  try {
    const hello = await client.hello({ transient: true, claim, join: handle ? { handle } : {} })
    if (values.json === true) out(JSON.stringify(hello.endpoint, null, 2))
    else out(`joined as ${hello.endpoint!.address}: peers can message it, and its hooks hand it new messages at turn boundaries`)
  } finally {
    client.close()
  }
  return 0
}
