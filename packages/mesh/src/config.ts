import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { privateDir, relayDir } from "@scp-dev/broker"
import { ACCOUNT_HANDLE } from "@scp-dev/core"
import { MACHINE_NAME } from "@scp-dev/hub"
import { type KeyPair, validKeyPair } from "./keys"

/** `mesh.json`: whether the broker links to peers, as which account and machine, where it listens and whom it dials */
export interface MeshConfig {
  v: 1
  enabled: boolean
  /** the account handle, the user part of addresses on every machine of the mesh */
  account: string
  machine: string
  /** `host:port` the peer listener binds; null dials out only */
  listen: string | null
  /** `host:port` of peers to dial */
  peers: string[]
}

/** `account.key`: the account's key pair, the same file on every machine of the account */
export interface AccountKey extends KeyPair {
  v: 1
  account: string
}

export const CONFIG_FILE = "mesh.json"
export const ACCOUNT_KEY_FILE = "account.key"
export const MACHINE_KEY_FILE = "machine.key"

/** `<relay dir>/mesh` */
export function meshDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(relayDir(env), "mesh")
}

/** `host:port` with a port of 1 to 65535 (0 only when `listen` allows an ephemeral port); IPv6 hosts in brackets */
export function parseHostPort(text: string, options: { listen?: boolean } = {}): { host: string; port: number } {
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(text.trim())
  const port = match ? Number(match[2]) : Number.NaN
  if (!match || port > 65_535 || (port === 0 && !options.listen)) throw new Error(`${text} is not host:port`)
  return { host: match[1]!.replace(/^\[|\]$/g, ""), port }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"))
}

/** writes 0600 through a rename, in a 0700 directory */
function writePrivate(dir: string, name: string, value: unknown): void {
  privateDir(dir)
  const path = join(dir, name)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

export function validConfig(value: unknown): value is MeshConfig {
  const c = value as MeshConfig
  if (c?.v !== 1 || typeof c.enabled !== "boolean" || typeof c.account !== "string" || typeof c.machine !== "string") return false
  if (!ACCOUNT_HANDLE.test(c.account) || !MACHINE_NAME.test(c.machine)) return false
  if (c.listen !== null && typeof c.listen !== "string") return false
  if (!Array.isArray(c.peers) || !c.peers.every((peer) => typeof peer === "string")) return false
  try {
    if (c.listen !== null) parseHostPort(c.listen, { listen: true })
    for (const peer of c.peers) parseHostPort(peer)
  } catch {
    return false
  }
  return true
}

/** the config, or null when the mesh was never set up here; throws on a file that is not a valid config */
export function readConfig(dir: string = meshDir()): MeshConfig | null {
  const path = join(dir, CONFIG_FILE)
  if (!existsSync(path)) return null
  const value = readJson(path)
  if (!validConfig(value)) throw new Error(`${path} is not a valid mesh config`)
  return value
}

export function writeConfig(config: MeshConfig, dir: string = meshDir()): void {
  if (!validConfig(config)) throw new Error("not a valid mesh config")
  writePrivate(dir, CONFIG_FILE, config)
}

export function parseAccountKey(text: string, path: string): AccountKey {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${path} is not an account key`)
  }
  const key = value as AccountKey
  if (key?.v !== 1 || typeof key.account !== "string" || !ACCOUNT_HANDLE.test(key.account) || !validKeyPair(key))
    throw new Error(`${path} is not an account key`)
  return { v: 1, account: key.account, public: key.public, private: key.private }
}

export function readAccountKey(dir: string = meshDir()): AccountKey {
  const path = join(dir, ACCOUNT_KEY_FILE)
  return parseAccountKey(readFileSync(path, "utf8"), path)
}

export function writeAccountKey(key: AccountKey, dir: string = meshDir()): void {
  writePrivate(dir, ACCOUNT_KEY_FILE, { v: 1, account: key.account, public: key.public, private: key.private })
}

export function readMachineKey(dir: string = meshDir()): KeyPair {
  const path = join(dir, MACHINE_KEY_FILE)
  const value = readJson(path) as KeyPair & { v?: number }
  if (value?.v !== 1 || !validKeyPair(value)) throw new Error(`${path} is not a machine key`)
  return { public: value.public, private: value.private }
}

export function writeMachineKey(key: KeyPair, dir: string = meshDir()): void {
  writePrivate(dir, MACHINE_KEY_FILE, { v: 1, public: key.public, private: key.private })
}
