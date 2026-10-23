import type { LocalAgent } from "@scp-dev/core"

/** what a broker task may read and do: local agents only, acting as the broker */
export interface BrokerTaskContext {
  agents(): LocalAgent[]
  /** marks a local agent hibernated by `provider` with `ref`, audited `{by: "broker"}`, and runs its waker when one is due */
  hibernate(endpoint: string, provider: string, ref: string | null): void
  unhibernate(endpoint: string): void
  /** runs the endpoint's waker when one is due */
  kick(endpoint: string): void
  log(line: string): void
}

/** an in-process task the broker runs every `everyMs`, never two runs of it at once */
export interface BrokerTask {
  name: string
  everyMs: number
  run(context: BrokerTaskContext): Promise<void>
}

export interface Tasks {
  stop(): void
}

/** schedules each task on its own unref'd interval; a run that throws is logged, a tick while the last run is in flight is skipped */
export function startTasks(tasks: BrokerTask[], context: BrokerTaskContext): Tasks {
  const timers: ReturnType<typeof setInterval>[] = []
  let stopped = false
  for (const task of tasks) {
    let running = false
    const tick = () => {
      if (running || stopped) return
      running = true
      Promise.resolve()
        .then(() => task.run(context))
        .catch((error: unknown) => context.log(`relay broker: task ${task.name} failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          running = false
        })
    }
    const timer = setInterval(tick, Math.max(1, task.everyMs))
    timer.unref?.()
    timers.push(timer)
  }
  return {
    stop() {
      stopped = true
      for (const timer of timers) clearInterval(timer)
    },
  }
}
