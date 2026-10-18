import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  activeRelay,
  checkRelayUrl,
  configDir,
  DEFAULT_RELAY,
  type Env,
  readCredentials,
  relayCredential,
  relayVerb,
  removeCredential,
  saveCredential,
} from "./relay"

const homes: string[] = []
function environment(): Env {
  const home = mkdtempSync(join(process.env.HOME!, "config-"))
  homes.push(home)
  return { HOME: home }
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe("relay configuration", () => {
  test("URL checks accept HTTPS and local HTTP and return only the origin", () => {
    for (const url of ["https://relay.example/path?q=1#part", "https://relay.example/"]) expect(checkRelayUrl(url)).toBe("https://relay.example")
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(checkRelayUrl(`http://${host}:1234/path`)).toBe(`http://${host}:1234`)
    for (const url of ["relay.example", "/relay", "http://relay.example", "ftp://localhost", "https://user:secret@relay.example"]) {
      expect(() => checkRelayUrl(url, "chosen relay")).toThrow("chosen relay must be an absolute https URL")
    }
  })

  test("config homes and relay precedence", () => {
    const env = environment()
    expect(configDir(env)).toBe(join(env.HOME!, ".config", "scp"))
    expect(configDir({ ...env, XDG_CONFIG_HOME: join(env.HOME!, "xdg") })).toBe(join(env.HOME!, "xdg", "scp"))
    expect(() => configDir({})).toThrow("neither XDG_CONFIG_HOME nor HOME")
    expect(activeRelay(env)).toEqual({ url: DEFAULT_RELAY, source: "default" })
    relayVerb(["use", "https://one.example/path"], true, env)
    expect(activeRelay(env)).toEqual({ url: "https://one.example", source: "config" })
    expect(activeRelay({ ...env, SCP_RELAY: "https://two.example/" })).toEqual({ url: "https://two.example", source: "SCP_RELAY" })
    expect(() => activeRelay({ ...env, SCP_RELAY: "bad" })).toThrow("$SCP_RELAY")
  })

  test("credentials stay per origin across switches, with an opaque env token first", () => {
    const env = environment()
    const one = "https://one.example"
    const two = "https://two.example"
    expect(relayCredential(env, one)).toEqual({ token: null, source: null, problem: `no login for ${one}: run swarm login, or set SCP_TOKEN` })
    saveCredential(env, one, { token: "first", kind: "device", org: "app", email: "ada@example.test" })
    saveCredential(env, two, { token: "second" })
    relayVerb(["use", two], true, env)
    expect(relayCredential(env, activeRelay(env).url)).toMatchObject({ token: "second", source: "credentials" })
    relayVerb(["use", one], true, env)
    expect(relayCredential(env, activeRelay(env).url)).toMatchObject({ token: "first", source: "credentials" })
    expect(relayCredential({ ...env, SCP_TOKEN: "  opaque  " }, one)).toEqual({ token: "opaque", source: "SCP_TOKEN", problem: null })
    expect(relayCredential({ ...env, SCP_TOKEN: " " }, one).token).toBe("first")
    expect(readCredentials(env)[one]!.saved_at).toMatch(/^\d{4}-/)
    expect(removeCredential(env, one)).toBe(true)
    expect(removeCredential(env, one)).toBe(false)
    expect(relayCredential(env, two).token).toBe("second")
  })

  test("atomic config and credential writes use private modes and replace permissive files", () => {
    const env = environment()
    relayVerb(["use", "https://one.example"], true, env)
    const dir = configDir(env)
    const credentials = join(dir, "credentials.json")
    writeFileSync(credentials, "{}", { mode: 0o644 })
    saveCredential(env, "https://one.example", { token: "opaque" })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    for (const file of ["credentials.json", "config.json"]) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).sort()).toEqual(["config.json", "credentials.json"])
    removeCredential(env, "https://one.example")
    expect(statSync(credentials).mode & 0o777).toBe(0o600)
  })

  test("malformed files fail without including their contents", () => {
    const env = environment()
    relayVerb(["use", "https://one.example"], true, env)
    const path = join(configDir(env), "credentials.json")
    writeFileSync(path, '{"secret-token":')
    expect(() => readCredentials(env)).toThrow(`${path} must contain a JSON object`)
    writeFileSync(path, '{"https://one.example":{"token":123}}')
    expect(() => readCredentials(env)).toThrow("contains an invalid credential")
  })
})
