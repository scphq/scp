import { dlopen, FFIType } from "bun:ffi"
import { closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, statSync, writeSync } from "node:fs"

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

let flockSymbol: ((fd: number, operation: number) => number) | undefined

function flock(fd: number, operation: number): number {
  if (!flockSymbol) {
    const libraries = ["libSystem.B.dylib", "libc.so.6", "libc.so"]
    if (process.platform !== "darwin") libraries.push(libraries.shift()!)
    for (const library of libraries) {
      try {
        flockSymbol = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock
        break
      } catch {}
    }
    if (!flockSymbol) throw new Error("the broker cannot take file locks on this platform")
  }
  return flockSymbol(fd, operation)
}

export class BrokerRunning extends Error {}

/** the broker's single-instance lock, without waiting: a second broker gets BrokerRunning */
export function takeBrokerLock(path: string): number {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600)
  let held = false
  try {
    held = flock(fd, LOCK_EX | LOCK_NB) === 0
    const current = held ? statSync(path, { throwIfNoEntry: false }) : undefined
    const mine = fstatSync(fd)
    if (current && current.ino === mine.ino && current.dev === mine.dev) {
      ftruncateSync(fd, 0)
      writeSync(fd, `${process.pid}:${Math.floor(Date.now() / 1000)}`, 0)
      return fd
    }
  } catch (error) {
    if (held) flock(fd, LOCK_UN)
    closeSync(fd)
    throw error
  }
  if (held) flock(fd, LOCK_UN)
  closeSync(fd)
  let holder = ""
  try {
    holder = readFileSync(path, "utf8").split(":")[0] ?? ""
  } catch {}
  throw new BrokerRunning(`a relay broker already runs${/^\d+$/.test(holder) ? ` (pid ${holder})` : ""}`)
}

/** whether a broker holds the lock at `path` right now; undefined when the file cannot be opened */
export function brokerLockHeld(path: string): boolean | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY)
  } catch {
    return undefined
  }
  try {
    if (flock(fd, LOCK_EX | LOCK_NB) !== 0) return true
    flock(fd, LOCK_UN)
    return false
  } finally {
    closeSync(fd)
  }
}

export function releaseBrokerLock(fd: number): void {
  flock(fd, LOCK_UN)
  closeSync(fd)
}
