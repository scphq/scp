import { setTimeout } from "node:timers/promises"

export async function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 10_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await setTimeout(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
