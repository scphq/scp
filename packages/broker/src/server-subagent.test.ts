import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RelayClient } from "./client"
import { type Broker, startBroker } from "./server"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const key = (pid: number) => `pid:${pid}:Fri-Oct-17-09:00:00-2026`

async function open(broker: Broker) {
  const client = await RelayClient.connect(broker.socket)
  cleanups.push(() => client.close())
  return client
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "relay-sub-"))
  const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0 })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => broker.stop())
  const claim = { handle: "claude-app", harness: "claude-code", session: key(1), process: key(1), lineage: [key(1)] }
  const main = await open(broker)
  await main.hello({ claim })
  return { broker, main, claim }
}

describe("broker, subagent endpoints", () => {
  test("a hook's subagent hello lands on a child of the root, said so once it is made; a --as of it from the root's shell binds it as itself", async () => {
    const { broker, main, claim } = await setup()
    const first = await (await open(broker)).hello({ transient: true, claim: { ...claim, subagent: { id: "aceb553c19f223c70", type: "Explore" } } })
    expect(first).toMatchObject({ subagent: true, created: true, endpoint: { address: "me/claude-app-explore-aceb", parent: "me/claude-app", depth: 1 } })
    const again = await (await open(broker)).hello({ transient: true, claim: { ...claim, subagent: { id: "aceb553c19f223c70", type: "Explore" } } })
    expect(again.subagent).toBe(true)
    expect(again.created).toBeUndefined()
    const shell = await open(broker)
    const bound = await shell.hello({
      claim: { handle: "claude-app-explore-aceb", exact: true, harness: "cli", lineage: [key(40), key(1)] },
      self: [key(40), key(1)],
      brief: true,
    })
    expect(bound.endpoint?.address).toBe("me/claude-app-explore-aceb")
    expect(bound.token).toBeUndefined()
    await main.request("send", { to: "claude-app-explore-aceb", body: "for you" })
    const { messages } = await shell.request<{ messages: { body: { text: string } }[] }>("inbox", {})
    expect(messages.map((m) => m.body.text)).toEqual(["for you"])
  })

  test("--as over the wire: the root and its --as child from the root's shells keep their state; from a spawned harness's shell the child resets", async () => {
    const { broker, main } = await setup()
    const resets = () =>
      broker.core
        .log({ scope: true })
        .filter((row) => row.event === "scope_reset")
        .map((row) => row.detail.target)
    const as = async (handle: string, lineage: number[], harness = 1) => {
      const shell = await open(broker)
      const hello = await shell.hello({
        claim: { handle, exact: true, harness: "cli", lineage: lineage.map(key) },
        self: lineage.slice(0, harness + 1).map(key),
        brief: true,
      })
      shell.close()
      return hello.endpoint?.address
    }
    expect(await as("claude-app", [40, 1])).toBe("me/claude-app")
    expect(await as("kid", [41, 1])).toBe("me/kid")
    await Bun.sleep(50)
    expect(await as("kid", [42, 1])).toBe("me/kid")
    expect(await as("claude-app", [43, 1])).toBe("me/claude-app")
    expect(resets()).toEqual([])
    await Bun.sleep(50)
    expect(await as("kid", [44, 20, 15, 1])).toBe("me/kid")
    expect(resets()).toEqual(["me/kid"])
    main.close()
  })

  test("the subagent's hook re-claims its endpoint after the subagent's own --as from its shell: same endpoint, its state and messages, no reset", async () => {
    const { broker, main, claim } = await setup()
    const sub = { ...claim, subagent: { id: "aceb553c19f223c70", type: "Explore" } }
    const first = await (await open(broker)).hello({ transient: true, claim: sub })
    const shell = await open(broker)
    const bound = await shell.hello({
      claim: { handle: "claude-app-explore-aceb", exact: true, harness: "cli", lineage: [key(40), key(1)] },
      self: [key(40), key(1)],
      brief: true,
    })
    expect(bound.endpoint?.id).toBe(first.endpoint!.id)
    await shell.request("status", { state: "waiting", note: "from the shell" })
    shell.close()
    await main.request("send", { to: "claude-app-explore-aceb", body: "after the shell" })
    const hook = await open(broker)
    const again = await hook.hello({ transient: true, claim: sub })
    expect(again).toMatchObject({ subagent: true, endpoint: { id: first.endpoint!.id, status: { state: "waiting", note: "from the shell" } } })
    expect(again.created).toBeUndefined()
    const injected = await hook.request<{ messages: { body: { text: string } }[] }>("inject", {})
    expect(injected.messages.map((m) => m.body.text)).toEqual(["after the shell"])
    expect(broker.core.log({ scope: true }).filter((row) => row.event === "scope_reset")).toEqual([])
    expect(
      broker.core
        .list({ all: true })
        .filter((e) => e.kind === "agent")
        .map((e) => e.address)
        .sort(),
    ).toEqual(["me/claude-app", "me/claude-app-explore-aceb"])
  })

  test("a parent hook's subagent_title names the subagent before or after its endpoint exists; a renamed root's new subagents carry its new name", async () => {
    const { broker, main, claim } = await setup()
    const parent = await open(broker)
    await parent.hello({ transient: true, claim })
    expect(await parent.request("subagent_title", { id: "f00d42", title: "Review the parser" })).toEqual({ changed: false })
    const first = await (await open(broker)).hello({ transient: true, claim: { ...claim, subagent: { id: "f00d42", type: "Explore" } } })
    expect(first.endpoint).toMatchObject({ address: "me/claude-app-explore-f00d", title: "Review the parser" })
    await main.request("rename", { handle: "lead" })
    const second = await (await open(broker)).hello({ transient: true, claim: { ...claim, subagent: { id: "aceb553c19f223c70", type: "general-purpose" } } })
    expect(second.endpoint?.address).toBe("me/lead-gp-aceb")
    expect(await parent.request("subagent_title", { id: "aceb553c19f223c70", title: "Map the broker" })).toEqual({ changed: true })
    expect(broker.core.whoami(second.endpoint!.id).title).toBe("Map the broker")
  })

  test("a subagent hello from another process is refused", async () => {
    const { broker, claim } = await setup()
    const other = await open(broker)
    await expect(other.hello({ transient: true, claim: { ...claim, process: key(2), subagent: { id: "aceb553c19f223c70" } } })).rejects.toMatchObject({
      code: "unauthorized",
    })
  })

  test("a message to a stopped subagent wakes the root's waker, tagged for the subagent; other connections of the root are not offered it", async () => {
    const { broker, main, claim } = await setup()
    expect(await main.request("wake", { via: "channels" })).toEqual({ changed: true })
    const hook = await open(broker)
    const sub = await hook.hello({ transient: true, claim: { ...claim, subagent: { id: "aceb553c19f223c70", type: "Explore" } } })
    await hook.request("status", { state: "done" })
    expect(broker.core.whoami(sub.endpoint!.id).wake).toBe("channels")
    const peer = await open(broker)
    await peer.hello({ claim: { handle: "peer", harness: "codex" } })
    const waiting = main.request<{ messages: { body: { text: string }; for?: { address: string; subagent: string } }[] }>("inbox", {
      wait_s: 5,
      offer: true,
    })
    await Bun.sleep(50)
    const started = Date.now()
    await peer.request("send", { to: sub.endpoint!.address, body: "one more thing" })
    const { messages } = await waiting
    expect(Date.now() - started).toBeLessThan(2000)
    expect(messages).toMatchObject([{ body: { text: "one more thing" }, for: { address: "me/claude-app-explore-aceb", subagent: "aceb553c19f223c70" } }])
    const other = await open(broker)
    await other.hello({ claim: { ...claim, handle: "claude-app", exact: true }, self: [key(1)] })
    await peer.request("send", { to: sub.endpoint!.address, body: "and another" })
    expect((await other.request<{ messages: unknown[] }>("inbox", { offer: true })).messages).toEqual([])
    const again = await main.request<{ messages: { body: { text: string } }[] }>("inbox", { offer: true })
    expect(again.messages.map((m) => m.body.text)).toEqual(["and another"])
  })
})
