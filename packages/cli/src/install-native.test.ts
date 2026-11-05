import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { swarmBinary } from "./test-setup"

setDefaultTimeout(60_000)

const entry = join(import.meta.dir, "cli.ts")
const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|OPENCODE|GROK_|MUSE_|CODEX_|SCP_)/
const root = mkdtempSync(join(process.env.HOME!, "install-native-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** stand-ins for the harness CLIs `mcp add` would run: each records that it ran */
const bin = join(root, "bin")
const ran = join(root, "ran")
mkdirSync(bin)
for (const name of ["claude", "codex", "grok", "opencode", "agy"]) {
  writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> ${JSON.stringify(ran)}\n`)
  chmodSync(join(bin, name), 0o755)
}

let homes = 0
function home() {
  const dir = join(root, `home-${homes++}`)
  mkdirSync(join(dir, "proj", ".git"), { recursive: true })
  return dir
}

/** `swarm <args>` in `dir`'s project, on the TypeScript CLI or routed to the native swarm */
function swarm(engine: "ts" | "native", dir: string, args: string[], log?: string) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) env[key] = value
  Object.assign(env, {
    HOME: dir,
    CLAUDE_CONFIG_DIR: join(dir, ".claude"),
    CODEX_HOME: join(dir, ".codex"),
    XDG_CONFIG_HOME: join(dir, ".config"),
    PATH: `${bin}:${env.PATH}`,
    ...(engine === "native" ? { SCP_NATIVE: "1", SCP_SWARM_BIN: swarmBinary!, ...(log ? { SCP_ROUTE_LOG: log } : {}) } : {}),
  })
  const result = Bun.spawnSync([process.execPath, "--no-env-file", entry, ...args], { env, cwd: join(dir, "proj"), stdout: "pipe", stderr: "pipe" })
  const strip = (text: string) => text.replaceAll(dir, "<home>").replace(/\.bak-\d{14}/g, ".bak-<stamp>")
  return { code: result.exitCode, stdout: strip(result.stdout.toString()), stderr: strip(result.stderr.toString()) }
}

/** every file under `dir`, backups by their stamp-free name */
function files(dir: string): Record<string, string> {
  const found: Record<string, string> = {}
  const walk = (at: string, rel: string) => {
    for (const name of readdirSync(at, { withFileTypes: true })) {
      if (name.name === ".git" || (rel === "" && (name.name === "Library" || name.name === ".cache" || name.name === ".bun"))) continue
      const path = join(at, name.name)
      const key = `${rel}${name.name}`.replace(/\.bak-\d{14}/, ".bak-<stamp>")
      if (name.isDirectory()) walk(path, `${key}/`)
      else found[key] = readFileSync(path, "utf8")
    }
  }
  walk(dir, "")
  return found
}

const SETTINGS = '{\n    "model": "opus",\n    "n": 1e3,\n    "hooks": {"Notification": [{"hooks": [{"type": "command", "command": "notify"}]}]}\n}'

const INSTALLS: string[][] = [
  ["--harness", "claude", "--scope", "user"],
  ["--harness", "claude"],
  ["--harness", "codex", "--scope", "user", "--push-wait", "0"],
  ["--harness", "codex", "--block-stop-on-unread"],
  ["--harness", "opencode", "--scope", "user"],
  ["--harness", "agy", "--scope", "user", "--block-stop-on-unread"],
  ["--harness", "muse", "--push-wait", "45"],
]

describe.skipIf(!swarmBinary)("hooks install and mcp install, TypeScript against native", () => {
  test("an install by either engine is up to date for the other, and both write the same files", () => {
    const log = join(root, "route.log")
    const seeded = () => {
      const dir = home()
      mkdirSync(join(dir, ".claude"), { recursive: true })
      writeFileSync(join(dir, ".claude", "settings.json"), SETTINGS)
      mkdirSync(join(dir, "proj", ".agents"), { recursive: true })
      writeFileSync(join(dir, "proj", ".agents", "hooks.json"), '{"other": 1.50, "scp": {"old": true}}')
      return dir
    }
    for (const args of INSTALLS) {
      const written: Record<string, { stdout: string; files: Record<string, string> }> = {}
      for (const [first, second] of [
        ["ts", "native"],
        ["native", "ts"],
      ] as const) {
        const dir = seeded()
        const wrote = swarm(first, dir, ["hooks", "install", ...args, "--write"], log)
        expect(wrote.code).toBe(0)
        const after = files(dir)
        written[first] = { stdout: wrote.stdout, files: after }
        const again = swarm(second, dir, ["hooks", "install", ...args, "--write"], log)
        expect({ args, second, code: again.code, stdout: again.stdout.split("\n")[0] }).toEqual({
          args,
          second,
          code: 0,
          stdout: expect.stringContaining("already has the swarm hooks"),
        })
        expect(files(dir)).toEqual(after)
      }
      expect({ args, ...written.native }).toEqual({ args, ...written.ts })
    }
    expect(readFileSync(log, "utf8")).toContain("hooks native run")
  })

  test("a settings file the native engine cannot keep is refused and left as it was, and an unreadable one is refused alike", () => {
    const log = join(root, "surrogate.log")
    const seeded = (text: string | Buffer) => {
      const dir = home()
      mkdirSync(join(dir, ".claude"), { recursive: true })
      writeFileSync(join(dir, ".claude", "settings.json"), text)
      return dir
    }
    const args = ["hooks", "install", "--harness", "claude", "--scope", "user", "--write"]
    for (const [text, reason] of [
      ['{"keep": "\\ud800", "\\ud800": 1, "\\ud801": 2}', "lone surrogate"],
      ['{"hooks": {"__proto__": [{"hooks": [{"command": "mine"}]}], "Stop": []}}', "__proto__ event"],
      [Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), "not valid UTF-8"],
    ] as const) {
      const dir = seeded(text)
      const before = files(dir)
      const refused = swarm("native", dir, args, log)
      expect(refused.code).toBe(125)
      expect(refused.stdout).toBe("")
      expect(refused.stderr).toContain(reason)
      expect(refused.stderr).toContain(".claude/settings.json")
      expect(files(dir)).toEqual(before)
    }
    expect(readFileSync(log, "utf8")).not.toContain("hooks ts")
    const detail = (text: string) => text.replace(/is not valid JSON \(.*\)/, "is not valid JSON (<parse error>)")
    for (const text of ["{x", "", "null", '{"hooks": []}', '{"hooks": {"Stop": [{"hooks": [{"command": {"toString": null}}]}]}}']) {
      const [a, b] = [seeded(text), seeded(text)]
      const [fromTs, fromNative] = [swarm("ts", a, args), swarm("native", b, args, log)]
      expect({
        text,
        code: fromNative.code,
        stdout: fromNative.stdout,
        stderr: detail(fromNative.stderr).replace("Cannot convert object to primitive value", "No default value"),
      }).toEqual({
        text,
        code: fromTs.code,
        stdout: fromTs.stdout,
        stderr: detail(fromTs.stderr),
      })
      expect(files(b)).toEqual(files(a))
    }
  })

  test("printed snippets, mcp install lines and refusals are the same", () => {
    const dir = home()
    const cases = [
      ...INSTALLS.map((args) => ["hooks", "install", ...args]),
      ["hooks", "install", "--harness", "grok"],
      ["hooks", "install", "--harness", "claude", "--push-wait", "later"],
      ["hooks", "install", "--harness", "claude", "--push-wait", "3601"],
      ["hooks", "install", "--harness", "claude", "--write", "--print"],
      ["hooks", "install", "--harness", "claude", "--as", "x"],
      ["hooks", "uninstall"],
      ["hooks"],
      ...["claude", "codex", "grok", "opencode", "agy", "muse", "vim"].flatMap((harness) => [
        ["mcp", "install", "--harness", harness],
        ["mcp", "install", "--harness", harness, "--as", "lane-impl"],
      ]),
      ["mcp", "install", "--harness", "claude", "--as", "me"],
      ["--as", "lane", "mcp", "install", "--harness", "codex"],
      ["mcp", "install", "--harness", "claude", "--channels"],
      ["mcp", "install", "extra", "--harness", "claude"],
    ]
    const log = join(root, "print.log")
    for (const args of cases) {
      const ts = swarm("ts", dir, args)
      const native = swarm("native", dir, args, log)
      expect({ args, ...native }).toEqual({ args, ...ts })
    }
    expect(existsSync(ran)).toBe(false)
    const routed = readFileSync(log, "utf8")
    expect(routed).toContain("hooks native run")
    expect(routed).toContain("mcp native run")
  })
})
