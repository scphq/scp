import { type ChildProcess, spawn } from "node:child_process"
import { constants } from "node:os"
import { handbackOutput } from "@scp-dev/core"

const RUNNER_STDOUT_BYTES = 4096
const RUNNER_STDERR_BYTES = 2048
const RUNNER_DRAIN_MS = 500

/** a pipe's last `bytes` bytes, and whether earlier ones were dropped */
function tail(from: NodeJS.ReadableStream, bytes: number): { text: () => string; cut: () => boolean } {
  let kept = Buffer.alloc(0)
  let cut = false
  from.on("data", (chunk: Buffer) => {
    kept = Buffer.concat([kept, chunk])
    if (kept.length > bytes) {
      kept = kept.subarray(kept.length - bytes)
      cut = true
    }
  })
  return { text: () => kept.toString("utf8"), cut: () => cut }
}

/** Run a runner detached with the request on stdin; its exit code (124 on timeout), its stdout and its cleaned stderr tail. */
export function runRunner(
  runner: { command: string[]; timeout_s: number },
  request: object,
  env: Record<string, string | undefined>,
  cwd: string,
  killSignal: NodeJS.Signals = "SIGTERM",
): Promise<{ code: number; timedOut: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const deadline = Date.now() + runner.timeout_s * 1000
    let child: ChildProcess
    try {
      child = spawn(runner.command[0]!, runner.command.slice(1), { detached: true, stdio: ["pipe", "pipe", "pipe"], env, cwd })
    } catch (error) {
      resolve({
        code: 126,
        timedOut: false,
        stdout: "",
        stderr: handbackOutput(error instanceof Error ? error.message : String(error), false, RUNNER_STDERR_BYTES),
      })
      return
    }
    const out = tail(child.stdout!, RUNNER_STDOUT_BYTES)
    const err = tail(child.stderr!, RUNNER_STDERR_BYTES)
    const pipes = [child.stdout!, child.stderr!]
    let settled = false
    const finish = (code: number, timedOut = false, message?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const done = () => {
        for (const pipe of pipes) pipe.destroy()
        child.unref()
        const stderr = handbackOutput(message ?? err.text(), message ? false : err.cut(), RUNNER_STDERR_BYTES)
        resolve({ code, timedOut, stdout: out.cut() ? "" : out.text(), stderr })
      }
      const open = pipes.filter((pipe) => !pipe.readableEnded)
      if (!open.length || message || timedOut) return done()
      const drain = setTimeout(done, Math.max(0, Math.min(RUNNER_DRAIN_MS, deadline - Date.now())))
      let left = open.length
      for (const pipe of open)
        pipe.once("end", () => {
          if (--left > 0) return
          clearTimeout(drain)
          done()
        })
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, killSignal)
      } catch {}
      finish(124, true)
    }, runner.timeout_s * 1000)
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ENOENT" ? 127 : 126, false, `${runner.command[0]}: ${error.code === "ENOENT" ? "command not found" : error.message}`),
    )
    child.once("exit", (code, signal) => finish(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)))
    child.stdin!.on("error", () => {})
    child.stdin!.end(`${JSON.stringify(request)}\n`)
  })
}
