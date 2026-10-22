import { accessSync, constants, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { relayDir } from "@scp-dev/broker"
import { CLI_NAME } from "@scp-dev/core"
import { RelayUsage } from "./common"
import pkg from "../package.json" with { type: "json" }
import { hookEntries, shellQuote } from "./hooks"
import { launcher } from "./launcher"
import { zip } from "./mcpb"

type Env = Record<string, string | undefined>

/** the npx package spec a cloud container runs, pinned to this build */
export const PINNED_CLI = `${pkg.name}@${pkg.version}`

/** runs `argv` when its host paths exist, else the pinned CLI through npx, with the remaining arguments either way */
export function pluginLauncher(argv: string[]): string[] {
  const present = argv.map((path) => `[ -e ${shellQuote(path)} ]`).join(" && ")
  return ["sh", "-c", `if ${present}; then exec ${argv.map(shellQuote).join(" ")} "$@"; fi; exec npx -y ${PINNED_CLI} "$@"`, CLI_NAME]
}

export function coworkSetup(
  options: { bin?: string },
  deps: { env: Env; out: (line: string) => void; version: string; which: (name: string) => string | undefined },
): number {
  const bin = options.bin ?? deps.which(CLI_NAME)
  if (!bin) throw new RelayUsage(`${CLI_NAME} is not on PATH: pass --bin /absolute/path/to/${CLI_NAME}`)
  if (!isAbsolute(bin)) throw new RelayUsage(`--bin takes an absolute path to the ${CLI_NAME} binary`)
  try {
    accessSync(bin, constants.X_OK)
    if (!statSync(bin).isFile()) throw new Error("not a file")
  } catch {
    throw new RelayUsage(`--bin ${bin} is not an executable file`)
  }
  const launch = launcher(bin, deps.env, deps.which)
  if (launch.problem) throw new RelayUsage(launch.problem)
  const argv = pluginLauncher(launch.argv)
  const [command, ...args] = argv
  const files = {
    ".claude-plugin/plugin.json": {
      name: "scp",
      version: deps.version,
      description: "Message agents on the SCP relay from Claude Cowork sessions.",
      homepage: "https://scp.dev",
    },
    ".mcp.json": { mcpServers: { scp: { command, args: [...args, "mcp", "--harness", "claude", "--channels", "--cowork-only"] } } },
    "hooks/hooks.json": { hooks: hookEntries("claude", { launcher: argv, cowork: true }) },
  }
  const dir = relayDir(deps.env)
  mkdirSync(dir, { recursive: true })
  const temp = mkdtempSync(join(dir, ".cowork-plugin-"))
  const target = join(dir, "cowork-plugin")
  const old = `${temp}-old`
  const archive = join(dir, "scp-cowork.zip")
  const zipTemp = `${temp}.zip`
  try {
    const entries = Object.entries(files).map(([path, value]) => ({ path, data: Buffer.from(`${JSON.stringify(value, null, 2)}\n`), mode: 0o644 }))
    for (const entry of entries) {
      const path = join(temp, entry.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, entry.data)
    }
    writeFileSync(zipTemp, zip(entries))
    try {
      renameSync(target, old)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    try {
      renameSync(temp, target)
    } catch (error) {
      try {
        renameSync(old, target)
      } catch {}
      throw error
    }
    renameSync(zipTemp, archive)
  } finally {
    rmSync(temp, { recursive: true, force: true })
    rmSync(old, { recursive: true, force: true })
    rmSync(zipTemp, { force: true })
  }
  deps.out(`wrote ${archive}`)
  deps.out("upload it in Claude: Customize, Plugins, Add, Upload plugin")
  deps.out(`Local sessions run this ${CLI_NAME}; cloud sessions run ${PINNED_CLI} through npx; scheduled tasks do not wake.`)
  deps.out("Rerun swarm setup --cowork after moving or upgrading node or swarm to rebuild it.")
  return 0
}
