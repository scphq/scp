import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { RelayClient, relayDir, shortHostname, socketPath } from "@scp-dev/broker"
import { ACCOUNT_HANDLE } from "@scp-dev/core"
import { MACHINE_NAME } from "@scp-dev/hub"
import {
  ACCOUNT_KEY_FILE,
  CONFIG_FILE,
  MACHINE_KEY_FILE,
  type AccountKey,
  type MeshConfig,
  meshDir,
  parseAccountKey,
  parseHostPort,
  readAccountKey,
  readConfig,
  readMachineKey,
  writeAccountKey,
  writeConfig,
  writeMachineKey,
} from "./config"
import { accountId, generateKeyPair } from "./keys"
import type { MeshStatus } from "./link"

export interface MeshIo {
  out(line: string): void
  err(line: string): void
}

const defaultIo: MeshIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

const HELP = `swarm mesh: experimental hubless mesh, links only this account's machines

usage:
  swarm mesh init --account <handle> [--machine <name>] [--listen <host:port>] [--account-key <file>] [--force]
  swarm mesh add-peer <host:port>
  swarm mesh rm-peer <host:port>
  swarm mesh listen <host:port|off>
  swarm mesh on
  swarm mesh off
  swarm mesh status [--json]
  swarm mesh help

Peers should be on a trusted network (for example a tailnet) since frames are not encrypted by the mesh itself.`

class UsageError extends Error {}

function parse(config: Parameters<typeof parseArgs>[0]): ReturnType<typeof parseArgs> {
  try {
    return parseArgs(config as never)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

function printHelp(io: MeshIo): number {
  for (const line of HELP.split("\n")) io.out(line)
  return 0
}

function defaultMachine(): string {
  const cleaned = shortHostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "")
  return cleaned || "machine"
}

function hostPort(text: string, options: { listen?: boolean } = {}): string {
  try {
    parseHostPort(text, options)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  return text.trim()
}

function requireConfig(dir: string): MeshConfig {
  const config = readConfig(dir)
  if (!config) throw new Error("run swarm mesh init first")
  return config
}

function noPositionals(positionals: string[], verb: string): void {
  if (positionals.length) throw new UsageError(`swarm mesh ${verb} takes no arguments`)
}

function onePositional(positionals: string[], verb: string, usage: string): string {
  if (positionals.length !== 1) throw new UsageError(`swarm mesh ${verb} takes ${usage}`)
  return positionals[0]!
}

function init(rest: string[], io: MeshIo, dir: string): number {
  const { values, positionals } = parse({
    args: rest,
    options: {
      account: { type: "string" },
      machine: { type: "string" },
      listen: { type: "string" },
      "account-key": { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  })
  if (values.help) return printHelp(io)
  noPositionals(positionals, "init")

  const accountKeyPath = values["account-key"] as string | undefined
  let imported: AccountKey | undefined
  if (accountKeyPath !== undefined) imported = parseAccountKey(readFileSync(accountKeyPath, "utf8"), accountKeyPath)

  const givenAccount = values.account as string | undefined
  if (imported && givenAccount !== undefined && givenAccount !== imported.account)
    throw new Error(`--account ${givenAccount} does not match the account key for ${imported.account}`)
  const account = imported ? imported.account : givenAccount
  if (account === undefined) throw new UsageError("swarm mesh init takes --account <handle> or --account-key <file>")
  if (!ACCOUNT_HANDLE.test(account)) throw new UsageError(`--account ${JSON.stringify(account)} is not an account handle`)
  if (imported && !ACCOUNT_HANDLE.test(imported.account)) throw new UsageError(`${accountKeyPath} is not an account key`)

  const machine = (values.machine as string | undefined) ?? defaultMachine()
  if (!MACHINE_NAME.test(machine)) throw new UsageError(`--machine ${JSON.stringify(machine)} is not a machine name`)

  const listenValue = values.listen as string | undefined
  const listen = listenValue === undefined ? null : hostPort(listenValue, { listen: true })

  const configPath = join(dir, CONFIG_FILE)
  const force = values.force === true
  let peers: string[] = []
  if (existsSync(configPath)) {
    if (!force) throw new Error(`${configPath} already exists: use --force to re-init`)
    peers = readConfig(dir)?.peers ?? []
  }

  let accountKey: AccountKey
  let writeAccount = true
  if (imported) {
    accountKey = imported
  } else if (existsSync(join(dir, ACCOUNT_KEY_FILE))) {
    const existing = readAccountKey(dir)
    if (existing.account === account) {
      accountKey = existing
      writeAccount = false
    } else if (!force) {
      throw new Error(`${join(dir, ACCOUNT_KEY_FILE)} is for account ${existing.account}: use --force to replace it with a new key`)
    } else {
      accountKey = { v: 1, account, ...generateKeyPair() }
    }
  } else {
    accountKey = { v: 1, account, ...generateKeyPair() }
  }

  const machineKeyExists = existsSync(join(dir, MACHINE_KEY_FILE))
  if (machineKeyExists) readMachineKey(dir)

  if (writeAccount) writeAccountKey(accountKey, dir)
  if (!machineKeyExists) writeMachineKey(generateKeyPair(), dir)
  const config: MeshConfig = { v: 1, enabled: true, account, machine, listen, peers }
  writeConfig(config, dir)

  io.out(`account: ${account}`)
  io.out(`account id: ${accountId(accountKey.public)}`)
  io.out(`machine: ${machine}`)
  io.out(`listen: ${listen ?? "dials out only"}`)
  io.out(`copy ${join(dir, ACCOUNT_KEY_FILE)} to the other machines and run swarm mesh init --account-key <file> there`)
  io.out("restart the broker (swarm daemon) for it to take effect")
  return 0
}

function addPeer(rest: string[], io: MeshIo, dir: string): number {
  const { values, positionals } = parse({ args: rest, options: { help: { type: "boolean" } }, allowPositionals: true, strict: true })
  if (values.help) return printHelp(io)
  const arg = onePositional(positionals, "add-peer", "<host:port>")
  const config = requireConfig(dir)
  const peer = hostPort(arg)
  if (config.peers.includes(peer)) {
    io.out(`peer ${peer} already present`)
    return 0
  }
  writeConfig({ ...config, peers: [...config.peers, peer] }, dir)
  io.out(`added peer ${peer}`)
  return 0
}

function rmPeer(rest: string[], io: MeshIo, dir: string): number {
  const { values, positionals } = parse({ args: rest, options: { help: { type: "boolean" } }, allowPositionals: true, strict: true })
  if (values.help) return printHelp(io)
  const arg = onePositional(positionals, "rm-peer", "<host:port>")
  const config = requireConfig(dir)
  const peer = hostPort(arg)
  if (!config.peers.includes(peer)) {
    io.out(`peer ${peer} not present`)
    return 0
  }
  writeConfig({ ...config, peers: config.peers.filter((item) => item !== peer) }, dir)
  io.out(`removed peer ${peer}`)
  return 0
}

function listenCommand(rest: string[], io: MeshIo, dir: string): number {
  const { values, positionals } = parse({ args: rest, options: { help: { type: "boolean" } }, allowPositionals: true, strict: true })
  if (values.help) return printHelp(io)
  const arg = onePositional(positionals, "listen", "<host:port|off>")
  const config = requireConfig(dir)
  if (arg === "off") {
    writeConfig({ ...config, listen: null }, dir)
    io.out("listen: off")
    return 0
  }
  const listen = hostPort(arg, { listen: true })
  writeConfig({ ...config, listen }, dir)
  io.out(`listen: ${listen}`)
  return 0
}

function setEnabled(rest: string[], io: MeshIo, dir: string, verb: "on" | "off"): number {
  const { values, positionals } = parse({ args: rest, options: { help: { type: "boolean" } }, allowPositionals: true, strict: true })
  if (values.help) return printHelp(io)
  noPositionals(positionals, verb)
  const config = requireConfig(dir)
  const enabled = verb === "on"
  writeConfig({ ...config, enabled }, dir)
  io.out(enabled ? "mesh enabled" : "mesh disabled")
  return 0
}

type LiveStatus = { mesh?: MeshStatus["mesh"] } & Record<string, unknown>

async function status(rest: string[], io: MeshIo, dir: string, socket: string | undefined): Promise<number> {
  const { values, positionals } = parse({
    args: rest,
    options: { json: { type: "boolean" }, help: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  })
  if (values.help) return printHelp(io)
  noPositionals(positionals, "status")
  const config = readConfig(dir)

  let live: unknown = null
  try {
    const client = await RelayClient.connect(socket ?? socketPath(relayDir()))
    try {
      await client.hello({ observe: true })
      live = await client.request("cloud_status")
    } finally {
      client.close()
    }
  } catch {
    live = null
  }

  if (values.json) {
    io.out(JSON.stringify({ config, live }))
    return 0
  }

  if (!config) {
    io.out("mesh: not set up, run swarm mesh init first")
  } else {
    let acct = "unknown"
    try {
      acct = accountId(readAccountKey(dir).public)
    } catch {
      acct = "unknown"
    }
    io.out(`account: ${config.account}`)
    io.out(`account id: ${acct}`)
    io.out(`machine: ${config.machine}`)
    io.out(`enabled: ${config.enabled}`)
    io.out(`listen: ${config.listen ?? "dials out only"}`)
    io.out(`peers: ${config.peers.length ? config.peers.join(", ") : "none"}`)
  }

  if (live === null) {
    io.out("the broker is not running")
    return 0
  }
  const mesh = (live as LiveStatus).mesh
  if (!mesh) {
    io.out("mesh: not active in the broker")
    return 0
  }
  io.out(`mesh listen: ${mesh.listen ?? "dials out only"}`)
  for (const peer of mesh.peers) io.out(`peer ${peer.addr}: ${peer.connected ? "connected" : (peer.last_error ?? "not connected")}`)
  for (const link of mesh.links) io.out(`link ${link.machine}: ${link.inbound ? "inbound" : "outbound"} since ${link.since}`)
  for (const item of mesh.machines) io.out(`machine ${item.machine}: epoch ${item.epoch}, seq ${item.seq}, endpoints ${item.endpoints}, linked ${item.linked}`)
  return 0
}

async function run(argv: string[], io: MeshIo, dir: string, socket: string | undefined): Promise<number> {
  const [verb, ...rest] = argv
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") return printHelp(io)
  switch (verb) {
    case "init":
      return init(rest, io, dir)
    case "add-peer":
      return addPeer(rest, io, dir)
    case "rm-peer":
      return rmPeer(rest, io, dir)
    case "listen":
      return listenCommand(rest, io, dir)
    case "on":
      return setEnabled(rest, io, dir, "on")
    case "off":
      return setEnabled(rest, io, dir, "off")
    case "status":
      return status(rest, io, dir, socket)
    default:
      throw new UsageError(`unknown command ${JSON.stringify(verb)}`)
  }
}

export async function meshCommand(argv: string[], options?: { io?: MeshIo; dir?: string; socket?: string }): Promise<number> {
  const io = options?.io ?? defaultIo
  const dir = options?.dir ?? meshDir()
  try {
    return await run(argv, io, dir, options?.socket)
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return error instanceof UsageError ? 2 : 1
  }
}
