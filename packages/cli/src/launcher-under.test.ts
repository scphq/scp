import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"
import { startFakeHubServer } from "@scp-dev/broker/testing"
import { attribute, attributed } from "./attribute"
import { bgDir, bgMount, claudeArgv, claudeCommand } from "./claude"
import { codexLaunch } from "./codex"
import { RelayUsage } from "./common"
import { museLaunch } from "./muse"
import { opencodeLaunch } from "./opencode"
import { piLaunch } from "./pi"
import { resumeLaunch } from "./resume"
import { t3Launch } from "./t3code"

const parsers = {
  claude: claudeArgv,
  codex: (args: string[]) => codexLaunch(args, {}, []),
  opencode: (args: string[]) => opencodeLaunch(args, {}, "opencode"),
  pi: (args: string[]) => piLaunch(args, {}, "extension"),
  muse: (args: string[]) => museLaunch(args, {}),
  agy: (args: string[]) => resumeLaunch("agy", args, {}),
  grok: (args: string[]) => resumeLaunch("grok", args, {}),
  t3code: (args: string[]) => t3Launch([...args, "--thread", "thread"], {}),
}
for (const [name, parse] of Object.entries(parsers)) {
  describe(`${name} --under`, () => {
    for (const address of ["lead", "me/lead", "me/vm/lead"]) {
      test(`accepts ${address} in both forms`, () => {
        expect(parse(["--under", address]).under).toBe(address)
        expect(parse([`--under=${address}`]).under).toBe(address)
      })
    }
    test("rejects root conflicts and invalid addresses", () => {
      for (const args of [
        ["--root", "--under=lead"],
        ["--under=lead", "--root"],
        ["--under"],
        ...["", "me/VM/lead", "me/-vm/lead", "me/vm/Bad", "me/vm/lead/extra", "me/"].map((a) => [`--under=${a}`]),
      ])
        expect(() => parse(args)).toThrow(RelayUsage)
    })
  })
}

test("explicit placement skips caller attribution and strips identity even on resume", async () => {
  const env = { SCP_NAME: "caller", SCP_GRANT: "spent", SCP_SESSION: "caller-session", SCP_UNDER: "old", SCP_DIR: "/tmp/unused" }
  const result = await attribute("pi", { under: "me/lead", resume: true }, env, "/tmp", () => {}, {
    connect: async () => {
      throw new Error("must not connect for a local parent")
    },
  })
  expect(result).toEqual({ env: { SCP_UNDER: "me/lead" }, parent: "me/lead" })
  expect(attributed(env, result)).toEqual({ SCP_DIR: "/tmp/unused", SCP_UNDER: "me/lead" })
})

async function until<T>(check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await Bun.sleep(20)
  }
  throw new Error("timed out waiting for bridge view")
}

test("background mount retains explicit placement and its claim links across brokers", async () => {
  const root = mkdtempSync(join(tmpdir(), "scp-launcher-under-"))
  const token = `scp_t_test${"u".repeat(32)}`
  const hub = startFakeHubServer({ tokens: { [token]: { tokenId: "tok_under", user: "account" } } })
  const brokers: Broker[] = []
  const clients: RelayClient[] = []
  const connect = async (broker: Broker) => {
    const client = await RelayClient.connect(broker.socket)
    clients.push(client)
    return client
  }
  const machine = async (name: string, linked = true, url = hub.url) => {
    const broker = await startBroker({
      dir: join(root, name),
      policyPath: join(root, `${name}.json`),
      idleMs: 0,
      log: () => {},
      ...(linked ? { bridge: { url, token, machine: name, backoff: { minMs: 20, maxMs: 100 }, localFlushMs: 20 } } : {}),
    })
    brokers.push(broker)
    if (linked && url === hub.url) await until(async () => broker.bridge!.status().connected || undefined)
    return broker
  }
  try {
    const a = await machine("laptop")
    const b = await machine("vm")
    const solo = await machine("solo", false)
    const lead = await connect(a)
    await lead.hello({ claim: { handle: "lead", harness: "cli" } })
    const observer = await connect(b)
    await observer.hello({ observe: true })
    type Listed = { endpoints: { address: string; parent: string | null }[] }
    await until(async () => (await observer.request<Listed>("list", { all: true })).endpoints.find((e) => e.address === "me/laptop/lead"))
    const deps = { connect: async () => RelayClient.connect(b.socket) }
    expect(await attribute("pi", { under: "me/vm/lead" }, {}, root, () => {}, deps)).toEqual({ env: { SCP_UNDER: "me/lead" }, parent: "me/lead" })
    await expect(attribute("pi", { under: "me/laptop/lead" }, {}, root, () => {}, { connect: async () => RelayClient.connect(solo.socket) })).rejects.toThrow(
      "not linked to a hub",
    )
    const down = await machine("down", true, "http://127.0.0.1:9")
    const warned: string[] = []
    expect(
      await attribute("pi", { under: "me/laptop/lead" }, {}, root, (line) => warned.push(line), { connect: async () => RelayClient.connect(down.socket) }),
    ).toEqual({
      env: { SCP_UNDER: "me/laptop/lead" },
      parent: "me/laptop/lead",
    })
    expect(warned.join("\n")).toContain("not linked to the hub yet")

    const bin = join(root, "bin")
    mkdirSync(bin)
    const daemonEnv = join(root, "daemon-env")
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nenv > '${daemonEnv}'\necho 'backgrounded · 1a2b3c4d (idle)'\n`, { mode: 0o755 })
    const env = { HOME: root, PATH: `${bin}:/usr/bin:/bin`, SCP_DIR: join(root, "vm"), SCP_NAME: "caller", SCP_GRANT: "spent" }
    expect(await claudeCommand(["--under", "me/lead", "--name", "foreground", "--", "--mcp-config", "custom.json"], env, () => {}, root)).toBe(0)
    const foreground = readFileSync(daemonEnv, "utf8")
    expect(foreground).toContain("SCP_UNDER=me/lead")
    expect(foreground).toContain("SCP_NAME=foreground")
    expect(foreground).not.toMatch(/^SCP_GRANT=/m)
    const lines: string[] = []
    expect(
      await claudeCommand(["--bg", "--name", "worker", "--under", "me/laptop/lead"], env, () => {}, root, { attribute: deps, out: (line) => lines.push(line) }),
    ).toBe(0)
    expect(lines.join("\n")).toContain("under me/laptop/lead")
    expect(readFileSync(daemonEnv, "utf8")).not.toMatch(/^SCP_(UNDER|NAME|GRANT)=/m)
    const config = JSON.parse(readFileSync(join(bgDir(env), "1a2b3c4d.json"), "utf8"))
    const mountEnv = config.mcpServers.scp.env
    expect(mountEnv).toMatchObject({ SCP_UNDER: "me/laptop/lead", SCP_NAME: "worker", SCP_GRANT: "" })
    expect(bgMount({ ...env, SCP_UNDER: "me/laptop/lead" }, "worker").env).toMatchObject({ SCP_UNDER: "me/laptop/lead" })
    const child = await connect(b)
    await child.hello({ claim: { handle: mountEnv.SCP_NAME, harness: "claude-code", under: mountEnv.SCP_UNDER } })
    expect(b.core.list({ all: true }).find((e) => e.address === "me/worker")?.parent).toBe("me/laptop/lead")
    const remote = await until(async () =>
      (await lead.request<Listed>("list", { all: true })).endpoints.find((e) => e.address === "me/vm/worker" && e.parent === "me/lead"),
    )
    expect(remote.parent).toBe("me/lead")
  } finally {
    for (const client of clients) client.close()
    for (const broker of brokers.reverse()) await broker.stop()
    await hub.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)
