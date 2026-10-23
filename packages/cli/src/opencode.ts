import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CLI_NAME, validHandle } from "@scp-dev/core"
import { attribute, attributed, validateUnder, hasFlag, ROOT_HELP } from "./attribute"
import { RelayUsage } from "./common"
import { opencodePlugin } from "./hooks"
import { gitToplevel } from "./identity"
import { hooksTarget } from "./install"
import { mcpFile, mountedEntry, whichOnPath } from "./setup"
import { safeCwd } from "./cwd"

type Env = Record<string, string | undefined>

export const OPENCODE_HELP = `${CLI_NAME} opencode [--name N | --as N] [--root] [--under ADDR] [--] [opencode args...]
  runs OpenCode with your own config and arguments, wake on: the ${CLI_NAME} plugin wakes the session on a new message, and opens
  one when none is open yet. Refuses to start without the current plugin; ${CLI_NAME} setup --write installs it.
  $SCP_OPENCODE_BIN picks the opencode binary (default opencode on PATH).
${ROOT_HELP}`

/** the opencode argv and the env it runs with: the name becomes $SCP_NAME, the harness opencode, wake on */
export function opencodeLaunch(args: string[], env: Env, bin: string): { name?: string; root?: true; under?: string; argv: string[]; env: Env } {
  let name: string | undefined
  let under: string | undefined
  let root = false
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--") {
      rest.push(...args.slice(i + 1))
      break
    }
    if (arg === "--name" || arg === "--as") {
      name = args[++i]
      if (name === undefined) throw new RelayUsage(`${CLI_NAME} opencode ${arg} takes a name`)
    } else if (arg.startsWith("--name=") || arg.startsWith("--as=")) name = arg.slice(arg.indexOf("=") + 1)
    else if (arg === "--under" || arg.startsWith("--under=")) {
      under = arg === "--under" ? args[++i] : arg.slice(8)
      if (under === undefined) throw new RelayUsage("--under takes an address")
    } else if (arg === "--root") root = true
    else rest.push(arg)
  }
  validateUnder(under, root)
  name = name?.replace(/^me\//, "")
  if (name !== undefined && !validHandle(name)) throw new RelayUsage(`${JSON.stringify(name)} is not a valid agent handle`)
  return {
    ...(name !== undefined ? { name } : {}),
    ...(root ? { root: true as const } : {}),
    ...(under !== undefined ? { under } : {}),
    argv: [bin, ...rest],
    env: { ...env, SCP_HARNESS: "opencode", SCP_WAKE: "1", ...(name !== undefined ? { SCP_NAME: name } : {}) },
  }
}

/** the plugin file OpenCode would load for `cwd`, and whether it is the one this CLI writes */
export function pluginState(env: Env, cwd: string): { file?: string; current: boolean } {
  const current = new Set([opencodePlugin({ blockStop: false }), opencodePlugin({ blockStop: true })])
  const files = [hooksTarget("opencode", "project", env, cwd), hooksTarget("opencode", "user", env, cwd)].filter((file) => existsSync(file))
  for (const file of files) {
    try {
      if (current.has(readFileSync(file, "utf8"))) return { file, current: true }
    } catch {}
  }
  return { ...(files[0] ? { file: files[0] } : {}), current: false }
}

/** the error that stops a launch without a current plugin, else undefined */
export function pluginProblem(env: Env, cwd: string): string | undefined {
  const plugin = pluginState(env, cwd)
  if (plugin.current) return undefined
  const fix = `run ${CLI_NAME} setup --write (or ${CLI_NAME} hooks install --harness opencode --scope user --write)`
  return plugin.file
    ? `${CLI_NAME} opencode: ${plugin.file} is not this ${CLI_NAME}'s plugin, so wake is not guaranteed; ${fix}`
    : `${CLI_NAME} opencode: OpenCode has no ${CLI_NAME} plugin, so messages would not wake it; ${fix}`
}

/** a one-line hint when neither the user's nor the project's OpenCode config mounts the scp MCP server, else undefined */
export function opencodeMountHint(env: Env, cwd: string): string | undefined {
  const project = gitToplevel(cwd) ?? cwd
  const files = [mcpFile("opencode", env), ...["opencode.json", "opencode.jsonc"].map((name) => join(project, name))]
  for (const file of files) {
    try {
      if (existsSync(file) && mountedEntry("opencode", file)) return undefined
    } catch {}
  }
  return `${CLI_NAME} opencode: OpenCode has no scp MCP mount, so the session has no relay tools; run ${CLI_NAME} setup --write`
}

/** `swarm opencode`: runs OpenCode in the foreground, wake on, exiting with its code */
export async function opencodeCommand(
  args: string[],
  env: Env = process.env,
  err: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
  cwd: string = safeCwd(),
): Promise<number> {
  const own = args.includes("--") ? args.slice(0, args.indexOf("--")) : args
  if (own.includes("--help") || own.includes("-h")) {
    process.stdout.write(`${OPENCODE_HELP}\n`)
    return 0
  }
  const bin = env.SCP_OPENCODE_BIN || whichOnPath("opencode", env)
  if (!bin) throw new RelayUsage(`opencode is not on PATH: install it with npm i -g opencode-ai, then run ${CLI_NAME} setup --write`)
  const parsed = opencodeLaunch(args, env, bin)
  const problem = pluginProblem(env, cwd)
  if (problem) throw new RelayUsage(problem)
  const hint = opencodeMountHint(env, cwd)
  if (hint) err(hint)
  const resume = hasFlag(parsed.argv.slice(1), ["-c", "--continue", "-s", "--session"])
  const attribution = await attribute("opencode", { ...parsed, resume }, env, cwd, err)
  const launch = attribution ? opencodeLaunch(args, attributed(env, attribution), bin) : parsed
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(launch.argv[0]!, launch.argv.slice(1), { env: launch.env as NodeJS.ProcessEnv, stdio: "inherit" })
    const forward = (signal: NodeJS.Signals) => child.kill(signal)
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"]
    const ignore = () => {}
    for (const signal of signals) process.on(signal, forward)
    process.on("SIGINT", ignore)
    child.once("error", (error) => reject(new RelayUsage(`could not start ${launch.argv[0]}: ${error.message}`)))
    child.once("exit", (code, signal) => {
      for (const each of signals) process.off(each, forward)
      process.off("SIGINT", ignore)
      resolve(code ?? (signal ? 1 : 0))
    })
  })
}
