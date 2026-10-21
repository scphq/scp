import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { TOOLS } from "@scp-dev/mcp"
import { CHAT_HARNESS, claudeDesktopSetup, mcpbBundle, mcpbLauncher, parseClaudeDesktopArgs } from "./mcpb"

/** the entries of a zip, read from its central directory */
function unzip(buf: Buffer): Map<string, { data: Buffer; mode: number }> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  const entries = new Map<string, { data: Buffer; mode: number }>()
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50)
    const size = buf.readUInt32LE(at + 20)
    const nameLength = buf.readUInt16LE(at + 28)
    const mode = (buf.readUInt32LE(at + 38) >>> 16) & 0o7777
    const offset = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8")
    expect(buf.readUInt32LE(offset)).toBe(0x04034b50)
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28)
    entries.set(name, { data: buf.subarray(start, start + size), mode })
    at += 46 + nameLength
  }
  return entries
}

const home = () => realpathSync(mkdtempSync(join(process.env.HOME!, "mcpb-")))

function put(file: string, content: string, mode = 0o755) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, mode)
}

describe("Claude desktop extension", () => {
  test("the bundle holds a valid MCPB manifest and the launcher it runs", () => {
    const files = unzip(mcpbBundle(["/opt/node", "/opt/scp/cli.js"], "1.2.3"))
    expect([...files.keys()]).toEqual(["manifest.json", "server/scp"])
    const manifest = JSON.parse(files.get("manifest.json")!.data.toString("utf8"))
    for (const key of ["manifest_version", "name", "version", "description", "author", "server"]) expect(manifest[key]).toBeDefined()
    expect(manifest.manifest_version).toBe("0.3")
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(manifest.author.name).toBeString()
    expect(manifest.server).toEqual({
      type: "binary",
      entry_point: "server/scp",
      mcp_config: { command: "/bin/sh", args: [`\${__dirname}/server/scp`], env: {} },
    })
    expect(files.has(manifest.server.entry_point)).toBe(true)
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOLS.map((tool) => tool.name))
    expect(manifest).not.toHaveProperty("user_config")
    expect(files.get("server/scp")!.mode).toBe(0o755)
    expect(files.get("server/scp")!.data.toString("utf8")).toBe(`#!/bin/sh\nexec /opt/node /opt/scp/cli.js mcp --harness ${CHAT_HARNESS}\n`)
    expect(mcpbBundle(["/opt/node", "/opt/scp/cli.js"], "1.2.3").equals(mcpbBundle(["/opt/node", "/opt/scp/cli.js"], "1.2.3"))).toBe(true)
  })

  test("paths with spaces, quotes and shell syntax reach the shim as single words", () => {
    const dir = home()
    const node = join(dir, "it's a $(dir)", "node")
    put(node, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n')
    const script = join(dir, "x `y`; z", "cli.js")
    const launcher = join(dir, "scp")
    put(launcher, mcpbLauncher([node, script]), 0o755)
    const result = spawnSync("/bin/sh", [launcher], { encoding: "utf8" })
    expect(result.stdout.split("\n").filter(Boolean)).toEqual([script, "mcp", "--harness", CHAT_HARNESS])
  })

  test("setup claude-desktop builds the extension in the config dir by absolute paths, never touches the app config, and opens it on --open", () => {
    const dir = home()
    const env = { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"), PATH: "/usr/bin:/bin" }
    const bin = join(dir, ".nvm/versions/node/v22.13.0/bin")
    put(join(bin, "node"), "#!/bin/sh\n")
    put(join(bin, "swarm"), "#!/usr/bin/env node\n")
    const lines: string[] = []
    const opened: string[][] = []
    const deps = {
      env,
      out: (line: string) => lines.push(line),
      version: "0.12.0",
      which: (name: string) => (name === "swarm" ? join(bin, "swarm") : undefined),
      run: (argv: string[]) => {
        opened.push(argv)
        return 0
      },
    }
    expect(claudeDesktopSetup({}, deps)).toBe(0)
    const file = join(dir, ".config", "scp", "scp.mcpb")
    const script = unzip(readFileSync(file)).get("server/scp")!.data.toString("utf8")
    expect(script).toContain(`exec ${join(bin, "node")} ${join(bin, "swarm")} mcp --harness ${CHAT_HARNESS}`)
    expect(lines.join("\n")).toContain("relay_inbox")
    expect(opened).toEqual([])
    expect(claudeDesktopSetup({ open: true }, deps)).toBe(0)
    expect(opened).toEqual([["open", file]])
    expect(existsSync(join(dir, "Library", "Application Support", "Claude"))).toBe(false)
    expect(() => claudeDesktopSetup({ out: "rel.mcpb" }, deps)).toThrow("--out takes an absolute path")
    expect(() => claudeDesktopSetup({ out: join(dir, "x.json") }, deps)).toThrow("ending in .mcpb")
    expect(parseClaudeDesktopArgs(["--open", "--out", "/a/b.mcpb"])).toEqual({ open: true, out: "/a/b.mcpb" })
    expect(() => parseClaudeDesktopArgs(["--write"])).toThrow()
  })
})
