import { BrokerUnavailable, connectBroker, type RelayClient, relayDir } from "@scp-dev/broker"
import { CLI_NAME, RelayError } from "@scp-dev/core"
import { spawnEnvironment, terminalAttached, type Walk, walkNow } from "./common"
import { codexShell } from "./identity"

type Env = Record<string, string | undefined>

/**
 * what the launcher gives the session it starts: the grant's variables in place of the caller's identity, and the agent it links under.
 * Without `parent` it only drops the caller's identity, for a session started as a root from an agent's shell
 */
export type Attribution = { env: Record<string, string>; parent?: string }

export type AttributeDeps = {
  /** the broker for `dir`, never started: none running means no agent runs this shell */
  connect?: (dir: string) => Promise<RelayClient>
  walk?: Walk
  /** whether a terminal is attached, which binds by lineage only, as spawn-env does */
  tty?: boolean
  timeoutMs?: number
}

/** how long a launcher waits on the broker for attribution before it starts the session unlinked */
export const ATTRIBUTE_TIMEOUT_MS = 5000

const ROOT: Attribution = { env: {} }

/**
 * the grant `swarm spawn-env [--name N]` from this shell would mint, so the session a launcher starts links under the agent whose harness
 * runs this shell: bound as spawn-env binds (self attestation, lineage only at a terminal), with that agent's authority and no more. A
 * $SCP_GRANT is the caller's own when it binds this shell (a spawned agent's spent grant), and is replaced; any other applies as is.
 * Nothing for a resumed session, on the cloud transport, or when no agent runs this shell, which stays silent. Once a harness or agent
 * is found, a failure warns and the session starts unlinked; with `root`, or once the caller is known, without the caller's identity
 */
export async function attribute(
  launcher: string,
  opts: { name?: string | undefined; root?: boolean | undefined; resume?: boolean | undefined; dir?: string | undefined },
  env: Env,
  cwd: string,
  warn: (line: string) => void,
  deps: AttributeDeps = {},
): Promise<Attribution | undefined> {
  if (opts.resume || env.SCP_TRANSPORT === "cloud") return undefined
  if (opts.root) return ROOT
  let walk: Walk
  try {
    walk = deps.walk ?? walkNow(env as NodeJS.ProcessEnv)
  } catch {
    return undefined
  }
  if (!walk.keys.length) return undefined
  const grant = env.SCP_GRANT || undefined
  const self = grant || !(deps.tty ?? terminalAttached(process, false)) ? walk.self : []
  const harnessed = walk.harness !== undefined || codexShell(env)
  const unlinked = (why: string) =>
    warn(`${CLI_NAME} ${launcher}: not linked under the agent that ran it (${why}); it starts as a root, ${CLI_NAME} adopt <name> links it later`)
  let client: RelayClient | undefined
  let caller: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const ms = deps.timeoutMs ?? ATTRIBUTE_TIMEOUT_MS
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from the relay broker within ${ms} ms`)), ms)
  })
  const mint = async (): Promise<Attribution | undefined> => {
    const connected = await (deps.connect ?? ((dir: string) => connectBroker(dir)))(opts.dir ?? relayDir(env as NodeJS.ProcessEnv))
    if (settled) {
      connected.close()
      return undefined
    }
    client = connected
    let bound: Awaited<ReturnType<RelayClient["hello"]>>
    try {
      bound = await client.hello({ observe: true, lineage: walk.keys, ...(self.length ? { self } : {}), ...(grant ? { grant } : {}), cwd, brief: true })
    } catch (error) {
      if (grant) return undefined
      throw error
    }
    caller = bound.endpoint?.address
    try {
      caller = (await client.rules()).address
    } catch (error) {
      if (caller !== undefined) throw error
      return undefined
    }
    const own = caller.slice(caller.lastIndexOf("/") + 1)
    if (env.SCP_NAME && env.SCP_NAME.replace(/^me\//, "") !== own) {
      unlinked(`$SCP_NAME names ${env.SCP_NAME}, but this shell runs under ${caller}`)
      caller = undefined
      return undefined
    }
    const { env: granted } = await client.grant(opts.name !== undefined ? { name: opts.name } : {})
    return { env: granted, parent: caller }
  }
  try {
    return await Promise.race([mint(), deadline])
  } catch (error) {
    if (caller === undefined && (!harnessed || error instanceof RelayError || (error instanceof BrokerUnavailable && !error.sandboxed))) return undefined
    unlinked(error instanceof Error ? error.message : String(error))
    return caller === undefined ? undefined : ROOT
  } finally {
    settled = true
    clearTimeout(timer)
    client?.close()
  }
}

/** the launch environment: the caller's identity swapped for the grant's, or `env` unchanged without one */
export function attributed(env: Env, attribution: Attribution | undefined): Env {
  return attribution ? spawnEnvironment(env, attribution.env) : env
}

/** the arguments before any `--`: a launched harness's own options */
export const optionsBefore = (args: string[]): string[] => (args.includes("--") ? args.slice(0, args.indexOf("--")) : args)

/** whether `args` carries one of `flags` (bare or `--flag=value`) before any `--` */
export const hasFlag = (args: string[], flags: string[]): boolean => optionsBefore(args).some((arg) => flags.includes(arg.split("=")[0]!))

/** the note a launcher adds to its address line when a grant links the session */
export const underText = (attribution: Attribution | undefined): string => (attribution?.parent ? ` under ${attribution.parent}` : "")

/** the help line of a launcher's --root */
export const ROOT_HELP = `  run from an agent's shell, it links under that agent by itself (as under env $(${CLI_NAME} spawn-env)); a $SCP_GRANT minted for it
  applies instead (your own spent grant is replaced), a resumed session keeps its place, and --root starts it as a root.`
