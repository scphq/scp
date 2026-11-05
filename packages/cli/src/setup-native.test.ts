import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { swarmBinary } from "./test-setup"

setDefaultTimeout(180_000)

const entry = join(import.meta.dir, "cli.ts")
const fake = join(import.meta.dir, "setup-fake-harness.ts")
const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|OPENCODE|GROK_|MUSE_|CODEX_|SCP_)/
const HARNESSES = ["claude", "codex", "opencode", "grok", "muse", "agy"]
const root = mkdtempSync(join(process.env.HOME!, "setup-native-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Engine = "ts" | "native"
type Vars = Record<string, string>

function put(file: string, content: string | Buffer, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, mode)
}

function stub(dir: string, name: string) {
  put(join(dir, "bin", name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(fake)} ${name} "$@"\n`, 0o755)
}

const HELP = '#!/bin/sh\nprintf "  swarm mcp [--as NAME]\\n  swarm hook <harness> [event]\\n"\n'

let homes = 0
/** a scratch home with `installed` harness stand-ins, a `swarm` on its PATH and a work directory */
function home(installed: string[] = HARNESSES, cli: string | undefined = HELP) {
  const dir = join(root, `home-${homes++}`)
  mkdirSync(join(dir, "work", ".git"), { recursive: true })
  for (const name of installed) stub(dir, name)
  if (cli !== undefined) put(join(dir, "bin", "swarm"), cli, 0o755)
  return dir
}

/** `swarm <args>` on the TypeScript CLI or on the native binary, in identical environments */
function swarm(engine: Engine, dir: string, args: string[], vars: Vars = {}) {
  const env: Vars = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) env[key] = value
  delete env.CLAUDE_CONFIG_DIR
  delete env.GEMINI_CLI_HOME
  Object.assign(env, {
    HOME: dir,
    CODEX_HOME: join(dir, ".codex"),
    XDG_CONFIG_HOME: join(dir, ".config"),
    XDG_DATA_HOME: join(dir, ".local", "share"),
    SCP_DIR: join(dir, ".scp"),
    SCP_HOOK_BIN: join(dir, "no-such-hook"),
    PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
    ...vars,
  })
  if (vars.SCP_HOOK_BIN === "<unset>") delete env.SCP_HOOK_BIN
  const argv = engine === "ts" ? [process.execPath, "--no-env-file", entry, ...args] : [swarmBinary!, ...args]
  const result = Bun.spawnSync(argv, { env, cwd: join(dir, "work"), stdout: "pipe", stderr: "pipe" })
  const strip = (text: string) =>
    text
      .replaceAll(dir, "<home>")
      .replaceAll(swarmBinary!, "<swarm>")
      .replace(/\.bak-\d{14}(-\d+)?/g, ".bak-<stamp>")
  return { args: args.map(strip), code: result.exitCode, stdout: strip(result.stdout.toString()), stderr: strip(result.stderr.toString()) }
}

/** a backup's place among the file's backups: by time, then its suffix */
const backupOrder = (name: string) => {
  const [, stamp, n] = /\.bak-(\d{14})(?:-(\d+))?$/.exec(name) ?? []
  return `${stamp}-${(n ?? "1").padStart(4, "0")}`
}

/** every file under `dir` with its mode, the backups of a file numbered in order; symlinks by their target */
function files(dir: string): Record<string, string> {
  const found: Record<string, string> = {}
  const walk = (at: string, rel: string) => {
    const counts = new Map<string, number>()
    const names = readdirSync(at, { withFileTypes: true }).sort((a, b) => backupOrder(a.name).localeCompare(backupOrder(b.name)))
    for (const name of names) {
      if (name.name === ".git" || (rel === "" && [".bun", ".cache", "Library", "bin", ".scp"].includes(name.name))) continue
      const path = join(at, name.name)
      const base = name.name.replace(/\.bak-\d{14}(-\d+)?$/, ".bak")
      const nth = counts.get(base) ?? 0
      counts.set(base, nth + 1)
      const key = `${rel}${base}${base === name.name ? "" : `-${nth}`}`
      if (lstatSync(path).isSymbolicLink()) found[key] = `-> ${readlinkSync(path).replaceAll(dir, "<home>")}`
      else if (name.isDirectory()) walk(path, `${key}/`)
      else {
        const text = readFileSync(path, "latin1").replaceAll(dir, "<home>").replaceAll(swarmBinary!, "<swarm>")
        found[key] = `${(lstatSync(path).mode & 0o7777).toString(8)} ${text.replace(/"sha256:[0-9a-f]{64}"/g, '"<hash of a path-bearing file>"')}`
      }
    }
  }
  walk(dir, "")
  return found
}

type Step = string[] | { args: string[]; vars?: Vars; engine?: Engine }

/** a parse failure's words are the engine's own; the rest of the line and everything after it has to match */
const plain = (text: string) =>
  text
    .replace(/added, is unreadable \((?!it has|it is not|its added).*\); fix/g, "added, is unreadable (<parse error>); fix")
    .replace(/is unreadable \((?!its hooks|it has|it is not)[\s\S]*?\)(; fix it or rerun after|$)/gm, "is unreadable (<parse error>)$1")
    .replace(/(\.mcp\.json|settings\.json|config\.toml): [^\n]*JSON[^\n]*/g, "$1: <parse error>")

/** the same steps on both engines from the same start: output, exit codes and files after each step are equal */
function same(prepare: (dir: string) => void, steps: Step[], options: { installed?: string[]; cli?: string; vars?: Vars } = {}) {
  const runs = (["ts", "native"] as const).map((engine) => {
    const dir = home(options.installed, options.cli)
    prepare(dir)
    return steps.map((step) => {
      const { args, vars } = Array.isArray(step) ? { args: step, vars: {} } : step
      const result = swarm(engine, dir, args, { ...options.vars, ...vars })
      return { ...result, stdout: plain(result.stdout), stderr: plain(result.stderr), files: files(dir) }
    })
  })
  const [ts, native] = runs
  for (const [at, step] of ts!.entries()) {
    const { files: written, ...rest } = native![at]!
    const { files: wanted, ...expected } = step
    expect(rest).toEqual(expected)
    expect(written).toEqual(wanted)
  }
  return ts!
}

const nothing = () => {}

function lived(dir: string) {
  put(
    join(dir, ".claude.json"),
    `${JSON.stringify(
      {
        numStartups: 3,
        mcpServers: {
          other: { type: "stdio", command: "x", args: [] },
          scp: { type: "stdio", command: "swarm", args: ["mcp", "--harness", "claude"], env: { SCP_NAME: "secret" } },
        },
        projects: { "/a": {}, "/tmp/proj": { mcpServers: { scp: { type: "stdio", command: "swarm", args: ["mcp"] } } } },
      },
      null,
      2,
    )}\n`,
    0o600,
  )
  put(
    join(dir, ".codex", "config.toml"),
    '# keep me\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "foo"\n\n[mcp_servers.scp]\ncommand = "swarm"\nargs = ["mcp", "--harness", "codex"]\nstartup_timeout_sec = 30\n\n[mcp_servers.scp.env]\nSCP_NAME = "secret"\nSTARTED = 1979-05-27\n',
    0o600,
  )
  put(join(dir, ".grok", "config.toml"), '# comment\n[mcp_servers.scp]\ncommand = "swarm"\nargs = ["mcp", "--harness", "grok"]\n', 0o600)
  put(
    join(dir, ".config", "opencode", "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: { x: {} },
        mcp: { scp: { type: "local", command: ["swarm", "mcp", "--harness", "opencode"], enabled: true, environment: { SCP_NAME: "secret" }, timeout: 9000 } },
      },
      null,
      "\t",
    )}\n`,
    0o640,
  )
  put(
    join(dir, ".config", "muse", "settings.json"),
    JSON.stringify(
      {
        schema_version: 1,
        tui: { theme: "dark" },
        mcpServers: { scp: { type: "stdio", command: "swarm", args: ["mcp", "--harness", "muse"], mode: "required", env: { A: "b" } } },
      },
      null,
      4,
    ),
  )
  put(
    join(dir, ".gemini", "config", "mcp_config.json"),
    JSON.stringify(
      { mcpServers: { scp: { args: ["mcp", "--harness", "agy"], command: "swarm", disabled: true, timeout: 5000, env: { N: 1, S: "v" } } } },
      null,
      2,
    ),
    0o600,
  )
  put(
    join(dir, ".gemini", "antigravity-cli", "settings.json"),
    `${JSON.stringify({ permissions: { allow: ["command(swarm)"] }, trustedWorkspaces: [] }, null, 2)}\n`,
    0o600,
  )
  put(
    join(dir, ".claude", "settings.json"),
    '{\n    "model": "opus",\n    "n": 1e3,\n    "hooks": {"Notification": [{"hooks": [{"type": "command", "command": "notify"}]}]}\n}',
  )
  put(join(dir, ".codex", "hooks.json"), '{"hooks": {"Stop": [{"hooks": [{"command": "swarm hook codex --block-stop-on-unread"}]}]}}')
}

const noBinary = !swarmBinary
const REGRESS = [["setup"], ["setup", "--write"], ["setup"], ["setup", "--undo"], ["setup", "--undo", "--write"], ["setup"]]

describe.skipIf(noBinary)("setup, TypeScript against native", () => {
  test("a fresh home: plan, write, up to date, undo", () => {
    const steps = same(nothing, REGRESS)
    expect(steps[1]!.stdout).toContain("verify:")
    expect(steps[2]!.stdout).toContain("everything is in place; nothing to do")
  })

  test("a lived-in home keeps what it had through write and undo", () => {
    const steps = same(lived, REGRESS)
    expect(steps[1]!.files[".codex/config.toml.bak-0"]).toContain("# keep me")
    expect(steps[1]!.files[".claude/settings.json"]).toContain('"Notification"')
  })

  test("each harness alone, and the flags of a run", () => {
    for (const harness of HARNESSES)
      same(lived, [
        ["setup", "--harness", harness, "--write"],
        ["setup", "--harness", harness, "--undo", "--write"],
      ])
    same(nothing, [
      ["setup", "--no-hooks", "--write"],
      ["setup"],
      ["setup", "--write", "--block-stop-on-unread"],
      ["setup", "--write"],
      ["setup", "--undo", "--no-hooks", "--write"],
      ["setup", "--undo", "--write"],
    ])
    same(nothing, [
      ["setup", "--join", "manual"],
      ["setup", "--join", "manual", "--write"],
      ["setup", "--join", "auto", "--write"],
    ])
    same(nothing, [["setup", "--hooks", "--harness", "codex"]], { installed: ["codex"] })
    same(nothing, [["setup"]], { installed: [] })
    same(
      nothing,
      [
        ["setup", "--write"],
        ["setup", "--undo", "--write"],
      ],
      { installed: ["grok"] },
    )
    same(
      nothing,
      [
        ["setup", "--write"],
        ["setup", "--undo", "--harness", "grok", "--write"],
      ],
      { installed: ["grok", "claude"] },
    )
  })

  test("the mounts and hooks an environment asks for", () => {
    const hook = (dir: string) => put(join(dir, "fake-hook"), `#!/bin/sh\necho "scp-hook ${pkg.version}"\n`, 0o755)
    const hooked = (dir: string) => {
      hook(dir)
      return dir
    }
    for (const engine of ["auto", "native", "ts"]) {
      const runs = (["ts", "native"] as const).map((which) => {
        const dir = hooked(home())
        return [
          swarm(which, dir, ["setup", "--write", "--engine", engine], { SCP_HOOK_BIN: join(dir, "fake-hook") }),
          swarm(which, dir, ["setup"], { SCP_HOOK_BIN: join(dir, "fake-hook") }),
          files(dir),
        ]
      })
      expect(runs[1]).toEqual(runs[0]!)
    }
    same(nothing, [
      ["setup", "--engine", "native"],
      { args: ["setup"], vars: { SCP_ENGINE: "native" } },
      { args: ["setup"], vars: { SCP_ENGINE: "bad" } },
      { args: ["setup"], vars: { SCP_ENGINE: "" } },
    ])
    same(nothing, [
      { args: ["setup", "--write"], vars: { SCP_TRANSPORT: "cloud" } },
      { args: ["setup", "--undo"], vars: { SCP_TRANSPORT: "cloud" } },
    ])
    const nativeVars = { SCP_SWARM_BIN: swarmBinary! }
    same(lived, [
      { args: ["setup", "--write"], vars: { ...nativeVars, SCP_NATIVE: "1" } },
      { args: ["setup"], vars: { ...nativeVars, SCP_NATIVE: "mcp" } },
      { args: ["setup", "--write"], vars: { ...nativeVars, SCP_NATIVE: "mcp" } },
      { args: ["setup"], vars: nativeVars },
      { args: ["setup", "--write"], vars: nativeVars },
      ["setup", "--undo", "--write"],
    ])
    same(nothing, [{ args: ["setup"], vars: { SCP_NATIVE: "1", SCP_SWARM_BIN: "/no/such/swarm" } }])
    same(nothing, [{ args: ["setup", "--write"], vars: { SCP_HOOK_BIN: "<unset>" } }])
    same(
      nothing,
      [
        {
          args: ["setup", "--write"],
          vars: { CLAUDE_CONFIG_DIR: "/x" },
        },
      ].slice(1),
    )
    const configured = (dir: string) => join(dir, "claude-home")
    const runs = (["ts", "native"] as const).map((engine) => {
      const dir = home()
      const vars = { CLAUDE_CONFIG_DIR: configured(dir) }
      return [
        swarm(engine, dir, ["setup", "--write"], vars),
        swarm(engine, dir, ["setup"], vars),
        swarm(engine, dir, ["setup", "--undo", "--write"], vars),
        files(dir),
      ]
    })
    expect(runs[1]).toEqual(runs[0]!)
  })

  test("a swarm that is a node script, a missing one, one without the relay, and --bin", () => {
    const script = (dir: string) => {
      put(join(dir, "tool", "cli.js"), "#!/usr/bin/env node\n", 0o755)
      put(join(dir, "tool", "node"), `#!/bin/sh\n${HELP.split("\n")[1]}\n`, 0o755)
      symlinkSync(join(dir, "tool", "cli.js"), join(dir, "bin", "swarm-link"))
    }
    same(script, [{ args: ["setup"] }, { args: ["setup", "--write", "--no-hooks"] }])
    const runs = (["ts", "native"] as const).map((engine) => {
      const dir = home(HARNESSES, undefined)
      const bin = join(dir, "bin", "swarm-alt")
      put(bin, HELP, 0o755)
      return [
        swarm(engine, dir, ["setup"]),
        swarm(engine, dir, ["setup", "--undo"]),
        swarm(engine, dir, ["setup", "--bin", bin]),
        swarm(engine, dir, ["setup", "--bin", bin, "--write"]),
        swarm(engine, dir, ["setup", "--bin", "relative"]),
        swarm(engine, dir, ["setup", "--bin", join(dir, "nope")]),
        files(dir),
      ]
    })
    expect(runs[1]).toEqual(runs[0]!)
    same(nothing, [["setup"], ["setup", "--write"]], { cli: "#!/bin/sh\necho no relay here\n" })
    same(nothing, [["setup"], ["setup", "--write"]], { cli: '#!/bin/sh\necho "  swarm mcp"\n' })
    const linked = (["ts", "native"] as const).map((engine) => {
      const dir = home()
      const real = join(dir, "opt", "swarm")
      put(real, HELP, 0o755)
      rmSync(join(dir, "bin", "swarm"))
      symlinkSync(real, join(dir, "bin", "swarm"))
      return [swarm(engine, dir, ["setup"]), files(dir)]
    })
    expect(linked[1]).toEqual(linked[0]!)
  })

  test("usage errors", () => {
    same(nothing, [
      ["setup", "--harness", "vim"],
      ["setup", "--block-stop-on-unread", "--no-hooks"],
      ["setup", "--block-stop-on-unread", "--undo"],
      ["setup", "--join", "manual", "--undo"],
      ["setup", "--join", "later"],
      ["setup", "--engine", "rust"],
      ["setup", "--hooks", "--no-hooks"],
      ["setup", "--nope"],
      ["setup", "stray"],
      ["setup", "--bin"],
      ["--as", "x", "setup"],
      ["setup", "--cowork", "--undo"],
      ["setup", "--cowork", "--harness", "claude"],
      ["setup", "--cowork", "--no-hooks"],
      ["setup", "--cowork", "--join", "auto"],
      ["setup", "--cowork", "--block-stop-on-unread"],
      ["setup", "claude-desktop", "--nope"],
      ["setup", "claude-desktop", "--out", "relative.mcpb"],
      ["setup", "claude-desktop", "--out", "/tmp/x.zip"],
      ["setup", "claude-desktop", "--bin", "relative"],
      ["setup", "claude-desktop", "stray"],
    ])
  })
})

describe.skipIf(noBinary)("setup across engines", () => {
  const run = (prepare: (dir: string) => void, first: Engine, second: Engine) => {
    const dir = home()
    prepare(dir)
    const wrote = swarm(first, dir, ["setup", "--write"])
    const configs = () => {
      const { ".fake-calls": _calls, ...rest } = files(dir)
      return rest
    }
    const after = configs()
    const plan = swarm(second, dir, ["setup"])
    expect(configs()).toEqual(after)
    const undone = swarm(second, dir, ["setup", "--undo", "--write"])
    return { wrote, plan, undone, files: files(dir) }
  }

  test("a write by either engine leaves nothing for the other to do, and the other's undo removes it", () => {
    for (const prepare of [nothing, lived]) {
      const tsFirst = run(prepare, "ts", "native")
      const nativeFirst = run(prepare, "native", "ts")
      expect(tsFirst.plan.code).toBe(0)
      expect(tsFirst.plan.stdout).toContain("everything is in place; nothing to do")
      expect(nativeFirst.plan.stdout).toContain("everything is in place; nothing to do")
      expect(tsFirst.undone.code).toBe(0)
      expect(nativeFirst).toEqual(tsFirst)
    }
  })

  test("the manifest one engine wrote drives the other's undo item by item", () => {
    for (const [first, second] of [
      ["ts", "native"],
      ["native", "ts"],
    ] as const) {
      const dir = home()
      expect(swarm(first, dir, ["setup", "--write"]).code).toBe(0)
      const manifest = JSON.parse(readFileSync(join(dir, ".config", "scp", "setup.json"), "utf8")) as { added: { kind: string }[] }
      expect(manifest.added.map((item) => item.kind)).toContain("rules")
      for (const harness of HARNESSES) expect(swarm(second, dir, ["setup", "--undo", "--write", "--harness", harness]).code).toBe(0)
      expect(existsSync(join(dir, ".config", "scp", "setup.json"))).toBe(false)
    }
  })
})

describe.skipIf(noBinary)("setup on files it has to be careful with", () => {
  const SETTINGS = {
    claude: ".claude/settings.json",
    codex: ".codex/hooks.json",
    agy: ".gemini/config/hooks.json",
    muse: ".config/muse/settings.json",
    opencode: ".config/opencode/opencode.json",
    rules: ".gemini/antigravity-cli/settings.json",
    mounts: ".gemini/config/mcp_config.json",
  }

  test("JSON keeps its indent, key order and what JavaScript prints of its numbers", () => {
    const texts = [
      '{\n\t"z": 1.50,\n\t"10": 1e3,\n\t"2": -0,\n\t"a": {"b": [1, 2]},\n\t"big": 12345678901234567890\n}',
      '{\r\n    "a": 1\r\n}\r\n',
      '{"a":1}',
      '{ "a": "é\\u00e9\\/" }\n\n',
      '{"__proto__": {"a": 1}, "k": 1}',
      '{"a": 1, "a": 2}',
      "",
      "   \n",
      "{}",
      "{\n}\n",
      '{\n            "wider than ten": 1\n}',
    ]
    for (const text of texts) {
      const seeded = (dir: string) => {
        for (const file of Object.values(SETTINGS)) put(join(dir, file), text)
      }
      same(seeded, [
        ["setup", "--write"],
        ["setup", "--undo", "--write"],
      ])
    }
  })

  test("what JSON.parse refuses is left alone with the same line", () => {
    for (const text of ["{x", "null", "[]", "1", '{"a": 1} // trailing', '{\n  // comment\n  "a": 1,\n}\n', '"text"']) {
      const targets = [...Object.values(SETTINGS), ".claude.json", ".config/opencode/opencode.jsonc"]
      const seeded = (dir: string) => {
        for (const file of targets) put(join(dir, file), text)
      }
      const steps = same(seeded, [
        ["setup", "--write"],
        ["setup", "--undo", "--write"],
      ])
      for (const file of targets) expect(steps[1]!.files[file]).toEndWith(text)
    }
  })

  test("a JSONC config is never rewritten, and the opencode file is chosen alike", () => {
    const jsonc = '{\n  // my comment\n  "mcp": {}\n}\n'
    const steps = same((dir) => put(join(dir, ".config", "opencode", "opencode.jsonc"), jsonc), [["setup", "--harness", "opencode", "--write"]])
    expect(steps[0]!.files[".config/opencode/opencode.jsonc"]).toEndWith(jsonc)
    expect(steps[0]!.code).toBe(1)
    const plainConfig = '{"mcp": {"scp": {"type": "local", "command": ["x"]}}}'
    same(
      (dir) => {
        put(join(dir, ".config", "opencode", "opencode.json"), "{}")
        put(join(dir, ".config", "opencode", "config.json"), plainConfig)
      },
      [
        ["setup", "--harness", "opencode", "--write"],
        ["setup", "--harness", "opencode", "--undo", "--write"],
      ],
    )
    same((dir) => put(join(dir, ".config", "opencode", "opencode.jsonc"), '{"a": 1}'), [["setup", "--harness", "opencode", "--write"]])
    same((dir) => put(join(dir, ".config", "opencode", "opencode.json"), '{"mcp": 3}'), [["setup", "--harness", "opencode"]])
    same((dir) => put(join(dir, ".config", "muse", "settings.json"), '{"mcp_servers": {}}'), [["setup", "--harness", "muse", "--write"]])
    same((dir) => put(join(dir, ".config", "muse", "settings.json"), '{"mcpServers": 1}'), [["setup", "--harness", "muse"]])
    same((dir) => put(join(dir, ".gemini", "antigravity-cli", "settings.json"), '{"permissions": []}'), [["setup", "--harness", "agy"]])
    same((dir) => put(join(dir, ".gemini", "antigravity-cli", "settings.json"), '{"permissions": {"allow": 1}}'), [["setup", "--harness", "agy"]])
    same(
      (dir) => put(join(dir, ".gemini", "antigravity-cli", "settings.json"), '{"permissions": {"allow": [1, {"a": 1}, "mcp(scp/relay_list)"]}}'),
      [
        ["setup", "--harness", "agy", "--write"],
        ["setup", "--harness", "agy", "--undo", "--write"],
      ],
    )
  })

  test("TOML: dates, inline tables, comments and what neither parser takes", () => {
    const tomls = [
      'd = 1979-05-27T07:32:00Z\nt = 07:32:00\nl = 1979-05-27T07:32:00\nf = inf\n[mcp_servers.scp]\ncommand = "swarm"\nargs = ["mcp", "--harness", "HARNESS"]\n',
      'mcp_servers = { scp = { command = "swarm", args = ["mcp", "--harness", "HARNESS"], env = { A = "1", B = 2, C = 1979-05-27 } } }\n',
      '[mcp_servers.scp]\ncommand = "swarm"\nargs = []\nenv = { SCP_NATIVE = "1", SCP_CLI_ARGV = "[]", KEEP = "x" }\nenabled = false\ntool_timeout_sec = 1.5\n',
      '[mcp_servers]\nscp = "text"\n',
      "mcp_servers = 3\n",
      "[mcp_servers.scp\n",
      'a = "unterminated\n',
      "[a]\nb = 1\n[a]\nb = 2\n",
      "# only a comment\n",
      "",
      "big = 9007199254740993\n",
      "big = 0x7FFFFFFFFFFFFFFF\n",
    ]
    for (const template of tomls)
      for (const [harness, file] of [
        ["codex", ".codex/config.toml"],
        ["grok", ".grok/config.toml"],
      ] as const) {
        const text = template.replaceAll("HARNESS", harness)
        same(
          (dir) => put(join(dir, file), text, 0o600),
          [
            ["setup", "--harness", harness],
            ["setup", "--harness", harness, "--write"],
          ],
        )
      }
  })

  test("symlinked configs are written through, and a dangling one is refused where a CLI would replace it", () => {
    const linked = (file: string, target: string, content?: string) => (dir: string) => {
      const path = join(dir, target)
      mkdirSync(dirname(path), { recursive: true })
      if (content !== undefined) writeFileSync(path, content)
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      symlinkSync(path, join(dir, file))
    }
    for (const file of [".claude.json", ".config/muse/settings.json", ".claude/settings.json", ".gemini/antigravity-cli/settings.json", ".codex/config.toml"]) {
      const content = file.endsWith(".toml") ? "" : "{}\n"
      same(linked(file, "dotfiles/real", content), [["setup", "--write"], ["setup"], ["setup", "--undo", "--write"]])
      same(linked(file, "dotfiles/absent"), [["setup"], ["setup", "--write"]])
      const dangling = (dir: string) => {
        mkdirSync(dirname(join(dir, file)), { recursive: true })
        symlinkSync(join(dir, "gone", "x"), join(dir, file))
      }
      same(dangling, [["setup"]])
    }
    same(
      (dir) => {
        mkdirSync(join(dir, ".claude"), { recursive: true })
        symlinkSync(join(dir, ".claude", "b"), join(dir, ".claude", "settings.json"))
        symlinkSync(join(dir, ".claude", "settings.json"), join(dir, ".claude", "b"))
      },
      [["setup", "--harness", "claude"]],
    )
  })

  test("a harness CLI that fails: the mount comes back, the backup stays and the manifest says what landed", () => {
    same(lived, [{ args: ["setup", "--write"], vars: { FAKE_FAIL: "claude add-json" } }, ["setup"]])
    same(lived, [{ args: ["setup", "--write"], vars: { FAKE_FAIL: "claude remove" } }])
    same(nothing, [{ args: ["setup", "--write"], vars: { FAKE_FAIL: "codex" } }, ["setup", "--undo"]])
    same(nothing, [{ args: ["setup", "--write"], vars: { FAKE_FAIL: "muse install" } }, ["setup"], ["setup", "--undo", "--write"]])
    same(nothing, [{ args: ["setup", "--write"], vars: { FAKE_FAIL: "muse approve" } }, ["setup"], ["setup", "--undo", "--write"]])
    same(nothing, [["setup", "--write"], { args: ["setup", "--undo", "--write"], vars: { FAKE_FAIL: "muse remove" } }, ["setup", "--undo", "--write"]])
    same(nothing, [["setup", "--write"], { args: ["setup", "--undo", "--write"], vars: { FAKE_FAIL: "agy" } }])
  })

  test("verification reports what each listing says", () => {
    same(nothing, [
      { args: ["setup", "--write"], vars: { FAKE_FAIL: "claude get" } },
      { args: ["setup", "--undo", "--write"], vars: { FAKE_FAIL: "opencode list" } },
    ])
    same(nothing, [{ args: ["setup", "--write"], vars: { FAKE_FAIL: "codex list" } }])
  })

  test("the manifest: unknown keys kept, unreadable refused, a mount setup did not add left", () => {
    const manifest = (text: string) => (dir: string) => put(join(dir, ".config", "scp", "setup.json"), text, 0o600)
    for (const text of ["{x", "[]", '{"added": 1}', "", '{"version": 1}']) same(manifest(text), [["setup"], ["setup", "--undo"]])
    same(
      manifest(
        '{"version": 1, "extra": true, "added": [{"harness": "claude", "kind": "mcp", "file": "/nowhere/x.json", "note": "kept"}, {"harness": 1}, 7, {"harness": "agy", "kind": "rules", "file": "/nowhere/y.json", "rules": ["a"]}]}',
      ),
      [
        ["setup", "--write"],
        ["setup", "--undo"],
      ],
    )
    same(lived, [
      ["setup", "--undo"],
      ["setup", "--undo", "--write"],
    ])
    same(nothing, [
      ["setup", "--write"],
      { args: ["setup", "--undo"], vars: { PATH: "/usr/bin:/bin" } },
      { args: ["setup", "--undo", "--write"], vars: { PATH: "/usr/bin:/bin" } },
    ])
  })

  test("plugins and hook files setup finds changed or gone", () => {
    same(nothing, [["setup", "--write"]].concat([["setup", "--undo"]]), {})
    const removeAfter = (rel: string) => {
      const runs = (["ts", "native"] as const).map((engine) => {
        const dir = home()
        swarm(engine, dir, ["setup", "--write"])
        rmSync(join(dir, rel), { force: true })
        return [swarm(engine, dir, ["setup", "--undo"]), swarm(engine, dir, ["setup", "--undo", "--write"]), files(dir)]
      })
      expect(runs[1]).toEqual(runs[0]!)
    }
    for (const rel of [
      ".claude/settings.json",
      ".config/opencode/plugin/scp.ts",
      ".config/scp/muse-plugin/.muse-plugin/plugin.json",
      ".gemini/config/hooks.json",
      ".claude.json",
      ".gemini/antigravity-cli/settings.json",
    ])
      removeAfter(rel)
    const replaced = (["ts", "native"] as const).map((engine) => {
      const dir = home()
      swarm(engine, dir, ["setup", "--write"])
      writeFileSync(join(dir, ".config", "opencode", "plugin", "scp.ts"), "// mine now\n")
      return [swarm(engine, dir, ["setup", "--undo", "--write"]), swarm(engine, dir, ["setup"]), files(dir)]
    })
    expect(replaced[1]).toEqual(replaced[0]!)
    const disabled = (["ts", "native"] as const).map((engine) => {
      const dir = home()
      swarm(engine, dir, ["setup", "--write"])
      const file = join(dir, ".local", "share", "muse", "plugins", "installed.json")
      const installed = JSON.parse(readFileSync(file, "utf8")) as { plugins: { scp: Record<string, unknown> } }
      installed.plugins.scp.enabled = false
      writeFileSync(file, JSON.stringify(installed))
      const first = swarm(engine, dir, ["setup", "--write"])
      installed.plugins.scp.enabled = true
      installed.plugins.scp.reviewed = false
      writeFileSync(file, JSON.stringify(installed))
      return [first, swarm(engine, dir, ["setup", "--write"]), swarm(engine, dir, ["setup"]), files(dir)]
    })
    expect(disabled[1]).toEqual(disabled[0]!)
    const gone = (dir: string) =>
      put(
        join(dir, ".codex", "hooks.json"),
        '{"hooks": {"Stop": [{"hooks": [{"command": "[ -x /gone/scp-hook ] && exec /gone/scp-hook swarm hook codex || exec swarm hook codex"}]}]}}',
      )
    same(gone, [["setup", "--harness", "codex"]])
    const shadowed = (dir: string) => {
      put(join(dir, "work", ".claude", "settings.local.json"), '{"hooks": {"Stop": [{"hooks": [{"command": "swarm hook claude"}]}]}}')
      put(join(dir, "work", ".mcp.json"), '{"mcpServers": {"scp": {"command": "x"}}}')
      put(join(dir, "work", ".codex", "hooks.json"), '{"hooks": {"Stop": [{"hooks": [{"command": "swarm hook codex"}]}]}}')
    }
    same(shadowed, [["setup"]])
  })

  test("what would not survive a rewrite is refused by the native engine, and the file stays as it was", () => {
    const refused = (file: string, text: string | Buffer, harness: string, word: string) => {
      const dir = home()
      put(join(dir, file), text)
      const before = files(dir)[file]
      const plan = swarm("native", dir, ["setup", "--harness", harness])
      expect(plan.code).toBe(0)
      expect(plan.stdout).toContain(word)
      const wrote = swarm("native", dir, ["setup", "--harness", harness, "--write"])
      expect(wrote.code).toBe(1)
      expect(files(dir)[file]).toBe(before!)
      expect(Object.keys(files(dir)).filter((name) => name.startsWith(`${file}.bak`))).toEqual([])
    }
    refused(".codex/config.toml", "x = { a = 1, }\n", "codex", "is unreadable")
    const lone = '{"keep": "\\ud800"}'
    for (const [harness, file] of [
      ["claude", SETTINGS.claude],
      ["codex", SETTINGS.codex],
      ["agy", SETTINGS.agy],
      ["agy", SETTINGS.rules],
      ["muse", SETTINGS.muse],
      ["opencode", SETTINGS.opencode],
    ] as const) {
      refused(file, lone, harness, "lone surrogate")
      refused(file, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), harness, "not valid UTF-8")
    }
    const raw = (text: string) => Buffer.concat(text.split("<ff>").flatMap((part, at) => [...(at ? [Buffer.from([0xff])] : []), Buffer.from(part)]))
    const mount = raw('{"mcpServers": {"scp": {"command": "x", "args": [], "env": {"A": "<ff>"}}}}')
    refused(".claude.json", mount, "claude", "not valid UTF-8")
    refused(".claude.json", raw('{"note": "<ff>", "mcpServers": {}}'), "claude", "not valid UTF-8")
    refused(".gemini/config/mcp_config.json", mount, "agy", "not valid UTF-8")
    refused(".codex/config.toml", raw('[mcp_servers.scp]\ncommand = "x"\n[mcp_servers.scp.env]\nA = "<ff>"\n'), "codex", "not valid UTF-8")
    refused(".grok/config.toml", raw('[mcp_servers.scp]\ncommand = "x"\n[mcp_servers.scp.env]\nA = "<ff>"\n'), "grok", "not valid UTF-8")
    refused(".config/opencode/plugin/scp.ts", raw("// scp: <ff>\nconst BLOCK_STOP = true\n"), "opencode", "not valid UTF-8")
    refused(".config/scp/muse-plugin/.muse-plugin/plugin.json", raw('{"a": "<ff>"}'), "muse", "not valid UTF-8")
    const bytes = home()
    expect(swarm("native", bytes, ["setup", "--write"]).code).toBe(0)
    for (const [harness, file, word] of [
      ["claude", ".claude.json", "mcp: skipped"],
      ["codex", ".codex/config.toml", "mcp: skipped"],
      ["opencode", ".config/opencode/plugin/scp.ts", "hooks: skipped"],
    ] as const) {
      const path = join(bytes, file)
      const damaged = Buffer.concat([readFileSync(path), Buffer.from([0xff])])
      writeFileSync(path, damaged)
      const calls = readFileSync(join(bytes, ".fake-calls"), "utf8")
      const undo = swarm("native", bytes, ["setup", "--undo", "--harness", harness, "--write"])
      expect(undo.code).toBe(1)
      expect(undo.stdout).toContain(word)
      expect(undo.stdout).toContain("not valid UTF-8")
      expect(readFileSync(path)).toEqual(damaged)
      expect(readFileSync(join(bytes, ".fake-calls"), "utf8").replace(calls, "")).not.toContain('"remove"')
    }
    for (const damage of [raw('{"plugins": {"scp": {"id": "<ff>"}}}'), "{x"]) {
      const registered = home()
      expect(swarm("native", registered, ["setup", "--write"]).code).toBe(0)
      const installed = join(registered, ".local", "share", "muse", "plugins", "installed.json")
      writeFileSync(installed, damage)
      const undo = swarm("native", registered, ["setup", "--undo", "--harness", "muse", "--write"])
      expect(undo.code).toBe(1)
      expect(undo.stdout).toContain("hooks: skipped, ~/.local/share/muse/plugins/installed.json is unreadable")
      expect(existsSync(join(registered, ".config", "scp", "muse-plugin", ".muse-plugin", "plugin.json"))).toBe(true)
      expect(readFileSync(installed)).toEqual(Buffer.from(damage))
      const kept = JSON.parse(readFileSync(join(registered, ".config", "scp", "setup.json"), "utf8")) as { added: { harness: string; kind: string }[] }
      expect(kept.added.some((item) => item.harness === "muse" && item.kind === "hooks")).toBe(true)
      expect(readFileSync(join(registered, ".fake-calls"), "utf8")).not.toContain('"plugins","remove"')
    }
    refused(SETTINGS.claude, '{"hooks": {"__proto__": [{"hooks": [{"command": "mine"}]}]}}', "claude", "__proto__")
    refused(SETTINGS.codex, '{"hooks": {"__proto__": {"a": 1}}}', "codex", "__proto__")
    refused(".claude.json", '{"mcpServers": {"scp": {"command": "x", "env": {"A": "\\ud800"}}}}', "claude", "lone surrogate")
    refused(".gemini/config/mcp_config.json", '{"mcpServers": {"scp": {"command": "x", "env": {"A": "\\ud800"}}}}', "agy", "lone surrogate")
    const elsewhere = same(
      (dir) => put(join(dir, ".claude.json"), '{"note": "\\ud800", "mcpServers": {}}'),
      [["setup", "--harness", "claude", "--no-hooks", "--write"]],
    )
    expect(elsewhere[0]!.code).toBe(0)
    const undone = home()
    expect(swarm("native", undone, ["setup", "--write"]).code).toBe(0)
    const settings = join(undone, SETTINGS.claude)
    writeFileSync(settings, readFileSync(settings, "utf8").replace('"hooks": {', '"hooks": {"__proto__": [],'))
    const before = readFileSync(settings)
    expect(swarm("native", undone, ["setup", "--undo", "--write"]).stdout).toContain("__proto__")
    expect(readFileSync(settings)).toEqual(before)
    const config = home()
    put(join(config, ".config", "scp", "config.json"), '{"note": "\\ud800"}')
    const join_ = swarm("native", config, ["setup", "--join", "manual", "--write"])
    expect(join_.code).not.toBe(0)
    expect(join_.stderr).toContain("lone surrogate")
    expect(readFileSync(join(config, ".config", "scp", "config.json"), "utf8")).toBe('{"note": "\\ud800"}')
    const list = home()
    put(join(list, ".config", "scp", "setup.json"), '{"added": [{"harness": "claude", "kind": "mcp", "file": "/x", "note": "\\ud800"}]}')
    expect(swarm("native", list, ["setup"]).stderr).toContain("lone surrogate")
  })
})

describe.skipIf(noBinary)("setup claude-desktop and --cowork, TypeScript against native", () => {
  const zipEntries = (bytes: Buffer) => {
    const entries: Record<string, string> = {}
    for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50; ) {
      const size = bytes.readUInt32LE(at + 18)
      const nameLength = bytes.readUInt16LE(at + 26)
      const name = bytes.toString("utf8", at + 30, at + 30 + nameLength)
      entries[name] = bytes.toString("utf8", at + 30 + nameLength, at + 30 + nameLength + size)
      at += 30 + nameLength + size
    }
    return entries
  }

  /** what `args` builds in `dir`, the outputs of a build before it gone, so both engines' paths and so their bytes are the same */
  const build = (engine: Engine, dir: string, args: string[], vars: Vars) => {
    rmSync(join(dir, ".scp"), { recursive: true, force: true })
    rmSync(join(dir, ".config", "scp"), { recursive: true, force: true })
    const result = swarm(engine, dir, args, vars)
    const read = (file: string) => (existsSync(file) ? readFileSync(file) : undefined)
    const tree: Record<string, string> = {}
    const plugin = join(dir, ".scp", "cowork-plugin")
    const walk = (at: string, rel: string) => {
      for (const name of readdirSync(at, { withFileTypes: true })) {
        if (name.isDirectory()) walk(join(at, name.name), `${rel}${name.name}/`)
        else tree[`${rel}${name.name}`] = `${(lstatSync(join(at, name.name)).mode & 0o777).toString(8)} ${readFileSync(join(at, name.name), "utf8")}`
      }
    }
    if (existsSync(plugin)) walk(plugin, "")
    return { result, mcpb: read(join(dir, ".config", "scp", "scp.mcpb")), zip: read(join(dir, ".scp", "scp-cowork.zip")), tree }
  }

  const script = (dir: string) => {
    put(join(dir, "tool", "cli.js"), "#!/usr/bin/env node\n", 0o755)
    put(join(dir, "bin", "node"), "#!/bin/sh\n", 0o755)
    rmSync(join(dir, "bin", "swarm"))
    symlinkSync(join(dir, "tool", "cli.js"), join(dir, "bin", "swarm"))
  }

  const VARIANTS: { vars: Vars; prepare?: (dir: string) => void }[] = [
    { vars: {} },
    { vars: {}, prepare: script },
    { vars: { SCP_NATIVE: "1", SCP_SWARM_BIN: swarmBinary ?? "" } },
    { vars: { SCP_NATIVE: "mcp", SCP_SWARM_BIN: swarmBinary ?? "" } },
    { vars: { SCP_NATIVE: "1", SCP_SWARM_BIN: "/no/such/swarm" } },
  ]

  test("the extension is the same bytes", () => {
    for (const { vars, prepare } of VARIANTS) {
      const dir = home()
      prepare?.(dir)
      const ts = build("ts", dir, ["setup", "claude-desktop"], vars)
      const fromNative = build("native", dir, ["setup", "claude-desktop"], vars)
      expect(ts.result.code).toBe(0)
      expect(fromNative).toEqual(ts)
    }
    const dir = home()
    const out = join(dir, "built", "x.mcpb")
    put(join(dir, "bin", "open"), "#!/bin/sh\nexit 3\n", 0o755)
    const direct = (["ts", "native"] as const).map((engine) => {
      rmSync(join(dir, "built"), { recursive: true, force: true })
      const steps = [
        swarm(engine, dir, ["setup", "claude-desktop", "--out", out, "--open"]),
        swarm(engine, dir, ["setup", "claude-desktop", "--out", out, "--bin", join(dir, "bin", "swarm")]),
      ]
      return [steps, files(dir)]
    })
    expect(direct[1]).toEqual(direct[0]!)
    const noCli = (["ts", "native"] as const).map((engine) => swarm(engine, home(HARNESSES, undefined), ["setup", "claude-desktop"]))
    expect(noCli[1]).toEqual(noCli[0]!)
  })

  test("the Cowork plugin compares entry by entry", () => {
    for (const { vars, prepare } of VARIANTS) {
      const dir = home()
      prepare?.(dir)
      const ts = build("ts", dir, ["setup", "--cowork"], vars)
      const fromNative = build("native", dir, ["setup", "--cowork"], vars)
      expect(ts.result).toMatchObject({ code: 0, stderr: "" })
      expect(Object.keys(zipEntries(ts.zip!))).toEqual([".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json"])
      expect(zipEntries(fromNative.zip!)).toEqual(zipEntries(ts.zip!))
      expect(fromNative).toEqual(ts)
    }
    const runs = (["ts", "native"] as const).map((engine) => {
      const dir = home()
      return [
        swarm(engine, dir, ["setup", "--cowork", "--write"]),
        swarm(engine, dir, ["setup", "--cowork"]),
        swarm(engine, dir, ["setup", "--cowork", "--bin", "rel"]),
        swarm(engine, dir, ["setup", "--cowork", "--bin", join(dir, "nope")]),
      ]
    })
    expect(runs[1]).toEqual(runs[0]!)
    const lost = (engine: Engine) => {
      const dir = home()
      put(join(dir, "bin", "swarm"), "#!/usr/bin/env node\n", 0o755)
      return swarm(engine, dir, ["setup", "--cowork"], { PATH: join(dir, "bin") })
    }
    expect(lost("native")).toEqual(lost("ts"))
  })
})

describe.skipIf(noBinary)("setup through the router", () => {
  test("a routed setup runs natively, and the kill switch keeps it on TypeScript", () => {
    const log = process.env.SCP_ROUTE_LOG ?? join(root, "route.log")
    const dir = home()
    const routed = (args: string[], extra: Vars = {}) => {
      const env = { SCP_NATIVE: "1", SCP_SWARM_BIN: swarmBinary!, SCP_ROUTE_LOG: log, ...extra }
      const argv = [process.execPath, "--no-env-file", entry, ...args]
      const vars: Vars = {}
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) vars[key] = value
      delete vars.CLAUDE_CONFIG_DIR
      Object.assign(vars, {
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, ".config"),
        SCP_DIR: join(dir, ".scp"),
        CODEX_HOME: join(dir, ".codex"),
        PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
        SCP_HOOK_BIN: join(dir, "none"),
        ...env,
      })
      return Bun.spawnSync(argv, { env: vars, cwd: join(dir, "work"), stdout: "pipe", stderr: "pipe" })
    }
    expect(routed(["setup", "--write"]).exitCode).toBe(0)
    expect(routed(["setup"]).stdout.toString()).toContain("everything is in place")
    expect(routed(["setup"], { SCP_NATIVE_TS: "setup" }).stdout.toString()).toContain("everything is in place")
    expect(routed(["setup", "claude-desktop"]).exitCode).toBe(0)
    expect(routed(["setup", "--cowork"]).exitCode).toBe(0)
    expect(routed(["setup", "--help"]).stdout.toString()).toContain("--undo")
    const lines = readFileSync(log, "utf8")
    expect(lines).toContain("setup native run")
    expect(lines).toContain("setup ts forced")
    expect(lines).toContain("setup ts decline")
  })
})

describe.skipIf(noBinary)("up, TypeScript against native", () => {
  const HUB = `
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (request.headers.get("authorization") !== "Bearer scp_good") return Response.json({ error: "unauthorized" }, { status: 401 })
    return Response.json({ kind: "human", email: "a@b.dev", org: "org_1", role: "owner", token: "scp_good" })
  },
})
console.log(server.port)
`

  /** a hub in its own process, since the steps block this one, taking one token */
  async function withHub<T>(steps: (url: string) => T): Promise<T> {
    const script = join(root, "hub.ts")
    writeFileSync(script, HUB)
    const hub = Bun.spawn([process.execPath, "--no-env-file", script], { stdout: "pipe" })
    try {
      const { value } = await hub.stdout.getReader().read()
      return steps(`http://127.0.0.1:${Buffer.from(value!).toString().trim()}`)
    } finally {
      hub.kill()
    }
  }

  const steady = (text: string) => text.replaceAll(/http:\/\/127\.0\.0\.1:\d+/g, "<hub>").replace(/ as machine \S+ /, " as machine <host> ")

  test("a headless up logs in, links, sets up and says what to run next", async () => {
    const runs = await withHub((url) =>
      [{ SCP_NATIVE_TS: "up,setup,cloud" }, { SCP_ROUTE_LOG: process.env.SCP_ROUTE_LOG ?? join(root, "up.log") }].map((route) => {
        const dir = home()
        const vars = { SCP_RELAY: url, SCP_NATIVE: "1", SCP_SWARM_BIN: swarmBinary!, ...route }
        const first = swarm("ts", dir, ["up", "--token", "scp_good", "--machine", "laptop", "--label", "t"], vars)
        const second = swarm("ts", dir, ["up", "--machine", "laptop"], vars)
        const bad = swarm("ts", dir, ["up", "--token", "scp_bad"], vars)
        const stray = swarm("ts", dir, ["up", "stray"], vars)
        swarm("ts", dir, ["daemon", "stop"], vars)
        const { "cloud.json": _cloud, ...state } = files(join(dir, ".config", "scp"))
        const shown = [first, second, bad, stray].map((step) => ({ ...step, stdout: steady(step.stdout), stderr: steady(step.stderr) }))
        return { shown, state: Object.keys(state), mounts: files(dir)[".fake-calls"] }
      }),
    )
    expect(runs[0]!.shown[0]!.code).toBe(0)
    expect(runs[0]!.shown[0]!.stdout).toContain("next: start each agent session wake-enabled:")
    expect(runs[1]).toEqual(runs[0]!)
  })
})
