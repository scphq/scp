import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { constants } from "node:os"
import { CLI_NAME, findSecret, handbackOutput, LIMITS, validHandle } from "@scp-dev/core"
import { connectBroker, policyPath, relayDir } from "@scp-dev/broker"
import { type Identity, localClient, type Option, open, RelayUsage, startDaemon, type Values } from "./common"
import { labelsFor, normalizeHarness, parseLabels } from "./identity"
import {
  agentShell,
  closedStdin,
  type HarnessRun,
  harnessArgv,
  harnessOutput,
  harnessStdin,
  programAt,
  runHarness,
  STDIN_WAIT_MS,
  spawnEnvironment,
  spawnTitle,
  stderrOutput,
  workerName,
} from "./spawn"
import { note } from "./term"

type Env = Record<string, string | undefined>

export interface Runner {
  command: string[]
  timeout_s: number
}

/** what a runner reads on stdin: one JSON line */
export interface SpawnRequest {
  scp: 1
  event: "spawn"
  name: string
  title: string | null
  cmd: string[]
  cwd: string
  parent: string
  labels: Record<string, string>
  join: { under: string; name: string; mode: "account" }
}

export const RUNNER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
export const RUNNER_TIMEOUT_S = 60
const RUNNER_TIMEOUT_MAX_S = 3600
/** how much of a failed runner's stderr spawn shows */
const RUNNER_STDERR_BYTES = 2048
/** how much of a runner's stdout spawn reads for its reply */
const RUNNER_STDOUT_BYTES = 4096
/** a runner's opaque reference to the worker it started */
const RUNNER_REF = /^[\x21-\x7e]{1,256}$/
/** a command line or URL that opens the worker's terminal: one line without control characters */
const RUNNER_ATTACH = /^[^\u0000-\u001f\u007f-\u009f]{1,1024}$/
/** how long a runner's stderr may still drain after it exits */
const RUNNER_DRAIN_MS = 500
const TITLE_CHARS = 64
const MACHINE = "[a-z0-9][a-z0-9-]{0,31}"
/** an agent on a named machine of this account */
const MACHINE_ADDRESS = new RegExp(`^me/(${MACHINE})/([^/]+)$`)
const STDERR_LABEL = `stderr (last ${LIMITS.stderrBytes / 1024} KB):`

/** the flags `spawn --via` takes */
const VIA_FLAGS: Option[] = ["as", "harness", "name", "title", "labels", "bg", "json", "via"]
/** the flags of a grant, which a worker linked under an agent on another machine runs without */
const GRANT_FLAGS: Option[] = ["scope", "rules", "in", "out", "allow", "group", "ttl", "peek", "no-push", "idle", "durable", "as", "human", "harness"]

/** `$SCP_RUNNERS_FILE`, else runners.json beside the policy file */
export function runnersPath(env: Env = process.env): string {
  return env.SCP_RUNNERS_FILE || join(dirname(policyPath()), "runners.json")
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** `{"<runner>": {"command": [argv...], "timeout_s"?: N}}` */
export function parseRunners(text: string, path: string): Record<string, Runner> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new RelayUsage(`${path} is not JSON`)
  }
  if (!isObject(value)) throw new RelayUsage(`${path} maps runner names to {command, timeout_s?}`)
  const runners: Record<string, Runner> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (!RUNNER_NAME.test(name))
      throw new RelayUsage(`${path}: runner ${JSON.stringify(name)} is not a valid name: lowercase letters, digits and -, at most 32`)
    const command = isObject(entry) ? entry.command : undefined
    if (!Array.isArray(command) || !command.length || !command.every((word) => typeof word === "string" && word.length > 0))
      throw new RelayUsage(`${path}: runner ${name} needs command, a non-empty list of words`)
    const timeout = (entry as Record<string, unknown>).timeout_s ?? RUNNER_TIMEOUT_S
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > RUNNER_TIMEOUT_MAX_S)
      throw new RelayUsage(`${path}: runner ${name}'s timeout_s is whole seconds, 1 to ${RUNNER_TIMEOUT_MAX_S}`)
    runners[name] = { command: [...(command as string[])], timeout_s: timeout }
  }
  return runners
}

/** the configured runners, none when the file is missing */
export function readRunners(path: string = runnersPath()): Record<string, Runner> {
  return existsSync(path) ? parseRunners(readFileSync(path, "utf8"), path) : {}
}

export function runnerFor(name: string, runners: Record<string, Runner>, path: string): Runner {
  const runner = Object.hasOwn(runners, name) ? runners[name] : undefined
  if (runner) return runner
  const known = Object.keys(runners)
  throw new RelayUsage(`no runner ${JSON.stringify(name)} in ${path}: ${known.length ? `configured: ${known.join(", ")}` : "none is configured"}`)
}

export function spawnRequest(o: {
  name: string
  title: string | null
  command: string[]
  cwd: string
  parent: string
  labels: Record<string, string>
}): SpawnRequest {
  return {
    scp: 1,
    event: "spawn",
    name: o.name,
    title: o.title,
    cmd: o.command,
    cwd: o.cwd,
    parent: o.parent,
    labels: o.labels,
    join: { under: o.parent, name: o.name, mode: "account" },
  }
}

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
  runner: Runner,
  request: SpawnRequest,
  env: Record<string, string>,
): Promise<{ code: number; timedOut: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(runner.command[0]!, runner.command.slice(1), { detached: true, stdio: ["pipe", "pipe", "pipe"], env, cwd: request.cwd })
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
        const stderr = message ?? handbackOutput(err.text(), err.cut(), RUNNER_STDERR_BYTES)
        resolve({ code, timedOut, stdout: out.cut() ? "" : out.text(), stderr })
      }
      const open = pipes.filter((pipe) => !pipe.readableEnded)
      if (!open.length || message) return done()
      const drain = setTimeout(done, RUNNER_DRAIN_MS)
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
        process.kill(-child.pid!, "SIGTERM")
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

export interface RunnerReply {
  address: string
  machine: string
  ref?: string
  attach?: string
}

/** the runner's optional stdout object `{address, machine, ref?, attach?}`; undefined when absent or invalid, a field that looks like a credential dropped */
export function runnerReply(stdout: string, name: string): RunnerReply | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout.trim())
  } catch {
    return undefined
  }
  if (!isObject(value) || typeof value.machine !== "string" || typeof value.address !== "string") return undefined
  const address = MACHINE_ADDRESS.exec(value.address)
  if (!address || address[1] !== value.machine || address[2] !== name) return undefined
  if (value.ref !== undefined && (typeof value.ref !== "string" || !RUNNER_REF.test(value.ref))) return undefined
  if (value.attach !== undefined && (typeof value.attach !== "string" || !RUNNER_ATTACH.test(value.attach))) return undefined
  const ref = typeof value.ref === "string" && !findSecret(value.ref) ? value.ref : undefined
  const attach = typeof value.attach === "string" && !findSecret(value.attach) ? value.attach : undefined
  return { address: value.address, machine: value.machine, ...(ref ? { ref } : {}), ...(attach ? { attach } : {}) }
}

/** what `spawn --via` prints once the runner started the worker */
export function viaStarted(o: { name: string; runner: string; parent: string; reply: RunnerReply | undefined; json: boolean }): string[] {
  if (o.json) return [JSON.stringify({ name: o.name, runner: o.runner, parent: o.parent, ...o.reply })]
  const where = o.reply
    ? `on machine ${o.reply.machine} and shows under you as ${o.reply.address}`
    : `on another machine and shows under you as me/<machine>/${o.name}`
  return [
    `${o.name} handed to runner ${o.runner}: it starts ${where}; its result arrives as a relay message by itself`,
    ...(o.reply?.attach ? [`attach: ${o.reply.attach}`] : []),
  ]
}

/** `--name`, else the default worker name, as a valid handle */
function spawnName(values: Values, command: string[]): string {
  const name = typeof values.name === "string" ? values.name.replace(/^me\//, "") : workerName(command)
  if (!validHandle(name)) throw new RelayUsage(`--name ${JSON.stringify(name)} is not a valid agent handle: lowercase letters, digits, . _ -`)
  return name
}

/** this broker's machine on the hub, refusing when the broker is not linked to one */
async function hubMachine(client: { request<T>(method: string, params?: object): Promise<T> }, why: string): Promise<string> {
  const bridge = await client.request<{ enabled: boolean; machine?: string }>("cloud_status")
  if (!bridge.enabled || !bridge.machine)
    throw new RelayUsage(`${why}, but this relay broker is not linked to a hub (${CLI_NAME} login, then ${CLI_NAME} cloud enable)`)
  return bridge.machine
}

/** `swarm spawn --via <runner>`: hand the spawn to a runner that starts the worker on another machine, linked under the caller */
export async function viaSpawn(values: Values, command: string[], cwd: string, out: (line: string) => void = (line) => console.log(line)): Promise<number> {
  const via = values.via as string
  const extra = (Object.keys(values) as Option[]).find((key) => !VIA_FLAGS.includes(key))
  if (extra)
    throw new RelayUsage(
      `--via starts the worker on another machine under you, without a local grant: it takes --name, --title, --labels and --json, not --${extra}`,
    )
  const path = runnersPath()
  const runner = runnerFor(via, readRunners(path), path)
  const name = spawnName(values, command)
  const title = typeof values.title === "string" ? values.title : (spawnTitle(command) ?? null)
  if (title !== null && title.length > TITLE_CHARS) throw new RelayUsage(`--title is longer than ${TITLE_CHARS} characters`)
  const opened = await open("spawn", values as Identity, cwd, false)
  const client = localClient(opened.client, opened.broker, "spawn")
  let parent: string
  try {
    const me = opened.me
    if (me?.kind !== "agent" || !me.address.startsWith("me/"))
      throw new RelayUsage(`${CLI_NAME} spawn --via starts a worker under you: run it from an agent's session, or name the agent with --as`)
    parent = `me/${await hubMachine(client, `${CLI_NAME} spawn --via shows the worker under you through the hub`)}/${me.address.slice(3)}`
  } finally {
    client.close()
  }
  const request = spawnRequest({ name, title, command, cwd, parent, labels: parseLabels(values.labels as string | undefined) })
  const result = await runRunner(runner, request, spawnEnvironment(process.env, {}))
  if (result.code === 0) {
    for (const line of viaStarted({ name, runner: via, parent, reply: runnerReply(result.stdout, name), json: values.json === true })) out(line)
    return 0
  }
  const failed = result.timedOut ? `did not finish within ${runner.timeout_s} s` : `failed (exit ${result.code})`
  note(`${CLI_NAME} spawn: runner ${via} ${failed}${result.stderr ? `:\n${result.stderr}` : ""}`)
  return result.code
}

export interface LinkedPlan {
  parent: string
  machine: string
  name: string
  title?: string
  labels?: string
}

/** `--under me/<machine>/<handle>` naming an agent on another machine: the linked spawn's plan; null for an agent of this machine */
export async function linkedPlan(values: Values, command: string[]): Promise<LinkedPlan | null> {
  const under = typeof values.under === "string" ? values.under : undefined
  const remote = under === undefined ? null : MACHINE_ADDRESS.exec(under)
  if (!under || !remote) return null
  const dir = relayDir()
  const client = await connectBroker(dir, () => startDaemon(dir))
  let machine: string
  try {
    await client.hello({ observe: true })
    machine = await hubMachine(client, `--under ${under} names an agent on machine ${remote[1]}`)
  } finally {
    client.close()
  }
  if (machine === remote[1]) return null
  if (values.via !== undefined) throw new RelayUsage("--via and --under an agent on another machine: the runner already starts this spawn there")
  const granted = (Object.keys(values) as Option[]).find((key) => GRANT_FLAGS.includes(key))
  if (granted) throw new RelayUsage(`a worker under an agent on another machine runs without a grant: --${granted} does not apply`)
  return {
    parent: under,
    machine,
    name: spawnName(values, command),
    ...(typeof values.title === "string" ? { title: values.title } : {}),
    ...(typeof values.labels === "string" ? { labels: values.labels } : {}),
  }
}

/** the handback a linked worker sends its parent, as section 9.3 words it */
export function linkedHandbackBody(address: string, code: number, output: string, stderr: string): string {
  const tail = code !== 0 && stderr ? `${STDERR_LABEL}\n${stderr}` : ""
  const kept = tail && output ? handbackOutput(output, false, LIMITS.handbackBytes - Buffer.byteLength(tail) - 2) : output
  const head = kept ? `worker ${address} finished (exit ${code})` : `worker ${address} exited without replying (exit ${code})`
  return [head, kept, tail].filter(Boolean).join("\n\n")
}

/** Run the harness as `plan.name` linked under its parent on another machine, then hand its result back as the worker. */
export async function linkedSpawn(
  plan: LinkedPlan,
  command: string[],
  cwd: string,
  options: { group: boolean; started?: (failed?: { message: string; code: number }) => void; bytes?: number },
): Promise<number> {
  const env = spawnEnvironment(process.env, { SCP_NAME: plan.name, SCP_UNDER: plan.parent }, plan.labels)
  const argv = harnessArgv(command, env)
  const stdin = closedStdin(command) ? await harnessStdin(agentShell(process.env) ? STDIN_WAIT_MS : undefined) : undefined
  const run = await runHarness(argv, env, {
    group: options.group,
    ...(closedStdin(argv) ? { stdin: "ignore" as const } : {}),
    ...(options.started ? { started: options.started } : {}),
    ...(stdin ? { stdin } : {}),
  })
  if (run.started) await linkedHandback(plan, command, cwd, env, run, options.bytes)
  return run.code
}

async function linkedHandback(plan: LinkedPlan, command: string[], cwd: string, env: Env, run: HarnessRun, bytes?: number): Promise<void> {
  const harness = normalizeHarness(basename(command[programAt(command)] ?? ""), "cli")
  const dir = relayDir()
  try {
    const client = await connectBroker(dir, () => startDaemon(dir))
    try {
      const hello = await client.hello({ claim: { handle: plan.name, exact: true, harness, cwd, under: plan.parent, labels: labelsFor(env) } })
      const me = hello.endpoint!
      const address = `me/${plan.machine}/${me.address.slice(3)}`
      if (plan.title && !me.title) await client.request("title", { text: plan.title })
      const code = Math.min(run.code, 255)
      await client.request("send", { to: plan.parent, kind: "message", body: linkedHandbackBody(address, code, harnessOutput(run, bytes), stderrOutput(run)) })
      await client.request("status", { state: "done", note: `exited ${code}` })
    } finally {
      client.close()
    }
  } catch (error) {
    note(`${CLI_NAME} spawn: could not hand ${plan.name}'s result back to ${plan.parent}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
