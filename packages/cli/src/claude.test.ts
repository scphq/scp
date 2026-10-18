import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHANNEL_FLAGS, claudeArgv, claudeCommand, mountHint } from "./claude"
import { setJoinMode } from "./relay"
import { CHANNELS_ENV } from "./common"
import { launchedWithChannels } from "./mcp"

function fixture(mount?: string[]) {
  const home = mkdtempSync(join(tmpdir(), "scp-claude-"))
  const bin = join(home, "bin")
  mkdirSync(bin)
  const record = join(home, "record")
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}.args"\nprintf '%s\\n' "$SCP_NAME" "$${CHANNELS_ENV}" > "${record}.env"\nexit 7\n`,
    { mode: 0o755 },
  )
  if (mount) writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { scp: { type: "stdio", command: "swarm", args: mount } } }))
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` }
  return { home, env, args: () => readFileSync(`${record}.args`, "utf8"), vars: () => readFileSync(`${record}.env`, "utf8") }
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
    expect(f.args()).toBe(`${[...CHANNEL_FLAGS, "-c"].join("\n")}\n`)
    expect(f.vars()).toBe(`lead\n${process.pid}\n`)
    expect(lines).toEqual([])
  })

  test("without --name, claude is asked to name itself with swarm name; --name, a system prompt of its own or manual join mode skip it", async () => {
    const f = fixture(["mcp", "--harness", "claude", "--channels"])
    const work = mkdtempSync(join(f.home, "lane-"))
    mkdirSync(join(work, ".git"))
    const prompt = `You are on the SCP network as claude-${work.split("/").at(-1)!.toLowerCase()}. Pick a short descriptive name for yourself with \`swarm name <name>\` when you know what you're working on.`
    expect(await claudeCommand(["-c"], f.env, () => {}, work)).toBe(7)
    expect(f.args()).toBe(`${[...CHANNEL_FLAGS, "--append-system-prompt", prompt, "-c"].join("\n")}\n`)
    expect(await claudeCommand(["--name", "lead", "-c"], f.env, () => {}, work)).toBe(7)
    expect(f.args()).toBe(`${[...CHANNEL_FLAGS, "-c"].join("\n")}\n`)
    expect(await claudeCommand(["--append-system-prompt", "mine"], f.env, () => {}, work)).toBe(7)
    expect(f.args()).toBe(`${[...CHANNEL_FLAGS, "--append-system-prompt", "mine"].join("\n")}\n`)
    setJoinMode(f.env, "manual")
    expect(await claudeCommand([], f.env, () => {}, work)).toBe(7)
    expect(f.args()).toBe(`${CHANNEL_FLAGS.join("\n")}\n`)
  })

  test("hints at setup when the scp mount is missing or lacks --channels", async () => {
    expect(mountHint(fixture().env)).toContain("no scp MCP mount; run swarm setup --write")
    const old = fixture(["mcp", "--harness", "claude"])
    expect(mountHint(old.env)).toContain("lacks --channels")
    const lines: string[] = []
    expect(await claudeCommand([], old.env, (line) => lines.push(line))).toBe(7)
    expect(lines).toEqual([expect.stringContaining("re-run swarm setup --write")])
    expect(mountHint(fixture(["mcp", "--harness", "claude", "--channels"]).env)).toBeUndefined()
  })

  test("a shim takes channel pushes only when its harness's parent is the launcher named in the environment", () => {
    const parentOf = (pid: number) => (pid === 500 ? { ppid: 400, comm: "node" } : undefined)
    expect(launchedWithChannels({ [CHANNELS_ENV]: "400" }, () => 500, parentOf)).toBe(true)
    expect(launchedWithChannels({ [CHANNELS_ENV]: "401" }, () => 500, parentOf)).toBe(false)
    expect(launchedWithChannels({ [CHANNELS_ENV]: "1" }, () => 500, parentOf)).toBe(false)
    expect(launchedWithChannels({}, () => 500, parentOf)).toBe(false)
  })
})
