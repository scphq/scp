import { spawnSync } from "node:child_process"
import { accessSync, constants, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { parseArgs } from "node:util"
import { CLI_NAME } from "@scp-dev/core"
import { TOOLS } from "@scp-dev/mcp"
import { RelayUsage } from "./common"
import { shellQuote } from "./hooks"
import { launcher } from "./launcher"

type Env = Record<string, string | undefined>

/** the harness label of the Claude desktop app's chat, which mounts the shim through the extension */
export const CHAT_HARNESS = "claude-desktop-chat"
const ENTRY = "server/scp"

export const CLAUDE_DESKTOP_HELP = `${CLI_NAME} setup claude-desktop [--out FILE] [--open] [--bin PATH]
  builds scp.mcpb, a Claude desktop extension that mounts the relay MCP shim in the app's chat (harness ${CHAT_HARNESS}),
  at ~/.config/scp/scp.mcpb or --out. It runs the ${CLI_NAME} PATH finds (or --bin) by absolute paths, a node script by
  absolute node and its real path, since the app does not start it with your shell's PATH; rebuild it after moving or
  upgrading either. Install it by opening the file (double-click, or --open). Chat is pull only: the model reads new
  messages when it calls relay_inbox; nothing wakes it. The app's Code tab is Claude Code and uses ${CLI_NAME} setup.
  claude_desktop_config.json is never edited.`

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** the extension's manifest (MCPB manifest_version 0.3): a binary server that runs the bundled launcher script with /bin/sh */
export function mcpbManifest(version: string): Record<string, unknown> {
  return {
    manifest_version: "0.3",
    name: "scp",
    display_name: "SCP",
    version,
    description: "Message the agents on this machine's SCP relay from Claude chat.",
    long_description: `Mounts the SCP relay MCP server (${CLI_NAME} mcp --harness ${CHAT_HARNESS}). Chat is pull only: call relay_inbox to read new messages.`,
    author: { name: "SCP", url: "https://scp.dev" },
    homepage: "https://scp.dev",
    documentation: "https://scp.dev/docs/harnesses",
    license: "Apache-2.0",
    server: {
      type: "binary",
      entry_point: ENTRY,
      mcp_config: { command: "/bin/sh", args: [`\${__dirname}/${ENTRY}`], env: {} },
    },
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description })),
    compatibility: { platforms: ["darwin"] },
  }
}

/** the launcher script the manifest runs: the shim by absolute paths, so the app's PATH does not matter */
export function mcpbLauncher(launch: string[]): string {
  return `#!/bin/sh\nexec ${[...launch, "mcp", "--harness", CHAT_HARNESS].map(shellQuote).join(" ")}\n`
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  path: string
  data: Uint8Array
  mode: number
}

/** a stored (uncompressed) zip with Unix modes and a fixed timestamp, so the same input builds the same bytes */
export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8")
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((0o100000 | entry.mode) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, Buffer.from(entry.data))
    centrals.push(central, name)
    offset += local.length + name.length + entry.data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** the .mcpb bytes for a shim run by `launch` */
export function mcpbBundle(launch: string[], version: string): Buffer {
  return zip([
    { path: "manifest.json", data: Buffer.from(`${JSON.stringify(mcpbManifest(version), null, 2)}\n`), mode: 0o644 },
    { path: ENTRY, data: Buffer.from(mcpbLauncher(launch)), mode: 0o755 },
  ])
}

export interface ClaudeDesktopOptions {
  out?: string
  open?: boolean
  bin?: string
}

export interface ClaudeDesktopDeps {
  env: Env
  out: (line: string) => void
  version: string
  which: (name: string) => string | undefined
  run?: (argv: string[]) => number
}

export function defaultMcpbFile(env: Env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "scp", "scp.mcpb")
}

/** `swarm setup claude-desktop`: builds the extension and says how to install it, or opens it with --open */
export function claudeDesktopSetup(options: ClaudeDesktopOptions, deps: ClaudeDesktopDeps): number {
  const { env, out } = deps
  const bin = options.bin ?? deps.which(CLI_NAME)
  if (bin === undefined) throw new RelayUsage(`${CLI_NAME} is not on PATH: pass --bin /absolute/path/to/${CLI_NAME}`)
  if (!isAbsolute(bin)) throw new RelayUsage(`--bin takes an absolute path to the ${CLI_NAME} binary`)
  if (!isExecutableFile(bin)) throw new RelayUsage(`${bin} is not an executable file`)
  const file = options.out ?? defaultMcpbFile(env)
  if (!isAbsolute(file) || !file.endsWith(".mcpb")) throw new RelayUsage("--out takes an absolute path ending in .mcpb")
  const launch = launcher(bin, env, deps.which)
  if (launch.problem) out(`! ${launch.problem}: the extension may not start`)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, mcpbBundle(launch.argv, deps.version), { mode: 0o644 })
  renameSync(temp, file)
  out(`wrote ${file}`)
  out(`  runs: ${[...launch.argv, "mcp", "--harness", CHAT_HARNESS].map(shellQuote).join(" ")}`)
  out("  chat is pull only: the model reads new relay messages when it calls relay_inbox")
  if (options.open) {
    const code = (deps.run ?? ((argv) => spawnSync(argv[0]!, argv.slice(1), { stdio: "ignore" }).status ?? 1))(["open", file])
    if (code !== 0) {
      out(`! open ${file} exited ${code}: open it from Finder instead`)
      return 1
    }
    out("opened it: confirm the install in Claude")
    return 0
  }
  out(`install: double-click it in Finder, or run open ${shellQuote(file)} (or ${CLI_NAME} setup claude-desktop --open)`)
  out("rebuild it after moving or upgrading node or swarm")
  return 0
}

export function parseClaudeDesktopArgs(args: string[]): ClaudeDesktopOptions | "help" {
  let values: { out?: string; open?: boolean; bin?: string; help?: boolean }
  try {
    values = parseArgs({
      args,
      options: { out: { type: "string" }, open: { type: "boolean" }, bin: { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: false,
      strict: true,
    }).values
  } catch (error) {
    throw new RelayUsage(error instanceof Error ? error.message : String(error))
  }
  if (values.help) return "help"
  return {
    ...(values.out !== undefined ? { out: values.out } : {}),
    ...(values.open ? { open: true } : {}),
    ...(values.bin !== undefined ? { bin: values.bin } : {}),
  }
}
