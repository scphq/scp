import { afterEach, describe, expect, test } from "bun:test"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrokerRunning, brokerLockHeld, releaseBrokerLock, takeBrokerLock } from "./lock"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})

function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), "relay-lock-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return join(root, "broker.lock")
}

const now = () => Math.floor(Date.now() / 1000)

describe("broker lock", () => {
  test("names this process as pid:started, and is gone once released", () => {
    const path = lockPath()
    const lock = takeBrokerLock(path)
    expect(readFileSync(path, "utf8")).toMatch(new RegExp(`^${process.pid}:\\d+$`))
    expect(brokerLockHeld(path)).toBe(true)
    releaseBrokerLock(lock)
    expect(existsSync(path)).toBe(false)
    expect(brokerLockHeld(path)).toBe(false)
  })

  test("a lock naming a dead pid is taken over", () => {
    const path = lockPath()
    const dead = spawnSync("true").pid
    writeFileSync(path, `${dead}:${now()}`)
    expect(brokerLockHeld(path)).toBe(false)
    const lock = takeBrokerLock(path)
    expect(readFileSync(path, "utf8").split(":")[0]).toBe(String(process.pid))
    releaseBrokerLock(lock)
  })

  test("a lock naming a live pid refuses, and stays", () => {
    const path = lockPath()
    const child: ChildProcess = spawn("sleep", ["30"], { stdio: "ignore" })
    cleanups.push(() => void child.kill())
    writeFileSync(path, `${child.pid}:${now()}`)
    expect(brokerLockHeld(path)).toBe(true)
    expect(() => takeBrokerLock(path)).toThrow(BrokerRunning)
    expect(() => takeBrokerLock(path)).toThrow(`a relay broker already runs (pid ${child.pid})`)
    expect(readFileSync(path, "utf8")).toBe(`${child.pid}:${now()}`)
  })

  test("a lock taken before this boot is stale even when its pid runs again", () => {
    const path = lockPath()
    writeFileSync(path, `${process.pid}:0`)
    expect(brokerLockHeld(path)).toBe(false)
    releaseBrokerLock(takeBrokerLock(path))
  })

  test("releasing leaves a lock another broker took over in place", () => {
    const path = lockPath()
    const lock = takeBrokerLock(path)
    writeFileSync(path, `${process.pid}:${now() + 1}`)
    releaseBrokerLock(lock)
    expect(existsSync(path)).toBe(true)
  })
})
