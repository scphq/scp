import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { connectBroker, privateDir, relayDir } from "@scp-dev/broker"
import { CLI_NAME, validHandle } from "@scp-dev/core"
import { MCP_PROTOCOLS, runRelayMcp } from "@scp-dev/mcp"
import { attribute, attributed, validateUnder, ROOT_HELP } from "./attribute"
import { RelayUsage, startDaemon } from "./common"
import { AGY_CONVERSATION, AGY_HOOK_SET } from "./hooks"
import { relayIdentity } from "./identity"
import { hooksTarget } from "./install"
import { whichOnPath } from "./setup"
import { agyNote, messagingAllow } from "./spawn"
import { safeCwd } from "./cwd"

type Env = Record<string, string | undefined>
type Json = Record<string, unknown>

export type ResumeHarness = "agy" | "grok"

const SPECS: Record<ResumeHarness, { bin: string; refused: string[]; prompt: string[]; ids: string[] }> = {
  agy: {
    bin: "SCP_AGY_BIN",
    refused: ["-i", "--prompt-interactive", "-c", "--continue", "--input-format", "--remote-control"],
    prompt: ["-p", "--print", "--prompt"],
    ids: ["--conversation"],
  },
  grok: {
    bin: "SCP_GROK_BIN",
    refused: ["-c", "--continue", "--fork-session"],
    prompt: ["-p", "--single", "--prompt-file", "--prompt-json"],
    ids: ["-s", "--session-id", "-r", "--resume"],
  },
}

export const AGY_HELP = `${CLI_NAME} agy [--name N | --as N] [--root] [--under ADDR] [--] [agy args...]
  runs agy headless, wake on: a -p prompt is its first turn, and each new message resumes the same conversation as a
  turn (agy --conversation <id> -p <message>); without a prompt the first message starts it. Refuses -i, -c,
  --input-format and --remote-control: nothing local starts a turn in an interactive agy, so run plain agy for that
  (its hooks still deliver before each model call). Refuses to start without the ${CLI_NAME} hooks, which report the
  conversation; ${CLI_NAME} setup --write installs them.
  $SCP_AGY_BIN picks the agy binary (default agy on PATH).
${ROOT_HELP}`

export const GROK_HELP = `${CLI_NAME} grok [--name N | --as N] [--root] [--under ADDR] [--] [grok args...]
  runs grok headless, wake on: a -p prompt is its first turn, and each new message resumes the same session as a turn
  (grok --resume <id> -p <message>); without a prompt the first message starts it. The session id is yours (-s, -r)
  or a new one. Refuses -c and --fork-session: nothing local starts a turn in an interactive grok, so run plain grok
  for that. Adds the --allow rules for the relay tools unless you pass your own.
  $SCP_GROK_BIN picks the grok binary (default grok on PATH).
${ROOT_HELP}`

export interface ResumeLaunch {
  harness: ResumeHarness
  name?: string
  root?: true
  under?: string
  /** the first turn's arguments when they hold a prompt: the user's as given */
  first?: string[]
  /** the user's arguments without prompt and conversation flags, which every other turn starts from */
  base: string[]
  /** the conversation flags of a turn that opens the conversation with a message */
  opening: string[]
  /** the conversation to resume, when known before a turn ran */
  id?: string
  /** flags every turn adds */
  extra: string[]
  env: Env
}

/** `extra` before a `--` in `args`, else after them */
function insert(args: string[], extra: string[]): string[] {
  const end = args.indexOf("--")
  return end < 0 ? [...args, ...extra] : [...args.slice(0, end), ...extra, ...args.slice(end)]
}

/** the launch of `swarm agy` or `swarm grok`: leading launcher flags, then the harness's own arguments */
export function resumeLaunch(harness: ResumeHarness, args: string[], env: Env, uuid: () => string = randomUUID): ResumeLaunch {
  let name: string | undefined
  let under: string | undefined
  let root = false
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--name" || arg === "--as") {
      name = args[++i]
      if (name === undefined) throw new RelayUsage(`${CLI_NAME} ${harness} ${arg} takes a name`)
    } else if (arg.startsWith("--name=") || arg.startsWith("--as=")) name = arg.slice(arg.indexOf("=") + 1)
    else if (arg === "--under" || arg.startsWith("--under=")) {
      under = arg === "--under" ? args[++i] : arg.slice(8)
      if (under === undefined) throw new RelayUsage("--under takes an address")
    } else if (arg === "--root") root = true
    else break
  }
  if (args[i] === "--") i++
  const rest = args.slice(i)
  validateUnder(under, root)
  name = name?.replace(/^me\//, "")
  if (name !== undefined && !validHandle(name)) throw new RelayUsage(`${JSON.stringify(name)} is not a valid agent handle`)
  const spec = SPECS[harness]
  const refusal = (flag: string) =>
    new RelayUsage(
      `${CLI_NAME} ${harness}: ${flag} is not supported: nothing local starts a turn in an interactive ${harness} session; run plain ${harness} for that`,
    )
  if (harness === "agy" && rest[0] === "remote-control") throw refusal("remote-control")
  const base: string[] = []
  const ids = new Map<string, string>()
  let prompt = false
  for (let j = 0; j < rest.length; j++) {
    const arg = rest[j]!
    if (arg === "--") {
      base.push(...rest.slice(j))
      break
    }
    const refused = spec.refused.find((flag) => arg === flag || arg.startsWith(`${flag}=`))
    if (refused) throw refusal(refused)
    const valued = [...spec.prompt, ...spec.ids].find((flag) => arg === flag || arg.startsWith(`${flag}=`))
    if (!valued) {
      base.push(arg)
      continue
    }
    const value = arg === valued ? rest[++j] : arg.slice(valued.length + 1)
    if (value === undefined) throw new RelayUsage(`${CLI_NAME} ${harness} ${valued} takes a value`)
    if (spec.prompt.includes(valued)) prompt = true
    else ids.set(valued, value)
  }
  const { SCP_SESSION: _session, SCP_PARENT: _parent, SCP_HARNESS_PID: _pid, ...clean } = env
  const launchEnv: Env = { ...clean, SCP_HARNESS: harness, SCP_SESSION: randomBytes(16).toString("hex"), ...(name !== undefined ? { SCP_NAME: name } : {}) }
  const named = { ...(name !== undefined ? { name } : {}), ...(root ? { root: true as const } : {}), ...(under !== undefined ? { under } : {}) }
  if (harness === "agy") {
    const id = ids.get("--conversation")
    return {
      harness,
      ...named,
      ...(prompt ? { first: rest } : {}),
      base,
      opening: id === undefined ? [] : ["--conversation", id],
      ...(id !== undefined ? { id } : {}),
      extra: [],
      env: launchEnv,
    }
  }
  const resumed = ids.get("-r") ?? ids.get("--resume")
  const given = ids.get("-s") ?? ids.get("--session-id")
  const id = resumed ?? given ?? uuid()
  const extra = messagingAllow("grok", rest)
  return {
    harness,
    ...named,
    ...(prompt ? { first: insert(rest, [...((resumed ?? given) ? [] : ["-s", id]), ...extra]) } : {}),
    base,
    opening: resumed !== undefined ? ["--resume", id] : ["-s", id],
    id,
    extra,
    env: launchEnv,
  }
}

/** a turn's arguments: one that opens the conversation with `text`, or resumes conversation `id` with it */
export function turnArgv(launch: ResumeLaunch, text: string, id?: string): string[] {
  const conversation = id === undefined ? launch.opening : launch.harness === "agy" ? ["--conversation", id] : ["--resume", id]
  return insert(launch.base, [...conversation, "-p", text, ...launch.extra])
}

/** the error that stops `swarm agy` when neither the project's nor the user's agy hooks hold the ${CLI_NAME} set, else undefined */
export function agyHooksProblem(env: Env, cwd: string): string | undefined {
  for (const scope of ["project", "user"] as const) {
    try {
      const set = (JSON.parse(readFileSync(hooksTarget("agy", scope, env, cwd), "utf8")) as Json)[AGY_HOOK_SET] as Json | undefined
      if (set && set.enabled !== false && Array.isArray(set.SessionStart) && set.SessionStart.length) return undefined
    } catch {}
  }
  return `${CLI_NAME} agy: agy has no ${CLI_NAME} hooks, so it cannot report the conversation to resume; run ${CLI_NAME} setup --write`
}

/** the conversation id agy's hooks wrote to `file`, when it is one */
export function readConversation(file: string | undefined): string | undefined {
  if (!file) return undefined
  try {
    const id = readFileSync(file, "utf8").trim()
    return AGY_CONVERSATION.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

/** `swarm agy` and `swarm grok`: holds the endpoint and runs one headless turn per batch of new messages, resuming one conversation */
export async function resumeCommand(
  harness: ResumeHarness,
  args: string[],
  env: Env = process.env,
  cwd: string = safeCwd(),
  err: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${harness === "agy" ? AGY_HELP : GROK_HELP}\n`)
    return 0
  }
  const parsed = resumeLaunch(harness, args, env)
  const spec = SPECS[harness]
  const bin = env[spec.bin] || whichOnPath(harness, env)
  if (!bin) throw new RelayUsage(`${harness} is not on PATH: install it, or set $${spec.bin} to its binary`)
  if (harness === "agy") {
    const problem = agyHooksProblem(env, cwd)
    if (problem) throw new RelayUsage(problem)
    const note = agyNote(["agy", "-p", "", ...parsed.base], env, "agy")
    if (note) err(note)
  }
  const resume = parsed.opening[0] === "--resume" || parsed.opening[0] === "--conversation"
  const attribution = await attribute(harness, { ...parsed, resume }, env, cwd, err)
  const launch = attribution ? resumeLaunch(harness, args, attributed(env, attribution)) : parsed
  const runEnv: Env = { ...launch.env, SCP_HARNESS_PID: String(process.pid) }
  const claim = relayIdentity({ harness, fallbackHarness: harness, cwd, env: runEnv, harnessPid: () => process.pid })
  if (!validHandle(claim.handle)) throw new RelayUsage(`${JSON.stringify(claim.handle)} is not a valid agent handle`)
  const dir = harness === "agy" ? mkdtempSync(join(privateDir(join(relayDir(runEnv), "agy")), "resume-")) : undefined
  const file = dir === undefined ? undefined : join(dir, "conversation")
  if (file) runEnv.SCP_AGY_CONVERSATION_FILE = file
  const broker = relayDir(runEnv)
  const input = new PassThrough()
  const queue: string[] = []
  let id = launch.id
  let opened = false
  let ready = false
  let stopping = false
  let running: ChildProcess | undefined
  let finish!: (code: number) => void
  const done = new Promise<number>((resolve) => {
    finish = resolve
  })
  let joined!: (result: Json) => void
  const whoami = new Promise<Json>((resolve) => {
    joined = resolve
  })

  const turn = (argv: string[]) => {
    const child = spawn(bin, argv, { env: runEnv as NodeJS.ProcessEnv, stdio: ["ignore", "inherit", "inherit"] })
    running = child
    let settled = false
    child.once("error", (error) => {
      if (settled) return
      settled = true
      running = undefined
      err(`${CLI_NAME} ${harness}: could not start ${bin}: ${error.message}`)
      finish(1)
    })
    child.once("exit", (code, signal) => {
      if (settled) return
      settled = true
      running = undefined
      if (stopping) return finish(0)
      if (code !== 0) {
        err(`${CLI_NAME} ${harness}: turn failed (exit ${code ?? signal}); undelivered messages stay unread in relay_inbox`)
        return finish(code ?? 1)
      }
      opened = true
      if (harness === "agy") id = readConversation(file) ?? id
      if (id === undefined) {
        err(`${CLI_NAME} agy: agy's ${CLI_NAME} hooks did not report the conversation, so it cannot be resumed; run ${CLI_NAME} setup --write`)
        return finish(1)
      }
      next()
    })
  }
  const next = () => {
    if (!ready || running || stopping || !queue.length) return
    turn(turnArgv(launch, queue.splice(0).join("\n\n"), opened ? id : undefined))
  }

  let lines = ""
  const channel = runRelayMcp({
    connect: () => connectBroker(broker, () => startDaemon(broker)),
    claim,
    channels: true,
    wake: harness === "agy" ? "agy-resume" : "grok-resume",
    input,
    env: runEnv,
    output: (chunk) => {
      lines += chunk
      for (;;) {
        const end = lines.indexOf("\n")
        if (end < 0) break
        const message = JSON.parse(lines.slice(0, end)) as Json
        lines = lines.slice(end + 1)
        if (message.id === 2) joined((message.result ?? {}) as Json)
        if (message.method === "notifications/claude/channel") {
          const content = (message.params as Json).content
          if (typeof content === "string") {
            queue.push(content)
            next()
          }
        }
      }
    },
    log: err,
  })
  void channel.catch((error: unknown) => {
    err(`${CLI_NAME} ${harness}: ${String(error)}`)
    finish(1)
  })
  const stop = (signal: NodeJS.Signals) => {
    stopping = true
    if (running) running.kill(signal)
    else finish(0)
  }
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
  for (const signal of signals) process.on(signal, stop)
  try {
    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOLS[0], capabilities: { experimental: { "claude/channel": {} } }, clientInfo: { name: `scp-${harness}`, version: "0.1.0" } } })}\n`,
    )
    input.write(`${JSON.stringify({ method: "notifications/initialized" })}\n`)
    input.write(`${JSON.stringify({ id: 2, method: "tools/call", params: { name: "relay_whoami", arguments: {} } })}\n`)
    const result = await Promise.race([whoami, done.then(() => undefined)])
    if (result === undefined) return await done
    const text = ((result.content as { text?: string }[] | undefined) ?? []).map((part) => part.text ?? "").join("\n")
    const address = /^address: (\S+)$/m.exec(text)?.[1]
    if (result.isError || !address) throw new RelayUsage(`${CLI_NAME} ${harness}: could not join the relay: ${text || "no answer"}`)
    runEnv.SCP_NAME = address.slice(address.lastIndexOf("/") + 1)
    ready = true
    if (launch.first) turn(launch.first)
    else {
      err(`${CLI_NAME} ${harness}: ${address} waiting for messages`)
      next()
    }
    return await done
  } finally {
    for (const signal of signals) process.off(signal, stop)
    input.end()
    await channel.catch(() => {})
    if (running?.exitCode === null && running.signalCode === null) running.kill("SIGTERM")
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}
