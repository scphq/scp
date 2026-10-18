import { type PeekLevel, type PeekResult, type PeekSeen, PREAMBLE, wrapPeek, CLI_NAME } from "@scp-dev/core"
import type { RelayClient } from "@scp-dev/broker"
import { note } from "./term"
import { RelayUsage, stamp } from "./common"

type Values = Partial<Record<string, string | boolean | string[]>>

const TURNS_MAX = 10
const LEVELS = new Set(["on", "local", "off"])

const out = (line = "") => process.stdout.write(`${line}\n`)
const json = (value: unknown) => out(JSON.stringify(value, null, 2))

function turnsArg(value: string | boolean | string[] | undefined): number | undefined {
  if (value === undefined) return undefined
  const turns = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!(turns >= 1 && turns <= TURNS_MAX)) throw new RelayUsage(`--turns takes a whole number from 1 to ${TURNS_MAX}, not ${JSON.stringify(value)}`)
  return turns
}

/** `swarm peek <ep> [--turns N] [--full]`: another agent's last turns behind the preamble, wrapped as data; `swarm peek --who [ep]`: who peeked */
export async function peekCommand(client: RelayClient, values: Values, positionals: string[]): Promise<number> {
  const asJson = values.json === true
  const [endpoint, extra] = positionals
  if (extra !== undefined) throw new RelayUsage(`${CLI_NAME} peek takes one address`)
  if (values.who === true) {
    if (values.turns !== undefined || values.full !== undefined) throw new RelayUsage(`${CLI_NAME} peek --who takes no --turns or --full`)
    const { peeked_by } = await client.request<{ peeked_by: PeekSeen[] }>("peek_who", endpoint ? { endpoint } : {})
    if (asJson) json({ peeked_by })
    else if (!peeked_by.length) note(`nobody peeked at ${endpoint ?? "you"}`)
    else for (const seen of peeked_by) out(`${stamp(seen.at)} ${seen.by} (${seen.auth}) ${seen.turns} turn${seen.turns === 1 ? "" : "s"}`)
    return 0
  }
  if (!endpoint) throw new RelayUsage(`${CLI_NAME} peek takes an address, or --who`)
  const turns = turnsArg(values.turns)
  const result = await client.request<PeekResult>("peek", {
    endpoint,
    ...(turns !== undefined ? { turns } : {}),
    ...(values.full === true ? { full: true } : {}),
  })
  if (asJson) json({ preamble: PREAMBLE, ...result })
  else out(`${PREAMBLE}\n\n${wrapPeek(result)}`)
  return 0
}

/** `swarm set-peek on|off [ep]`: your own peek setting, or (off only) one you have authority over */
export async function setPeekCommand(client: RelayClient, values: Values, positionals: string[]): Promise<number> {
  const [level, endpoint, extra] = positionals
  if (!level || !LEVELS.has(level) || extra !== undefined) throw new RelayUsage(`${CLI_NAME} set-peek takes on|off [endpoint]`)
  const result = await client.request<{ endpoint: string; peek: PeekLevel | null }>("peek_set", { level, ...(endpoint ? { endpoint } : {}) })
  if (values.json === true) json(result)
  else out(`${result.endpoint}: peek ${result.peek ?? "off"}`)
  return 0
}

export { peekGrant } from "./common"
