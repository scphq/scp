import { spawnSync } from "node:child_process"
import { CLI_NAME } from "@scp-dev/core"

/** exit code for swarm's own failures, kept apart from a spawned harness's codes */
export const FAILED = 125

/** this CLI as a command line, to start the broker or a child under the same runtime */
export const SELF: string[] = [process.execPath, ...(process.versions.bun ? ["--no-env-file", "--config=/dev/null"] : []), process.argv[1]!]

/** a short command's stdout, or undefined when it cannot run or exits non-zero */
export function capture(argv: string[], env?: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...(env ? { env } : {}) })
  return result.status === 0 ? result.stdout : undefined
}

export function note(message: string): void {
  process.stderr.write(`${message.startsWith(`${CLI_NAME} `) ? "" : `${CLI_NAME}: `}${message}\n`)
}

/**
 * process.exit drops what a pipe has not taken yet, and an empty write's callback does not wait for it under Bun, so the streams
 * are ended first; a reader that never drains them gets at most `waitMs`
 */
export async function exitFlushed(code: number, waitMs = 10_000): Promise<never> {
  const ended = (stream: NodeJS.WriteStream) =>
    new Promise<void>((resolve) => {
      try {
        stream.end(() => resolve())
      } catch {
        resolve()
      }
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([Promise.all([ended(process.stdout), ended(process.stderr)]), new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))])
  clearTimeout(timer)
  process.exit(code)
}

export function printTable(rows: string[][]): void {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  for (const row of rows)
    console.log(
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
}

const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g
const DURATION_UNITS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }

/** `90s`, `30m`, `1h30m`; a bare number is seconds. Whole seconds out, at least one. */
export function parseSeconds(text: string, flag: string): number {
  const trimmed = text.trim()
  let seconds: number
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) seconds = Number(trimmed)
  else {
    seconds = 0
    let consumed = ""
    for (const match of trimmed.matchAll(DURATION_PART)) {
      seconds += Number(match[1]) * DURATION_UNITS[match[2]!]!
      consumed += match[0]
    }
    if (consumed !== trimmed || consumed === "") {
      throw new Error(`${flag} ${JSON.stringify(text)} is not a duration like 90s, 30m or 1h30m`)
    }
  }
  if (!(seconds > 0)) throw new Error(`${flag} must be more than zero`)
  return Math.max(1, Math.ceil(seconds))
}
