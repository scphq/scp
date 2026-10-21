import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { BLOCK_STOP, claudeVersionFile, hookEntries, mergeHooks, musePlugin, opencodePlugin } from "./hooks"
import { type Added, agyRules, manifestFile, parseSetupArgs, relaySetup, type RunResult, type SetupOptions, verifyMount, verifyMusePlugin } from "./setup"

const SERVER = "scp"
const RULES = agyRules().length

interface Fixture {
  home: string
  env: Record<string, string>
  swarm: string
  calls: string[][]
  cwds: (string | undefined)[]
  files: Record<"claude" | "codex" | "grok" | "opencode" | "opencodec" | "muse" | "agy" | "agySettings" | "museInstalled", string>
}

function put(file: string, content: string, mode: number) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, mode)
}

function fixture(): Fixture {
  const home = mkdtempSync(join(process.env.HOME!, "setup-"))
  const files = {
    claude: join(home, ".claude.json"),
    codex: join(home, ".codex", "config.toml"),
    grok: join(home, ".grok", "config.toml"),
    opencode: join(home, ".config", "opencode", "opencode.json"),
    opencodec: join(home, ".config", "opencode", "opencode.jsonc"),
    muse: join(home, ".config", "muse", "settings.json"),
    agy: join(home, ".gemini", "config", "mcp_config.json"),
    agySettings: join(home, ".gemini", "antigravity-cli", "settings.json"),
    museInstalled: join(home, ".local", "share", "muse", "plugins", "installed.json"),
  }
  put(
    files.claude,
    `${JSON.stringify({ numStartups: 3, mcpServers: { other: { type: "stdio", command: "x", args: [] } }, projects: { "/a": {} } }, null, 2)}\n`,
    0o600,
  )
  put(files.codex, '# keep me\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "foo"\n', 0o600)
  put(files.grok, "[cli]\nauto_update = false\n", 0o600)
  put(files.opencode, `${JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { x: {} } }, null, 2)}\n`, 0o600)
  put(files.opencodec, '{ "$schema": "https://opencode.ai/config.json" }\n', 0o644)
  put(files.muse, `${JSON.stringify({ schema_version: 1, tui: { theme: "dark" }, contributor_mode_enabled: false }, null, 4)}\n`, 0o644)
  put(files.agy, "", 0o600)
  put(files.agySettings, `${JSON.stringify({ permissions: { allow: ["command(swarm)"] }, trustedWorkspaces: [] }, null, 2)}\n`, 0o600)
  for (const rel of [".local/bin/claude", ".local/bin/codex", ".local/bin/muse", ".local/bin/agy", ".opencode/bin/opencode", ".grok/bin/grok", "bin/swarm"])
    put(join(home, rel), "#!/bin/sh\n", 0o755)
  mkdirSync(join(home, "work"))
  return {
    home,
    env: { HOME: home, PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: join(home, ".config"), CODEX_HOME: join(home, ".codex") },
    swarm: join(home, "bin", "swarm"),
    calls: [],
    cwds: [],
    files,
  }
}

/** existing mounts with custom fields, agy rules and a local Claude mount */
function lived(f: Fixture) {
  const claude = readJson(f.files.claude)
  claude.mcpServers[SERVER] = { type: "stdio", command: "swarm", args: ["mcp", "--harness", "claude"], env: { SCP_NAME: "cc-secret-name" } }
  claude.projects["/tmp/proj"] = { mcpServers: { [SERVER]: { type: "stdio", command: "swarm", args: ["mcp"] } } }
  writeFileSync(f.files.claude, JSON.stringify(claude, null, 2))
  writeFileSync(
    f.files.codex,
    `${readFileSync(f.files.codex, "utf8")}\n[mcp_servers.${SERVER}]\ncommand = "swarm"\nargs = ["mcp", "--harness", "codex"]\nstartup_timeout_sec = 30\n\n[mcp_servers.${SERVER}.env]\nSCP_NAME = "cx-secret-name"\n`,
  )
  writeFileSync(f.files.grok, `[mcp_servers.${SERVER}]\ncommand = "swarm"\nargs = ["mcp", "--harness", "grok"]\n`)
  const opencode = readJson(f.files.opencode)
  opencode.mcp = {
    [SERVER]: { type: "local", command: ["swarm", "mcp", "--harness", "opencode"], enabled: true, environment: { SCP_NAME: "oc-secret-name" }, timeout: 9000 },
  }
  writeFileSync(f.files.opencode, JSON.stringify(opencode, null, 2))
  const muse = readJson(f.files.muse)
  muse.mcpServers = { [SERVER]: { type: "stdio", command: "swarm", args: ["mcp", "--harness", "muse"], mode: "required", env: { A: "b" } } }
  writeFileSync(f.files.muse, JSON.stringify(muse, null, 4))
  writeFileSync(
    f.files.agy,
    JSON.stringify({ mcpServers: { [SERVER]: { args: ["mcp", "--harness", "agy"], command: "swarm", disabled: false, timeout: 5000 } } }, null, 2),
  )
  writeFileSync(f.files.agySettings, JSON.stringify({ permissions: { allow: ["command(swarm)", ...agyRules()] }, trustedWorkspaces: [] }, null, 2))
}

// biome-ignore lint/suspicious/noExplicitAny: Harness fixtures have different config schemas.
type FixtureConfig = Record<string, any>

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8") || "{}") as FixtureConfig
const mode = (file: string) => statSync(file).mode & 0o777
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`

function tomlWithout(text: string, name: string): string {
  const lines = text.split("\n")
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    if (/^\[/.test(line)) skipping = line.startsWith(`[mcp_servers.${name}]`) || line.startsWith(`[mcp_servers.${name}.`)
    if (!skipping) kept.push(line)
  }
  return kept.join("\n").replace(/\n+$/, "\n")
}

const HELP = "  swarm mcp [--as NAME]\n  swarm hook <harness> [event]\n"

/** --env pairs before the server name, the command after `--` */
function addArgs(args: string[]): { env: Record<string, string>; command: string[] } {
  const dash = args.indexOf("--")
  const env: Record<string, string> = {}
  for (let i = 0; i < dash; i++) if (args[i] === "--env") env[args[i + 1]!.split("=")[0]!] = args[i + 1]!.split("=").slice(1).join("=")
  return { env, command: dash >= 0 ? args.slice(dash + 1) : [] }
}

/** stands in for the harness CLIs: edits the fixture files the way each one does (agy resets the file mode, grok and codex rewrite the whole entry) */
function fakeRun(f: Fixture, options: { relayHelp?: (bin: string) => string; fail?: string } = {}) {
  return (argv: string[], cwd?: string): RunResult => {
    f.calls.push(argv)
    f.cwds.push(cwd)
    const [cli, ...args] = argv
    const name = basename(cli!)
    if (args[0] === "help") return { code: 0, output: options.relayHelp?.(cli!) ?? HELP }
    if (name === "claude" && args[0] === "--version") return { code: 0, output: "2.1.100 (Claude Code)\n" }
    if (options.fail === name && args[1] !== "list" && args[1] !== "get") return { code: 1, output: "boom\n" }
    const { env, command } = addArgs(args)
    switch (name) {
      case "claude": {
        const config = existsSync(f.files.claude) ? readJson(f.files.claude) : {}
        config.mcpServers ??= {}
        const servers = config.mcpServers
        if (args[1] === "add") {
          if (servers[SERVER]) return { code: 1, output: `MCP server ${SERVER} already exists in user config\n` }
          servers[SERVER] = { type: "stdio", command: command[0], args: command.slice(1), env: {} }
        } else if (args[1] === "add-json") servers[args[4]!] = JSON.parse(args[5]!)
        else if (args[1] === "remove") delete servers[SERVER]
        else if (args[1] === "get") {
          const s = servers[SERVER]
          if (!s) return { code: 1, output: `No MCP server named "${SERVER}". Run \`claude mcp add\` to add one.\n` }
          return {
            code: 0,
            output: `${SERVER}:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: stdio\n  Command: ${s.command}\n  Args: ${s.args.join(" ")}\n`,
          }
        }
        writeFileSync(f.files.claude, `${JSON.stringify(config, null, 2)}\n`)
        return { code: 0, output: "" }
      }
      case "codex":
      case "grok": {
        const file = name === "codex" ? f.files.codex : f.files.grok
        const text = existsSync(file) ? readFileSync(file, "utf8") : ""
        if (args[1] === "list") {
          const servers = (Bun.TOML.parse(text) as FixtureConfig).mcp_servers ?? {}
          const argv = (server: string) => [servers[server].command, ...(servers[server].args ?? [])]
          if (name === "grok")
            return {
              code: 0,
              output: Object.keys(servers)
                .map((server) => `  ${server}: ${argv(server).join(" ")}\n`)
                .join(""),
            }
          return {
            code: 0,
            output: `Name  Command  Args  Env  Cwd  Status  Auth\n${Object.keys(servers)
              .map((server) => `${server}  ${servers[server].command}  ${(servers[server].args ?? []).join(" ")}  -  -  enabled  Unsupported\n`)
              .join("")}`,
          }
        }
        const without = tomlWithout(text, SERVER)
        const envTable = Object.keys(env).length
          ? `\n[mcp_servers.${SERVER}.env]\n${Object.entries(env)
              .map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`)
              .join("")}`
          : ""
        writeFileSync(
          file,
          args[1] === "add"
            ? `${without}\n[mcp_servers.${SERVER}]\ncommand = ${JSON.stringify(command[0])}\nargs = ${JSON.stringify(command.slice(1))}\n${envTable}`
            : without,
        )
        return { code: 0, output: "" }
      }
      case "agy": {
        const config = readJson(f.files.agy)
        config.mcpServers ??= {}
        const servers = config.mcpServers
        if (args[1] === "list")
          return {
            code: 0,
            output:
              Object.keys(servers)
                .map((server) => `${server}  stdio  enabled  ${[servers[server].command, ...servers[server].args].join(" ")}\n`)
                .join("") || "No MCP servers configured.\n",
          }
        if (args[1] === "add") servers[SERVER] = { args: command.slice(1), command: command[0], disabled: false, ...(Object.keys(env).length ? { env } : {}) }
        else delete servers[SERVER]
        writeFileSync(f.files.agy, `${JSON.stringify(config, null, 2)}\n`)
        chmodSync(f.files.agy, 0o644)
        return { code: 0, output: "" }
      }
      case "opencode": {
        let servers: Record<string, unknown>
        try {
          servers = readJson(f.files.opencode).mcp ?? {}
        } catch {
          return { code: 1, output: "Config file is not valid JSON\n" }
        }
        return {
          code: 0,
          output: Object.keys(servers)
            .map((server) => `\x1b[0m●  ✓ ${server} \x1b[90mconnected\n`)
            .join(""),
        }
      }
      case "muse": {
        if (args[0] !== "plugins") break
        const installed = existsSync(f.files.museInstalled) ? readJson(f.files.museInstalled) : { version: 1, plugins: {} }
        if (args[1] === "list") return { code: 0, output: JSON.stringify({ plugins: Object.values(installed.plugins).map((record) => ({ record })) }) }
        if (args[1] === "inspect") {
          const record = installed.plugins[args[2]!]
          if (!record) return { code: 1, output: `plugin \`${args[2]}\` is not installed\n` }
          return { code: 0, output: JSON.stringify({ runtime_capabilities: [{ status: record.reviewed ? "trusted_enabled" : "review_needed" }] }) }
        }
        if (args[1] === "install") {
          const manifest = readFileSync(join(args[2]!, ".muse-plugin", "plugin.json"), "utf8")
          installed.plugins[SERVER] = {
            id: SERVER,
            enabled: installed.plugins[SERVER]?.enabled ?? true,
            trust: "user-local",
            source: { provenance: "native-local", path: args[2] },
            manifest_sha256: sha(manifest),
            reviewed: false,
          }
        } else if (args[1] === "enable") {
          if (!installed.plugins[args[2]!]) return { code: 1, output: `plugin \`${args[2]}\` is not installed\n` }
          installed.plugins[args[2]!].enabled = true
        } else if (args[1] === "approve") {
          if (!installed.plugins[args[2]!]) return { code: 1, output: `plugin \`${args[2]}\` is not installed\n` }
          installed.plugins[args[2]!].reviewed = true
        } else if (args[1] === "remove") {
          if (!installed.plugins[args[2]!]) return { code: 1, output: `plugin \`${args[2]}\` is not installed\n` }
          delete installed.plugins[args[2]!]
        }
        put(f.files.museInstalled, JSON.stringify(installed), 0o644)
        return { code: 0, output: "" }
      }
    }
    return { code: 127, output: `unexpected ${argv.join(" ")}\n` }
  }
}

function setup(f: Fixture, options: SetupOptions = {}, run = fakeRun(f), which = (name: string) => (name === "swarm" ? f.swarm : undefined), env = f.env) {
  const lines: string[] = []
  const code = relaySetup(options, { env, cwd: join(f.home, "work"), out: (line) => lines.push(line), now: new Date(2026, 9, 15, 12, 0, 0), which, run })
  return { code, text: lines.join("\n") }
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isSymbolicLink()) files[path] = `-> ${realpathSync(path)}`
      else files[path] = `${mode(path).toString(8)} ${readFileSync(path, "utf8")}`
    }
  }
  walk(root)
  return files
}

const mutating = (f: Fixture) => f.calls.filter((argv) => ["add", "add-json", "remove", "install", "enable", "approve"].includes(argv[2]!))
const userHooks = (f: Fixture) => ({
  claude: join(f.home, ".claude", "settings.json"),
  codex: join(f.home, ".codex", "hooks.json"),
  opencode: join(f.home, ".config", "opencode", "plugin", "scp.ts"),
  agy: join(f.home, ".gemini", "config", "hooks.json"),
  muse: join(f.home, ".config", "scp", "muse-plugin", ".muse-plugin", "plugin.json"),
})
const museDir = (f: Fixture) => join(f.home, ".config", "scp", "muse-plugin")
const argvOf = (f: Fixture, harness: string) => [f.swarm, "mcp", "--harness", harness]

describe("relay setup", () => {
  test("the dry run prints a step per harness, mounting PATH's swarm by its path, and writes nothing", () => {
    const f = fixture()
    const before = snapshot(f.home)
    const { code, text } = setup(f)
    expect(code).toBe(0)
    expect(snapshot(f.home)).toEqual(before)
    expect(f.calls.map((argv) => argv.slice(1).join(" "))).toEqual(["help --all"])
    expect(text).toContain("dry run, nothing is written")
    expect(text).toContain("mounts run: ~/bin/swarm (swarm on PATH, by that path, so a harness started without your PATH finds it)")
    expect(text).toContain(`$ claude mcp add --scope user scp -- ${f.swarm} mcp --harness claude`)
    expect(text).toContain(`$ codex mcp add scp -- ${f.swarm} mcp --harness codex`)
    expect(text).toContain(`$ grok mcp add --scope user scp -- ${f.swarm} mcp --harness grok`)
    expect(text).toContain(`$ agy mcp add scp -- ${f.swarm} mcp --harness agy`)
    expect(text).toContain(`mcp.scp = ${JSON.stringify({ type: "local", command: argvOf(f, "opencode"), enabled: true })}`)
    expect(text).toContain(`mcpServers.scp = ${JSON.stringify({ type: "stdio", command: f.swarm, args: argvOf(f, "muse").slice(1), mode: "optional" })}`)
    expect(text).toContain(`add ${RULES} permissions.allow rules to ~/.gemini/antigravity-cli/settings.json`)
    expect(text).toContain("hooks: merge the swarm hooks into ~/.claude/settings.json")
    expect(text).toContain("12 changes planned")
    expect(
      text
        .split("\n")
        .filter((line) => !line.startsWith("      "))
        .join("\n"),
    ).not.toContain(f.home)
  })

  test("--write mounts every harness, keeps other keys, their order, comments and modes, and backs each file up", () => {
    const f = fixture()
    const before = snapshot(f.home)
    const { code, text } = setup(f, { write: true })
    expect(code).toBe(0)
    const claude = readJson(f.files.claude)
    expect(Object.keys(claude)).toEqual(["numStartups", "mcpServers", "projects"])
    expect(claude.mcpServers).toEqual({
      other: { type: "stdio", command: "x", args: [] },
      [SERVER]: { type: "stdio", command: f.swarm, args: ["mcp", "--harness", "claude", "--channels"], env: {} },
    })
    const codex = readFileSync(f.files.codex, "utf8")
    expect(codex).toStartWith('# keep me\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "foo"\n')
    expect((Bun.TOML.parse(codex) as FixtureConfig).mcp_servers[SERVER]).toEqual({ command: f.swarm, args: ["mcp", "--harness", "codex"] })
    expect((Bun.TOML.parse(readFileSync(f.files.grok, "utf8")) as FixtureConfig).mcp_servers[SERVER].args).toEqual(["mcp", "--harness", "grok"])
    const opencode = readJson(f.files.opencode)
    expect(Object.keys(opencode)).toEqual(["$schema", "provider", "mcp"])
    expect(opencode.mcp[SERVER]).toEqual({ type: "local", command: argvOf(f, "opencode"), enabled: true })
    expect(readFileSync(f.files.opencodec, "utf8")).toBe('{ "$schema": "https://opencode.ai/config.json" }\n')
    const muse = readFileSync(f.files.muse, "utf8")
    expect(Object.keys(JSON.parse(muse))).toEqual(["schema_version", "tui", "contributor_mode_enabled", "mcpServers"])
    expect(muse).toContain('\n    "tui": {\n        "theme": "dark"\n    },')
    expect(JSON.parse(muse).mcpServers[SERVER]).toEqual({ type: "stdio", command: f.swarm, args: ["mcp", "--harness", "muse"], mode: "optional" })
    expect(readJson(f.files.agy).mcpServers[SERVER]).toEqual({ args: ["mcp", "--harness", "agy"], command: f.swarm, disabled: false })
    expect(readJson(f.files.agySettings)).toEqual({ permissions: { allow: ["command(swarm)", ...agyRules()] }, trustedWorkspaces: [] })
    expect(agyRules()).toContain("mcp(scp/relay_send)")
    for (const [file, perms] of [
      [f.files.claude, 0o600],
      [f.files.codex, 0o600],
      [f.files.grok, 0o600],
      [f.files.opencode, 0o600],
      [f.files.muse, 0o644],
      [f.files.agy, 0o600],
      [f.files.agySettings, 0o600],
    ] as const) {
      expect(mode(file)).toBe(perms)
      const saved = `${file}.bak-20261015120000`
      expect(snapshot(dirname(file))[saved]).toBe(before[file])
    }
    expect(text).toContain("claude: mounted (claude mcp get scp: Status: ✔ Connected)")
    expect(text).toContain("opencode: mounted (opencode mcp list: ●  ✓ scp connected)")
    for (const harness of ["codex", "grok", "agy"])
      expect(text).toContain(`\n  ${harness}: configured (${harness} mcp list lists it; ${harness} does not start servers to check them)`)
    expect(text).toContain(`agy permissions: ${RULES} of ${RULES} relay tool rules`)
    expect(text).toContain("muse: configured in ~/.config/muse/settings.json")
  })

  test("a second --write changes nothing and takes no backups", () => {
    const f = fixture()
    expect(setup(f, { write: true, hooks: true }).code).toBe(0)
    const before = snapshot(f.home)
    f.calls.length = 0
    const { code, text } = setup(f, { write: true, hooks: true })
    expect(code).toBe(0)
    expect(mutating(f)).toEqual([])
    expect(snapshot(f.home)).toEqual(before)
    expect(text).toContain("everything is in place; nothing to do")
    expect(text).not.toContain("restart sessions")
    expect(text).toContain(`permissions: ${RULES} relay tool rules already in`)
    expect(setup(f).text).toContain("everything is in place; nothing to do")
  })

  test("an outdated mount is replaced: claude removed then added, the others updated in place", () => {
    const f = fixture()
    const claude = readJson(f.files.claude)
    claude.mcpServers[SERVER] = { type: "stdio", command: "/old/swarm", args: ["mcp"], env: {} }
    writeFileSync(f.files.claude, JSON.stringify(claude))
    writeFileSync(f.files.codex, `${readFileSync(f.files.codex, "utf8")}\n[mcp_servers.${SERVER}]\ncommand = "/old/swarm"\nargs = ["mcp"]\n`)
    const dry = setup(f).text
    expect(dry).toContain("update scp (now: /old/swarm mcp) in ~/.claude.json")
    expect(setup(f, { write: true }).code).toBe(0)
    const claudeCalls = mutating(f).filter((argv) => basename(argv[0]!) === "claude")
    expect(claudeCalls.map((argv) => argv[2])).toEqual(["remove", "add-json"])
    expect(readJson(f.files.claude).mcpServers[SERVER].command).toBe(f.swarm)
    expect((Bun.TOML.parse(readFileSync(f.files.codex, "utf8")) as FixtureConfig).mcp_servers[SERVER].command).toBe(f.swarm)
  })

  test("--hooks installs the relay hooks at user scope for claude, codex, opencode, agy and muse", () => {
    const f = fixture()
    const { code, text } = setup(f, { write: true, hooks: true })
    expect(code).toBe(0)
    const hooks = userHooks(f)
    expect(JSON.stringify(readJson(hooks.claude).hooks.PostToolUse)).toContain("swarm hook claude")
    expect(JSON.stringify(readJson(hooks.claude).hooks.UserPromptSubmit)).toContain("swarm hook claude")
    expect(text.trimEnd().split("\n").at(-1)).toBe("restart sessions started before setup: harnesses read hooks only at session start")
    expect(JSON.stringify(readJson(hooks.codex).hooks.SessionEnd)).toContain("swarm hook codex")
    expect(readFileSync(hooks.opencode, "utf8")).toBe(opencodePlugin())
    expect(readJson(hooks.agy)[SERVER].enabled).toBe(true)
    expect(readJson(hooks.muse)).toEqual(musePlugin())
    expect(f.calls).toContainEqual([join(f.home, ".local/bin/muse"), "plugins", "install", museDir(f), "--scope", "user"])
    expect(f.calls).toContainEqual([join(f.home, ".local/bin/muse"), "plugins", "approve", SERVER])
    expect(readJson(f.files.museInstalled).plugins[SERVER].manifest_sha256).toBe(sha(readFileSync(hooks.muse, "utf8")))
    expect(text).toContain("Codex runs them after you review them in /hooks")
    expect(text).toContain("Grok runs the Claude Code hooks")
    expect(text).toContain("approves its hooks: a headless muse exec runs no hook Muse holds for review")
    expect(text).toContain("muse hooks: in place in ~/.config/scp/muse-plugin/.muse-plugin/plugin.json")
    expect(text).toContain("muse hooks: installed (muse plugins list)")
    expect(text).toContain(
      "hooks run: ~/bin/swarm for claude and codex, whose desktop apps start them without your PATH; swarm from each harness's PATH for the others (~/bin/swarm here)",
    )
    expect(readFileSync(claudeVersionFile(f.env), "utf8")).toBe("2.1.100\n")
  })

  test("--undo removes what setup added and our hooks, after a dry run that writes nothing", () => {
    const f = fixture()
    expect(setup(f, { write: true, hooks: true }).code).toBe(0)
    expect(existsSync(manifestFile(f.env))).toBe(true)
    const settings = userHooks(f).claude
    const own = readJson(settings)
    own.hooks.Stop.push({ hooks: [{ type: "command", command: "say done" }] })
    own.theme = "dark"
    writeFileSync(settings, JSON.stringify(own, null, 2))
    const before = snapshot(f.home)
    f.calls.length = 0
    const dry = setup(f, { undo: true, hooks: true })
    expect(dry.code).toBe(0)
    expect(snapshot(f.home)).toEqual(before)
    expect(mutating(f)).toEqual([])
    expect(dry.text).toContain(`remove ${RULES} permissions.allow rules from ~/.gemini/antigravity-cli/settings.json`)

    const { code, text } = setup(f, { undo: true, hooks: true, write: true })
    expect(code).toBe(0)
    expect(readJson(f.files.claude).mcpServers).toEqual({ other: { type: "stdio", command: "x", args: [] } })
    expect(Object.keys((Bun.TOML.parse(readFileSync(f.files.codex, "utf8")) as FixtureConfig).mcp_servers)).toEqual(["other"])
    expect((Bun.TOML.parse(readFileSync(f.files.grok, "utf8")) as FixtureConfig).mcp_servers?.[SERVER]).toBeUndefined()
    expect(readJson(f.files.opencode).mcp).toEqual({})
    expect(readJson(f.files.opencode).provider).toEqual({ x: {} })
    expect(readJson(f.files.muse)).toEqual({ schema_version: 1, tui: { theme: "dark" }, contributor_mode_enabled: false, mcpServers: {} })
    expect(readJson(f.files.agy).mcpServers).toEqual({})
    expect(readJson(f.files.agySettings).permissions.allow).toEqual(["command(swarm)"])
    const after = readJson(settings)
    expect(after.theme).toBe("dark")
    expect(after.hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "say done" }] }] })
    expect(existsSync(userHooks(f).opencode)).toBe(false)
    expect(readJson(userHooks(f).agy)).toEqual({})
    expect(existsSync(userHooks(f).muse)).toBe(false)
    expect(f.calls).toContainEqual([join(f.home, ".local/bin/muse"), "plugins", "remove", SERVER])
    expect(readJson(f.files.museInstalled).plugins).toEqual({})
    expect(text).toContain("claude: removed (claude mcp get scp)")
    expect(text).toContain("muse: removed in ~/.config/muse/settings.json")
    expect(text).toContain("muse hooks: removed (muse plugins list)")
    expect(existsSync(manifestFile(f.env))).toBe(false)
    expect(setup(f, { undo: true, hooks: true }).text).toContain("nothing to remove")
  })

  test("without swarm on PATH it needs an absolute --bin, mounts that path and skips the hooks", () => {
    const f = fixture()
    const none = () => undefined
    expect(() => setup(f, {}, fakeRun(f), none)).toThrow("swarm is not on PATH: pass --bin")
    expect(() => setup(f, { bin: "bin/swarm" }, fakeRun(f), none)).toThrow("--bin takes an absolute path")
    expect(() => setup(f, { bin: join(f.home, "nope") }, fakeRun(f), none)).toThrow("is not an executable file")
    const { code, text } = setup(f, { bin: f.swarm, write: true, hooks: true }, fakeRun(f), none)
    expect(code).toBe(1)
    expect(text).toContain("1 item marked ! need a fix by hand or a rerun")
    expect(text).toContain("mounts run: ~/bin/swarm (from --bin; they break if that file moves)")
    expect(text).toContain("hooks are skipped until it is there")
    expect(readJson(f.files.claude).mcpServers[SERVER].command).toBe(f.swarm)
    expect(readJson(f.files.opencode).mcp[SERVER].command[0]).toBe(f.swarm)
    expect(existsSync(userHooks(f).claude)).toBe(false)
  })

  test("PATH's swarm is mounted by the path PATH finds, not the file a symlink there points at", () => {
    const f = fixture()
    const real = join(f.home, ".local", "share", "swarm", "swarm")
    put(real, "#!/bin/sh\n", 0o755)
    const link = join(f.home, ".local", "bin", "swarm")
    symlinkSync(real, link)
    const { text } = setup(f, { harness: "claude" }, fakeRun(f), (name) => (name === "swarm" ? link : undefined))
    expect(text).toContain(
      "mounts run: ~/.local/bin/swarm (swarm on PATH, by that path and not its target ~/.local/share/swarm/swarm, so a harness started without your PATH finds it)",
    )
    expect(text).toContain(`-- ${link} mcp --harness claude`)
  })

  test("hooks are skipped when PATH's swarm has no swarm hook, even with a --bin that has one", () => {
    const f = fixture()
    const other = join(f.home, "build", "swarm")
    put(other, "#!/bin/sh\n", 0o755)
    const run = fakeRun(f, { relayHelp: (bin) => (bin === other ? HELP : "usage: swarm session ...\n") })
    const { code, text } = setup(f, { bin: other, hooks: true, write: true }, run)
    expect(code).toBe(1)
    expect(text).toContain("has no `swarm hook`: hooks are skipped until it does")
    expect(existsSync(userHooks(f).claude)).toBe(false)
    expect(readJson(f.files.claude).mcpServers[SERVER].command).toBe(other)
  })

  test("a swarm without the relay shim is refused for --write, and the dry run says so", () => {
    const f = fixture()
    const before = snapshot(f.home)
    const run = fakeRun(f, { relayHelp: () => "usage: swarm session ...\n" })
    expect(setup(f, {}, run).text).toContain("has no `swarm mcp`")
    expect(setup(f, { write: true }, run).code).toBe(1)
    expect(snapshot(f.home)).toEqual(before)
  })

  test("a Muse file with mcp_servers and an unreadable OpenCode file are left alone; the rest is set up", () => {
    const f = fixture()
    writeFileSync(f.files.muse, JSON.stringify({ schema_version: 1, mcp_servers: {} }))
    writeFileSync(f.files.opencode, "{ // a comment\n}")
    const muse = readFileSync(f.files.muse, "utf8")
    const { code, text } = setup(f, { write: true })
    expect(text).toContain("Muse drops every MCP server when both mcp_servers and mcpServers exist")
    expect(text).toMatch(/opencode:\n {2}! mcp: skipped, ~\/\.config\/opencode\/opencode\.json/)
    expect(text).toContain("2 items marked ! need a fix by hand or a rerun")
    expect(readFileSync(f.files.muse, "utf8")).toBe(muse)
    expect(readFileSync(f.files.opencode, "utf8")).toBe("{ // a comment\n}")
    expect(readJson(f.files.claude).mcpServers[SERVER]).toBeDefined()
    expect(code).toBe(1)
    expect(text).toContain("opencode: failed: opencode mcp list does not list scp")
  })

  test("a JSON file written between the plan and the write keeps that write", () => {
    const f = fixture()
    const fake = fakeRun(f)
    const run = (argv: string[], cwd?: string) => {
      if (basename(argv[0]!) === "claude" && argv[2] === "add")
        writeFileSync(f.files.muse, JSON.stringify({ ...readJson(f.files.muse), tui: { theme: "light" } }, null, 4))
      return fake(argv, cwd)
    }
    expect(setup(f, { write: true }, run).code).toBe(0)
    const muse = readJson(f.files.muse)
    expect(muse.tui).toEqual({ theme: "light" })
    expect(muse.mcpServers[SERVER]).toBeDefined()
  })

  test("a failing harness CLI is reported, keeps its backup, is not recorded, and does not stop the others", () => {
    const f = fixture()
    const { code, text } = setup(f, { write: true }, fakeRun(f, { fail: "codex" }))
    expect(code).toBe(1)
    expect(text).toContain("codex mcp: FAILED, codex mcp add exited 1: boom")
    expect(existsSync(`${f.files.codex}.bak-20261015120000`)).toBe(true)
    expect(readJson(f.files.claude).mcpServers[SERVER]).toBeDefined()
    expect(text).toContain("codex: failed: codex mcp list does not list scp")
    expect(
      readJson(manifestFile(f.env))
        .added.filter((item: Added) => item.kind === "mcp")
        .map((item: Added) => item.harness),
    ).not.toContain("codex")
  })

  test("--harness limits the run to one harness; PATH and known locations both detect it", () => {
    const f = fixture()
    const { text } = setup(f, { harness: "agy" })
    expect(text).toContain("found: agy (~/.local/bin/agy)")
    expect(text).not.toContain("claude:")
    expect(text).toContain("3 changes planned")
    const onPath = setup(f, { harness: "claude" }, fakeRun(f), (name) =>
      name === "swarm" ? f.swarm : name === "claude" ? "/opt/elsewhere/claude" : undefined,
    ).text
    expect(onPath).toContain("found: claude (/opt/elsewhere/claude)")
    expect(() => setup(f, { harness: "gemini" })).toThrow("--harness is one of")
    rmHarness(f, ".local/bin/muse")
    expect(setup(f).text).toContain("not installed: muse")
  })

  test("a symlinked settings file is written through the link, and the link stays", () => {
    const f = fixture()
    const real = join(f.home, "dotfiles", "muse.json")
    put(real, readFileSync(f.files.muse, "utf8"), 0o640)
    Bun.spawnSync(["rm", f.files.muse])
    symlinkSync(real, f.files.muse)
    expect(setup(f, { write: true, harness: "muse" }).code).toBe(0)
    expect(readJson(real).mcpServers[SERVER]).toBeDefined()
    expect(mode(real)).toBe(0o640)
    expect(existsSync(`${real}.bak-20261015120000`)).toBe(true)
    expect(readFileSync(f.files.muse, "utf8")).toBe(readFileSync(real, "utf8"))
  })
})

describe("relay setup on a lived-in HOME", () => {
  test("updates keep each entry's own fields: JSON entries merged, CLI ones carry env, and the plan lists what a CLI drops without printing env values", () => {
    const f = fixture()
    lived(f)
    const dry = setup(f).text
    expect(dry).not.toContain("secret-name")
    expect(dry).toContain(
      `$ claude mcp add-json --scope user scp '${JSON.stringify({ type: "stdio", command: f.swarm, args: ["mcp", "--harness", "claude", "--channels"], env: { SCP_NAME: "<kept>" } })}'`,
    )
    expect(dry).toContain(`$ codex mcp add --env SCP_NAME=<kept> scp -- ${f.swarm} mcp --harness codex`)
    expect(dry).toContain("mcp: codex mcp add writes the entry anew and drops startup_timeout_sec from it; the backup keeps them")
    expect(dry).toContain("mcp: agy mcp add writes the entry anew and drops timeout from it; the backup keeps them")
    expect(dry).toContain(`mcp.scp.command = ${JSON.stringify(argvOf(f, "opencode"))}, mcp.scp.enabled = true (its other keys kept)`)
    expect(dry).toContain("mcp: warning, a local-scope scp for /tmp/proj (in ~/.claude.json): in that project it is used instead of the user mount")
    expect(dry).toContain(`permissions: ${RULES} relay tool rules already in`)

    expect(setup(f, { write: true }).code).toBe(0)
    expect(readJson(f.files.claude).mcpServers[SERVER]).toEqual({
      type: "stdio",
      command: f.swarm,
      args: ["mcp", "--harness", "claude", "--channels"],
      env: { SCP_NAME: "cc-secret-name" },
    })
    expect((Bun.TOML.parse(readFileSync(f.files.codex, "utf8")) as FixtureConfig).mcp_servers[SERVER]).toEqual({
      command: f.swarm,
      args: ["mcp", "--harness", "codex"],
      env: { SCP_NAME: "cx-secret-name" },
    })
    expect(readJson(f.files.opencode).mcp[SERVER]).toEqual({
      type: "local",
      command: argvOf(f, "opencode"),
      enabled: true,
      environment: { SCP_NAME: "oc-secret-name" },
      timeout: 9000,
    })
    expect(readJson(f.files.muse).mcpServers[SERVER]).toEqual({
      type: "stdio",
      command: f.swarm,
      args: ["mcp", "--harness", "muse"],
      mode: "required",
      env: { A: "b" },
    })
  })

  test("a remote scp becomes a local one: its type set and its url and headers dropped, and the plan says so", () => {
    const f = fixture()
    const claude = readJson(f.files.claude)
    claude.mcpServers[SERVER] = { type: "http", url: "https://relay.example/mcp", headers: { Authorization: "Bearer cc-secret" } }
    writeFileSync(f.files.claude, JSON.stringify(claude))
    const opencode = readJson(f.files.opencode)
    opencode.mcp = {
      [SERVER]: { type: "remote", url: "https://relay.example/mcp", headers: { Authorization: "Bearer oc-secret" }, enabled: true, timeout: 9000 },
    }
    writeFileSync(f.files.opencode, JSON.stringify(opencode))
    const muse = readJson(f.files.muse)
    muse.mcpServers = { [SERVER]: { type: "http", url: "https://relay.example/mcp", mode: "required" } }
    writeFileSync(f.files.muse, JSON.stringify(muse))
    const dry = setup(f).text
    expect(dry).not.toContain("secret")
    expect(dry).toContain("(its other keys kept, and url, headers dropped)")
    expect(setup(f, { write: true }).code).toBe(0)
    expect(readJson(f.files.claude).mcpServers[SERVER]).toEqual({ type: "stdio", command: f.swarm, args: ["mcp", "--harness", "claude", "--channels"] })
    expect(readJson(f.files.opencode).mcp[SERVER]).toEqual({ type: "local", command: argvOf(f, "opencode"), enabled: true, timeout: 9000 })
    expect(readJson(f.files.muse).mcpServers[SERVER]).toEqual({ type: "stdio", command: f.swarm, args: ["mcp", "--harness", "muse"], mode: "required" })
  })

  test("a disabled CLI-written mount is re-added enabled, and the plan says so", () => {
    const f = fixture()
    writeFileSync(
      f.files.codex,
      `${readFileSync(f.files.codex, "utf8")}\n[mcp_servers.${SERVER}]\ncommand = "${f.swarm}"\nargs = ["mcp", "--harness", "codex"]\nenabled = false\n`,
    )
    expect(setup(f, { harness: "codex" }).text).toContain("update scp (now: ~/bin/swarm mcp --harness codex, disabled; setup enables it)")
  })

  test("--undo removes only what setup added: mounts and agy rules that were there before stay", () => {
    const f = fixture()
    lived(f)
    writeFileSync(f.files.grok, "[cli]\nauto_update = false\n")
    expect(setup(f, { write: true, hooks: false }).code).toBe(0)
    expect(readJson(manifestFile(f.env)).added).toEqual([{ harness: "grok", kind: "mcp", file: f.files.grok }])
    const { code, text } = setup(f, { undo: true, write: true, hooks: false })
    expect(code).toBe(0)
    expect((Bun.TOML.parse(readFileSync(f.files.grok, "utf8")) as FixtureConfig).mcp_servers?.[SERVER]).toBeUndefined()
    expect(readJson(f.files.claude).mcpServers[SERVER].command).toBe(f.swarm)
    expect(readJson(f.files.agySettings).permissions.allow).toEqual(["command(swarm)", ...agyRules()])
    expect(text).toContain("mcp: keeps the scp in ~/.claude.json, which setup did not add")
    expect(text).toContain(`permissions: keeps ${RULES} relay tool rules in ~/.gemini/antigravity-cli/settings.json that setup did not add`)
    expect(existsSync(manifestFile(f.env))).toBe(false)
  })

  test("agy rules from an older tool list get the new tools added once, and --undo removes only those", () => {
    const f = fixture()
    lived(f)
    const added = agyRules().filter((rule) => !OLD_RULES.includes(rule))
    expect(added.length).toBeGreaterThan(0)
    writeFileSync(f.files.agySettings, JSON.stringify({ permissions: { allow: ["command(swarm)", ...OLD_RULES] }, trustedWorkspaces: [] }, null, 2))
    expect(setup(f).text).toContain(`add ${added.length} permissions.allow rules to ~/.gemini/antigravity-cli/settings.json`)
    expect(setup(f, { write: true }).code).toBe(0)
    expect(setup(f, { write: true }).code).toBe(0)
    expect(readJson(f.files.agySettings).permissions.allow).toEqual(["command(swarm)", ...OLD_RULES, ...added])
    expect(readJson(manifestFile(f.env)).added).toContainEqual({ harness: "agy", kind: "rules", file: f.files.agySettings, rules: added })
    expect(setup(f, { undo: true, write: true }).code).toBe(0)
    expect(readJson(f.files.agySettings).permissions.allow).toEqual(["command(swarm)", ...OLD_RULES])
  })

  test("rules an older setup added are joined by the new tools' rules, and --undo removes all of them", () => {
    const f = fixture()
    expect(setup(f, { write: true }).code).toBe(0)
    const settings = readJson(f.files.agySettings)
    settings.permissions.allow = ["command(swarm)", ...OLD_RULES]
    writeFileSync(f.files.agySettings, JSON.stringify(settings, null, 2))
    const manifest = readJson(manifestFile(f.env))
    manifest.added.find((item: Added) => item.kind === "rules")!.rules = OLD_RULES
    writeFileSync(manifestFile(f.env), JSON.stringify(manifest, null, 2))
    expect(setup(f, { write: true }).code).toBe(0)
    expect(readJson(f.files.agySettings).permissions.allow).toEqual(["command(swarm)", ...OLD_RULES, ...agyRules().filter((rule) => !OLD_RULES.includes(rule))])
    expect(new Set(readJson(manifestFile(f.env)).added.find((item: Added) => item.kind === "rules")!.rules)).toEqual(new Set(agyRules()))
    expect(setup(f, { undo: true, write: true }).code).toBe(0)
    expect(readJson(f.files.agySettings).permissions.allow).toEqual(["command(swarm)"])
  })
})

const OLD_RULES = ["relay_whoami", "relay_list", "relay_send", "relay_reply", "relay_inbox", "relay_ask", "relay_ask_wait", "relay_set_status"].map(
  (tool) => `mcp(${SERVER}/${tool})`,
)

describe("relay setup hooks options", () => {
  test("--block-stop-on-unread writes the holding stop hooks everywhere, and a rerun without it keeps them", () => {
    const f = fixture()
    expect(() => setup(f, { blockStop: true, hooks: false })).toThrow("--block-stop-on-unread goes with the hooks: not with --no-hooks or --undo")
    expect(() => setup(f, { blockStop: true, undo: true })).toThrow("--block-stop-on-unread goes with the hooks: not with --no-hooks or --undo")
    expect(setup(f, { write: true, hooks: true, blockStop: true }).code).toBe(0)
    const hooks = userHooks(f)
    expect(JSON.stringify(readJson(hooks.claude).hooks.Stop)).toContain("swarm hook claude --block-stop-on-unread")
    expect(JSON.stringify(readJson(hooks.codex).hooks.Stop)).toContain("swarm hook codex --block-stop-on-unread")
    expect(readFileSync(hooks.opencode, "utf8")).toBe(opencodePlugin({ blockStop: true }))
    expect(JSON.stringify(readJson(hooks.agy)[SERVER].Stop)).toContain("--block-stop-on-unread")
    expect(readJson(hooks.muse)).toEqual(musePlugin({ blockStop: true }))
    const before = snapshot(f.home)
    f.calls.length = 0
    const { code, text } = setup(f, { write: true, hooks: true })
    expect(code).toBe(0)
    expect(mutating(f)).toEqual([])
    expect(snapshot(f.home)).toEqual(before)
    expect(text).toContain("hooks: up to date in ~/.claude/settings.json (it keeps --block-stop-on-unread, which the file has)")
  })

  test("a plain hooks file switches to the holding stop only with the flag, and the plan says so", () => {
    const f = fixture()
    expect(setup(f, { write: true, hooks: true }).code).toBe(0)
    const { text } = setup(f, { hooks: true, blockStop: true, harness: "claude" })
    expect(text).toContain("merge the swarm hooks into ~/.claude/settings.json, with --block-stop-on-unread")
  })

  test("SCP_TRANSPORT=cloud skips the hooks at plan time, marked !", () => {
    const f = fixture()
    const { code, text } = setup(f, { write: true, hooks: true }, fakeRun(f), undefined, { ...f.env, SCP_TRANSPORT: "cloud" })
    expect(code).toBe(1)
    expect(text).toContain("! the hooks report to the local broker, and SCP_TRANSPORT=cloud bypasses it: hooks are skipped")
    expect(existsSync(userHooks(f).claude)).toBe(false)
    expect(readJson(f.files.claude).mcpServers[SERVER]).toBeDefined()
  })

  test("a project that already runs our Claude hooks is warned about", () => {
    const f = fixture()
    put(
      join(f.home, "work", ".claude", "settings.local.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "swarm hook claude" }] }] } }),
      0o644,
    )
    expect(setup(f, { hooks: true, harness: "claude" }).text).toContain("hooks: warning, ~/work/.claude/settings.local.json already runs the swarm hooks")
  })

  test("hooks a grok-only run added are undone with claude's once claude is installed, and kept by a grok-only undo", () => {
    const f = fixture()
    rmHarness(f, ".local/bin/claude")
    expect(setup(f, { write: true, hooks: true, harness: "grok" }).code).toBe(0)
    put(join(f.home, ".local/bin/claude"), "#!/bin/sh\n", 0o755)
    expect(setup(f, { write: true, hooks: true, harness: "claude" }).code).toBe(0)
    const grok = setup(f, { undo: true, hooks: true, write: true, harness: "grok" })
    expect(grok.text).toContain("hooks: keeps the hooks in ~/.claude/settings.json, which Claude Code runs too; undo them with --harness claude")
    expect(JSON.stringify(readJson(userHooks(f).claude).hooks)).toContain("swarm hook claude")
    expect(setup(f, { undo: true, hooks: true, write: true, harness: "claude" }).code).toBe(0)
    expect(readJson(userHooks(f).claude).hooks).toEqual({})
    expect(existsSync(manifestFile(f.env))).toBe(false)
  })

  test("a Muse plugin whose hooks wait for review is not up to date: setup approves them", () => {
    const f = fixture()
    expect(setup(f, { write: true, hooks: true, harness: "muse" }).code).toBe(0)
    const installed = readJson(f.files.museInstalled)
    installed.plugins[SERVER].reviewed = false
    writeFileSync(f.files.museInstalled, JSON.stringify(installed))
    const dry = setup(f, { hooks: true, harness: "muse" }).text
    expect(dry).toContain("hooks: approve the hooks of the swarm plugin ~/.config/scp/muse-plugin/.muse-plugin/plugin.json, which Muse holds for review")
    expect(dry).toContain(`$ muse plugins approve ${SERVER}`)
    f.calls.length = 0
    expect(setup(f, { write: true, hooks: true, harness: "muse" }).code).toBe(0)
    expect(mutating(f).map((argv) => argv.slice(1, 3).join(" "))).toEqual(["plugins approve"])
    expect(readJson(f.files.museInstalled).plugins[SERVER].reviewed).toBe(true)
    f.calls.length = 0
    expect(setup(f, { write: true, hooks: true, harness: "muse" }).code).toBe(0)
    expect(mutating(f)).toEqual([])
  })

  test("a Muse plugin recorded under another path to the same plugin directory is up to date", () => {
    const f = fixture()
    expect(setup(f, { write: true, hooks: true, harness: "muse" }).code).toBe(0)
    const link = join(f.home, "plugin-link")
    symlinkSync(museDir(f), link)
    const installed = readJson(f.files.museInstalled)
    installed.plugins[SERVER].source.path = link
    writeFileSync(f.files.museInstalled, JSON.stringify(installed))
    f.calls.length = 0
    const { code, text } = setup(f, { write: true, hooks: true, harness: "muse" })
    expect(code).toBe(0)
    expect(mutating(f)).toEqual([])
    expect(text).toContain("muse hooks: installed (muse plugins list)")
  })

  test("a disabled Muse plugin is not up to date: setup enables it", () => {
    const f = fixture()
    expect(setup(f, { write: true, hooks: true, harness: "muse" }).code).toBe(0)
    const installed = readJson(f.files.museInstalled)
    installed.plugins[SERVER].enabled = false
    writeFileSync(f.files.museInstalled, JSON.stringify(installed))
    const dry = setup(f, { hooks: true, harness: "muse" }).text
    expect(dry).toContain("hooks: enable the swarm plugin ~/.config/scp/muse-plugin/.muse-plugin/plugin.json, which Muse has disabled")
    expect(dry).toContain(`$ muse plugins enable ${SERVER}`)
    f.calls.length = 0
    const { code, text } = setup(f, { write: true, hooks: true, harness: "muse" })
    expect(code).toBe(0)
    expect(mutating(f).map((argv) => argv.slice(1, 3).join(" "))).toEqual(["plugins enable"])
    expect(readJson(f.files.museInstalled).plugins[SERVER].enabled).toBe(true)
    expect(text).toContain("muse hooks: installed (muse plugins list)")
  })

  test("an OpenCode plugin from an earlier swarm is still recognised as ours by --undo", () => {
    const f = fixture()
    expect(setup(f, { write: true, hooks: true, harness: "opencode" }).code).toBe(0)
    const earlier = opencodePlugin().replace("const hook = async", "// an earlier version\nconst hook = async")
    writeFileSync(userHooks(f).opencode, earlier)
    expect(setup(f, { undo: true, hooks: true, write: true, harness: "opencode" }).code).toBe(0)
    expect(existsSync(userHooks(f).opencode)).toBe(false)
    expect(existsSync(manifestFile(f.env))).toBe(false)
  })

  test("grok without claude still gets the Claude Code hooks file it reads, and --undo takes them out", () => {
    const f = fixture()
    rmHarness(f, ".local/bin/claude")
    const { code, text } = setup(f, { write: true, hooks: true, harness: "grok" })
    expect(code).toBe(0)
    expect(text).toContain("merge the swarm hooks into ~/.claude/settings.json (Grok runs the Claude Code hooks; claude is not installed)")
    expect(JSON.stringify(readJson(userHooks(f).claude).hooks)).toContain("swarm hook claude")
    expect(text).toContain("grok hooks: in place in ~/.claude/settings.json")
    expect(setup(f, { undo: true, hooks: true, write: true, harness: "grok" }).code).toBe(0)
    expect(readJson(userHooks(f).claude).hooks).toEqual({})
  })
})

describe("relay setup installs hooks by default", () => {
  test("a plain run installs the hooks, --no-hooks mounts the MCP shim only, and --block-stop-on-unread needs no --hooks", () => {
    const f = fixture()
    const bare = setup(f, { write: true, hooks: false })
    expect(bare.code).toBe(0)
    expect(bare.text).toContain("hooks: not installed (--no-hooks); only the MCP shim is mounted")
    for (const file of Object.values(userHooks(f))) expect(existsSync(file)).toBe(false)
    expect(readJson(f.files.claude).mcpServers[SERVER]).toBeDefined()
    const { code, text } = setup(f, { write: true })
    expect(code).toBe(0)
    expect(readJson(userHooks(f).claude).hooks).toEqual(hookEntries("claude", { launcher: [f.swarm] }))
    expect(readJson(userHooks(f).codex).hooks).toEqual(hookEntries("codex", { launcher: [f.swarm] }))
    expect(readFileSync(userHooks(f).opencode, "utf8")).toBe(opencodePlugin())
    expect(readJson(userHooks(f).muse)).toEqual(musePlugin())
    expect(text).toContain("swarm from each harness's PATH for the others (~/bin/swarm here)")
    expect(setup(f, { blockStop: true, harness: "claude" }).text).toContain(`merge the swarm hooks into ~/.claude/settings.json, with ${BLOCK_STOP}`)
  })

  test("--undo takes the hooks out too, unless --no-hooks", () => {
    const f = fixture()
    expect(setup(f, { write: true }).code).toBe(0)
    expect(setup(f, { undo: true, write: true, hooks: false }).code).toBe(0)
    expect(readJson(f.files.claude).mcpServers[SERVER]).toBeUndefined()
    expect(JSON.stringify(readJson(userHooks(f).claude).hooks)).toContain("swarm hook claude")
    expect(setup(f, { undo: true, write: true }).code).toBe(0)
    expect(readJson(userHooks(f).claude).hooks).toEqual({})
    expect(existsSync(userHooks(f).opencode)).toBe(false)
  })

  test("a stop hook from an earlier swarm without its status line is rewritten with one, which the harness shows while the stop waits", () => {
    const f = fixture()
    expect(setup(f, { write: true }).code).toBe(0)
    for (const harness of ["claude", "codex"] as const) {
      const [stop] = hookEntries(harness, { launcher: [f.swarm] }).Stop![0]!.hooks
      expect(stop!.statusMessage).toBe("waiting for worker messages (swarm)")
      const { statusMessage: _, ...earlier } = stop!
      put(
        userHooks(f)[harness],
        `${JSON.stringify({ hooks: { ...hookEntries(harness, { launcher: [f.swarm] }), Stop: [{ hooks: [earlier] }] } }, null, 2)}\n`,
        0o644,
      )
    }
    expect(setup(f).text).toContain("hooks: merge the swarm hooks into ~/.claude/settings.json")
    expect(setup(f, { write: true }).code).toBe(0)
    expect(readJson(userHooks(f).claude).hooks.Stop).toEqual(hookEntries("claude", { launcher: [f.swarm] }).Stop)
    expect(readJson(userHooks(f).codex).hooks.Stop).toEqual(hookEntries("codex", { launcher: [f.swarm] }).Stop)
  })

  test("hooks with a background stop from an earlier swarm are outdated and rewritten with a foreground one", () => {
    const f = fixture()
    expect(setup(f, { write: true }).code).toBe(0)
    const background = (harness: "claude" | "codex") => ({
      ...hookEntries(harness, { launcher: [f.swarm] }),
      Stop: [{ hooks: [{ type: "command", command: `swarm hook ${harness}`, timeout: 5, async: true }] }],
    })
    put(userHooks(f).claude, `${JSON.stringify({ hooks: background("claude") }, null, 2)}\n`, 0o644)
    put(userHooks(f).codex, `${JSON.stringify({ hooks: background("codex") }, null, 2)}\n`, 0o644)
    const muse = musePlugin() as { capabilities: { hooks: Record<string, unknown>[] } }
    muse.capabilities.hooks = muse.capabilities.hooks.map((hook) => (hook.event === "Stop" ? { ...hook, async: true } : hook))
    put(userHooks(f).muse, `${JSON.stringify(muse, null, 2)}\n`, 0o644)
    const dry = setup(f).text
    expect(dry).toContain("hooks: merge the swarm hooks into ~/.claude/settings.json")
    expect(dry).toContain("hooks: merge the swarm hooks into ~/.codex/hooks.json")
    expect(dry).toContain("hooks: write the swarm plugin ~/.config/scp/muse-plugin/.muse-plugin/plugin.json")
    const { code, text } = setup(f, { write: true })
    expect(code).toBe(0)
    expect(readJson(userHooks(f).claude).hooks.Stop).toEqual(hookEntries("claude", { launcher: [f.swarm] }).Stop)
    expect(readJson(userHooks(f).codex).hooks.Stop).toEqual(hookEntries("codex", { launcher: [f.swarm] }).Stop)
    expect(readJson(userHooks(f).muse)).toEqual(musePlugin())
    expect(text).toContain("claude hooks: in place in ~/.claude/settings.json")
    expect(text).toContain("muse hooks: installed (muse plugins list)")
  })

  test("the CLI flags: --no-hooks, --hooks kept as a no-op, both refused together", () => {
    expect(parseSetupArgs([])).toEqual({})
    expect(parseSetupArgs(["--hooks", "--write"])).toEqual({ write: true })
    expect(parseSetupArgs(["--no-hooks", "--undo"])).toEqual({ hooks: false, undo: true })
    expect(parseSetupArgs(["--block-stop-on-unread"])).toEqual({ blockStop: true })
    expect(() => parseSetupArgs(["--hooks", "--no-hooks"])).toThrow("--hooks and --no-hooks")
    expect(() => parseSetupArgs(["--nope"])).toThrow()
    expect(parseSetupArgs(["--help"])).toBe("help")
  })
})

describe("relay setup symlinks", () => {
  test("a dangling symlink is written through when its directory exists, and refused otherwise or for a CLI-edited file", () => {
    const f = fixture()
    const real = join(f.home, "dotfiles", "muse.json")
    mkdirSync(dirname(real), { recursive: true })
    Bun.spawnSync(["rm", f.files.muse])
    symlinkSync(real, f.files.muse)
    expect(setup(f, { write: true, harness: "muse" }).code).toBe(0)
    expect(readJson(real).mcpServers[SERVER].command).toBe(f.swarm)
    expect(readFileSync(f.files.muse, "utf8")).toBe(readFileSync(real, "utf8"))

    Bun.spawnSync(["rm", f.files.agySettings])
    symlinkSync(join(f.home, "nowhere", "settings.json"), f.files.agySettings)
    Bun.spawnSync(["rm", f.files.claude])
    symlinkSync(join(f.home, "dotfiles", "claude.json"), f.files.claude)
    const { code, text } = setup(f, { write: true })
    expect(code).toBe(1)
    expect(text).toContain(
      "! permissions: skipped, ~/.gemini/antigravity-cli/settings.json is a symlink to ~/nowhere/settings.json, whose directory does not exist",
    )
    expect(text).toContain(
      "! mcp: skipped, ~/.claude.json is a symlink to ~/dotfiles/claude.json, which does not exist, and the harness CLI would replace the link",
    )
    expect(f.calls.some((argv) => basename(argv[0]!) === "claude" && argv[2] === "add")).toBe(false)
    expect(existsSync(join(f.home, "nowhere"))).toBe(false)
  })
})

describe("relay setup verify", () => {
  const f = fixture()
  const reply = (code: number, output: string) => () => ({ code, output })
  const expected = (harness: "codex" | "grok" | "agy" | "claude" | "opencode") => ["swarm", "mcp", "--harness", harness]

  test("Claude and OpenCode count only a connected server running the mounted command; captured real outputs", () => {
    const connected = `${SERVER}:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: stdio\n  Command: swarm\n  Args: mcp --harness claude\n`
    expect(verifyMount("claude", "claude", f.env, reply(0, connected), expected("claude")).ok).toBe(true)
    expect(verifyMount("claude", "claude", f.env, reply(0, connected.replace("✔ Connected", "✘ Failed to connect")), expected("claude")).ok).toBe(false)
    expect(verifyMount("claude", "claude", f.env, reply(0, connected.replace("✔ Connected", "✔ Disconnected")), expected("claude")).ok).toBe(false)
    expect(verifyMount("claude", "claude", f.env, reply(0, connected.replace("Command: swarm", "Command: /old/swarm")), expected("claude")).line).toContain(
      "it runs /old/swarm mcp --harness claude, not swarm mcp --harness claude",
    )
    expect(verifyMount("claude", "claude", f.env, reply(0, connected.replace("Args: mcp --harness claude", "Args: mcp")), expected("claude")).ok).toBe(false)
    expect(verifyMount("claude", "claude", f.env, reply(0, `${SERVER}:\n  Status: ✔ Connected\n`), expected("claude")).ok).toBe(false)
    expect(
      verifyMount("claude", "claude", f.env, reply(1, `No MCP server named "${SERVER}". Run \`claude mcp add\` to add one.\n`), expected("claude")).ok,
    ).toBe(false)
    const opencode = `\x1b[0m\n┌  MCP Servers\n│\n●  ✓ ${SERVER} \x1b[90mconnected\n│      swarm mcp --harness opencode\n│\n└  1 server(s)\n`
    const config = readJson(f.files.opencode)
    writeFileSync(f.files.opencode, JSON.stringify({ ...config, mcp: { [SERVER]: { type: "local", command: expected("opencode"), enabled: true } } }))
    expect(verifyMount("opencode", "opencode", f.env, reply(0, opencode), expected("opencode")).ok).toBe(true)
    expect(
      verifyMount(
        "opencode",
        "opencode",
        f.env,
        reply(0, opencode.replace(`✓ ${SERVER} \x1b[90mconnected`, `✗ ${SERVER} \x1b[90mfailed`)),
        expected("opencode"),
      ).ok,
    ).toBe(false)
    writeFileSync(
      f.files.opencode,
      JSON.stringify({ ...config, mcp: { [SERVER]: { type: "remote", url: "https://relay.example/mcp", command: expected("opencode"), enabled: true } } }),
    )
    expect(verifyMount("opencode", "opencode", f.env, reply(0, opencode), expected("opencode")).line).toContain(
      `failed: the scp in ${f.files.opencode} is not this local one`,
    )
    writeFileSync(f.files.opencode, JSON.stringify(config))
  })

  test("Muse counts only a local, enabled entry running the mounted command", () => {
    const g = fixture()
    const argv = ["swarm", "mcp", "--harness", "muse"]
    const entry = (extra: Record<string, unknown>) =>
      writeFileSync(
        g.files.muse,
        JSON.stringify({ schema_version: 1, mcpServers: { [SERVER]: { type: "stdio", command: "swarm", args: argv.slice(1), ...extra } } }),
      )
    entry({})
    expect(verifyMount("muse", "muse", g.env, reply(0, ""), argv).ok).toBe(true)
    entry({ type: "http", url: "https://relay.example/mcp" })
    expect(verifyMount("muse", "muse", g.env, reply(0, ""), argv).ok).toBe(false)
    entry({ enabled: false })
    expect(verifyMount("muse", "muse", g.env, reply(0, ""), argv).ok).toBe(false)
  })

  test("Codex, Grok and agy listings must show the mounted command, enabled", () => {
    const codex = `Name         Command  Args                        Env  Cwd  Status   Auth\n${SERVER}  swarm    mcp --harness codex  -    -    enabled  Unsupported\nother        foo      -                           -    -    enabled  Unsupported\n`
    expect(verifyMount("codex", "codex", f.env, reply(0, codex), expected("codex")).ok).toBe(true)
    expect(
      verifyMount("codex", "codex", f.env, reply(0, codex.replace("enabled  Unsupported\nother", "disabled  Unsupported\nother")), expected("codex")).ok,
    ).toBe(false)
    expect(verifyMount("codex", "codex", f.env, reply(0, codex.replace("--harness codex", "--harness claude ")), expected("codex")).ok).toBe(false)
    expect(verifyMount("grok", "grok", f.env, reply(0, `  ${SERVER}: swarm mcp --harness grok\n`), expected("grok")).ok).toBe(true)
    expect(verifyMount("grok", "grok", f.env, reply(0, `  ${SERVER}: /old/swarm mcp --harness grok\n`), expected("grok")).ok).toBe(false)
    expect(
      verifyMount(
        "agy",
        "agy",
        f.env,
        reply(0, `NAME         TYPE   STATUS   COMMAND/URL\n${SERVER}  stdio  enabled  swarm mcp --harness agy\n`),
        expected("agy"),
      ).ok,
    ).toBe(true)
  })

  test("after an undo, only a clean listing counts as removed", () => {
    expect(verifyMount("claude", "claude", f.env, reply(1, `No MCP server named "${SERVER}". Run \`claude mcp add\` to add one.\n`)).ok).toBe(true)
    expect(verifyMount("claude", "claude", f.env, reply(124, "")).ok).toBe(false)
    expect(verifyMount("agy", "agy", f.env, reply(0, "No MCP servers configured.\n")).ok).toBe(true)
    expect(verifyMount("codex", "codex", f.env, reply(124, "")).ok).toBe(false)
    expect(verifyMount("grok", "grok", f.env, reply(0, `  ${SERVER}: swarm mcp --harness grok\n`)).ok).toBe(false)
  })

  test("the Muse plugin counts only from setup's directory at the manifest's hash, enabled; captured real list output", () => {
    const manifest = `${JSON.stringify(musePlugin(), null, 2)}\n`
    const listing = (record: Record<string, unknown>) =>
      JSON.stringify({
        plugins: [
          {
            record: {
              id: SERVER,
              enabled: true,
              trust: "user-local",
              source: { provenance: "native-local", path: "/p" },
              manifest_sha256: sha(manifest),
              ...record,
            },
            warning: "third-party plugin: hooks require review before activation",
          },
        ],
      })
    expect(verifyMusePlugin("muse", "/p", reply(0, listing({})), manifest).ok).toBe(true)
    expect(verifyMusePlugin("muse", "/p", reply(0, listing({ manifest_sha256: "sha256:00" })), manifest).ok).toBe(false)
    expect(verifyMusePlugin("muse", "/p", reply(0, listing({ enabled: false })), manifest).ok).toBe(false)
    expect(verifyMusePlugin("muse", "/elsewhere", reply(0, listing({})), manifest).ok).toBe(false)
    expect(verifyMusePlugin("muse", "/p", reply(0, '{\n  "plugins": []\n}\n')).ok).toBe(true)
    expect(verifyMusePlugin("muse", "/p", reply(2, "error: boom\n")).ok).toBe(false)
  })

  test("the harness CLIs use the supplied environment and verify from a neutral directory", () => {
    const g = fixture()
    const bin = join(g.home, "fakebin")
    put(
      join(bin, "claude"),
      `#!/bin/sh\npwd >> "${g.home}/claude-cwd"\nprintf '%s\\n' "$HOME" "$PATH" "$XDG_CONFIG_HOME" "$CODEX_HOME" > "${g.home}/claude-env"\nif [ "$2" = get ]; then printf '${SERVER}:\\n  Status: \\342\\234\\224 Connected\\n  Command: ${g.swarm}\\n  Args: mcp --harness claude --channels\\n'; exit 0; fi\nexit 0\n`,
      0o755,
    )
    put(g.swarm, `#!/bin/sh\nprintf '${HELP.replaceAll("\n", "\\n")}'\n`, 0o755)
    const lines: string[] = []
    const which = (name: string) => (name === "swarm" ? g.swarm : name === "claude" ? join(bin, "claude") : undefined)
    const code = relaySetup({ write: true, harness: "claude" }, { env: g.env, cwd: join(g.home, "work"), out: (line) => lines.push(line), which })
    expect(lines.join("\n")).toContain("claude: mounted (claude mcp get scp: Status: ✔ Connected)")
    expect(code).toBe(0)
    expect(readFileSync(join(g.home, "claude-env"), "utf8").trim().split("\n")).toEqual([g.env.HOME!, g.env.PATH!, g.env.XDG_CONFIG_HOME!, g.env.CODEX_HOME!])
    const cwds = readFileSync(join(g.home, "claude-cwd"), "utf8").trim().split("\n")
    expect(cwds.at(-1)).toEndWith("/relay-setup-check")
    expect(cwds.at(-1)).not.toContain(g.home)
    expect(existsSync(dirname(cwds.at(-1)!))).toBe(false)
  })
})

describe("relay setup failures and leftovers", () => {
  test("a failed Claude add after the remove puts the previous mount back", () => {
    const f = fixture()
    const old = { type: "stdio", command: "/old/swarm", args: ["mcp"], env: { KEEP: "me" } }
    const claude = readJson(f.files.claude)
    claude.mcpServers[SERVER] = old
    writeFileSync(f.files.claude, JSON.stringify(claude))
    const fake = fakeRun(f)
    let adds = 0
    const run = (argv: string[], cwd?: string) =>
      basename(argv[0]!) === "claude" && argv[2] === "add-json" && adds++ === 0 ? { code: 1, output: "config is locked\n" } : fake(argv, cwd)
    const { code, text } = setup(f, { write: true, harness: "claude" }, run)
    expect(code).toBe(1)
    expect(text).toContain("claude mcp: FAILED, claude mcp add-json exited 1: config is locked; the previous mount is back")
    expect(readJson(f.files.claude).mcpServers[SERVER]).toEqual(old)
  })

  test("a harness CLI that rewrites a file and then fails still leaves the original mode", () => {
    const f = fixture()
    const fake = fakeRun(f)
    const run = (argv: string[], cwd?: string) => {
      if (basename(argv[0]!) === "agy" && argv[2] === "add") {
        fake(argv, cwd)
        return { code: 2, output: "agy: crashed after writing\n" }
      }
      return fake(argv, cwd)
    }
    expect(setup(f, { write: true, harness: "agy" }, run).code).toBe(1)
    expect(mode(f.files.agy)).toBe(0o600)
  })

  test("a harness CLI that adds the mount and then fails still records it, so a rerun and --undo own it", () => {
    const f = fixture()
    const fake = fakeRun(f)
    const run = (argv: string[], cwd?: string) => {
      if (basename(argv[0]!) === "agy" && argv[2] === "add") {
        fake(argv, cwd)
        return { code: 2, output: "agy: crashed after writing\n" }
      }
      return fake(argv, cwd)
    }
    const { text } = setup(f, { write: true, harness: "agy" }, run)
    expect(text).toContain("agy mcp: FAILED, agy mcp add exited 2: agy: crashed after writing; the mount it wrote is recorded, so --undo removes it")
    expect(readJson(manifestFile(f.env)).added).toContainEqual({ harness: "agy", kind: "mcp", file: f.files.agy })
    expect(setup(f, { harness: "agy" }).text).toContain("everything is in place; nothing to do")
    expect(setup(f, { undo: true, write: true, harness: "agy" }).code).toBe(0)
    expect(readJson(f.files.agy).mcpServers).toEqual({})
  })

  test("a failed muse plugins install still records the plugin it wrote, so --undo removes it", () => {
    const f = fixture()
    const fake = fakeRun(f)
    const run = (argv: string[], cwd?: string) => {
      if (basename(argv[0]!) === "muse" && argv[2] === "install") {
        fake(argv, cwd)
        return { code: 1, output: "error: half installed\n" }
      }
      return fake(argv, cwd)
    }
    const { code, text } = setup(f, { write: true, hooks: true, harness: "muse" }, run)
    expect(code).toBe(1)
    expect(text).toContain("muse hooks: FAILED, muse plugins install exited 1: error: half installed; the plugin it wrote is recorded, so --undo removes it")
    expect(readJson(manifestFile(f.env)).added).toContainEqual({ harness: "muse", kind: "hooks", file: userHooks(f).muse })
    expect(setup(f, { undo: true, hooks: true, write: true, harness: "muse" }).code).toBe(0)
    expect(existsSync(userHooks(f).muse)).toBe(false)
    expect(readJson(f.files.museInstalled).plugins).toEqual({})
  })

  test("an unreadable hooks path is a ! problem for that harness, and the others are still set up and undone", () => {
    const f = fixture()
    mkdirSync(userHooks(f).claude, { recursive: true })
    mkdirSync(dirname(userHooks(f).codex), { recursive: true })
    symlinkSync(userHooks(f).codex, userHooks(f).codex)
    const { code, text } = setup(f, { write: true, hooks: true })
    expect(code).toBe(1)
    expect(text).toMatch(/claude:\n(.*\n)*? {2}! hooks: skipped, ~\/\.claude\/settings\.json is unreadable/)
    expect(text).toContain("! hooks: skipped, ~/.codex/hooks.json: too many levels of symlinks")
    expect(readFileSync(userHooks(f).opencode, "utf8")).toBe(opencodePlugin())
    expect(readJson(f.files.claude).mcpServers[SERVER]).toBeDefined()
    expect(() => setup(f, { undo: true, hooks: true })).not.toThrow()
  })

  test("--undo keeps agy rules it never adds, and reports mounts it cannot remove for an uninstalled harness", () => {
    const f = fixture()
    expect(setup(f, { write: true, hooks: false }).code).toBe(0)
    const settings = readJson(f.files.agySettings)
    settings.permissions.allow.push("mcp(scp/relay_future_tool)")
    writeFileSync(f.files.agySettings, JSON.stringify(settings, null, 2))
    rmHarness(f, ".local/bin/codex")
    rmHarness(f, ".local/bin/muse")
    const { code, text } = setup(f, { undo: true, write: true, hooks: false })
    expect(code).toBe(1)
    expect(readJson(f.files.agySettings).permissions.allow).toEqual(["command(swarm)", "mcp(scp/relay_future_tool)"])
    expect(text).toContain("codex (not installed):\n  ! mcp: ~/.codex/config.toml still mounts scp, and codex is not installed to remove it; remove it by hand")
    expect(readJson(f.files.muse).mcpServers).toEqual({})
    expect(readJson(manifestFile(f.env)).added).toEqual([{ harness: "codex", kind: "mcp", file: f.files.codex }])
  })

  test("an unreadable manifest stops the run before anything is planned", () => {
    const f = fixture()
    put(manifestFile(f.env), "{ nope", 0o600)
    expect(() => setup(f, { undo: true })).toThrow("setup's list of what it added, is unreadable")
  })
})

function rmHarness(f: Fixture, rel: string) {
  Bun.spawnSync(["rm", join(f.home, rel)])
}

describe("relay setup for desktop apps", () => {
  test("an nvm swarm mounts and hooks as absolute node plus its script, rewriting bare swarm entries and keeping every other entry", () => {
    const f = fixture()
    lived(f)
    const bin = join(f.home, ".nvm/versions/node/v22.13.0/bin")
    let script = join(f.home, ".nvm/versions/node/v22.13.0/lib/node_modules/@scp-dev/cli/dist/cli.js")
    put(join(bin, "node"), "#!/bin/sh\n", 0o755)
    put(script, "#!/usr/bin/env node\n", 0o755)
    symlinkSync(script, join(bin, "swarm"))
    script = realpathSync(script)
    const other = { type: "command", command: "notify-tool --done", timeout: 3 }
    const bare = (harness: string) => ({ ...hookEntries(harness as "codex"), Stop: [{ hooks: [other] }, ...hookEntries(harness as "codex").Stop!] })
    put(userHooks(f).codex, `${JSON.stringify({ hooks: bare("codex") }, null, 2)}\n`, 0o644)
    put(userHooks(f).claude, `${JSON.stringify({ model: "x", hooks: bare("claude") }, null, 2)}\n`, 0o644)
    const which = (name: string) => (name === "swarm" ? join(bin, "swarm") : undefined)
    const { code, text } = setup(f, { write: true, harness: "codex" }, fakeRun(f), which)
    expect(code).toBe(0)
    expect(text).toContain("mounts run: ~/.nvm/versions/node/v22.13.0/bin/node ")
    expect(text).toContain("dist/cli.js (swarm on PATH, by its real path, run by ~/.nvm/versions/node/v22.13.0/bin/node")
    const codex = Bun.TOML.parse(readFileSync(f.files.codex, "utf8")) as FixtureConfig
    expect([codex.mcp_servers[SERVER].command, ...codex.mcp_servers[SERVER].args]).toEqual([join(bin, "node"), script, "mcp", "--harness", "codex"])
    expect(codex.mcp_servers[SERVER].env).toEqual({ SCP_NAME: "cx-secret-name" })
    expect(codex.mcp_servers.other).toEqual({ command: "foo" })
    const hooks = readJson(userHooks(f).codex).hooks
    expect(hooks).toEqual(mergeHooksFor("codex", [join(bin, "node"), script], other))
    expect(JSON.stringify(hooks)).not.toContain('"swarm hook')
    expect(readdirSync(dirname(userHooks(f).codex)).some((name) => name.startsWith("hooks.json.bak-"))).toBe(true)
    const claude = setup(f, { write: true, harness: "claude" }, fakeRun(f), which)
    expect(claude.code).toBe(0)
    const settings = readJson(userHooks(f).claude)
    expect(settings.model).toBe("x")
    expect(settings.hooks).toEqual(mergeHooksFor("claude", [join(bin, "node"), script], other))
    expect(readJson(f.files.claude).mcpServers.other).toEqual({ type: "stdio", command: "x", args: [] })
    expect(setup(f, { write: true, harness: "codex" }, fakeRun(f), which).text).toContain("hooks: up to date in ~/.codex/hooks.json")
  })

  test("--undo removes the absolute hooks it wrote and keeps the others", () => {
    const f = fixture()
    const bin = join(f.home, "node-bin")
    const script = join(f.home, "pkg/@scp-dev/cli/dist/cli.js")
    put(join(bin, "node"), "#!/bin/sh\n", 0o755)
    put(script, "#!/usr/bin/env node\n", 0o755)
    symlinkSync(script, join(bin, "swarm"))
    const other = { type: "command", command: "notify-tool --done", timeout: 3 }
    put(userHooks(f).codex, `${JSON.stringify({ hooks: { Stop: [{ hooks: [other] }] } }, null, 2)}\n`, 0o644)
    const which = (name: string) => (name === "swarm" ? join(bin, "swarm") : undefined)
    expect(setup(f, { write: true, harness: "codex" }, fakeRun(f), which).code).toBe(0)
    expect(JSON.stringify(readJson(userHooks(f).codex))).toContain(`${realpathSync(script)} hook codex`)
    expect(setup(f, { write: true, undo: true, harness: "codex" }, fakeRun(f), which).code).toBe(0)
    expect(readJson(userHooks(f).codex).hooks).toEqual({ Stop: [{ hooks: [other] }] })
  })
})

test("a hook of another tool's cli.js is never taken for ours", () => {
  const foreign = { type: "command", command: "/opt/node /home/u/other/cli/dist/cli.js hook claude --mine" }
  const merged = mergeHooks({ hooks: { Stop: [{ hooks: [foreign] }] } }, hookEntries("claude", { launcher: ["/opt/node", "/x/@scp-dev/cli/dist/cli.js"] }))
  expect((merged.hooks as FixtureConfig).Stop[0]).toEqual({ hooks: [foreign] })
  expect(mergeHooks(merged, {})).toEqual({ hooks: { Stop: [{ hooks: [foreign] }] } })
})

function mergeHooksFor(harness: "claude" | "codex", launch: string[], other: Record<string, unknown>) {
  const entries = hookEntries(harness, { launcher: launch })
  return { ...entries, Stop: [{ hooks: [other] }, ...entries.Stop!] }
}
