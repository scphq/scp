import { randomBytes } from "node:crypto"
import { closeSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { uptime } from "node:os"

export class BrokerRunning extends Error {}

/** a held broker lock: the file and the `pid:started` line this process wrote to it */
export interface BrokerLock {
  path: string
  content: string
}

const ATTEMPTS = 8
/** how far before this boot a lock may claim to start and still count, for clock steps at boot */
const BOOT_SLACK_S = 60

function readLock(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** whether the process a lock line names runs (one of another user's counts too) and took the lock since this boot */
function holderAlive(content: string): boolean {
  const [pid, started] = content.split(":").map(Number)
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false
  if (started !== undefined && Number.isFinite(started) && started < Date.now() / 1000 - uptime() - BOOT_SLACK_S) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

/** moves a stale lock aside, and back when it turns out another broker had replaced it with a live one meanwhile */
function clearStale(path: string, stale: string): void {
  const aside = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`
  try {
    renameSync(path, aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  try {
    if (readLock(aside) !== stale) linkSync(aside, path)
  } catch {}
  try {
    unlinkSync(aside)
  } catch {}
}

const held = new Set<BrokerLock>()
let exitHook = false

/** the broker's single-instance lock, without waiting: a second broker gets BrokerRunning, a dead broker's lock is taken over */
export function takeBrokerLock(path: string): BrokerLock {
  const content = `${process.pid}:${Math.floor(Date.now() / 1000)}`
  let holder: string | undefined
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let fd: number
    try {
      fd = openSync(path, "wx", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      holder = readLock(path)
      if (holder === undefined) continue
      if (holderAlive(holder)) break
      clearStale(path, holder)
      continue
    }
    try {
      writeSync(fd, content, 0)
    } catch (error) {
      unlinkSync(path)
      throw error
    } finally {
      closeSync(fd)
    }
    const lock = { path, content }
    held.add(lock)
    if (!exitHook) {
      exitHook = true
      process.on("exit", () => {
        for (const lock of held) releaseBrokerLock(lock)
      })
    }
    return lock
  }
  const pid = holder?.split(":")[0] ?? ""
  throw new BrokerRunning(`a relay broker already runs${/^\d+$/.test(pid) ? ` (pid ${pid})` : ""}`)
}

/** whether a live broker holds the lock at `path`; undefined when the file cannot be read */
export function brokerLockHeld(path: string): boolean | undefined {
  try {
    const content = readLock(path)
    return content !== undefined && holderAlive(content)
  } catch {
    return undefined
  }
}

/** removes the lock file, unless another broker took it over meanwhile */
export function releaseBrokerLock(lock: BrokerLock): void {
  if (!held.delete(lock)) return
  try {
    if (readLock(lock.path) === lock.content) unlinkSync(lock.path)
  } catch {}
}
