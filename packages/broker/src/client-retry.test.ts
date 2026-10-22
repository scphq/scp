import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, spyOn, test } from "bun:test"
import { BrokerUnavailable, connectBroker, RelayClient, RETRY_MAX_MS, RETRY_MIN_MS, retryDelay } from "./client"
import { privateDir } from "./paths"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

test("the pause between tries starts at RETRY_MIN_MS, doubles to RETRY_MAX_MS and never passes what is left", () => {
  expect([0, 1, 2, 3, 4, 8].map((attempt) => retryDelay(attempt, 10_000, () => 0))).toEqual([50, 100, 200, 400, 400, 400])
  for (let attempt = 0; attempt < 10; attempt++) {
    const delay = retryDelay(attempt, 10_000, () => 0.999)
    expect(delay).toBeGreaterThanOrEqual(RETRY_MIN_MS)
    expect(delay).toBeLessThanOrEqual(RETRY_MAX_MS)
  }
  expect(retryDelay(3, 120, () => 0.5)).toBe(120)
  expect(retryDelay(0, -5)).toBe(0)
})

test("a running broker that refuses is retried with backoff inside the budget, then reported busy", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-retry-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dir = privateDir(join(root, "state"))
  writeFileSync(join(dir, "broker.lock"), `${process.pid}:${Math.floor(Date.now() / 1000)}`, { mode: 0o600 })
  const tries: number[] = []
  const connect = spyOn(RelayClient, "connect").mockImplementation(() => {
    tries.push(Date.now())
    return Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))
  })
  cleanups.push(() => connect.mockRestore())
  const budget = 700
  const began = Date.now()
  const error = await connectBroker(dir, undefined, { budgetMs: budget }).catch((e: unknown) => e)
  const elapsed = Date.now() - began
  expect(error).toBeInstanceOf(BrokerUnavailable)
  expect((error as BrokerUnavailable).busy).toBe(true)
  expect(elapsed).toBeGreaterThanOrEqual(budget)
  expect(elapsed).toBeLessThan(budget + 100)
  const gaps = tries.slice(1).map((at, i) => at - tries[i]!)
  expect(gaps.length).toBeGreaterThanOrEqual(3)
  expect(gaps.length).toBeLessThanOrEqual(6)
  for (const gap of gaps.slice(0, -1)) expect(gap).toBeGreaterThanOrEqual(RETRY_MIN_MS - 5)
})
