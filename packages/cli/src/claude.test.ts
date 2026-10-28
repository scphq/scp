import { describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bgMount, bgDir, CHANNEL_FLAGS, claudeArgv, claudeCommand, claudeLaunchArgs, mountHint, resumeTarget } from "./claude"
import { setJoinMode } from "./relay"
import { CHANNELS_ENV } from "./common"
import { launchedWithChannels } from "./mcp"
import { SELF } from "./term"

function fixture(mount?: string[]) {
  const home = mkdtempSync(join(tmpdir(), "scp-claude-"))
  const bin = join(home, "bin")
  mkdirSync(bin)
  const record = join(home, "record")
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `if [ "$1" = agents ]; then cat "${home}/agents.json" 2>/dev/null || echo '[]'; exit 0; fi`,
      `printf '%s\\n' "$@" > "${record}.args"`,
      `printf '%s\\n' "$SCP_NAME" "$${CHANNELS_ENV}" "$SCP_GRANT" > "${record}.env"`,
      `env > "${record}.all-env"`,
      `for a in "$@"; do [ "$a" = --bg ] && { echo 'backgrounded · 1a2b3c4d (idle)'; exit 0; }; done`,
      "exit 7",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  if (mount) writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { scp: { type: "stdio", command: "swarm", args: mount } } }))
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` }
  return {
    home,
    env,
    args: () => readFileSync(`${record}.args`, "utf8"),
    allEnv: () => readFileSync(`${record}.all-env`, "utf8"),
    vars: () => readFileSync(`${record}.env`, "utf8"),
  }
}

describe("swarm claude", () => {
  test("takes a leading --name and passes everything else to claude", () => {
    expect(claudeArgv([])).toEqual({ args: [] })
    expect(claudeArgv(["--name", "lead", "-c", "--model", "opus"])).toEqual({ name: "lead", args: ["-c", "--model", "opus"] })
    expect(claudeArgv(["--name=lead", "--", "--name", "x"])).toEqual({ name: "lead", args: ["--name", "x"] })
    expect(() => claudeArgv(["--name"])).toThrow("takes a handle")
    expect(() => claudeArgv(["--name", "me"])).toThrow("not a valid agent handle")
  })

  test("starts claude with the scp channel, its name and the launcher's pid, and returns its exit code", async () => {
    const f = fixture(["mcp", "--harness", "claude", "--channels"])
    const lines: string[] = []
    expect(await claudeCommand(["--name", "lead", "-c"], f.env, (line) => lines.push(line))).toBe(7)
    expect(f.args()).toBe(`${["-c", ...CHANNEL_FLAGS].join("\n")}\n`)
    expect(f.vars()).toBe(`lead\n${process.pid}\n\n`)
    expect(lines).toEqual([])
  })

  test("without --name, claude is asked to name itself with swarm name; --name, a system prompt of its own or manual join mode skip it", async () => {
    const f = fixture(["mcp", "--harness", "claude", "--channels"])
    const work = mkdtempSync(join(f.home, "lane-"))
    mkdirSync(join(work, ".git"))
    const prompt = `You are on the SCP network as claude-${work.split("/").at(-1)!.toLowerCase()}. Pick a short descriptive name for yourself with \`swarm name <name>\` when you know what you're working on.`
    expect(await claudeCommand(["-c"], f.env, () => {}, work)).toBe(7)
    expect(f.args()).toBe(`${["-c", ...CHANNEL_FLAGS, "--append-system-prompt", prompt].join("\n")}\n`)
    expect(await claudeCommand(["--name", "lead", "-c"], f.env, () => {}, work)).toBe(7)
    expect(f.args()).toBe(`${["-c", ...CHANNEL_FLAGS].join("\n")}\n`)
    expect(await claudeCommand(["--append-system-prompt", "mine"], f.env, () => {}, work)).toBe(7)
    expect(f.args()).toBe(`${["--append-system-prompt", "mine", ...CHANNEL_FLAGS].join("\n")}\n`)
    setJoinMode(f.env, "manual")
    expect(await claudeCommand([], f.env, () => {}, work)).toBe(7)
    expect(f.args()).toBe(`${CHANNEL_FLAGS.join("\n")}\n`)
  })

  test("refuses to start without a wake-capable scp mount, naming the fix; user, local and project scopes count", async () => {
    const none = fixture()
    expect(mountHint(none.env, none.home)).toContain("no scp MCP mount, so messages cannot wake this session; run swarm setup --write")
    await expect(claudeCommand([], none.env, () => {}, none.home)).rejects.toThrow("run swarm setup --write")
    const old = fixture(["mcp", "--harness", "claude"])
    expect(mountHint(old.env, old.home)).toContain("lacks --channels")
    await expect(claudeCommand([], old.env, () => {}, old.home)).rejects.toThrow("run swarm setup --write")
    expect(mountHint(fixture(["mcp", "--harness", "claude", "--channels"]).env)).toBeUndefined()
    const scp = { type: "stdio", command: "swarm", args: ["mcp", "--harness", "claude", "--channels"] }
    const local = fixture()
    writeFileSync(join(local.home, ".claude.json"), JSON.stringify({ projects: { [local.home]: { mcpServers: { scp } } } }))
    expect(mountHint(local.env, local.home)).toBeUndefined()
    const project = fixture()
    writeFileSync(join(project.home, ".mcp.json"), JSON.stringify({ mcpServers: { scp } }))
    expect(mountHint(project.env, project.home)).toBeUndefined()
    const lines: string[] = []
    expect(await claudeCommand(["--mcp-config", "mine.json"], none.env, (line) => lines.push(line), none.home)).toBe(7)
    expect(lines).toEqual([expect.stringContaining("using your --mcp-config")])
    await expect(claudeCommand(["--strict-mcp-config"], project.env, () => {}, project.home)).rejects.toThrow("drops the scp mount")
  })

  test("passes every claude argument through untouched, adding the channel before any -- so its variadic flag never takes a prompt", async () => {
    expect(claudeArgv(["--as", "me/lead", "--name", "x", "--model", "opus"])).toEqual({ name: "x", args: ["--model", "opus"] })
    expect(claudeArgv(["--model", "opus", "--name", "session"])).toEqual({ args: ["--model", "opus", "--name", "session"] })
    expect(claudeLaunchArgs(["fix the bug"], [])).toEqual(["fix the bug", ...CHANNEL_FLAGS])
    expect(claudeLaunchArgs(["--resume", "abc", "--", "-p"], [])).toEqual(["--resume", "abc", ...CHANNEL_FLAGS, "--", "-p"])
    expect(claudeLaunchArgs([CHANNEL_FLAGS[0]!, "server:mine", "server:scp"], [])).toEqual([CHANNEL_FLAGS[0]!, "server:mine", "server:scp"])
    const f = fixture(["mcp", "--harness", "claude", "--channels"])
    const args = ["--continue", "--model", "opus", "--permission-mode", "plan", "--settings", "s.json", "--plugin-dir", "p", "hello there"]
    expect(await claudeCommand(["--name", "lead", "--", ...args], f.env, () => {})).toBe(7)
    expect(f.args()).toBe(`${[...args, ...CHANNEL_FLAGS].join("\n")}\n`)
  })

  test("--bg starts claude in the background with an scp mount claiming the name and the caller's grant, and prints its id and address", async () => {
    const mount = ["mcp", "--harness", "claude", "--channels"]
    const f = fixture(mount)
    const env = { ...f.env, SCP_NAME: "bgkid", SCP_GRANT: "krt_grant", SCP_LABELS: "lane=x", [CHANNELS_ENV]: "1" }
    const lines: string[] = []
    expect(await claudeCommand(["--bg"], env, () => {}, f.home, { out: (line) => lines.push(line) })).toBe(0)
    const args = f.args().trimEnd().split("\n")
    expect(args.slice(0, -1)).toEqual(["--bg", "--name", "bgkid", "--mcp-config"])
    expect(args.join(" ")).not.toContain(CHANNEL_FLAGS[0]!)
    expect(f.vars()).toBe("\n\n\n")
    const file = args.at(-1)!
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      mcpServers: {
        scp: { type: "stdio", command: "swarm", args: mount, env: { SCP_LABELS: "lane=x", SCP_NAME: "bgkid", SCP_GRANT: "krt_grant", SCP_UNDER: "" } },
      },
    })
    const link = join(bgDir(env), "1a2b3c4d.json")
    expect(lstatSync(link).isSymbolicLink() && join(bgDir(env), readlinkSync(link))).toBe(file)
    expect(lines).toEqual([expect.stringContaining("background session 1a2b3c4d is me/bgkid on SCP")])
  })

  test("--bg keeps the user's prompt last, needs no mount and never passes a daemon's grant on", async () => {
    const f = fixture()
    expect(await claudeCommand(["--bg", "--name", "lead", "--", "fix it"], f.env, () => {}, f.home, { out: () => {} })).toBe(0)
    const args = f.args().trimEnd().split("\n")
    expect(args.slice(0, -1)).toEqual(["fix it", "--bg", "--name", "lead", "--mcp-config"])
    const scp = JSON.parse(readFileSync(args.at(-1)!, "utf8")).mcpServers.scp
    expect([scp.command, ...scp.args]).toEqual([...SELF, "mcp", "--harness", "claude", "--channels"])
    expect(scp.env).toEqual({ SCP_NAME: "lead", SCP_GRANT: "", SCP_UNDER: "" })
    expect(claudeArgv(["--", "--model", "opus", "--bg"])).toEqual({ bg: true, args: ["--model", "opus", "--bg"] })
    expect(claudeArgv(["--bg", "--name", "x", "--", "-p", "--", "--bg"])).toEqual({ name: "x", bg: true, args: ["-p", "--", "--bg"] })
    expect(claudeArgv(["--", "-p", "--", "--bg"])).toEqual({ args: ["-p", "--", "--bg"] })
  })

  test("attach --name renames the session's endpoint and the name its mount claims on resume, then runs claude attach", async () => {
    const f = fixture(["mcp", "--harness", "claude", "--channels"])
    const env = { ...f.env, SCP_GRANT: "krt_grant" }
    await claudeCommand(["--bg", "--name", "bgkid"], env, () => {}, f.home, { out: () => {} })
    const link = join(bgDir(env), "1a2b3c4d.json")
    const renamed: string[][] = []
    const rename = async (from: string, to: string) => {
      renamed.push([from, to])
      return to === "taken" ? 1 : 0
    }
    expect(await claudeCommand(["attach", "1a2b3c4d", "--name", "lead"], env, () => {}, f.home, { rename })).toBe(7)
    expect(f.args()).toBe("attach\n1a2b3c4d\n")
    expect(JSON.parse(readFileSync(link, "utf8")).mcpServers.scp.env).toEqual({ SCP_NAME: "lead", SCP_GRANT: "krt_grant", SCP_UNDER: "" })
    writeFileSync(join(f.home, "agents.json"), JSON.stringify([{ id: "1a2b3c4d", name: "lead", state: "working" }]))
    const lines: string[] = []
    expect(await claudeCommand(["attach", "lead", "--name=taken"], env, (line) => lines.push(line), f.home, { rename })).toBe(7)
    expect(f.args()).toBe("attach\nlead\n")
    expect(renamed).toEqual([
      ["bgkid", "lead"],
      ["lead", "taken"],
    ])
    expect(JSON.parse(readFileSync(link, "utf8")).mcpServers.scp.env.SCP_NAME).toBe("lead")
    expect(lines).toEqual(["swarm claude: me/lead keeps its name"])
    expect(await claudeCommand(["attach", "0f0f0f0f", "--name", "x"], env, (line) => lines.push(line), f.home, { rename })).toBe(7)
    expect(lines.at(-1)).toContain("was not started by swarm claude --bg --name")
    expect(existsSync(join(bgDir(env), "0f0f0f0f.json"))).toBe(false)
    await expect(claudeCommand(["attach"], env, () => {}, f.home)).rejects.toThrow("takes a background session")
  })

  test("--bg --resume claims the name, grant and parent request the session's mount had, also when the resume forks a new id", async () => {
    const f = fixture(["mcp", "--harness", "claude", "--channels"])
    const caller = { ...f.env, SCP_NAME: "lead", SCP_GRANT: "krt_lead" }
    await claudeCommand(["--bg", "--name", "w1"], { ...f.env, SCP_GRANT: "krt_w1", SCP_UNDER: "me/lead" }, () => {}, f.home, { out: () => {} })
    const mountOf = () => JSON.parse(readFileSync(join(bgDir(caller), "1a2b3c4d.json"), "utf8")).mcpServers.scp.env
    const lines: string[] = []
    const session = "1a2b3c4d-0000-4000-8000-000000000000"
    expect(await claudeCommand(["--bg", "--resume", session], caller, () => {}, f.home, { out: (line) => lines.push(line) })).toBe(0)
    expect(f.args().split("\n").slice(0, 5)).toEqual(["--resume", session, "--bg", "--name", "w1"])
    expect(mountOf()).toEqual({ SCP_NAME: "w1", SCP_GRANT: "krt_w1", SCP_UNDER: "me/lead" })
    expect(lines).toEqual([expect.stringContaining("is me/w1 on SCP")])
    const forked = { mcpServers: { scp: { env: { SCP_NAME: "w2", SCP_GRANT: "krt_w2", SCP_UNDER: "" } } } }
    writeFileSync(join(bgDir(caller), "0f0f0f0f.json"), JSON.stringify(forked))
    await claudeCommand(["--bg", "--resume=0f0f0f0f"], caller, () => {}, f.home, { out: () => {} })
    expect(mountOf()).toEqual({ SCP_NAME: "w2", SCP_GRANT: "krt_w2", SCP_UNDER: "" })
    await claudeCommand(["--bg", "--name", "w3", "--resume", "0f0f0f0f"], caller, () => {}, f.home, { out: () => {} })
    expect(mountOf()).toEqual({ SCP_NAME: "w3", SCP_GRANT: "krt_w2", SCP_UNDER: "" })
    await claudeCommand(["--bg", "--resume", "deadbeef"], caller, () => {}, f.home, { out: () => {} })
    expect(mountOf()).toEqual({ SCP_NAME: "lead", SCP_GRANT: "krt_lead", SCP_UNDER: "" })
  })

  test("--resume of a live background session attaches to it instead of starting a second claude", async () => {
    const f = fixture(["mcp", "--harness", "claude", "--channels"])
    const session = "1a2b3c4d-0000-4000-8000-000000000000"
    writeFileSync(join(f.home, "agents.json"), JSON.stringify([{ id: "1a2b3c4d", sessionId: session, pid: 1, state: "working" }]))
    const lines: string[] = []
    expect(await claudeCommand(["--", "--resume", session], f.env, (line) => lines.push(line), f.home)).toBe(7)
    expect(f.args()).toBe("attach\n1a2b3c4d\n")
    expect(lines).toEqual([expect.stringContaining("already woken through claude-inbox; attaching to it (claude attach 1a2b3c4d)")])
    expect(await claudeCommand(["--name", "lead", "-r", "0f0f0f0f-0000-4000-8000-000000000000"], f.env, () => {}, f.home)).toBe(7)
    expect(f.args()).toBe(`${["-r", "0f0f0f0f-0000-4000-8000-000000000000", ...CHANNEL_FLAGS].join("\n")}\n`)
    expect(resumeTarget(["--resume=abc"])).toBe("abc")
    expect(resumeTarget(["--resume", "--model", "x"])).toBeUndefined()
    expect(resumeTarget(["--", "--resume", "abc"])).toBeUndefined()
  })

  test("a shim takes channel pushes only when its harness's parent is the launcher named in the environment", () => {
    const parentOf = (pid: number) => (pid === 500 ? { ppid: 400, comm: "node" } : undefined)
    expect(launchedWithChannels({ [CHANNELS_ENV]: "400" }, () => 500, parentOf)).toBe(true)
    expect(launchedWithChannels({ [CHANNELS_ENV]: "401" }, () => 500, parentOf)).toBe(false)
    expect(launchedWithChannels({ [CHANNELS_ENV]: "1" }, () => 500, parentOf)).toBe(false)
    expect(launchedWithChannels({}, () => 500, parentOf)).toBe(false)
  })
})

test("Claude foreground and background launches clear inherited desktop and Cowork identity", async () => {
  for (const args of [["--root"], ["--root", "--bg"]]) {
    const f = fixture(["mcp", "--harness", "claude", "--channels"])
    const session = {
      CLAUDE_CODE_IS_COWORK: "1",
      CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
      CLAUDE_CODE_MESSAGING_SOCKET: "/fake/socket",
      CLAUDE_CODE_MESSAGING_TOKEN: "fake-token",
      CLAUDE_CODE_SESSION_ID: "fake-session",
      CLAUDE_CODE_WORKSPACE_HOST_PATHS: "/fake/workspace",
    }
    const env = { ...f.env, ...session }
    await claudeCommand(args, env, () => {}, f.home, { out: () => {} })
    for (const key of Object.keys(session)) expect(f.allEnv()).not.toContain(`${key}=`)
  }
})

test("explicit parent stays in the background mount and resume arguments stay with claude", () => {
  const f = fixture()
  expect(bgMount({ ...f.env, SCP_UNDER: "me/vm/lead", SCP_GRANT: "" }, "worker").env).toMatchObject({
    SCP_NAME: "worker",
    SCP_UNDER: "me/vm/lead",
    SCP_GRANT: "",
  })
  expect(claudeArgv(["--under=me/vm/lead", "--bg", "--", "--resume", "session"])).toEqual({
    under: "me/vm/lead",
    bg: true,
    args: ["--resume", "session"],
  })
  expect(claudeArgv(["--", "--under", "prompt"])).toEqual({ args: ["--under", "prompt"] })
})
