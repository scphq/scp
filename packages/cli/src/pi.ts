import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { CLI_NAME, validHandle } from "@scp-dev/core"
import { attribute, attributed, ROOT_HELP } from "./attribute"
import { RelayUsage } from "./common"

type Env = Record<string, string | undefined>

export const PI_HELP = `${CLI_NAME} pi [--name NAME | --as NAME] [--root] [--] [pi args...]
  runs pi with the bundled SCP extension: the relay tools, and each new message as a turn, waking the session when idle.
  pi's own --name and every other argument after the leading launcher flags go to pi untouched.
  $SCP_PI_BIN picks the pi binary (default pi on PATH), $SCP_PI_EXTENSION the extension file.
${ROOT_HELP}`

/** the pi argv and the env it runs with: a leading name becomes $SCP_NAME, the harness pi, and everything after it goes to pi untouched */
export function piLaunch(args: string[], env: Env, extension: string): { name?: string; root?: true; argv: string[]; env: Env } {
  let name: string | undefined
  let root = false
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--name" || arg === "--as") {
      name = args[++i]
      if (name === undefined) throw new RelayUsage(`${CLI_NAME} pi ${arg} takes a name`)
    } else if (arg.startsWith("--name=") || arg.startsWith("--as=")) name = arg.slice(arg.indexOf("=") + 1)
    else if (arg === "--root") root = true
    else break
  }
  if (args[i] === "--") i++
  const rest = args.slice(i)
  name = name?.replace(/^me\//, "")
  if (name !== undefined && !validHandle(name)) throw new RelayUsage(`${JSON.stringify(name)} is not a valid agent handle`)
  return {
    ...(name !== undefined ? { name } : {}),
    ...(root ? { root: true as const } : {}),
    argv: [env.SCP_PI_BIN || "pi", "--extension", extension, ...rest],
    env: { ...env, SCP_HARNESS: "pi", ...(name !== undefined ? { SCP_NAME: name } : {}) },
  }
}

/** the extension file: $SCP_PI_EXTENSION, else the one bundled next to the CLI, else the workspace package's source */
export function extensionPath(env: Env, base: string | URL = import.meta.url): string {
  if (env.SCP_PI_EXTENSION) return env.SCP_PI_EXTENSION
  for (const candidate of ["./pi-extension.js", "../../pi/src/index.ts"]) {
    const file = fileURLToPath(new URL(candidate, base))
    if (existsSync(file)) return file
  }
  throw new RelayUsage(`${CLI_NAME} pi found no pi extension next to ${CLI_NAME}: reinstall it, or set $SCP_PI_EXTENSION to the extension file`)
}

/** `swarm pi`: runs pi in the foreground with the extension loaded, exiting with its code */
export async function piCommand(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${PI_HELP}\n`)
    return 0
  }
  const extension = extensionPath(process.env)
  const parsed = piLaunch(args, process.env, extension)
  const attribution = await attribute("pi", parsed, process.env, process.cwd(), (line) => void process.stderr.write(`${line}\n`))
  const launch = attribution ? piLaunch(args, attributed(process.env, attribution), extension) : parsed
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
