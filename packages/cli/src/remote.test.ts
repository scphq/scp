import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type Envelope, PREAMBLE } from "@scp-dev/core"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"
import { type FakeHubServer, startFakeHubServer } from "@scp-dev/broker/testing"
import { daemonBridge, hostMachine, machineName, readCloudFile } from "./remote"
import { saveCredential } from "./relay"
import { alive, waitFor } from "./testing/fixtures"

setDefaultTimeout(30_000)

const entry = join(import.meta.dir, "cli.ts")
const TOKEN = `scp_t_test${"c".repeat(32)}`

let fake: FakeHubServer
let broker: Broker
let impl: RelayClient
let cloud: Record<string, string>

async function swarm(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

beforeAll(async () => {
  fake = startFakeHubServer({ tokens: { [TOKEN]: { tokenId: "tok_ci", user: "ada" } } })
  cloud = { SCP_RELAY: fake.url, SCP_TOKEN: TOKEN }
  const root = mkdtempSync(join(process.env.HOME!, "bridged-"))
  broker = await startBroker({
    dir: join(root, "state"),
    policyPath: join(root, "policy.json"),
    idleMs: 0,
    log: () => {},
    bridge: { url: fake.url, token: TOKEN, machine: "a", backoff: { minMs: 20, maxMs: 100 } },
  })
  await waitFor(() => broker.bridge!.status().connected, 5000, "the bridge")
  impl = await RelayClient.connect(broker.socket)
  await impl.hello({ claim: { handle: "impl", harness: "claude-code" } })
})

/** a hub stand-in that answers every call with a canned result and keeps the hellos it got */
function scriptedHub(results: Record<string, unknown>) {
  const hellos: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, srv) => (srv.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 })),
    websocket: {
      message(ws, text) {
        const frame = JSON.parse(String(text)) as { id: number; method: string; params: Record<string, unknown> }
        if (frame.method === "hello") hellos.push(frame.params)
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: results[frame.method] ?? {} }))
      },
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, hellos, stop: () => server.stop(true) }
}

afterAll(async () => {
  impl.close()
  await broker.stop()
  await fake.stop()
})

describe("swarm --cloud", () => {
  test("a machine with no broker claims, sends to a bridged machine and reads its inbox", async () => {
    const whoami = await swarm(["whoami", "--cloud", "--machine", "ci", "--as", "tester"], cloud)
    expect(whoami.stderr).toBe("")
    expect(whoami.stdout.split("\n")[0]).toBe("ada/ci/tester (agent, cli)")

    const sent = await swarm(["send", "a/impl", "from ci", "--as", "tester"], { ...cloud, SCP_TRANSPORT: "cloud", SCP_MACHINE: "ci" })
    expect(sent.stderr).toBe("")
    expect(sent.stdout).toContain("sent msg_")
    const got = await impl.request<{ messages: Envelope[] }>("inbox", { wait_s: 5 })
    expect(got.messages.map((m) => [m.body.text, m.from.address, m.from.auth, m.from.machine])).toEqual([["from ci", "me/ci/tester", "account", "ci"]])
    await impl.request("ack", { seqs: got.messages.map((m) => m.seq) })

    await waitFor(() => broker.core.isRemote("ci/tester"), 5000, "ci/tester on a")
    await impl.request("send", { to: "ci/tester", body: "back to ci" })
    const inbox = await swarm(["inbox", "--cloud", "--machine", "ci", "--as", "tester", "--json", "--ack"], cloud)
    const parsed = JSON.parse(inbox.stdout) as { preamble: string; messages: Envelope[] }
    expect(parsed.preamble).toBe(PREAMBLE)
    expect(parsed.messages.map((m) => [m.body.text, m.from.address, m.from.auth])).toEqual([["back to ci", "ada/a/impl", "account+bridge"]])
    const text = await swarm(["inbox", "--cloud", "--machine", "ci", "--as", "tester"], cloud)
    expect(text.stderr).toContain("no unread messages")

    const machines = await swarm(["machines", "--machine", "ci", "--json"], cloud)
    const listed = (JSON.parse(machines.stdout) as { machines: { name: string; bridge: boolean; online: boolean }[] }).machines
    expect(listed.map((m) => [m.name, m.bridge])).toEqual([
      ["a", true],
      ["ci", false],
    ])
    expect(listed.find((m) => m.name === "a")!.online).toBe(true)
  })

  test("machines observes without binding the machine it names", async () => {
    const machines = await swarm(["machines", "--machine", "fresh", "--json"], cloud)
    expect(machines.stderr).toBe("")
    const listed = (JSON.parse(machines.stdout) as { machines: { name: string }[] }).machines
    expect(listed.map((m) => m.name)).not.toContain("fresh")
  })

  test("observer verbs without --as send the observer hello; other verbs keep the inbox, and --as claims", async () => {
    const scripted = scriptedHub({
      hello: { account: "ada" },
      list: { endpoints: [] },
      snapshot: { endpoints: [], activity: [] },
      log: { rows: [] },
      machines: { machines: [] },
      send: { id: "msg_1", thread: "msg_1", deliveries: [] },
    })
    try {
      const env = { SCP_RELAY: scripted.url, SCP_TOKEN: TOKEN }
      for (const args of [
        ["list", "--cloud"],
        ["status", "--cloud"],
        ["log", "--cloud"],
        ["machines"],
        ["send", "ada/", "hi", "--cloud", "--human"],
        ["list", "--cloud", "--as", "tester"],
      ]) {
        const result = await swarm([...args, "--machine", "ci", "--json"], env)
        expect(result.stderr).toBe("")
        expect(result.code).toBe(0)
      }
      expect(scripted.hellos.map((h) => [h.machine, h.observe ?? null, h.human ?? null, (h.claim as { handle?: string } | undefined)?.handle ?? null])).toEqual(
        [
          ["ci", true, null, null],
          ["ci", true, null, null],
          ["ci", true, null, null],
          ["ci", true, null, null],
          ["ci", null, true, null],
          ["ci", null, null, "tester"],
        ],
      )
    } finally {
      await scripted.stop()
    }
  })

  test("cloud.json private_ok is true or false and reaches the bridge as privateOk", async () => {
    const home = mkdtempSync(join(process.env.HOME!, "private-ok-"))
    const file = join(home, "scp", "cloud.json")
    mkdirSync(dirname(file), { recursive: true })
    const env = { HOME: process.env.HOME, XDG_CONFIG_HOME: home, SCP_TOKEN: TOKEN }
    try {
      writeFileSync(file, JSON.stringify({ bridge: true, machine: "laptop", url: fake.url, private_ok: true }))
      expect(readCloudFile(file)).toEqual({ bridge: true, machine: "laptop", url: fake.url, private_ok: true })
      expect(await daemonBridge(env, () => {})).toMatchObject({ machine: "laptop", token: TOKEN, privateOk: true })
      writeFileSync(file, JSON.stringify({ bridge: true, machine: "laptop", url: fake.url }))
      expect((await daemonBridge(env, () => {}))?.privateOk).toBeUndefined()
      writeFileSync(file, JSON.stringify({ bridge: true, machine: "laptop", url: fake.url, private_ok: "yes" }))
      expect(() => readCloudFile(file)).toThrow("private_ok is true or false")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("the bridge reads its token again on each reconnect, so a new login is picked up", async () => {
    const home = mkdtempSync(join(process.env.HOME!, "relogin-"))
    const file = join(home, "scp", "cloud.json")
    mkdirSync(dirname(file), { recursive: true })
    const env: Record<string, string | undefined> = { HOME: process.env.HOME, XDG_CONFIG_HOME: home, SCP_TOKEN: TOKEN }
    try {
      writeFileSync(file, JSON.stringify({ bridge: true, machine: "laptop", url: fake.url }))
      const bridge = await daemonBridge(env, () => {})
      const next = `scp_t_test${"n".repeat(32)}`
      env.SCP_TOKEN = next
      expect(await bridge!.credentials!()).toBe(next)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("cloud.json mirror refuses scope selectors, which a mirrored endpoint never matches", () => {
    const home = mkdtempSync(join(process.env.HOME!, "mirror-"))
    const file = join(home, "cloud.json")
    try {
      writeFileSync(file, JSON.stringify({ bridge: true, machine: "laptop", url: fake.url, mirror: ["harness:codex", "label:team=a"] }))
      expect(readCloudFile(file).mirror).toEqual(["harness:codex", "label:team=a"])
      for (const sel of ["group:crew", "fleet:main", "tree:children", "machine:laptop", "org:acme"]) {
        writeFileSync(file, JSON.stringify({ bridge: true, machine: "laptop", url: fake.url, mirror: ["harness:codex", sel] }))
        expect(() => readCloudFile(file)).toThrow(`${file}: mirror selectors match by handle, harness, kind and label; "${sel}" is a scope selector`)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("machine selection prefers the flag, then SCP_MACHINE, then the normalized hostname", () => {
    expect(machineName("ci", { SCP_MACHINE: "desk" })).toBe("ci")
    expect(machineName(undefined, { SCP_MACHINE: "desk" })).toBe("desk")
    expect(machineName(undefined, {})).toBe(hostMachine())
    for (const name of ["me", "", "Upper", "a_b", "x".repeat(33)]) expect(() => machineName(name, {})).toThrow("is not valid")
  })

  test("cloud.json defaults its URL to the active relay and rereads stored credentials", async () => {
    const home = mkdtempSync(join(process.env.HOME!, "stored-login-"))
    const file = join(home, "scp", "cloud.json")
    const env = { XDG_CONFIG_HOME: home, SCP_RELAY: fake.url }
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ bridge: true, machine: "laptop" }))
      expect(readCloudFile(file, env).url).toBe(fake.url)
      const bridge = await daemonBridge(env, () => {})
      expect(bridge?.token).toBeNull()
      expect(bridge?.tokenError).toContain("no login for")
      saveCredential(env, fake.url, { token: TOKEN })
      expect(await bridge!.credentials!()).toBe(TOKEN)
      saveCredential(env, fake.url, { token: "replacement" })
      expect(await bridge!.credentials!()).toBe("replacement")
      writeFileSync(file, JSON.stringify({ bridge: true, machine: "laptop", url: "http://outside.example" }))
      const logs: string[] = []
      expect(await daemonBridge(env, (line) => logs.push(line))).toBeUndefined()
      expect(logs[0]).toContain("running local-only")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("cloud identity, grants and local-only verbs keep their usage checks", async () => {
    const scripted = scriptedHub({ hello: { account: "ada" } })
    const env = { SCP_RELAY: scripted.url, SCP_TOKEN: TOKEN }
    try {
      for (const [args, extra, message] of [
        [["send", "ada/", "hi", "--cloud"], {}, "needs an identity"],
        [["whoami", "--machine", "ci", "--human"], {}, "add --cloud"],
        [["whoami", "--cloud", "--human", "--as", "rev"], {}, "name two identities"],
        [["whoami", "--cloud", "--as", "rev"], { SCP_GRANT: `krt_${"a".repeat(64)}` }, "not the cloud transport"],
        [["whoami", "--cloud", "--as", "rev"], { SCP_TOKEN: "", XDG_CONFIG_HOME: join(process.env.HOME!, "no-login") }, "run swarm login, or set SCP_TOKEN"],
        [["spawn-env", "--cloud"], {}, "does not take --cloud"],
        [["spawn-env", "--human"], { SCP_TRANSPORT: "cloud" }, "has no --cloud form"],
        ...[
          ["rules", "show"],
          ["group", "ls"],
          ["policy", "show"],
          ["peek", "rev"],
          ["admin", "ls"],
          ["why", "rev", "impl"],
          ["peers"],
          ["set-peek", "on"],
          ["holds"],
        ].map((args) => [[...args, "--cloud", "--human"], {}, "has no --cloud form"]),
      ] as [string[], Record<string, string>, string][]) {
        const result = await swarm(args, { ...env, ...extra })
        expect(result.code).toBe(125)
        expect(result.stderr).toContain(message)
        expect(result.stdout + result.stderr).not.toContain(TOKEN)
      }
      for (const args of [
        ["cloud"],
        ["cloud", "enable", "extra"],
        ["cloud", "disable", "--machine", "ci"],
        ["machines", "rm"],
        ["machines", "rm", "ci", "extra"],
      ]) {
        expect((await swarm(args, env)).code).toBe(125)
      }
    } finally {
      await scripted.stop()
    }
  })

  test("opaque credentials reach the hub without a token prefix check", async () => {
    const scripted = scriptedHub({ hello: { account: "ada" }, machines: { machines: [] } })
    try {
      const result = await swarm(["machines", "--json"], { SCP_RELAY: scripted.url, SCP_TOKEN: "opaque-test-credential" })
      expect(result.code).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).not.toContain("opaque-test-credential")
    } finally {
      await scripted.stop()
    }
  })

  test("cloud enable writes cloud.json privately without the token, and the broker it starts links to the hub", async () => {
    const file = join(process.env.XDG_CONFIG_HOME!, "scp", "cloud.json")
    const enabled = await swarm(["cloud", "enable", "--machine", "laptop"], cloud)
    expect(enabled.code).toBe(0)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700)
    const text = readFileSync(file, "utf8")
    expect(JSON.parse(text)).toEqual({ bridge: true, machine: "laptop", url: fake.url })
    expect(text).not.toContain(TOKEN)
    expect(enabled.stdout + enabled.stderr).not.toContain(TOKEN)

    const env = { SCP_DIR: mkdtempSync(join(process.env.HOME!, "laptop-relay-")), SCP_IDLE: "3s", SCP_TOKEN: TOKEN, SCP_RELAY: fake.url }
    let status: { config: unknown; broker: { enabled: boolean; connected: boolean; machine: string } }
    const deadline = Date.now() + 10_000
    for (;;) {
      status = JSON.parse((await swarm(["cloud", "status", "--json"], env)).stdout) as typeof status
      if (status.broker.connected || Date.now() > deadline) break
      await Bun.sleep(100)
    }
    expect(status).toMatchObject({ config: { machine: "laptop", url: fake.url }, broker: { enabled: true, machine: "laptop", connected: true } })
    const pid = Number(readFileSync(join(env.SCP_DIR, "broker.lock"), "utf8").split(":")[0])
    await waitFor(() => !alive(pid), 15_000, "the idle broker to exit")

    expect((await swarm(["cloud", "disable"])).stdout).toContain("removed")
    expect(() => statSync(file)).toThrow()
    rmSync(env.SCP_DIR, { recursive: true, force: true })
  })
})
