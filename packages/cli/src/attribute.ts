import { BrokerUnavailable, connectBroker, type RelayClient, relayDir } from "@scp-dev/broker"
import { CLI_NAME } from "@scp-dev/core"
import { spawnEnvironment, type Walk, walkNow } from "./common"
import { codexShell } from "./identity"

type Env = Record<string, string | undefined>

/** what links the session a launcher starts under the agent whose shell ran it: the grant's variables, and that agent's address */
export type Attribution = { env: Record<string, string>; parent: string }

export type AttributeDeps = {
  /** the broker for `dir`, never started: none running means no agent runs this shell */
  connect?: (dir: string) => Promise<RelayClient>
  walk?: Walk
}

/**
 * the grant `swarm spawn-env [--name N]` from this shell would mint, so the session a launcher starts links under the agent whose harness
 * runs this shell: minted by that agent's self or lineage attestation, with its authority and no more. None with `root`, with $SCP_GRANT
 * set (that grant applies), on the cloud transport, or when no agent runs this shell; any failure warns and the session starts unlinked
 */
export async function attribute(
  launcher: string,
  opts: { name?: string | undefined; root?: boolean | undefined; dir?: string | undefined },
  env: Env,
  cwd: string,
  warn: (line: string) => void,
  deps: AttributeDeps = {},
): Promise<Attribution | undefined> {
  if (opts.root || env.SCP_GRANT || env.SCP_TRANSPORT === "cloud") return undefined
  const unlinked = (why: string) =>
    warn(`${CLI_NAME} ${launcher}: not linked under the agent that ran it (${why}); it starts as a root, ${CLI_NAME} adopt <name> links it later`)
  let client: RelayClient
  try {
    const walk = deps.walk ?? walkNow(env as NodeJS.ProcessEnv)
    if (!walk.keys.length && !walk.self.length) return undefined
    client = await (deps.connect ?? ((dir: string) => connectBroker(dir)))(opts.dir ?? relayDir(env as NodeJS.ProcessEnv))
    try {
      await client.hello({ observe: true, lineage: walk.keys, ...(walk.self.length ? { self: walk.self } : {}), cwd, brief: true })
    } catch (error) {
      client.close()
      throw error
    }
  } catch (error) {
    if (error instanceof BrokerUnavailable && !error.sandboxed && !codexShell(env)) return undefined
    unlinked(error instanceof Error ? error.message : String(error))
    return undefined
  }
  try {
    let parent: string
    try {
      parent = (await client.rules()).address
    } catch {
      return undefined
    }
    const own = parent.slice(parent.lastIndexOf("/") + 1)
    const name = opts.name ?? (env.SCP_NAME && env.SCP_NAME !== own ? env.SCP_NAME : undefined)
    const { env: granted } = await client.grant(name !== undefined ? { name } : {})
    return { env: granted, parent }
  } catch (error) {
    unlinked(error instanceof Error ? error.message : String(error))
    return undefined
  } finally {
    client.close()
  }
}

/** the launch environment: the caller's identity swapped for the grant's, or `env` unchanged without one */
export function attributed(env: Env, attribution: Attribution | undefined): Env {
  return attribution ? spawnEnvironment(env, attribution.env) : env
}

/** the note a launcher adds to its address line when a grant links the session */
export const underText = (attribution: Attribution | undefined): string => (attribution ? ` under ${attribution.parent}` : "")

/** the help line of a launcher's --root */
export const ROOT_HELP = `  run from an agent's shell, it links under that agent by itself (as under env $(${CLI_NAME} spawn-env)); $SCP_GRANT set uses that grant,
  --root starts it as a root.`
