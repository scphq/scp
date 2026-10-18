import { spawn } from "node:child_process"
import { setTimeout } from "node:timers/promises"
import { CLI_NAME } from "@scp-dev/core"
import { RelayUsage } from "./common"
import { machineName } from "./remote"
import { activeRelay, type Env, saveCredential } from "./relay"
import { note } from "./term"

export function openBrowser(url: string, env: Env = process.env): boolean {
  if (!/^https?:\/\//.test(url) || env.SSH_CONNECTION || env.SSH_TTY || (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY)) return false
  const command =
    env.BROWSER !== undefined
      ? env.BROWSER && env.BROWSER !== "none"
        ? env.BROWSER
        : undefined
      : process.platform === "darwin"
        ? "open"
        : process.platform === "linux"
          ? "xdg-open"
          : undefined
  if (!command) return false
  try {
    const child = spawn(command, [url], { detached: true, stdio: "ignore", env })
    child.on("error", () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

type Fields = Record<string, unknown>
const WHOAMI_FIELDS = ["kind", "org", "email", "role", "label", "ambient", "endpoint_labels", "expires_at"]
const publicWhoami = (value: Fields): Fields => Object.fromEntries(WHOAMI_FIELDS.filter((key) => key in value).map((key) => [key, value[key]]))

async function responseBody(response: Response): Promise<Fields> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Fields
  } catch {}
  throw new Error("the relay returned an invalid login response")
}

export async function login(values: { token?: string; label?: string; "no-browser"?: boolean; json?: boolean }, env: Env = process.env): Promise<number> {
  const { url } = activeRelay(env)
  const token = values.token !== undefined ? values.token.trim() : env.SCP_TOKEN?.trim()
  const done = (who: Fields) => {
    if (values.json) console.log(JSON.stringify(publicWhoami(who)))
    else console.log(`logged in to ${url} as ${who.email ?? "?"} in ${who.org ?? "?"}`)
    return 0
  }
  if (values.token !== undefined && !token) throw new RelayUsage("--token needs a nonempty token")
  if (token) {
    let response: Response
    try {
      response = await fetch(`${url}/v1/whoami`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: "error" })
    } catch {
      throw new Error(`could not check the token at ${url}`)
    }
    if (response.status === 401) throw new Error(`that token is not valid for ${url}`)
    if (response.status !== 200) throw new Error(`could not check the token at ${url} (HTTP ${response.status})`)
    const who = await responseBody(response)
    saveCredential(env, url, { token, ...metadata(who) })
    return done(who)
  }
  const label = machineName(values.label, env)
  let startResponse: Response
  try {
    startResponse = await fetch(`${url}/v1/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    })
  } catch {
    throw new Error(`could not start login at ${url}`)
  }
  const start = await responseBody(startResponse)
  if (!startResponse.ok)
    throw new Error(typeof start.error_description === "string" ? start.error_description : `could not start login at ${url} (HTTP ${startResponse.status})`)
  if (
    typeof start.device_code !== "string" ||
    typeof start.user_code !== "string" ||
    typeof start.verification_uri !== "string" ||
    typeof start.verification_uri_complete !== "string" ||
    typeof start.expires_in !== "number" ||
    !Number.isFinite(start.expires_in) ||
    start.expires_in <= 0 ||
    typeof start.interval !== "number" ||
    !Number.isFinite(start.interval) ||
    start.interval < 0
  ) {
    throw new Error("the relay returned an invalid device code")
  }
  const expires = Date.now() + start.expires_in * 1000
  let interval = start.interval * 1000
  note(`to sign in, open ${start.verification_uri_complete}`)
  note(`and check that it shows the code ${start.user_code}`)
  const opened = !values["no-browser"] && openBrowser(start.verification_uri_complete, env)
  note(opened ? "opened it in your browser; waiting for approval" : "waiting for approval")
  while (Date.now() < expires) {
    await setTimeout(Math.min(interval, Math.max(0, expires - Date.now())))
    if (Date.now() >= expires) break
    let response: Response
    let body: Fields
    try {
      response = await fetch(`${url}/v1/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: start.device_code }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, expires - Date.now()))),
        redirect: "error",
      })
      if (response.status >= 500) continue
      body = await responseBody(response)
    } catch {
      continue
    }
    if (response.ok && typeof body.access_token === "string" && body.access_token) {
      saveCredential(env, url, { token: body.access_token, ...metadata(body), kind: "device", label: typeof body.label === "string" ? body.label : label })
      return done({ ...body, kind: "device" })
    }
    if (body.error === "authorization_pending") continue
    if (body.error === "slow_down") {
      interval += 5000
      continue
    }
    throw new Error(
      typeof body.error_description === "string"
        ? body.error_description
        : `login failed: ${typeof body.error === "string" ? body.error : `HTTP ${response.status}`}`,
    )
  }
  throw new Error(`the device code expired: run ${CLI_NAME} login again`)
}

function metadata(who: Fields): { kind?: string; org?: string; email?: string; label?: string } {
  return Object.fromEntries(["kind", "org", "email", "label"].filter((key) => typeof who[key] === "string").map((key) => [key, who[key]]))
}
