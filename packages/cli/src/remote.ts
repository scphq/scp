import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { CLI_NAME, type Claim, type EndpointView, parsePolicy, PROTOCOL, RelayError, type ErrorCode } from "@scp-dev/core"
import { MACHINE_NAME } from "@scp-dev/hub"
import { type BridgeConfig, relaySocketUrl, thisHostname } from "@scp-dev/broker"
import { activeRelay, checkRelayUrl, configDir, relayCredential, writePrivateJson } from "./relay"
import { RelayUsage } from "./common"
import { note, printTable } from "./term"

type Env = Record<string, string | undefined>

/** what relay.ts needs from a connection, local broker or hub */
export interface RelayTransport {
  request<T = unknown>(method: string, params?: object): Promise<T>
  onNotification(fn: (method: string, params: unknown) => void): void
  close(): void
}

/** a usage problem with the cloud transport (exit code and help hint like relay.ts's) */
export class CloudUsage extends RelayUsage {}

type Frame = {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message: string; data?: { code?: ErrorCode; retry_after?: number } }
}

/** one JSON-RPC WebSocket to the hub */
export class CloudRelayClient implements RelayTransport {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private listeners: ((method: string, params: unknown) => void)[] = []
  private closedError: Error | undefined

  private constructor(private readonly ws: WebSocket) {}

  static async connect(origin: string, token: string): Promise<CloudRelayClient> {
    const url = relaySocketUrl(origin)
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[])
    const client = new CloudRelayClient(ws)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve())
      ws.addEventListener("error", () => reject(new RelayError("unavailable", `could not connect to the relay at ${url} (check SCP_RELAY and your login)`)))
    })
    ws.addEventListener("message", (event) => client.onFrame(String(event.data)))
    ws.addEventListener("close", (event) => {
      const reason = event.reason ? `: ${event.reason}` : ""
      client.fail(
        event.code === 1008
          ? new RelayError("unauthorized", `the relay closed the connection${reason}`)
          : new RelayError("unavailable", `the relay closed the connection (${event.code}${reason})`),
      )
    })
    return client
  }

  onNotification(fn: (method: string, params: unknown) => void): void {
    this.listeners.push(fn)
  }

  request<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }

  close(): void {
    this.fail(new RelayError("unavailable", "the connection is closed"))
    if (this.ws.readyState <= 1) this.ws.close(1000, "done")
  }

  private onFrame(text: string) {
    let frame: Frame
    try {
      frame = JSON.parse(text) as Frame
    } catch {
      return
    }
    if (frame.method) {
      for (const fn of this.listeners) fn(frame.method, frame.params)
      return
    }
    const waiter = frame.id !== undefined ? this.pending.get(frame.id) : undefined
    if (!waiter) return
    this.pending.delete(frame.id!)
    if (frame.error) waiter.reject(new RelayError(frame.error.data?.code ?? "invalid_params", frame.error.message, frame.error.data?.retry_after))
    else waiter.resolve(frame.result)
  }

  private fail(error: Error) {
    if (this.closedError) return
    this.closedError = error
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }
}

/** the short hostname, lowercased, as a machine name */
export function hostMachine(): string {
  const name = thisHostname()
    .split(".")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  return MACHINE_NAME.test(name) && name !== "me" ? name : "machine"
}

export function machineName(flag: string | undefined, env: Env = process.env): string {
  const name = flag ?? env.SCP_MACHINE ?? hostMachine()
  if (!MACHINE_NAME.test(name) || name === "me")
    throw new CloudUsage(`machine ${JSON.stringify(name)} is not valid: lowercase letters, digits and -, at most 32, not "me"`)
  return name
}

/** opens the hub transport for a verb: an agent claim with --as, an observer that binds no machine with `observe`, else the account inbox */
export async function openCloud(options: {
  machine?: string
  handle?: string
  claim?: Claim
  tty: boolean
  observe?: boolean
}): Promise<{ client: CloudRelayClient; me: EndpointView | null; where: string }> {
  const machine = machineName(options.machine)
  const { url } = activeRelay()
  const { token, problem } = relayCredential(process.env, url)
  if (!token) throw new CloudUsage(problem!)
  const client = await CloudRelayClient.connect(url, token)
  try {
    const hello = await client.request<{ account: string; endpoint?: EndpointView }>(
      "hello",
      options.handle
        ? { protocol: PROTOCOL, machine, claim: options.claim }
        : options.observe
          ? { protocol: PROTOCOL, observe: true, machine }
          : { protocol: PROTOCOL, machine, human: true, tty: options.tty },
    )
    return { client, me: hello.endpoint ?? null, where: `the relay at ${url}, account ${hello.account}, machine ${machine}` }
  } catch (error) {
    client.close()
    throw error
  }
}

const out = (line = "") => process.stdout.write(`${line}\n`)
const json = (value: unknown) => out(JSON.stringify(value, null, 2))

/** The machine inventory over an open hub connection */
export async function machinesVerb(client: RelayTransport, positionals: string[], asJson: boolean): Promise<number> {
  const [action, name] = positionals
  if (action === "rm") {
    if (!name || positionals.length !== 2) throw new CloudUsage(`${CLI_NAME} machines rm needs one machine name`)
    const result = await client.request<{ removed: string; endpoints: number }>("machines_rm", { name })
    if (asJson) json(result)
    else out(`released ${result.removed} (${result.endpoints} endpoints dropped)`)
    return 0
  }
  if (action !== undefined) throw new CloudUsage(`${CLI_NAME} machines takes no argument, or rm NAME`)
  const { machines } = await client.request<{
    machines: { name: string; kind: string; online: boolean; bridge: boolean; created_at: string | null; last_seen: string | null }[]
  }>("machines")
  if (asJson) json({ machines })
  else
    printTable([
      ["MACHINE", "KIND", "ONLINE", "BRIDGE", "LAST SEEN"],
      ...machines.map((m) => [m.name, m.kind, m.online ? "yes" : "no", m.bridge ? "yes" : "no", m.last_seen ?? ""]),
    ])
  return 0
}

export interface CloudFile {
  bridge: true
  machine: string
  url: string
  mirror?: string[]
  redact?: boolean
  private_ok?: boolean
}

/** The bridge configuration beside the relay selection and credentials. */
export function cloudFilePath(env: Env = process.env): string {
  return join(configDir(env), "cloud.json")
}

export function readCloudFile(path: string, env: Env = process.env): CloudFile {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CloudFile>
  if (value.bridge !== true) throw new Error(`${path}: bridge is not true`)
  if (typeof value.machine !== "string" || !MACHINE_NAME.test(value.machine) || value.machine === "me") throw new Error(`${path}: machine is not a valid name`)
  if (value.url !== undefined && typeof value.url !== "string") throw new Error(`${path}: url must be a URL`)
  const url = value.url === undefined ? activeRelay(env).url : checkRelayUrl(value.url, `url in ${path}`)
  if (value.mirror !== undefined) {
    if (!Array.isArray(value.mirror)) throw new Error(`${path}: mirror is a list of selectors`)
    const scoped = value.mirror.find((sel) => typeof sel === "string" && /^(?:group|fleet|tree|machine|org):/.test(sel))
    if (scoped) throw new Error(`${path}: mirror selectors match by handle, harness, kind and label; ${JSON.stringify(scoped)} is a scope selector`)
    parsePolicy({ rules: value.mirror.map((match) => ({ match })) })
  }
  if (value.redact !== undefined && typeof value.redact !== "boolean") throw new Error(`${path}: redact is true or false`)
  if (value.private_ok !== undefined && typeof value.private_ok !== "boolean") throw new Error(`${path}: private_ok is true or false`)
  return {
    bridge: true,
    machine: value.machine,
    url,
    ...(value.mirror ? { mirror: value.mirror } : {}),
    ...(value.redact !== undefined ? { redact: value.redact } : {}),
    ...(value.private_ok !== undefined ? { private_ok: value.private_ok } : {}),
  }
}

/** the broker's bridge from cloud.json, or undefined when there is none; a missing token keeps the bridge down with a reason */
export async function daemonBridge(env: Env = process.env, log: (line: string) => void = console.error): Promise<BridgeConfig | undefined> {
  const path = cloudFilePath(env)
  if (!path || !existsSync(path)) return undefined
  let file: CloudFile
  try {
    file = readCloudFile(path, env)
  } catch (error) {
    log(`relay broker: ${error instanceof Error ? error.message : String(error)}; running local-only`)
    return undefined
  }
  let credentials: { token: string | null; problem: string | null }
  try {
    credentials = relayCredential(env, file.url)
  } catch (error) {
    credentials = { token: null, problem: error instanceof Error ? error.message : String(error) }
  }
  if (credentials.problem) log(`relay broker: ${credentials.problem}; running local-only`)
  return {
    url: file.url,
    token: credentials.token,
    ...(credentials.problem ? { tokenError: `${credentials.problem}; running local-only` } : {}),
    credentials: async () => relayCredential(env, file.url).token,
    machine: file.machine,
    mirror: file.mirror,
    redact: file.redact,
    privateOk: file.private_ok,
  }
}

type BridgeStatus = { enabled: boolean; machine?: string; url?: string; connected?: boolean; last_error?: string | null; since?: string }

/** Enable, disable or inspect the bridge. */
export async function cloudMain(
  positionals: string[],
  values: { machine?: string; json?: boolean },
  brokerStatus: () => Promise<BridgeStatus>,
): Promise<number> {
  const [action] = positionals
  if (positionals.length !== 1) throw new CloudUsage(`${CLI_NAME} cloud takes enable [--machine NAME], disable or status`)
  const path = cloudFilePath()
  if (!path) throw new CloudUsage("neither XDG_CONFIG_HOME nor HOME is set, so there is no place for the relay's cloud.json")
  if (action === "enable") {
    const machine = machineName(values.machine)
    const { url } = activeRelay()
    const { problem } = relayCredential(process.env, url)
    const file: CloudFile = { bridge: true, machine, url }
    writePrivateJson(path, file)
    if (values.json) json({ file: path, ...file, token: problem ? "missing" : "found" })
    else {
      out(`the relay broker links to ${url} as machine ${machine} the next time it starts (${path})`)
      if (problem) note(problem)
    }
    return 0
  }
  if (values.machine !== undefined) throw new CloudUsage(`${CLI_NAME} cloud ${action ?? ""} does not take --machine`)
  if (action === "disable") {
    const had = existsSync(path)
    rmSync(path, { force: true })
    if (values.json) json({ file: path, removed: had })
    else out(had ? `removed ${path}; the running broker keeps its link until it exits` : `no ${path}; the broker is local-only`)
    return 0
  }
  if (action === "status") {
    let file: CloudFile | null = null
    let fileError: string | null = null
    if (existsSync(path)) {
      try {
        file = readCloudFile(path)
      } catch (error) {
        fileError = error instanceof Error ? error.message : String(error)
      }
    }
    const broker = await brokerStatus()
    if (values.json) {
      json({ file: path, config: file, ...(fileError ? { config_error: fileError } : {}), broker })
      return 0
    }
    out(file ? `${path}: machine ${file.machine} at ${file.url}` : fileError ? fileError : `no ${path}: the broker is local-only`)
    if (!broker.enabled) out(file ? "the running broker started before this file existed and is local-only until it restarts" : "the broker is local-only")
    else
      out(
        `broker: ${broker.connected ? "connected" : "not connected"} to ${broker.url} as ${broker.machine} since ${broker.since}${broker.last_error ? `; ${broker.last_error}` : ""}`,
      )
    return 0
  }
  throw new CloudUsage(`${CLI_NAME} cloud takes enable [--machine NAME], disable or status`)
}
