import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RelayClient, socketPath } from "@scp-dev/broker"
import { alive } from "./testing/fixtures"

setDefaultTimeout(90_000)

const entry = join(import.meta.dir, "cli.ts")
const RUNNER = join(import.meta.dir, "testing", "local-ssh-runner.ts")

type Listed = { endpoints: { address: string; presence?: string; parent?: string | null; status?: { state: string; note: string | null } | null }[] }
type Message = {
  id: string
  seq: number
  kind: string
  thread: string
  reply_to?: string | null
  from: { address: string; machine?: string; auth?: string }
  body: { text: string }
}
type Inbox = { messages: Message[] }
type MeshLive = {
  connected: boolean
  mesh?: { listen: string | null; peers: { addr: string; connected: boolean; last_error: string | null }[]; links: { machine: string }[] }
}

async function until<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

/** listed and not offline: a fresh claim shows online, a quiet one idle */
function present(row: Listed["endpoints"][number] | undefined): boolean {
  return !!row && row.presence !== "offline"
}

/** a free loopback port below the ephemeral ranges, so no outgoing connection takes it before the broker binds it */
async function freePort(): Promise<number> {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 12_000)
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
}

/** one machine: its own HOME and relay dir, driven only through the swarm CLI and its broker socket */
class Machine {
  readonly home: string
  readonly dir: string
  readonly clients: RelayClient[] = []
  port = 0

  constructor(
    root: string,
    readonly name: string,
  ) {
    this.home = join(root, name)
    this.dir = join(this.home, "state")
    mkdirSync(this.dir, { recursive: true })
  }

  get addr(): string {
    return `127.0.0.1:${this.port}`
  }

  get env(): Record<string, string> {
    const home = this.home
    return {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      SCP_DIR: this.dir,
      SCP_HARNESS_DETECT: "0",
    }
  }

  async swarm(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}) {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("SCP_")) env[key] = value
    const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], {
      stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...env, ...this.env, ...options.env },
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, code }
  }

  async ok(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}): Promise<string> {
    const result = await this.swarm(args, options)
    if (result.code !== 0) throw new Error(`swarm ${args.join(" ")} on ${this.name} exited ${result.code}: ${result.stderr}${result.stdout}`)
    return result.stdout
  }

  async json<T>(args: string[]): Promise<T> {
    return JSON.parse(await this.ok([...args, "--json"])) as T
  }

  async init(args: string[], stdin?: string) {
    this.port ||= await freePort()
    return this.ok(["mesh", "init", "--machine", this.name, "--listen", this.addr, ...args], stdin === undefined ? {} : { stdin })
  }

  /** a long-lived agent session on this machine, so its endpoint stays online */
  async agent(handle: string): Promise<RelayClient> {
    const client = await RelayClient.connect(socketPath(this.dir))
    await client.hello({ claim: { handle, harness: "cli" } })
    this.clients.push(client)
    return client
  }

  async observer(): Promise<RelayClient> {
    const client = await RelayClient.connect(socketPath(this.dir))
    await client.hello({ observe: true })
    this.clients.push(client)
    return client
  }

  async listed(address: string) {
    const observer = await this.observer()
    try {
      return (await observer.request<Listed>("list", { all: true })).endpoints.find((row) => row.address === address)
    } finally {
      observer.close()
    }
  }

  async live(): Promise<MeshLive | null> {
    return (await this.json<{ live: MeshLive | null }>(["mesh", "status"])).live
  }

  async linkedTo(name: string): Promise<boolean> {
    const live = await this.live()
    return !!live?.mesh?.links.some((link) => link.machine === name)
  }

  async start() {
    await this.ok(["daemon", "restart"])
  }

  async stop() {
    for (const client of this.clients.splice(0)) client.close()
    const lock = join(this.dir, "broker.lock")
    const pid = existsSync(lock) ? Number(readFileSync(lock, "utf8").split(":")[0]) : 0
    await this.ok(["daemon", "stop"])
    if (pid > 0) await until(async () => !alive(pid), `${this.name}'s broker to exit`)
  }
}

describe("mesh across real brokers", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-e2e-"))
  const a = new Machine(root, "laptop")
  const b = new Machine(root, "vm")
  const c = new Machine(root, "other")
  const harness = join(root, "harness.ts")
  const runners = join(root, "runners.json")
  let lead: RelayClient

  beforeAll(async () => {
    writeFileSync(harness, `console.log("result from " + process.env.SCP_NAME + " under " + process.env.SCP_UNDER)\n`)
    writeFileSync(runners, JSON.stringify({ vm: { command: [process.execPath, "--no-env-file", RUNNER, "--dir", b.dir, "--machine", "vm"], timeout_s: 60 } }))
  })

  afterAll(async () => {
    try {
      for (const machine of [a, b, c]) {
        try {
          await machine.stop()
        } catch (error) {
          console.error(error)
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("setup: init, copy the account key, add peers; a broker started before its peer links once the peer is up", async () => {
    b.port = await freePort()
    const out = await a.init(["--account", "team"])
    expect(out).toContain("machine: laptop")
    await b.init(["--account-key", "-"], readFileSync(join(a.dir, "mesh", "account.key"), "utf8"))
    await a.ok(["mesh", "add-peer", b.addr])
    await b.ok(["mesh", "add-peer", a.addr])
    const accountA = JSON.parse(readFileSync(join(a.dir, "mesh", "account.key"), "utf8")) as { public: string }
    const accountB = JSON.parse(readFileSync(join(b.dir, "mesh", "account.key"), "utf8")) as { public: string }
    expect(accountB.public).toBe(accountA.public)

    await a.start()
    const waiting = await until(async () => (await a.live())?.mesh?.peers.find((peer) => peer.addr === b.addr && peer.last_error), "a dial failure")
    expect(waiting.connected).toBe(false)
    await b.start()
    await until(() => a.linkedTo("vm"), "laptop linked to vm")
    await until(() => b.linkedTo("laptop"), "vm linked to laptop")
  })

  test("send, receive and reply threads cross machines, with presence mirrored both ways", async () => {
    lead = await a.agent("lead")
    const review = await b.agent("review")
    await until(async () => present(await a.listed("me/vm/review")), "vm/review online on laptop")
    await until(async () => present(await b.listed("me/laptop/lead")), "laptop/lead online on vm")

    const sent = await a.json<{ id: string; deliveries: { address: string }[] }>(["send", "--as", "lead", "vm/review", "please look at the parser"])
    expect(sent.deliveries.map((delivery) => delivery.address)).toEqual(["me/vm/review"])
    const inbox = await review.request<Inbox>("inbox", { wait_s: 5 })
    const first = inbox.messages.find((message) => message.body.text === "please look at the parser")!
    expect(first.from).toMatchObject({ address: "me/laptop/lead", machine: "laptop", auth: "account+bridge" })
    await review.request("ack", { seqs: inbox.messages.map((message) => message.seq) })

    await b.ok(["reply", "--as", "review", first.id, "parser looks fine"])
    const replied = await until(
      async () => (await lead.request<Inbox>("inbox", { wait_s: 1 })).messages.find((message) => message.body.text === "parser looks fine"),
      "the reply on laptop",
    )
    expect(replied).toMatchObject({ kind: "reply", reply_to: sent.id, from: { address: "me/vm/review" } })
    expect(replied.thread).toBe(first.thread)
    await lead.request("ack", { seqs: [replied.seq] })

    review.close()
    await until(async () => (await a.listed("me/vm/review"))?.presence === "offline", "vm/review offline on laptop")
  })

  test("ask waits for the answer from the other machine, and ask_wait picks it up later", async () => {
    const answerer = await b.agent("answerer")
    await until(async () => present(await a.listed("me/vm/answerer")), "vm/answerer on laptop")
    const asking = a.json<{ reply?: { body: { text: string } } }>(["ask", "--as", "lead", "vm/answerer", "what is 6 times 7", "--wait", "20"])
    const question = await until(
      async () => (await answerer.request<Inbox>("inbox", { wait_s: 1 })).messages.find((message) => message.kind === "request"),
      "the question on vm",
    )
    await answerer.request("send", { to: "laptop/lead", body: "42", kind: "reply", reply_to: question.id })
    expect((await asking).reply?.body.text).toBe("42")

    const later = await lead.request<{ id: string }>("ask", { to: "vm/answerer", body: "and 6 times 8", wait_s: 0 })
    const second = await until(
      async () => (await answerer.request<Inbox>("inbox", { wait_s: 1 })).messages.find((message) => message.body.text === "and 6 times 8"),
      "the second question",
    )
    await answerer.request("send", { to: "laptop/lead", body: "48", kind: "reply", reply_to: second.id })
    const waited = await lead.request<{ reply?: { body: { text: string } } }>("ask_wait", { id: later.id, wait_s: 15 })
    expect(waited.reply?.body.text).toBe("48")
  })

  test("an agent's rules on one machine gate senders on the other", async () => {
    const closed = await b.agent("closed")
    await until(async () => present(await a.listed("me/vm/closed")), "vm/closed on laptop")
    await closed.request("rules_set", { in: ["tree:descendants"] })
    const refused = await until(async () => {
      const sent = await a.swarm(["send", "--as", "lead", "vm/closed", "may I"])
      return sent.code !== 0 ? sent : undefined
    }, "the mirrored rules on laptop")
    expect(refused.stderr).toContain("closed")
    await closed.request("rules_set", { in: ["*"] })
    await until(async () => (await a.swarm(["send", "--as", "lead", "vm/closed", "now?"])).code === 0, "the opened rules on laptop")
    expect((await closed.request<Inbox>("inbox", { wait_s: 5 })).messages.map((message) => message.body.text)).toEqual(["now?"])
  })

  test("a worker linked under an agent on the other machine shows under it and hands its result back", async () => {
    const run = await b.swarm(["spawn", "--fg", "--under", "me/laptop/lead", "--name", "w1", "--", process.execPath, "--no-env-file", harness])
    expect(run.stderr).toBe("")
    expect(run.code).toBe(0)
    const handback = await until(
      async () => (await lead.request<Inbox>("inbox", { wait_s: 1 })).messages.find((message) => message.from.address === "me/vm/w1"),
      "w1's handback on laptop",
    )
    expect(handback.body.text).toBe("worker me/vm/w1 finished (exit 0)\n\nresult from w1 under me/laptop/lead")
    const shown = await until(async () => {
      const row = await a.listed("me/vm/w1")
      return row?.status?.state === "done" ? row : undefined
    }, "vm/w1 done on laptop")
    expect(shown.parent).toBe("me/lead")
  })

  test("spawn --via starts the worker on the other machine through a runner and the handback crosses back", async () => {
    const spawned = await a.swarm(["spawn", "--as", "lead", "--via", "vm", "--name", "w2", "--", process.execPath, "--no-env-file", harness], {
      env: { SCP_RUNNERS_FILE: runners },
    })
    expect(spawned.stderr).toBe("")
    expect(spawned.code).toBe(0)
    expect(spawned.stdout).toStartWith("w2 handed to runner vm: it starts on machine vm and shows under you as me/vm/w2;")
    const handback = await until(
      async () => (await lead.request<Inbox>("inbox", { wait_s: 1 })).messages.find((message) => message.from.address === "me/vm/w2"),
      "w2's handback on laptop",
    )
    expect(handback.body.text).toBe("worker me/vm/w2 finished (exit 0)\n\nresult from w2 under me/laptop/lead")
    expect((await a.listed("me/vm/w2"))?.parent).toBe("me/lead")
  })

  test("a restarted peer relinks and messages flow again, while its endpoints show offline in between", async () => {
    const before = await b.agent("steady")
    await until(async () => present(await a.listed("me/vm/steady")), "vm/steady on laptop")
    await b.ok(["daemon", "stop"])
    before.close()
    await until(async () => !(await a.linkedTo("vm")), "laptop sees vm gone")
    expect((await a.listed("me/vm/steady"))?.presence).toBe("offline")
    const refused = await a.swarm(["send", "--as", "lead", "vm/steady", "anyone there"])
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain("not linked")

    await b.start()
    await until(() => a.linkedTo("vm"), "laptop relinked to vm")
    const back = await b.agent("back")
    await until(async () => present(await a.listed("me/vm/back")), "vm/back on laptop")
    await a.ok(["send", "--as", "lead", "vm/back", "welcome back"])
    const got = await until(
      async () => (await back.request<Inbox>("inbox", { wait_s: 1 })).messages.find((message) => message.body.text === "welcome back"),
      "the message after the restart",
    )
    expect(got.from.address).toBe("me/laptop/lead")
  })

  test("a machine of another account with the same handle is refused and reaches nothing", async () => {
    await c.init(["--account", "team"])
    await c.ok(["mesh", "add-peer", a.addr])
    await c.start()
    const refused = await until(async () => (await c.live())?.mesh?.peers.find((peer) => peer.addr === a.addr && peer.last_error), "c refused by laptop")
    expect(refused.connected).toBe(false)
    expect(await a.linkedTo("other")).toBe(false)
    expect(await a.listed("me/other/intruder")).toBeUndefined()
    await c.agent("intruder")
    const sent = await c.swarm(["send", "--as", "intruder", "laptop/lead", "let me in"])
    expect(sent.code).not.toBe(0)
    await c.stop()
  })

  test("a disabled mesh opens no port and dials nothing, while the broker keeps working locally", async () => {
    await b.ok(["mesh", "off"])
    await b.start()
    await until(async () => !(await a.linkedTo("vm")), "laptop sees vm gone")
    const live = await b.live()
    expect(live?.mesh).toBeUndefined()
    const listening = await new Promise<boolean>((resolve) => {
      const socket = connect(b.port, "127.0.0.1")
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
    })
    expect(listening).toBe(false)
    await b.ok(["whoami", "--as", "quiet"])
    await b.ok(["send", "--as", "solo", "quiet", "local only"])
    const inbox = await b.json<Inbox>(["inbox", "--as", "quiet"])
    expect(inbox.messages.map((message) => message.body.text)).toContain("local only")
  })
})
