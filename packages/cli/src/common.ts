import { spawn } from "node:child_process"
import { closeSync, openSync, statSync, truncateSync } from "node:fs"
import { join } from "node:path"
import { CLI_NAME, type EndpointView, type ScopePreset } from "@scp-dev/core"
import { type BrokerInfo, type HelloResult, connectBroker, privateDir, type RelayClient, relayDir } from "@scp-dev/broker"
import {
  codexShell,
  detectHarness,
  harnessAt,
  inferring,
  harnessLineage,
  hiddenHarness,
  labelsFor,
  lineage,
  type PsCommTable,
  readPsTable,
  readShimBinding,
  sessionKey,
} from "./identity"
import { membership } from "./session"
import { parseSeconds, SELF } from "./term"
import type { RelayTransport } from "./remote"

export class RelayUsage extends Error {}

export const OPTIONS = {
  cloud: { type: "boolean" },
  machine: { type: "string" },
  token: { type: "string" },
  label: { type: "string" },
  "no-browser": { type: "boolean" },
  json: { type: "boolean" },
  channels: { type: "boolean" },
  write: { type: "boolean" },
  print: { type: "boolean" },
  "block-stop-on-unread": { type: "boolean" },
  "push-wait": { type: "string" },
  all: { type: "boolean" },
  as: { type: "string" },
  harness: { type: "string" },
  wait: { type: "string" },
  ack: { type: "boolean" },
  keep: { type: "boolean" },
  "reply-to": { type: "string" },
  "require-reply": { type: "boolean" },
  thread: { type: "string" },
  private: { type: "boolean" },
  attach: { type: "string", multiple: true },
  tool: { type: "string" },
  summary: { type: "string" },
  since: { type: "string" },
  limit: { type: "string" },
  idle: { type: "string" },
  policy: { type: "string" },
  human: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  scope: { type: "string" },
  tree: { type: "boolean" },
  roots: { type: "boolean" },
  contacts: { type: "boolean" },
  activity: { type: "boolean" },
  in: { type: "string" },
  out: { type: "string" },
  allow: { type: "string", multiple: true },
  rules: { type: "string" },
  group: { type: "string" },
  under: { type: "string" },
  ttl: { type: "string" },
  labels: { type: "string" },
  "handback-bytes": { type: "string" },
  "no-push": { type: "boolean" },
  bg: { type: "boolean" },
  fg: { type: "boolean" },
  name: { type: "string" },
  title: { type: "string" },
  judge: { type: "boolean" },
  redacted: { type: "boolean" },
  reason: { type: "string" },
  turns: { type: "string" },
  full: { type: "boolean" },
  who: { type: "boolean" },
  peek: { type: "string" },
  endpoint: { type: "string" },
  live: { type: "boolean" },
  parent: { type: "string" },
} as const

export type Option = keyof typeof OPTIONS
export type Values = Partial<Record<Option, string | boolean | string[]>>
export const SPAWN_OPTIONS: Option[] = [
  "as",
  "harness",
  "human",
  "name",
  "title",
  "scope",
  "rules",
  "in",
  "out",
  "allow",
  "group",
  "under",
  "ttl",
  "labels",
  "peek",
  "handback-bytes",
  "no-push",
  "bg",
  "fg",
]

export const OBSERVE = new Set([
  "list",
  "status",
  "watch",
  "log",
  "policy",
  "machines",
  "rules",
  "group",
  "admin",
  "spawn-env",
  "spawn",
  "why",
  "peek",
  "set-peek",
])
export const CLOUD_OBSERVE = new Set(["list", "status", "watch", "log", "machines"])
export const GRANT_TOKEN = /^krt_[0-9a-f]{64}$/

const DAEMON_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SCP_IDLE",
  "HOME",
  "XDG_CONFIG_HOME",
  "SCP_TOKEN",
  "SCP_RELAY",
  "SCP_MACHINE",
]
const LOG_MAX_BYTES = 1024 * 1024

/** the broker for `dir`, detached, with a fixed environment and its stderr in broker.log */
export function startDaemon(dir: string): void {
  privateDir(dir)
  const logFile = join(dir, "broker.log")
  if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > LOG_MAX_BYTES) truncateSync(logFile, 0)
  const log = openSync(logFile, "a", 0o600)
  try {
    const env: Record<string, string> = { SCP_DIR: dir }
    for (const key of DAEMON_ENV) if (process.env[key] !== undefined) env[key] = process.env[key]!
    const child = spawn(SELF[0]!, [...SELF.slice(1), "daemon"], {
      detached: true,
      stdio: ["ignore", log, log],
      env,
      cwd: dir,
    })
    child.unref()
  } finally {
    closeSync(log)
  }
}

export type Identity = {
  as?: string | undefined
  harness?: string | undefined
  human?: boolean | undefined
  cloud?: boolean | undefined
  machine?: string | undefined
}

type Streams = Record<"stdin" | "stdout" | "stderr", { isTTY?: boolean }>

/** a terminal is attached when stdin is one, or, while the body does not come from stdin, when stdout or stderr is */
export function terminalAttached(streams: Streams, bodyFromStdin: boolean): boolean {
  if (streams.stdin.isTTY === true) return true
  return !bodyFromStdin && (streams.stdout.isTTY === true || streams.stderr.isTTY === true)
}

/** how a command came to act as an endpoint: `--as` (or $SCP_NAME), the lineage of this shell's harness process, or the human inbox */
export type Bound = "as" | "lineage" | "human"

export type Opened = {
  client: RelayTransport
  me: EndpointView | null
  broker: BrokerInfo | null
  where: string
  bound: Bound | null
  harnessPid?: number | undefined
}

/** an --as handle: a local handle, with a leading `me/` dropped */
export function localHandle(raw: string): string {
  const handle = raw.startsWith("me/") ? raw.slice(3) : raw
  if (!handle) throw new RelayUsage("--as me/ names your own human inbox: use --human")
  if (handle.includes("/")) throw new RelayUsage(`--as names a local handle, not ${JSON.stringify(raw)}`)
  return handle
}

/** this shell's process walk: the lineage keys, the harness walk it claims with and the harness its nearest harness process runs */
export type Walk = { keys: string[]; self: string[]; harness?: string | undefined }

export function walkNow(env = process.env, pid = process.ppid, table: PsCommTable | undefined = readPsTable()): Walk {
  const keys = lineage(pid, table)
  const self = harnessLineage(pid, table)
  if (!self.length && codexShell(env)) {
    const binding = readShimBinding(env, pid, table)
    if (binding) {
      const bound = [...keys, binding.process]
      return { keys: bound, self: bound, harness: "codex" }
    }
  }
  const harness = self.length ? harnessAt(Number(/^pid:(\d+)/.exec(self.at(-1)!)?.[1]), table) : undefined
  return { keys, self, ...(harness ? { harness } : {}) }
}

/** an `--as` claim's harness: --harness or $SCP_HARNESS, else the harness this shell's walk or environment shows, else cli */
export function claimHarness(values: Identity, env: Record<string, string | undefined>, walk: Walk | undefined): string {
  return values.harness ?? env.SCP_HARNESS ?? (inferring(env) ? (walk?.harness ?? detectHarness(env)) : undefined) ?? "cli"
}

export async function open(verb: string, values: Identity, cwd: string, bodyFromStdin: boolean, walk?: Walk): Promise<Opened> {
  const named = values.as ?? process.env.SCP_NAME
  const tty = terminalAttached(process, bodyFromStdin)
  if (named && values.human) throw new RelayUsage("--human and --as (or $SCP_NAME) name two identities; pick one")
  const grant = process.env.SCP_GRANT || undefined
  const cloud = values.cloud || process.env.SCP_TRANSPORT === "cloud" || verb === "machines"
  if (grant !== undefined) {
    if (!GRANT_TOKEN.test(grant)) {
      throw new RelayUsage(
        `$SCP_GRANT is not one spawn-env grant: pass spawn-env's lines as separate words: env $(${CLI_NAME} spawn-env ...) cmd; in zsh env \${=G} cmd`,
      )
    }
    if (values.human) throw new RelayUsage("--human and $SCP_GRANT name two identities: unset the grant to act as me/")
    if (cloud) throw new RelayUsage("a spawn-env grant is for this machine's relay broker, not the cloud transport")
  }
  if (cloud) {
    if (!named && !values.human && !tty && !OBSERVE.has(verb)) {
      throw new RelayUsage(
        `${CLI_NAME} ${verb} needs an identity: --as HANDLE (or $SCP_NAME) for an agent, or --human for your own inbox me/ (no terminal is attached, so me/ is not assumed)`,
      )
    }
    const { machineName, openCloud } = await import("./remote")
    const handle = named ? localHandle(named) : undefined
    const claim = handle
      ? {
          handle,
          harness: claimHarness(values, process.env, walk ?? walkNow()),
          cwd,
          ...(process.env.SCP_PARENT ? { parent: process.env.SCP_PARENT } : {}),
          labels: labelsFor(process.env, machineName(values.machine)),
        }
      : undefined
    const observe = !handle && !values.human && CLOUD_OBSERVE.has(verb)
    return {
      ...(await openCloud({
        ...(values.machine !== undefined ? { machine: values.machine } : {}),
        ...(handle ? { handle } : {}),
        ...(claim ? { claim } : {}),
        tty,
        observe,
      })),
      broker: null,
      bound: handle ? "as" : observe ? null : "human",
    }
  }
  if (values.machine !== undefined) throw new RelayUsage("--machine names the machine of the cloud transport: add --cloud")
  const here = walk ?? walkNow()
  const { keys, self } = here
  const joined = !values.as && named && self.length ? membership(process.env, sessionKey(process.env, self.at(-1)!)) : {}
  const handle = "handle" in joined && joined.handle ? joined.handle : named ? localHandle(named) : undefined
  const harnessPid = self.length ? Number(/^pid:(\d+)/.exec(self.at(-1)!)?.[1]) : undefined
  const lineageClaim = keys.length ? { lineage: keys } : {}
  const dir = relayDir()
  const client = await connectBroker(dir, () => startDaemon(dir))
  try {
    let bound: Bound | null
    let hello: HelloResult
    if (handle) {
      bound = "as"
      hello = await client.hello({
        claim: {
          handle,
          exact: true,
          harness: claimHarness(values, process.env, here),
          cwd,
          ...(process.env.SCP_PARENT ? { parent: process.env.SCP_PARENT } : {}),
          labels: labelsFor(process.env),
          ...lineageClaim,
          ...(grant ? { grant } : {}),
        },
        ...(self.length ? { self } : {}),
        brief: true,
      })
    } else if (grant) {
      hello = await client.hello({ observe: true, ...lineageClaim, ...(self.length ? { self } : {}), grant, cwd, brief: true })
      if (!hello.grant_bound) throw new RelayUsage(`the running ${CLI_NAME} broker does not check spawn-env grants: let it exit (it stops when idle) and retry`)
      bound = "lineage"
    } else if (values.human || tty) {
      hello = await client.hello({ human: true, tty, cwd, brief: true, ...lineageClaim })
      bound = hello.endpoint?.kind === "human" ? "human" : "lineage"
    } else {
      hello = await client.hello({ observe: true, ...lineageClaim, ...(self.length ? { self } : {}), cwd, brief: true })
      bound = hello.endpoint ? "lineage" : null
      if (!hello.endpoint && !OBSERVE.has(verb)) {
        if (hiddenHarness(process.ppid, readPsTable()))
          throw new RelayUsage(`${CLI_NAME} ${verb}: sandbox pid namespace: this shell cannot see its harness; use the scp MCP tools`)
        throw new RelayUsage(
          `${CLI_NAME} ${verb}: no relay agent runs this shell's harness process (${harnessPid ? `pid ${harnessPid}` : "none found"}); ${CLI_NAME} join <name> puts this session on the relay, or pass --as HANDLE or --human (no terminal is attached, so me/ is not assumed)`,
        )
      }
    }
    return { client, me: hello.endpoint, broker: hello.broker, where: brokerLine(hello.broker), bound, harnessPid }
  } catch (error) {
    client.close()
    throw error
  }
}

export function localClient(client: RelayTransport, broker: BrokerInfo | null, verb: string): RelayClient {
  if (!broker) throw new RelayUsage(`${CLI_NAME} ${verb} is the local broker's; it has no --cloud form`)
  return client as RelayClient
}

export function brokerLine(broker: BrokerInfo): string {
  const policy =
    broker.policy.state === "open"
      ? `no policy at ${broker.policy.file}, open`
      : broker.policy.state === "loaded"
        ? `policy ${broker.policy.file}`
        : `policy ${broker.policy.file} unusable, sends refused`
  return `broker ${broker.socket} (pid ${broker.pid}); ${policy}`
}

/** `a,b, c` as a selector list; repeated flags add up */
export function selectorList(value: string | string[] | boolean | undefined): string[] | undefined {
  if (value === undefined || typeof value === "boolean") return undefined
  return (Array.isArray(value) ? value : [value])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean)
}

const PRESETS = new Set(["open", "tree", "parent", "none"])

export function preset(value: string | string[] | boolean | undefined): ScopePreset | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !PRESETS.has(value)) throw new RelayUsage("--scope takes open, tree, parent or none")
  return value as ScopePreset
}

export function peekGrant(value: Values["peek"]): { peek?: "local" } {
  if (value === undefined) return {}
  if (value !== "local") throw new RelayUsage(`--peek takes local (peekable on this machine from its start), not ${JSON.stringify(value)}`)
  return { peek: "local" }
}

export function grantParams(values: Values): Parameters<RelayClient["grant"]>[0] & { peek?: "local" } {
  const rules = selectorList(values.rules)
  if (rules && values.scope !== undefined) throw new RelayUsage("--rules and --scope both set a preset; pick one")
  const allow = [...(rules ?? []), ...(selectorList(values.allow) ?? [])]
  const scope = rules ? "none" : preset(values.scope)
  const groups = selectorList(values.group)
  const incoming = selectorList(values.in)
  const outgoing = selectorList(values.out)
  return {
    ...(values.name ? { name: values.name as string } : {}),
    ...(values.title !== undefined ? { title: values.title as string } : {}),
    ...(values.under ? { under: values.under as string } : {}),
    ...(scope ? { scope } : {}),
    ...(incoming ? { in: incoming } : {}),
    ...(outgoing ? { out: outgoing } : {}),
    ...(allow.length ? { allow } : {}),
    ...(groups?.length ? { groups } : {}),
    ...(values.ttl !== undefined ? { ttl_s: ttlSeconds(values.ttl as string) } : {}),
    ...(values["no-push"] === true ? { no_push: true } : {}),
    ...peekGrant(values.peek),
  }
}

export function ttlSeconds(text: string): number {
  try {
    return parseSeconds(text, "--ttl")
  } catch (error) {
    throw new RelayUsage(error instanceof Error ? error.message : String(error))
  }
}

const pad = (n: number) => String(n).padStart(2, "0")

/** `HH:MM:SS` in local time */
export function time(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

/** `YYYY-MM-DD HH:MM:SS` in local time */
export function stamp(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time(iso)}`
}

/** names the `swarm claude` launcher's pid, so only the Claude Code it started (not a nested or spawned one) takes channel pushes */
export const CHANNELS_ENV = "SCP_CHANNELS"
