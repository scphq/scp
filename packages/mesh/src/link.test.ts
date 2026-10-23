import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { RelayError, type SendParams, type Sql, type SqlValue } from "@scp-dev/core"
import { FederatedCore } from "@scp-dev/hub"
import { generateKeyPair } from "./keys"
import { startMesh } from "./link"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup() {
  const db = new Database(":memory:")
  cleanups.push(() => db.close())
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new FederatedCore(sql, {
    machine: "a",
    hash: (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: (fn) => db.transaction(fn)(),
  })
  core.migrate()
  const sender = core.claim({ handle: "impl", harness: "test" }).endpoint.id
  const local = core.claim({ handle: "local", harness: "test" }).endpoint.id
  core.mirror("b", [{ address: "me/review", kind: "agent", harness: "test", presence: "online", parent_ep: null, depth: 0 }])
  const link = startMesh({
    core,
    hooks: { wake: () => {}, fleet: () => {}, policyError: () => null },
    send: async (from, params, origin) => core.send(from, params, origin),
    config: { v: 1, enabled: true, account: "team", machine: "a", listen: null, peers: [] },
    account: { ...generateKeyPair(), v: 1, account: "team" },
    machineKey: generateKeyPair(),
  })
  cleanups.push(() => link.stop())
  return { core, sender, local, link }
}

async function code(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (error instanceof RelayError) return error.code
    throw error
  }
  return undefined
}

test("sender checks run before requiring a direct link", async () => {
  const { core, sender, link } = setup()
  expect(await link.listening()).toBeNull()
  expect(core.route("team/b/review")).toBe("b/review")
  expect(await code(link.forward(sender, { to: "other/b/review", body: "outside" }))).toBe("not_found")
  for (const to of [[], ["b/review", "c/review"], ["local", "b/review"], ["local"]]) {
    expect(await code(link.forward(sender, { to, body: "split" }))).toBe("invalid_params")
  }
  expect(await code(link.forward(sender, { to: "b/review", body: 1 } as unknown as SendParams))).toBe("invalid_params")
  expect(await code(link.forward(sender, { to: "b/review", body: "private", data_class: "private" }))).toBe("data_class_refused")
  const credential = `scp_${"z".repeat(24)}`
  expect(await code(link.forward(sender, { to: "b/review", body: credential }))).toBe("secret_refused")
  expect(await code(link.forward(sender, { to: "b/review", body: "path", attachments: [{ kind: "path", path: credential }] }))).toBe("secret_refused")
  expect(await code(link.forward(sender, { to: "b/review", body: "disconnected" }))).toBe("unavailable")
  expect(await code(link.contacts())).toBe("unavailable")
})

test("a recorded forward stays idempotent without a link", async () => {
  const { core, sender, local, link } = setup()
  const params = { to: "b/review", body: "once", client_id: "once" }
  const result = core.send(local, { to: "impl", body: "receipt" })
  core.recordForward(sender, params, result)
  expect(await link.forward(sender, params)).toEqual({ ...result, duplicate: true })
  expect(await code(link.forward(sender, { ...params, body: "changed" }))).toBe("invalid_params")
})

test("stopping cancels scheduled rebuilds and is repeatable", async () => {
  const { sender, link } = setup()
  link.changed(sender)
  link.resync()
  const stopping = link.stop()
  expect(link.stop()).toBe(stopping)
  await stopping
  expect(link.status()).toMatchObject({ enabled: true, machine: "a", url: "mesh", connected: false, mesh: { listen: null, links: [], peers: [] } })
})
