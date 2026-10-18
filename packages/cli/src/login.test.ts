import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { hostMachine } from "./remote"
import { configDir, readCredentials, saveCredential } from "./relay"
import { waitFor } from "./testing/fixtures"

const TOKEN = "scp_d_test-device-secret"
const API_TOKEN = "scp_t_test-api-secret"
const who = { kind: "token", email: "ada@example.test", org: "app", role: "member", label: "runner", ambient: {}, endpoint_labels: {}, expires_at: null }
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture(options: { polls?: string[]; interval?: number; expires?: number; whoStatus?: number; hang?: boolean; disconnect?: boolean } = {}) {
  const home = mkdtempSync(join(process.env.HOME!, "login-"))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  let calls = 0
  let label: unknown
  const times: number[] = []
  const authorizations: (string | null)[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/whoami") {
        authorizations.push(request.headers.get("authorization"))
        return Response.json(options.whoStatus === 401 ? { error: "unauthorized" } : { ...who, token: API_TOKEN }, { status: options.whoStatus ?? 200 })
      }
      if (url.pathname === "/v1/device/code") {
        expect(request.method).toBe("POST")
        label = ((await request.json()) as { label: string }).label
        return Response.json({
          device_code: "private-device-code",
          user_code: "BCDF-GHJK",
          verification_uri: `${url.origin}/device`,
          verification_uri_complete: `${url.origin}/device?code=BCDF-GHJK`,
          interval: options.interval ?? 0,
          expires_in: options.expires ?? 30,
        })
      }
      if (url.pathname === "/v1/device/token") {
        expect(await request.json()).toEqual({ device_code: "private-device-code" })
        times.push(Date.now())
        const error = options.polls?.[calls] ?? (options.polls ? "approved" : calls < 2 ? "authorization_pending" : "approved")
        calls++
        if (options.hang) {
          await Bun.sleep(1500)
          return Response.json({ error: "authorization_pending" })
        }
        if (options.disconnect && calls === 1) {
          return Response.redirect("http://127.0.0.1:1/unavailable", 307)
        }
        if (error === "server_error") return new Response("temporarily unavailable", { status: 503 })
        if (error !== "approved") return Response.json({ error, error_description: `server says ${error}` }, { status: 400 })
        return Response.json({ access_token: TOKEN, email: who.email, org: who.org, label })
      }
      return new Response("not found", { status: 404 })
    },
  })
  cleanups.push(() => server.stop(true))
  const url = `http://127.0.0.1:${server.port}`
  const browserFile = join(home, "browser-url")
  const browser = join(home, "browser")
  writeFileSync(browser, '#!/bin/sh\nprintf "%s" "$1" > "$BROWSER_OUTPUT"\n')
  chmodSync(browser, 0o700)
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    SCP_RELAY: url,
    SCP_TOKEN: "",
    SCP_NAME: "",
    SCP_GRANT: "",
    SCP_TRANSPORT: "",
    SCP_MACHINE: "",
    SSH_CONNECTION: "",
    SSH_TTY: "",
    DISPLAY: ":test",
    BROWSER: browser,
    BROWSER_OUTPUT: browserFile,
  }
  delete (env as Record<string, string | undefined>).SCP_MACHINE
  async function run(args: string[], extra: Record<string, string> = {}) {
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "cli.ts"), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...env, ...extra },
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stdout + stderr).not.toContain(TOKEN)
    expect(stdout + stderr).not.toContain(API_TOKEN)
    expect(stdout + stderr).not.toContain("private-device-code")
    return { stdout, stderr, code }
  }
  return { home, env, url, run, browserFile, authorizations, times, label: () => label, calls: () => calls }
}

describe("swarm login", () => {
  test("device approval after two pending polls opens the complete URL and stores the credential per origin", async () => {
    const f = fixture()
    const result = await f.run(["login", "--label", "workstation"])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`logged in to ${f.url} as ${who.email} in ${who.org}\n`)
    expect(result.stderr).toContain(`${f.url}/device`)
    expect(result.stderr).toContain("BCDF-GHJK")
    await waitFor(() => existsSync(f.browserFile))
    expect(readFileSync(f.browserFile, "utf8")).toBe(`${f.url}/device?code=BCDF-GHJK`)
    expect(f.calls()).toBe(3)
    expect(readCredentials(f.env)[f.url]).toMatchObject({ token: TOKEN, kind: "device", org: "app", email: who.email, label: "workstation" })
  })

  for (const mode of ["--no-browser", "none", "ssh", "linux-headless"]) {
    test(`${mode} prints the URL and code without a browser`, async () => {
      const f = fixture()
      const extra =
        mode === "none"
          ? { BROWSER: "none" }
          : mode === "ssh"
            ? { SSH_CONNECTION: "remote" }
            : mode === "linux-headless" && process.platform === "linux"
              ? { DISPLAY: "", WAYLAND_DISPLAY: "" }
              : {}
      const result = await f.run(
        ["login", ...(mode === "--no-browser" || (mode === "linux-headless" && process.platform !== "linux") ? ["--no-browser"] : [])],
        extra,
      )
      expect(result.code).toBe(0)
      expect(result.stderr).toContain(`${f.url}/device`)
      expect(result.stderr).toContain("BCDF-GHJK")
      expect(existsSync(f.browserFile)).toBe(false)
      expect(f.label()).toBe(hostMachine())
    })
  }

  test("slow_down adds five seconds to the polling interval", async () => {
    const f = fixture({ polls: ["slow_down", "approved"] })
    const result = await f.run(["login", "--no-browser", "--json"], { SCP_MACHINE: "runner" })
    expect(result.code).toBe(0)
    expect(f.times[1]! - f.times[0]!).toBeGreaterThanOrEqual(4900)
    expect(JSON.parse(result.stdout)).toEqual({ kind: "device", org: "app", email: who.email, label: "runner" })
  }, 10_000)

  for (const error of ["expired_token", "access_denied", "invalid_grant"]) {
    test(`${error} fails with the server description and stores nothing`, async () => {
      const f = fixture({ polls: [error] })
      const result = await f.run(["login", "--no-browser"])
      expect(result.code).toBe(125)
      expect(result.stderr).toContain(`server says ${error}`)
      expect(readCredentials(f.env)).toEqual({})
    })
  }

  test("5xx responses and network failures keep polling", async () => {
    const f = fixture({ polls: ["authorization_pending", "server_error", "approved"], disconnect: true })
    const result = await f.run(["login", "--no-browser"])
    expect(result.code).toBe(0)
    expect(readCredentials(f.env)[f.url]!.token).toBe(TOKEN)
  })

  test("local expiry stops polling even when requests hang", async () => {
    const f = fixture({ expires: 0.15, hang: true })
    const started = Date.now()
    const result = await f.run(["login", "--no-browser"])
    expect(result.code).toBe(125)
    expect(result.stderr).toContain("the device code expired")
    expect(Date.now() - started).toBeLessThan(1400)
    expect(readCredentials(f.env)).toEqual({})
  })

  for (const method of ["flag", "environment"]) {
    test(`${method} token checks whoami and saves without opening a browser or showing the secret`, async () => {
      const f = fixture()
      const result = await f.run(["login", "--json", ...(method === "flag" ? ["--token", API_TOKEN] : [])], {
        SCP_TOKEN: method === "environment" ? ` ${API_TOKEN} ` : "",
      })
      expect(result.code).toBe(0)
      expect(result.stderr).toBe("")
      expect(JSON.parse(result.stdout)).toEqual(who)
      expect(f.authorizations).toEqual([`Bearer ${API_TOKEN}`])
      expect(readCredentials(f.env)[f.url]).toMatchObject({ token: API_TOKEN, kind: "token", email: who.email, org: "app" })
      expect(existsSync(f.browserFile)).toBe(false)
      expect(f.calls()).toBe(0)
    })

    test(`${method} token refuses whoami 401 without overwriting a login`, async () => {
      const f = fixture({ whoStatus: 401 })
      saveCredential(f.env, f.url, { token: "previous" })
      const result = await f.run(["login", ...(method === "flag" ? ["--token", API_TOKEN] : [])], method === "environment" ? { SCP_TOKEN: API_TOKEN } : {})
      expect(result.code).toBe(125)
      expect(result.stderr).toContain(`that token is not valid for ${f.url}`)
      expect(readCredentials(f.env)[f.url]!.token).toBe("previous")
      expect(existsSync(f.browserFile)).toBe(false)
    })
  }

  test("explicit token wins over SCP_TOKEN", async () => {
    const f = fixture()
    expect((await f.run(["login", "--token", API_TOKEN], { SCP_TOKEN: "other-token" })).code).toBe(0)
    expect(f.authorizations).toEqual([`Bearer ${API_TOKEN}`])
  })

  test("relay use and show, logout and argument validation", async () => {
    const f = fixture()
    expect((await f.run(["relay", "use", "https://relay.example/path"])).code).toBe(0)
    const shown = JSON.parse((await f.run(["relay", "show", "--json"])).stdout)
    expect(shown).toEqual({ url: f.url, source: "SCP_RELAY", credential: "missing", credential_source: null })
    saveCredential(f.env, f.url, { token: TOKEN })
    expect((await f.run(["relay", "show"])).stdout).toContain("credential found")
    const loggedOut = await f.run(["logout"], { SCP_TOKEN: API_TOKEN })
    expect(loggedOut.stdout).toContain(`logged out of ${f.url}`)
    expect(loggedOut.stderr).toContain("$SCP_TOKEN still applies")
    expect((await f.run(["logout"])).stdout).toContain("no stored login")
    for (const args of [["relay"], ["relay", "use"], ["relay", "show", "extra"], ["login", "extra"], ["logout", "extra"], ["login", "--token", " "]]) {
      expect((await f.run(args)).code).toBe(125)
    }
    expect(existsSync(join(configDir(f.env), "config.json"))).toBe(true)
  })
})
