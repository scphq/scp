import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { CLI_NAME, validHandle } from "@scp-dev/core"
import { RelayUsage } from "./common"

type Env = Record<string, string | undefined>

export const PI_HELP = `${CLI_NAME} pi [--name NAME | --as NAME] [--] [pi args...]
  runs pi with the @scp-dev/pi extension: the relay tools, and each new message as a turn, waking the session when idle.
  $SCP_PI_BIN picks the pi binary (default pi on PATH), $SCP_PI_EXTENSION the extension file.`

/** the pi argv and the env it runs with: the name becomes $SCP_NAME, the harness pi */
export function piLaunch(args: string[], env: Env, extension: string): { argv: string[]; env: Env } {
  let name: string | undefined
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--") {
      rest.push(...args.slice(i + 1))
      break
    }
    if (arg === "--name" || arg === "--as") {
      name = args[++i]
      if (name === undefined) throw new RelayUsage(`${CLI_NAME} pi ${arg} takes a name`)
    } else if (arg.startsWith("--name=") || arg.startsWith("--as=")) name = arg.slice(arg.indexOf("=") + 1)
    else rest.push(arg)
  }
  name = name?.replace(/^me\//, "")
  if (name !== undefined && !validHandle(name)) throw new RelayUsage(`${JSON.stringify(name)} is not a valid agent handle`)
  return {
    argv: [env.SCP_PI_BIN || "pi", "--extension", extension, ...rest],
    env: { ...env, SCP_HARNESS: "pi", ...(name !== undefined ? { SCP_NAME: name } : {}) },
  }
}

function extensionPath(env: Env): string {
  if (env.SCP_PI_EXTENSION) return env.SCP_PI_EXTENSION
  try {
    return fileURLToPath(import.meta.resolve("@scp-dev/pi"))
  } catch {
    throw new RelayUsage(`${CLI_NAME} pi needs the @scp-dev/pi extension: install it next to ${CLI_NAME}, or set $SCP_PI_EXTENSION to its file`)
  }
}

/** `swarm pi`: runs pi in the foreground with the extension loaded, exiting with its code */
export async function piCommand(args: string[]): Promise<number> {
  const own = args.includes("--") ? args.slice(0, args.indexOf("--")) : args
  if (own.includes("--help") || own.includes("-h")) {
    process.stdout.write(`${PI_HELP}\n`)
    return 0
  }
  const launch = piLaunch(args, process.env, extensionPath(process.env))
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
