import { describe, expect, test } from "bun:test"
import { chmodSync } from "node:fs"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { AGY_UNVERIFIED, agyHookSet, BLOCK_STOP, musePlugin, PUSH_WAIT, mergeHooks, hookEntries, opencodePlugin, SUBAGENT } from "./hooks"
import { installHooks, mcpInstall } from "./install"

const entry = join(import.meta.dir, "cli.ts")
const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|OPENCODE|GROK_|MUSE_|CODEX_THREAD_ID)/
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) env[key] = value
  return { ...env, ...extra }
}

describe("swarm hooks install", () => {
  const setup = () => {
    const root = mkdtempSync(join(process.env.HOME!, "install-"))
    const project = join(root, "proj")
    mkdirSync(join(project, ".git"), { recursive: true })
    const env = { HOME: root, CLAUDE_CONFIG_DIR: join(root, ".claude"), CODEX_HOME: join(root, ".codex"), XDG_CONFIG_HOME: join(root, ".config") }
    const lines: string[] = []
    const install = (options: { harness: string; scope?: string; write?: boolean; blockStop?: boolean }) =>
      installHooks({ ...options, env, cwd: join(project), out: (line) => lines.push(line) })
    return { root, project, env, lines, install }
  }

  test("installing hooks with the cloud transport is refused: they report to a local broker", () => {
    const { install, env } = setup()
    Object.assign(env, { SCP_TRANSPORT: "cloud" })
    expect(() => install({ harness: "claude" })).toThrow("relay hooks report to the local broker, and SCP_TRANSPORT=cloud bypasses it")
  })

  test("print mode writes nothing and names the target", () => {
    const { project, lines, install, root } = setup()
    install({ harness: "claude" })
    expect(lines[0]).toContain(join(project, ".claude", "settings.local.json"))
    install({ harness: "claude", scope: "project" })
    expect(lines.join("\n")).toContain(join(project, ".claude", "settings.json"))
    expect(lines.join("\n")).toContain('"command": "swarm hook claude"')
    expect(existsSync(join(project, ".claude"))).toBe(false)
    install({ harness: "opencode", scope: "user" })
    expect(lines.join("\n")).toContain(join(root, ".config", "opencode", "plugin", "scp.ts"))
    expect(existsSync(join(root, ".config"))).toBe(false)
  })

  test("the per-person Claude install warns when the shared project file already runs the hooks", () => {
    const { project, lines, install } = setup()
    install({ harness: "claude" })
    expect(lines.join("\n")).not.toContain("report twice")
    install({ harness: "claude", scope: "project", write: true })
    lines.length = 0
    install({ harness: "claude", write: true })
    expect(lines[0]).toBe(`# ${join(project, ".claude", "settings.json")} already runs the swarm hooks; remove them there, or every event reports twice`)
    expect(existsSync(join(project, ".claude", "settings.local.json"))).toBe(true)
  })

  test("--write creates, merges keeping other keys and hooks, backs up, keeps the mode, and is idempotent", () => {
    const { project, lines, install } = setup()
    const file = join(project, ".claude", "settings.json")
    install({ harness: "claude", scope: "project", write: true })
    const created = JSON.parse(readFileSync(file, "utf8"))
    expect(Object.keys(created.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop", "SessionEnd"])
    expect(created.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: "swarm hook claude", timeout: 5 }] }])
    expect(created.hooks.PostToolUse).toEqual([
      {
        matcher: "*",
        hooks: [
          { type: "command", command: "swarm hook claude", timeout: 5, async: true },
          { type: "command", command: `swarm hook claude ${SUBAGENT}`, timeout: 5 },
        ],
      },
    ])
    expect(created.hooks.SessionEnd).toEqual([{ hooks: [{ type: "command", command: "swarm hook claude", timeout: 2 }] }])
    expect(readdirSync(join(project, ".claude"))).toEqual(["settings.json"])
    expect(lines).toContain("# restart sessions started before this install: harnesses read hooks only at session start")

    const existing = {
      model: "opus",
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "my-linter" },
              { type: "command", command: "swarm hook claude --old" },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "swarm hook claude", timeout: 5, async: true }] }],
        Notification: [{ hooks: [{ type: "command", command: "notify-send hi" }] }],
      },
    }
    const original = `${JSON.stringify(existing, null, 2)}\n`
    writeFileSync(file, original)
    chmodSync(file, 0o600)
    install({ harness: "claude", scope: "project", write: true })
    const merged = JSON.parse(readFileSync(file, "utf8"))
    expect(merged.model).toBe("opus")
    expect(merged.permissions).toEqual({ allow: ["Bash(ls)"] })
    expect(merged.hooks.Notification).toEqual(existing.hooks.Notification)
    expect(merged.hooks.PostToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }, created.hooks.PostToolUse[0]])
    expect(merged.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: `swarm hook claude ${PUSH_WAIT} 600`, timeout: 630 }] }])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const backups = readdirSync(join(project, ".claude")).filter((name) => /^settings\.json\.bak-\d{14}$/.test(name))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(project, ".claude", backups[0]!), "utf8")).toBe(original)

    const before = readFileSync(file, "utf8")
    lines.length = 0
    install({ harness: "claude", scope: "project", write: true })
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(lines.join("\n")).not.toContain("restart sessions")
    expect(readdirSync(join(project, ".claude")).filter((name) => name.includes(".bak-"))).toHaveLength(1)
    expect(lines.filter((line) => !line.startsWith("#")).at(-1)).toContain("already has the swarm hooks")
    expect(mergeHooks(merged, hookEntries("claude"))).toEqual(merged)
  })

  test("a symlinked settings file is written through the link, and backups keep its mode and never overwrite each other", () => {
    const { root, project, env, lines } = setup()
    const real = join(root, "dotfiles", "settings.json")
    const link = join(project, ".claude", "settings.json")
    mkdirSync(dirname(real), { recursive: true })
    mkdirSync(dirname(link), { recursive: true })
    writeFileSync(real, '{ "model": "opus" }\n')
    chmodSync(real, 0o600)
    symlinkSync(real, link)
    const now = new Date(2026, 9, 15, 12, 0, 0)
    const install = () => installHooks({ harness: "claude", scope: "project", write: true, env, cwd: project, out: (line) => lines.push(line), now })
    install()
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    const written = JSON.parse(readFileSync(real, "utf8"))
    expect(written.model).toBe("opus")
    expect(written.hooks.Stop).toHaveLength(1)
    expect(statSync(real).mode & 0o777).toBe(0o600)
    const first = `${real}.bak-20261015120000`
    expect(readFileSync(first, "utf8")).toBe('{ "model": "opus" }\n')
    expect(statSync(first).mode & 0o777).toBe(0o600)
    expect(readdirSync(dirname(link))).toEqual(["settings.json"])
    writeFileSync(real, '{ "model": "sonnet" }\n')
    install()
    expect(readFileSync(first, "utf8")).toBe('{ "model": "opus" }\n')
    expect(readFileSync(`${first}-2`, "utf8")).toBe('{ "model": "sonnet" }\n')
    expect(statSync(`${first}-2`).mode & 0o777).toBe(0o600)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
  })

  test("merging recognises our hook by its command words, with or without a path, and nothing that merely starts like it", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "swarm hookup.sh" },
              { type: "command", command: "/opt/homebrew/bin/swarm hook claude" },
            ],
          },
        ],
        SessionEnd: [{ hooks: [{ type: "command", command: "/usr/local/bin/swarm hook claude" }] }],
      },
    }
    const merged = mergeHooks(settings, hookEntries("claude")).hooks as Record<string, unknown[]>
    expect(merged.Stop).toEqual([{ hooks: [{ type: "command", command: "swarm hookup.sh" }] }, ...hookEntries("claude").Stop!])
    expect(merged.SessionEnd).toEqual(hookEntries("claude").SessionEnd!)
  })

  test("--block-stop-on-unread makes the stop hook hold, in the foreground; muse gets a plugin; each install says how messages arrive", () => {
    const { root, project, lines, install } = setup()
    install({ harness: "claude", scope: "project", write: true, blockStop: true })
    const claude = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8"))
    expect(claude.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: `swarm hook claude ${BLOCK_STOP} ${PUSH_WAIT} 600`, timeout: 630 }] }])
    expect(claude.hooks.UserPromptSubmit[0].hooks[0].async).toBeUndefined()
    expect(lines.join("\n")).toContain(
      "a stop names each request not yet answered once, and is held while a require_reply request waits (at most 3 times a session)",
    )
    expect(lines.join("\n")).toContain(`with ${BLOCK_STOP} it is also held while messages are unread`)
    expect(lines.join("\n")).toContain("Grok runs these hooks too")
    install({ harness: "muse", write: true, blockStop: true })
    const manifest = join(root, ".config", "scp", "muse-plugin", ".muse-plugin", "plugin.json")
    const plugin = JSON.parse(readFileSync(manifest, "utf8"))
    expect(plugin).toEqual(musePlugin({ blockStop: true }))
    const hooks = plugin.capabilities.hooks as { event: string; command: string[]; async?: boolean }[]
    expect(hooks.map((h) => h.event)).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"])
    expect(hooks.filter((h) => h.async).map((h) => h.event)).toEqual(["SessionStart"])
    expect(hooks.find((h) => h.event === "Stop")!.command).toEqual(["swarm", "hook", "muse", "Stop", BLOCK_STOP, PUSH_WAIT, "600"])
    expect(lines.join("\n")).toContain("no SCP_* variables")
    expect(lines.join("\n")).toContain(`muse plugins install ${join(root, ".config", "scp", "muse-plugin")} --scope user`)
    install({ harness: "agy", write: true, blockStop: true })
    const agy = JSON.parse(readFileSync(join(project, ".agents", "hooks.json"), "utf8")).scp
    expect(agy.PreInvocation).toEqual([{ type: "command", command: "swarm hook agy PreInvocation", timeout: 1 }])
    expect(agy.Stop).toEqual([{ type: "command", command: `swarm hook agy Stop ${BLOCK_STOP}`, timeout: 1 }])
    expect(lines.join("\n")).toContain("agy reads nothing from a PostToolUse hook")
    install({ harness: "opencode", write: true, blockStop: true })
    const source = readFileSync(join(project, ".opencode", "plugin", "scp.ts"), "utf8")
    expect(source).toContain("const BLOCK_STOP = true")
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(source)).not.toThrow()
    expect(lines.join("\n")).toContain("OpenCode has no stop hook")
  })

  test("codex goes to CODEX_HOME at user scope, opencode gets its plugin file, grok is refused", () => {
    const { root, project, lines, install } = setup()
    install({ harness: "codex", scope: "user", write: true })
    const codex = JSON.parse(readFileSync(join(root, ".codex", "hooks.json"), "utf8"))
    expect(codex.hooks.SessionEnd).toEqual([{ hooks: [{ type: "command", command: "swarm hook codex", timeout: 2 }] }])
    expect(codex.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: `swarm hook codex ${PUSH_WAIT} 600`, timeout: 630 }] }])
    expect(lines.join("\n")).toContain(`add ${BLOCK_STOP} to also hold it while messages are unread`)
    expect(codex.hooks.PostToolUse).toEqual([{ hooks: [{ type: "command", command: "swarm hook codex", timeout: 5, async: true }] }])
    expect(codex.hooks.SubagentStop).toEqual([{ hooks: [{ type: "command", command: "swarm hook codex", timeout: 5, async: true }] }])
    expect(lines.join("\n")).toContain("/hooks")
    install({ harness: "opencode", write: true })
    expect(readFileSync(join(project, ".opencode", "plugin", "scp.ts"), "utf8")).toBe(opencodePlugin())
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(opencodePlugin())).not.toThrow()
    expect(() => install({ harness: "grok" })).toThrow("Claude Code hooks")
    expect(() => install({ harness: "claude", scope: "global" })).toThrow("--scope")
    expect(() => install({ harness: "codex", scope: "local" })).toThrow("--scope")
    install({ harness: "claude", scope: "local", write: true })
    expect(JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8")).hooks.SessionStart).toHaveLength(1)
    expect(existsSync(join(project, ".claude", "settings.json"))).toBe(false)
  })

  test("agy hooks go to .agents/hooks.json or ~/.gemini/config/hooks.json as a named set, and its MCP line is printed only", () => {
    const { root, project, lines, install } = setup()
    install({ harness: "agy" })
    expect(lines[0]).toContain(join(project, ".agents", "hooks.json"))
    expect(lines.at(-1)).toBe(`# ${AGY_UNVERIFIED}`)
    expect(existsSync(join(project, ".agents"))).toBe(false)
    const file = join(root, ".gemini", "config", "hooks.json")
    mkdirSync(join(root, ".gemini", "config"), { recursive: true })
    writeFileSync(file, JSON.stringify({ "my-hooks": { enabled: true, Stop: [{ command: "say done" }] } }))
    install({ harness: "agy", scope: "user", write: true })
    const written = JSON.parse(readFileSync(file, "utf8"))
    expect(written["my-hooks"]).toEqual({ enabled: true, Stop: [{ command: "say done" }] })
    expect(written.scp).toEqual(agyHookSet())
    expect(written.scp.PostToolUse).toEqual([{ matcher: ".*", hooks: [{ type: "command", command: "swarm hook agy PostToolUse", timeout: 1 }] }])
    expect(written.scp.Stop).toEqual([{ type: "command", command: "swarm hook agy Stop", timeout: 1 }])
    const before = readFileSync(file, "utf8")
    install({ harness: "agy", scope: "user", write: true })
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(readdirSync(join(root, ".gemini", "config")).filter((name) => name.includes(".bak-"))).toHaveLength(1)

    const out: string[] = []
    mcpInstall("agy", undefined, (line) => out.push(line))
    expect(out[0]).toBe("agy mcp add scp -- swarm mcp --harness agy")
    expect(out.join("\n")).toContain("~/.gemini/config/mcp_config.json")
    expect(out.join("\n")).toContain(".agents/mcp_config.json")
    expect(JSON.parse(out.slice(2, -1).join("\n"))).toEqual({ mcpServers: { scp: { command: "swarm", args: ["mcp", "--harness", "agy"] } } })
    expect(out.at(-1)).toBe(`# ${AGY_UNVERIFIED}`)
    const named: string[] = []
    mcpInstall("agy", "lane-impl", (line) => named.push(line))
    expect(named[0]).toBe("agy mcp add scp -- swarm mcp --harness agy --as lane-impl")
    expect(JSON.parse(named.slice(2, -1).join("\n")).mcpServers.scp.args).toEqual(["mcp", "--harness", "agy", "--as", "lane-impl"])
  })

  test("the CLI prints by default and writes the user's Claude settings with --write", () => {
    const { root, env } = setup()
    const run = (args: string[]) =>
      Bun.spawnSync([process.execPath, "--no-env-file", entry, "hooks", "install", ...args], { env: cleanEnv(env), cwd: root, stdout: "pipe", stderr: "pipe" })
    const printed = run(["--harness", "claude", "--scope", "user"])
    expect(printed.exitCode).toBe(0)
    expect(printed.stdout.toString()).toContain(join(root, ".claude", "settings.json"))
    expect(existsSync(join(root, ".claude"))).toBe(false)
    expect(run(["--harness", "claude", "--scope", "user", "--write"]).exitCode).toBe(0)
    expect(JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")).hooks.Stop).toHaveLength(1)
    expect(run(["--harness", "claude", "--write", "--print"]).exitCode).toBe(125)
  })
  test("--push-wait accepts zero and whole seconds through 3600, and rejects invalid values", () => {
    const { root, env } = setup()
    const run = (wait: string) =>
      Bun.spawnSync([process.execPath, "--no-env-file", entry, "hooks", "install", "--harness", "claude", `--push-wait=${wait}`], {
        env: cleanEnv(env),
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
    for (const wait of ["0", "15", "3600"]) {
      const result = run(wait)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain(`swarm hook claude --push-wait ${wait}`)
    }
    for (const wait of ["-1", "1.5", "3601", "later"]) {
      const result = run(wait)
      expect(result.exitCode).toBe(125)
      expect(result.stderr.toString()).toContain("--push-wait takes whole seconds, 0 to 3600")
    }
    expect(existsSync(join(root, ".claude"))).toBe(false)
  })

  test("the stop hook runs in the foreground everywhere setup installs it, with or without the flag", () => {
    for (const harness of ["claude", "codex"] as const) {
      expect(hookEntries(harness).Stop).toEqual([{ hooks: [{ type: "command", command: `swarm hook ${harness} ${PUSH_WAIT} 600`, timeout: 630 }] }])
      expect(hookEntries(harness, { blockStop: true }).Stop).toEqual([
        { hooks: [{ type: "command", command: `swarm hook ${harness} ${BLOCK_STOP} ${PUSH_WAIT} 600`, timeout: 630 }] },
      ])
      expect(hookEntries(harness).SubagentStop![0]!.hooks[0]!.async).toBe(true)
    }
    for (const blockStop of [false, true]) {
      const stop = (musePlugin({ blockStop }).capabilities as { hooks: Record<string, unknown>[] }).hooks.find((h) => h.event === "Stop")!
      expect(stop.async).toBeUndefined()
      expect(stop.command).toEqual(["swarm", "hook", "muse", "Stop", ...(blockStop ? [BLOCK_STOP] : []), PUSH_WAIT, "600"])
      expect(stop.timeoutMs).toBe(630_000)
      expect(agyHookSet({ blockStop }).Stop).toEqual([{ type: "command", command: `swarm hook agy Stop${blockStop ? ` ${BLOCK_STOP}` : ""}`, timeout: 1 }])
    }
  })
})
