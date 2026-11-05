// Stands in for the harness CLIs in setup-native.test.ts: edits each harness's files the way it does, and records every call in
// $HOME/.fake-calls so both engines can be compared on what they ran.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"

const SERVER = "scp"
const [name, ...args] = process.argv.slice(2)
const env = process.env
const home = env.HOME!
const config = env.XDG_CONFIG_HOME || join(home, ".config")
const files = {
  claude: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json"),
  codex: join(env.CODEX_HOME || join(home, ".codex"), "config.toml"),
  grok: join(home, ".grok", "config.toml"),
  opencode: join(config, "opencode", "opencode.json"),
  agy: join(home, ".gemini", "config", "mcp_config.json"),
  museInstalled: join(env.XDG_DATA_HOME || join(home, ".local", "share"), "muse", "plugins", "installed.json"),
}

// biome-ignore lint/suspicious/noExplicitAny: each harness has its own config schema.
type Config = Record<string, any>

const finish = (code: number, output = ""): never => {
  process.stdout.write(output)
  process.exit(code)
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8") || "{}") as Config

function write(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function tomlWithout(text: string): string {
  const kept: string[] = []
  let skipping = false
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) skipping = line.startsWith(`[mcp_servers.${SERVER}]`) || line.startsWith(`[mcp_servers.${SERVER}.`)
    if (!skipping) kept.push(line)
  }
  return kept.join("\n").replace(/\n+$/, "\n")
}

function addArgs(): { vars: Record<string, string>; command: string[] } {
  const dash = args.indexOf("--")
  const vars: Record<string, string> = {}
  for (let i = 0; i < dash; i++) if (args[i] === "--env") vars[args[i + 1]!.split("=")[0]!] = args[i + 1]!.split("=").slice(1).join("=")
  return { vars, command: dash >= 0 ? args.slice(dash + 1) : [] }
}

appendFileSync(join(home, ".fake-calls"), `${JSON.stringify([name, ...args])}\n`)
if (name === "claude" && args[0] === "--version") finish(0, "2.1.100 (Claude Code)\n")
if (env.FAKE_FAIL === name && args[1] !== "list" && args[1] !== "get") finish(1, "boom\n")
if (env.FAKE_FAIL === `${name} ${args[1]}`) finish(3, "\x1b[31mboom\x1b[0m\nlast words\n")

const { vars, command } = addArgs()
switch (name) {
  case "claude": {
    const settings = existsSync(files.claude) ? readJson(files.claude) : {}
    settings.mcpServers ??= {}
    const servers = settings.mcpServers
    if (args[1] === "add") {
      if (servers[SERVER]) finish(1, `MCP server ${SERVER} already exists in user config\n`)
      servers[SERVER] = { type: "stdio", command: command[0], args: command.slice(1), env: {} }
    } else if (args[1] === "add-json") servers[args[4]!] = JSON.parse(args[5]!)
    else if (args[1] === "remove") delete servers[SERVER]
    else if (args[1] === "get") {
      const server = servers[SERVER]
      if (!server) finish(1, `No MCP server named "${SERVER}". Run \`claude mcp add\` to add one.\n`)
      finish(
        0,
        `${SERVER}:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: stdio\n  Command: ${server.command}\n  Args: ${server.args.join(" ")}\n`,
      )
    }
    write(files.claude, `${JSON.stringify(settings, null, 2)}\n`)
    finish(0)
    break
  }
  case "codex":
  case "grok": {
    const file = name === "codex" ? files.codex : files.grok
    const text = existsSync(file) ? readFileSync(file, "utf8") : ""
    if (args[1] === "list") {
      const servers = (Bun.TOML.parse(text) as Config).mcp_servers ?? {}
      const line = (server: string) => [servers[server].command, ...(servers[server].args ?? [])].join(" ")
      if (name === "grok")
        finish(
          0,
          Object.keys(servers)
            .map((server) => `  ${server}: ${line(server)}\n`)
            .join(""),
        )
      finish(
        0,
        `Name  Command  Args  Env  Cwd  Status  Auth\n${Object.keys(servers)
          .map((server) => `${server}  ${servers[server].command}  ${(servers[server].args ?? []).join(" ")}  -  -  enabled  Unsupported\n`)
          .join("")}`,
      )
    }
    const without = tomlWithout(text)
    const table = Object.keys(vars).length
      ? `\n[mcp_servers.${SERVER}.env]\n${Object.entries(vars)
          .map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`)
          .join("")}`
      : ""
    write(
      file,
      args[1] === "add"
        ? `${without}\n[mcp_servers.${SERVER}]\ncommand = ${JSON.stringify(command[0])}\nargs = ${JSON.stringify(command.slice(1))}\n${table}`
        : without,
    )
    finish(0)
    break
  }
  case "agy": {
    const settings = existsSync(files.agy) ? readJson(files.agy) : {}
    settings.mcpServers ??= {}
    const servers = settings.mcpServers
    if (args[1] === "list")
      finish(
        0,
        Object.keys(servers)
          .map((server) => `${server}  stdio  enabled  ${[servers[server].command, ...servers[server].args].join(" ")}\n`)
          .join("") || "No MCP servers configured.\n",
      )
    if (args[1] === "add")
      servers[SERVER] = { args: command.slice(1), command: command[0], disabled: false, ...(Object.keys(vars).length ? { env: vars } : {}) }
    else delete servers[SERVER]
    write(files.agy, `${JSON.stringify(settings, null, 2)}\n`)
    chmodSync(files.agy, 0o644)
    finish(0)
    break
  }
  case "opencode": {
    let servers: Record<string, unknown> = {}
    try {
      servers = existsSync(files.opencode) ? (readJson(files.opencode).mcp ?? {}) : {}
    } catch {
      finish(1, "Config file is not valid JSON\n")
    }
    finish(
      0,
      Object.keys(servers)
        .map((server) => `\x1b[0m●  ✓ ${server} \x1b[90mconnected\n`)
        .join(""),
    )
    break
  }
  case "muse": {
    if (args[0] !== "plugins") break
    const installed = existsSync(files.museInstalled) ? readJson(files.museInstalled) : { version: 1, plugins: {} }
    if (args[1] === "list") finish(0, JSON.stringify({ plugins: Object.values(installed.plugins).map((record) => ({ record })) }))
    if (args[1] === "inspect") {
      const record = installed.plugins[args[2]!]
      if (!record) finish(1, `plugin \`${args[2]}\` is not installed\n`)
      finish(0, JSON.stringify({ runtime_capabilities: [{ status: record.reviewed ? "trusted_enabled" : "review_needed" }] }))
    }
    if (args[1] === "install") {
      const manifest = readFileSync(join(args[2]!, ".muse-plugin", "plugin.json"), "utf8")
      installed.plugins[SERVER] = {
        id: SERVER,
        enabled: installed.plugins[SERVER]?.enabled ?? true,
        trust: "user-local",
        source: { provenance: "native-local", path: args[2] },
        manifest_sha256: `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
        reviewed: false,
      }
    } else {
      if (!installed.plugins[args[2]!]) finish(1, `plugin \`${args[2]}\` is not installed\n`)
      if (args[1] === "enable") installed.plugins[args[2]!].enabled = true
      else if (args[1] === "approve") installed.plugins[args[2]!].reviewed = true
      else if (args[1] === "remove") delete installed.plugins[args[2]!]
    }
    write(files.museInstalled, JSON.stringify(installed))
    finish(0)
    break
  }
}
finish(127, `unexpected ${[name, ...args].join(" ")}\n`)
