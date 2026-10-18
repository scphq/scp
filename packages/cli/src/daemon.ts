import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { capture } from "./term"

/** the pid in the broker lock of `dir` when that process runs a broker, else null */
export function brokerPid(dir: string): number | null {
  let pid: number
  try {
    pid = Number(readFileSync(join(dir, "broker.lock"), "utf8").split(":")[0])
  } catch {
    return null
  }
  if (!Number.isInteger(pid) || pid <= 0) return null
  const command = capture(["ps", "-p", String(pid), "-o", "command="])?.trim() ?? ""
  return /(^|\s)daemon(\s|$)/.test(command) && (/scp|swarm/.test(command) || command.includes(process.argv[1] ?? "\0")) ? pid : null
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM"
  }
}

/** waits up to `ms` for `pid` to exit; whether it did */
export async function exited(pid: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (alive(pid)) {
    if (Date.now() >= deadline) return false
    await sleep(50)
  }
  return true
}

/** stops the broker of `dir` with SIGTERM and waits for it; its pid, or null when none ran */
export async function stopBroker(dir: string): Promise<number | null> {
  const pid = brokerPid(dir)
  if (pid === null) return null
  try {
    process.kill(pid, "SIGTERM")
  } catch (error) {
    if ((error as { code?: unknown }).code === "ESRCH") return null
    throw error
  }
  if (!(await exited(pid))) throw new Error(`the relay broker (pid ${pid}) did not stop within 5 s`)
  return pid
}
