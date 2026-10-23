import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { readOwnedFile } from "@scp-dev/broker"
import { CLI_NAME } from "@scp-dev/core"
import { RelayUsage } from "./common"
import { note } from "./term"

export type Env = Record<string, string | undefined>
export const DEFAULT_RELAY = "https://app.scp.dev"

export function configDir(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : undefined)
  if (!base) throw new RelayUsage("neither XDG_CONFIG_HOME nor HOME is set, so there is no place for the relay configuration")
  return join(base, "scp")
}

export function checkRelayUrl(text: string, what = "relay URL"): string {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new RelayUsage(`${what} must be an absolute https URL (http is allowed only for localhost)`)
  }
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password
  ) {
    throw new RelayUsage(`${what} must be an absolute https URL without credentials (http is allowed only for localhost)`)
  }
  return url.origin
}

function readObject<T>(path: string): T | undefined {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new RelayUsage(`could not read ${path}`)
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    return value as T
  } catch {
    throw new RelayUsage(`${path} must contain a JSON object`)
  }
}

export function writePrivateJson(path: string, value: unknown): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const temp = join(dir, `.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    chmodSync(temp, 0o600)
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

export function activeRelay(env: Env = process.env): { url: string; source: "SCP_RELAY" | "config" | "default" } {
  if (env.SCP_RELAY !== undefined) return { url: checkRelayUrl(env.SCP_RELAY, "$SCP_RELAY"), source: "SCP_RELAY" }
  const path = join(configDir(env), "config.json")
  const config = readObject<{ relay?: unknown }>(path)
  if (config?.relay !== undefined) {
    if (typeof config.relay !== "string") throw new RelayUsage(`relay in ${path} must be a URL`)
    return { url: checkRelayUrl(config.relay, `relay in ${path}`), source: "config" }
  }
  return { url: DEFAULT_RELAY, source: "default" }
}

export type JoinMode = "auto" | "manual"

/** how hooked sessions join: `auto` at session start, `manual` only once they run `swarm join`; auto when unset or unreadable */
export function joinMode(env: Env = process.env): JoinMode {
  try {
    return (JSON.parse(readOwnedFile(join(configDir(env), "config.json"))) as { join?: unknown })?.join === "manual" ? "manual" : "auto"
  } catch {
    return "auto"
  }
}

export function setJoinMode(env: Env, mode: JoinMode): void {
  const path = join(configDir(env), "config.json")
  writePrivateJson(path, { ...readObject<Record<string, unknown>>(path), join: mode })
}

export interface Credential {
  token: string
  kind?: string
  org?: string
  email?: string
  label?: string
  saved_at: string
}

export function readCredentials(env: Env = process.env): Record<string, Credential> {
  const path = join(configDir(env), "credentials.json")
  const entries = readObject<Record<string, Credential>>(path) ?? {}
  for (const entry of Object.values(entries)) {
    if (!entry || typeof entry !== "object" || typeof entry.token !== "string" || !entry.token.trim() || typeof entry.saved_at !== "string") {
      throw new RelayUsage(`${path} contains an invalid credential`)
    }
  }
  return entries
}

export function saveCredential(env: Env, origin: string, credential: Omit<Credential, "saved_at">): void {
  const url = checkRelayUrl(origin)
  writePrivateJson(join(configDir(env), "credentials.json"), { ...readCredentials(env), [url]: { ...credential, saved_at: new Date().toISOString() } })
}

export function removeCredential(env: Env, origin: string): boolean {
  const entries = readCredentials(env)
  const url = checkRelayUrl(origin)
  if (!Object.hasOwn(entries, url)) return false
  delete entries[url]
  writePrivateJson(join(configDir(env), "credentials.json"), entries)
  return true
}

export function relayCredential(env: Env, origin: string): { token: string | null; source: "SCP_TOKEN" | "credentials" | null; problem: string | null } {
  const token = env.SCP_TOKEN?.trim()
  if (token) return { token, source: "SCP_TOKEN", problem: null }
  const stored = readCredentials(env)[checkRelayUrl(origin)]
  if (stored) return { token: stored.token, source: "credentials", problem: null }
  return { token: null, source: null, problem: `no login for ${origin}: run ${CLI_NAME} login, or set SCP_TOKEN` }
}

export function relayVerb(positionals: string[], asJson: boolean, env: Env = process.env): number {
  const [action, text] = positionals
  if (action === "use" && text !== undefined && positionals.length === 2) {
    const url = checkRelayUrl(text)
    writePrivateJson(join(configDir(env), "config.json"), { ...readObject<Record<string, unknown>>(join(configDir(env), "config.json")), relay: url })
    if (asJson) console.log(JSON.stringify({ url }))
    else console.log(`saved relay ${url}`)
    if (env.SCP_RELAY !== undefined) note("$SCP_RELAY still selects the active relay")
    return 0
  }
  if (action === "show" && positionals.length === 1) {
    const relay = activeRelay(env)
    const credential = relayCredential(env, relay.url)
    const result = { ...relay, credential: credential.token ? "found" : "missing", credential_source: credential.source }
    if (asJson) console.log(JSON.stringify(result))
    else console.log(`${relay.url} (${relay.source}); credential ${result.credential}${credential.source ? ` (${credential.source})` : ""}`)
    return 0
  }
  throw new RelayUsage(`${CLI_NAME} relay takes use <url> or show`)
}

export async function loginMain(positionals: string[], values: { token?: string; label?: string; "no-browser"?: boolean; json?: boolean }): Promise<number> {
  if (positionals.length) throw new RelayUsage(`${CLI_NAME} login takes only flags`)
  return (await import("./login")).login(values)
}

export function logoutMain(positionals: string[], asJson: boolean, env: Env = process.env): number {
  if (positionals.length) throw new RelayUsage(`${CLI_NAME} logout takes no arguments`)
  const { url } = activeRelay(env)
  const removed = removeCredential(env, url)
  if (asJson) console.log(JSON.stringify({ url, removed, env_token: !!env.SCP_TOKEN?.trim() }))
  else console.log(removed ? `logged out of ${url}` : `no stored login for ${url}`)
  if (env.SCP_TOKEN?.trim()) note("$SCP_TOKEN still applies")
  return 0
}
