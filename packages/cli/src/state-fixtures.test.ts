import { spawnSync } from "node:child_process"
import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseWakers, type Runner, readSessionMarker, type WakerConfigs, writeSessionMarker } from "@scp-dev/broker"
import { lint, validate } from "../../conformance/src/broker/schema"
import { bgMount } from "./claude"
import {
  type BgTaskState,
  bgConfig,
  claudeWakeCommand,
  historicAfterS,
  readAllStates,
  readRecords,
  lockSession,
  readState,
  readTaskState,
  refSession,
  reviveRef,
  spawnIdleAfterS,
  writeState,
  writeTaskState,
} from "./claude-bg"
import { codexLockPath, codexOwner, codexThread } from "./codex-queue"
import { parseHoldRef, refProblem } from "./hold"
import { claudeVersion, claudeVersionFile, stopContinues } from "./hooks"
import { readMuseLaunch, readShimBinding, writeMuseLaunch, writeShimBinding } from "./identity"
import { activeRelay, joinMode, readCredentials, relayCredential, saveCredential, setJoinMode } from "./relay"
import { cloudFilePath, cloudMain, readCloudFile } from "./remote"
import { readRunners, runnersPath } from "./remote-spawn"
import { membership } from "./session"
import { cacheClaudeVersion, manifestFile, readManifest, writeManifest } from "./setup"
import { durableRef } from "./spawn"
import { SELF } from "./term"

const schemaDir = join(import.meta.dir, "../../spec/schema/cli")
const fixtureDir = join(schemaDir, "fixtures")
const TEXT_FORMATS = new Set(["claude-bg-ref", "claude-version", "codex-thread-lock"])
const SID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
const PK = "pid:48213:Wed-Nov-4-09:12:44-2026"

const scratchRoot = mkdtempSync(join(tmpdir(), "scp-state-fixtures-"))
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }))
const scratch = (): string => mkdtempSync(join(scratchRoot, "d-"))

type Fixture = { name: string; text: string; invalid: boolean; tolerated: boolean }

const formats = readdirSync(schemaDir)
  .filter((name) => name.endsWith(".schema.json") && name !== "common.schema.json")
  .map((name) => name.slice(0, -".schema.json".length))
  .sort()

function fixtures(format: string): Fixture[] {
  return readdirSync(join(fixtureDir, format))
    .sort()
    .map((name) => ({
      name,
      text: readFileSync(join(fixtureDir, format, name), "utf8"),
      invalid: name.startsWith("invalid-"),
      tolerated: name.startsWith("tolerated-"),
    }))
}

/** the value a fixture holds: the parsed JSON of a .json file, the text of a .txt file of a text format */
function contentOf(format: string, fixture: Fixture): unknown {
  if (fixture.name.endsWith(".json")) return JSON.parse(fixture.text)
  if (TEXT_FORMATS.has(format)) return fixture.text
  throw new Error(`${format}/${fixture.name} is raw text for a JSON format`)
}

const schemaOf = (format: string) => `../cli/${format}.schema.json`
const conforms = (format: string, value: unknown) => validate(schemaOf(format), value)
const good = (format: string) => fixtures(format).filter((f) => !f.invalid && !f.tolerated)
const bad = (format: string) => fixtures(format).filter((f) => f.invalid)
const tolerated = (format: string) => fixtures(format).filter((f) => f.tolerated)
const fixture = (format: string, name: string) => fixtures(format).find((f) => f.name === name)!
const fileMode = (path: string) => statSync(path).mode & 0o777

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, text, { mode: 0o600 })
  return path
}

describe("state schemas", () => {
  test("use the portable keyword subset and resolve every $ref", () => {
    for (const file of ["common.schema.json", ...formats.map((format) => `${format}.schema.json`)]) expect(lint(`../cli/${file}`)).toEqual([])
  })

  test("every format has valid and edge fixtures", () => {
    expect(readdirSync(fixtureDir).sort()).toEqual(formats)
    for (const format of formats) expect(good(format).length).toBeGreaterThan(0)
  })

  for (const format of formats) {
    test(`${format}: valid fixtures conform, tolerated ones do not`, () => {
      for (const f of good(format)) expect({ name: f.name, errors: conforms(format, contentOf(format, f)) }).toEqual({ name: f.name, errors: [] })
      for (const f of tolerated(format)) expect(conforms(format, contentOf(format, f)).length).toBeGreaterThan(0)
    })
  }
})

describe("claude-bg-mcp-config", () => {
  const place = (text: string) => {
    const dir = scratch()
    const file = put(join(dir, "claude-bg", "0123456789abcdef.json"), text)
    symlinkSync("0123456789abcdef.json", join(dir, "claude-bg", "1a2b3c4d.json"))
    return { env: { SCP_DIR: dir }, file: realpathSync(file) }
  }
  const expected: Record<string, object> = {
    "named-worker.json": { handle: "reviewer", parented: true },
    "armed-native.json": { handle: "builder", parented: true },
    "root-unnamed.json": {},
  }

  test("readRecords reads each record through its short-id link", () => {
    for (const f of good("claude-bg-mcp-config")) {
      const { env, file } = place(f.text)
      const records = readRecords(env)
      expect([...records.keys()]).toEqual(["1a2b3c4d"])
      expect(records.get("1a2b3c4d")).toEqual({ file, ...expected[f.name] })
    }
  })

  test("readRecords skips an unreadable config", () => {
    for (const f of bad("claude-bg-mcp-config")) expect(readRecords(place(f.text).env).size).toBe(0)
  })

  test("the mount the writer puts in the config conforms", () => {
    const env = { ...process.env, SCP_DIR: scratch(), SCP_UNDER: "me/lead", SCP_GRANT: "krt_9f2c4e1a7b3d5f60" }
    const config = { mcpServers: { scp: bgMount(env, "reviewer", SID) } }
    expect(conforms("claude-bg-mcp-config", JSON.parse(JSON.stringify(config)))).toEqual([])
    const root = { mcpServers: { scp: bgMount({ ...process.env, SCP_DIR: scratch() }, undefined) } }
    expect(conforms("claude-bg-mcp-config", JSON.parse(JSON.stringify(root)))).toEqual([])
    expect(root.mcpServers.scp.env).toMatchObject({ SCP_UNDER: "", SCP_GRANT: "" })
  })
})

describe("claude-bg-state", () => {
  const place = (text: string) => {
    const dir = scratch()
    put(join(dir, "claude-bg", "1a2b3c4d.state.json"), text)
    return { SCP_DIR: dir }
  }

  test("readState and readAllStates read each state", () => {
    for (const f of good("claude-bg-state")) {
      const env = place(f.text)
      const value = JSON.parse(f.text)
      expect(readState(env, "1a2b3c4d")).toEqual(value)
      expect(readAllStates(env)).toEqual([{ ...value, id: "1a2b3c4d" }])
    }
  })

  test("a state without a string sessionId and cwd reads as none", () => {
    for (const f of bad("claude-bg-state")) {
      const env = place(f.text)
      expect(readState(env, "1a2b3c4d")).toBeUndefined()
      expect(readAllStates(env)).toEqual([])
    }
  })

  test("writeState writes a conforming private file by rename", () => {
    const env = { SCP_DIR: scratch() }
    writeState(env, "1a2b3c4d", { sessionId: SID, cwd: "/Users/dev/src/app", handle: "reviewer", stoppedAt: 1793261564000 })
    const path = join(env.SCP_DIR, "claude-bg", "1a2b3c4d.state.json")
    expect(conforms("claude-bg-state", JSON.parse(readFileSync(path, "utf8")))).toEqual([])
    expect(fileMode(path)).toBe(0o600)
    expect(readdirSync(dirname(path))).toEqual(["1a2b3c4d.state.json"])
  })
})

describe("claude-bg-lock", () => {
  const place = (text: string, pid = 48213) => {
    const dir = scratch()
    put(join(dir, "claude-bg", `1a2b3c4d.lock.${pid}.held`), text)
    return { SCP_DIR: dir }
  }

  test("a holder this process is, or one it cannot read, keeps the session", () => {
    expect(lockSession(place(`{"pid":${process.pid}}\n`), "1a2b3c4d")).toBeUndefined()
    for (const f of bad("claude-bg-lock")) expect(lockSession(place(f.text, process.pid), "1a2b3c4d")).toBeUndefined()
  })

  test("a live holder however old keeps the session, and one whose pid now names another process does not", () => {
    const env = place(`{"pid":${process.pid}}\n`)
    const dir = join(env.SCP_DIR, "claude-bg")
    const live = join(dir, "1a2b3c4d.lock.48213.held")
    utimesSync(live, new Date(1000), new Date(1000))
    expect(lockSession(env, "1a2b3c4d")).toBeUndefined()
    expect(existsSync(live)).toBe(true)
    writeFileSync(live, `${JSON.stringify({ pid: process.pid, started: "Thu Jan  1 00:00:00 1970" })}\n`)
    const release = lockSession(env, "1a2b3c4d")
    expect(release).toBeFunction()
    expect(existsSync(live)).toBe(false)
    const [mine] = readdirSync(dir)
    expect(JSON.parse(readFileSync(join(dir, mine!), "utf8"))).toEqual({ pid: process.pid, started: expect.stringMatching(/^[A-Z][a-z]{2} [A-Z][a-z]{2} /) })
    release!()
    writeFileSync(join(dir, `1a2b3c4d.lock.${process.pid}.torn`), "{")
    expect(lockSession(env, "1a2b3c4d")).toBeUndefined()
    rmSync(join(dir, `1a2b3c4d.lock.${process.pid}.torn`))
    writeFileSync(join(dir, "1a2b3c4d.lock.2147483646.torn"), "{")
    expect(lockSession(env, "1a2b3c4d")).toBeFunction()
  })

  test("a holder that exited and that its parent never reaped frees its session", async () => {
    const parent = Bun.spawn(["/bin/sh", "-c", "sleep 0.2 & echo $!; exec sleep 30"], { stdout: "pipe", stderr: "ignore" })
    try {
      const reader = parent.stdout.getReader()
      let printed = ""
      while (!printed.includes("\n")) printed += new TextDecoder().decode((await reader.read()).value)
      const pid = Number(printed.trim())
      const stat = () => spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()
      for (let tries = 0; !stat().startsWith("Z"); tries++) {
        expect(tries).toBeLessThan(100)
        await Bun.sleep(50)
      }
      const env = place(`{"pid":${pid}}\n`, pid)
      const release = lockSession(env, "1a2b3c4d")
      expect(release).toBeFunction()
      expect(existsSync(join(env.SCP_DIR, "claude-bg", `1a2b3c4d.lock.${pid}.held`))).toBe(false)
      release!()
    } finally {
      parent.kill()
      await parent.exited
    }
  })

  test("a holder whose process is gone is taken over, and the taker's file conforms and goes when released", () => {
    const env = place('{"pid":2147483646}\n')
    const dir = join(env.SCP_DIR, "claude-bg")
    const release = lockSession(env, "1a2b3c4d")!
    const [mine] = readdirSync(dir)
    expect(mine).toStartWith(`1a2b3c4d.lock.${process.pid}.`)
    expect(conforms("claude-bg-lock", JSON.parse(readFileSync(join(dir, mine!), "utf8")))).toEqual([])
    expect(fileMode(join(dir, mine!))).toBe(0o600)
    expect(lockSession(env, "1a2b3c4d")).toBeUndefined()
    expect(lockSession(env, "2b3c4d5e")).toBeFunction()
    release()
    expect(readdirSync(dir).filter((name) => name.startsWith("1a2b3c4d."))).toEqual([])
  })

  test("runs in several processes racing over stale holders never hold one session together", async () => {
    const env = { SCP_DIR: scratch() }
    const dir = join(env.SCP_DIR, "claude-bg")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const log = join(env.SCP_DIR, "held.log")
    const script = `
      import { appendFileSync, writeFileSync } from "node:fs"
      import { lockSession } from ${JSON.stringify(join(import.meta.dir, "claude-bg.ts"))}
      const env = { SCP_DIR: ${JSON.stringify(env.SCP_DIR)} }
      for (let round = 0; round < 60; round++) {
        if (round % 10 === 0) writeFileSync(${JSON.stringify(dir)} + "/1a2b3c4d.lock.dead" + process.pid + round, '{"pid":2147483646}\\n')
        const release = lockSession(env, "1a2b3c4d")
        if (!release) continue
        appendFileSync(${JSON.stringify(log)}, "in\\n")
        Bun.sleepSync(1)
        appendFileSync(${JSON.stringify(log)}, "out\\n")
        release()
      }
    `
    const runs = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" }))
    const codes = await Promise.all(runs.map(async (one) => [await one.exited, await new Response(one.stderr).text()]))
    expect(codes.map(([code]) => code)).toEqual([0, 0, 0, 0])
    const lines = readFileSync(log, "utf8").trim().split("\n")
    expect(lines.length).toBeGreaterThan(0)
    expect(lines).toEqual(lines.map((_, at) => (at % 2 === 0 ? "in" : "out")))
  }, 60_000)
})

describe("claude-bg-task", () => {
  const place = (text: string) => {
    const dir = scratch()
    put(join(dir, "claude-bg-task.json"), text)
    return { SCP_DIR: dir }
  }
  const fresh: BgTaskState = { sessions: new Map(), seen: new Set(), stopped: new Map(), listed: false }

  test("readTaskState reads each saved run", () => {
    for (const f of good("claude-bg-task")) {
      const value = JSON.parse(f.text)
      expect(readTaskState(place(f.text))).toEqual({
        sessions: new Map(value.sessions),
        seen: new Set(value.seen),
        stopped: new Map(value.stopped),
        listed: value.listed,
      })
    }
  })

  test("readTaskState drops malformed pairs and fields", () => {
    expect(readTaskState(place(fixture("claude-bg-task", "tolerated-partial.json").text))).toEqual({
      ...fresh,
      sessions: new Map([[SID, "1a2b3c4d"]]),
      seen: new Set(["1a2b3c4d"]),
    })
  })

  test("an unreadable file starts fresh", () => {
    for (const f of bad("claude-bg-task")) expect(readTaskState(place(f.text))).toEqual(fresh)
    expect(readTaskState({ SCP_DIR: scratch() })).toEqual(fresh)
  })

  test("writeTaskState round-trips through a conforming file", () => {
    const env = { SCP_DIR: scratch() }
    const state = {
      sessions: new Map([[SID, "1a2b3c4d"]]),
      seen: new Set(["1a2b3c4d"]),
      stopped: new Map([["1a2b3c4d", { id: "1a2b3c4d", kind: "background", sessionId: SID, state: "stopped" }]]),
      listed: true,
    }
    writeTaskState(env, state)
    const path = join(env.SCP_DIR, "claude-bg-task.json")
    expect(conforms("claude-bg-task", JSON.parse(readFileSync(path, "utf8")))).toEqual([])
    expect(fileMode(path)).toBe(0o600)
    expect(readTaskState(env)).toEqual(state)
  })
})

describe("claude-bg-ref", () => {
  test("refSession names the session of a record or a bare id", () => {
    for (const f of good("claude-bg-ref")) expect(refSession(f.text)).toBe(SID)
  })

  test("reviveRef writes the record fixtures", () => {
    expect(JSON.parse(reviveRef(SID, "/Users/dev/src/app", "review auth"))).toEqual(JSON.parse(fixture("claude-bg-ref", "record.json").text))
    expect(JSON.parse(reviveRef(SID, "/Users/dev/src/app", undefined))).toEqual(JSON.parse(fixture("claude-bg-ref", "record-unnamed.json").text))
    expect(reviveRef(SID, `/${"d".repeat(600)}`, undefined)).toBe(SID)
  })

  test("claude-wake declines a ref that names no Claude session", async () => {
    for (const f of bad("claude-bg-ref")) {
      let printed = ""
      expect(
        await claudeWakeCommand(
          { SCP_DIR: scratch(), SCP_WAKE_REF: f.text },
          {
            stdout: (text) => {
              printed += text
            },
          },
        ),
      ).toBe(77)
      expect(JSON.parse(printed)).toEqual({ declined: "unresumable" })
    }
  })
})

describe("codex-thread-lock", () => {
  const holderTable = () => new Map([[4242, { ppid: 1, start: "Wed-Nov-4-09:00:00-2026", args: "/usr/local/bin/codex exec --json review" }]])

  test("codexOwner finds the lock by its thread id and asks who holds it", async () => {
    for (const f of good("codex-thread-lock")) {
      const thread = f.text.slice(0, -".lock".length)
      const env = { CODEX_HOME: scratch() }
      expect(codexThread(thread)).toBe(thread)
      const path = codexLockPath(thread, env)
      expect(path).toBe(join(env.CODEX_HOME, "thread-writer-locks", f.text))
      expect(await codexOwner(thread, env, { run: async () => ({ code: 0, stdout: "4242\n", stderr: "" }), table: holderTable })).toBe("none")
      put(path, "")
      expect(await codexOwner(thread, env, { run: async () => ({ code: 0, stdout: "4242\n", stderr: "" }), table: holderTable })).toBe("exec")
      expect(await codexOwner(thread, env, { run: async () => ({ code: 1, stdout: "", stderr: "" }), table: holderTable })).toBe("none")
    }
  })

  test("a name that is not a thread id is no thread", () => {
    for (const f of bad("codex-thread-lock")) expect(codexThread(f.text.slice(0, -".lock".length))).toBeUndefined()
  })
})

describe("shim-binding", () => {
  const pidOf = (key: string) => Number(key.split(":")[1])

  test("readShimBinding reads a binding by launch key and by pid", () => {
    for (const f of good("shim-binding")) {
      const value = JSON.parse(f.text)
      const dir = scratch()
      put(join(dir, "bindings", "key-ab12.json"), f.text)
      expect(readShimBinding({ SCP_DIR: dir, SCP_SHIM_BINDING: "ab12" }, 999_999, undefined)).toEqual(value)
      const pid = pidOf(value.process)
      put(join(dir, "bindings", `pid-${pid}.json`), f.text)
      expect(readShimBinding({ SCP_DIR: dir }, pid, new Map())).toEqual(value)
      put(join(dir, "bindings", `pid-${pid + 1}.json`), f.text)
      expect(readShimBinding({ SCP_DIR: dir }, pid + 1, new Map())).toBeUndefined()
    }
  })

  test("readShimBinding ignores a binding of another harness, a bad handle or process, and a link", () => {
    for (const f of bad("shim-binding")) {
      const dir = scratch()
      put(join(dir, "bindings", "key-ab12.json"), f.text)
      put(join(dir, "bindings", "pid-48213.json"), f.text)
      expect(readShimBinding({ SCP_DIR: dir, SCP_SHIM_BINDING: "ab12" }, 48213, new Map())).toBeUndefined()
    }
    const dir = scratch()
    const target = put(join(dir, "elsewhere.json"), fixture("shim-binding", "codex.json").text)
    mkdirSync(join(dir, "bindings"))
    symlinkSync(target, join(dir, "bindings", "key-ab12.json"))
    expect(readShimBinding({ SCP_DIR: dir, SCP_SHIM_BINDING: "ab12" }, 999_999, undefined)).toBeUndefined()
  })

  test("writeShimBinding writes conforming private files its remover takes back", () => {
    const dir = scratch()
    const unbind = writeShimBinding({ process: PK, handle: "builder", harness: "codex" }, { SCP_DIR: dir, SCP_SHIM_BINDING: "ab12" })
    expect(readdirSync(join(dir, "bindings")).sort()).toEqual(["key-ab12.json", "pid-48213.json"])
    for (const name of ["key-ab12.json", "pid-48213.json"]) {
      const path = join(dir, "bindings", name)
      expect(conforms("shim-binding", JSON.parse(readFileSync(path, "utf8")))).toEqual([])
      expect(fileMode(path)).toBe(0o600)
    }
    unbind()
    expect(readdirSync(join(dir, "bindings"))).toEqual([])
  })
})

describe("session-marker", () => {
  const markerPath = (dir: string, session: string) => join(dir, "sessions", `${createHash("sha256").update(session).digest("hex").slice(0, 32)}.json`)
  const config = (mode?: string) => {
    const cfg = scratch()
    if (mode) put(join(cfg, "scp", "config.json"), JSON.stringify({ join: mode }))
    return { XDG_CONFIG_HOME: cfg }
  }
  const expected: Record<string, object> = {
    "joined.json": { handle: "reviewer" },
    "left.json": { dark: "this session left the relay; swarm join (or relay_join) joins it again" },
    "joined-no-handle.json": {},
  }

  test("readSessionMarker and membership read each marker by its session's hash", () => {
    for (const f of good("session-marker")) {
      const dir = scratch()
      put(markerPath(dir, PK), f.text)
      expect(readSessionMarker(dir, PK)).toEqual(JSON.parse(f.text))
      expect(membership(config(), PK, dir)).toEqual(expected[f.name]!)
    }
  })

  test("a marker without a boolean joined reads as none", () => {
    for (const f of bad("session-marker")) {
      const dir = scratch()
      put(markerPath(dir, PK), f.text)
      expect(readSessionMarker(dir, PK)).toBeUndefined()
      expect(membership(config(), PK, dir)).toEqual({})
      expect(membership(config("manual"), PK, dir)).toHaveProperty("dark")
    }
  })

  test("writeSessionMarker writes a conforming private file by rename", () => {
    const dir = scratch()
    writeSessionMarker(dir, PK, { joined: true, handle: "reviewer" })
    const path = markerPath(dir, PK)
    expect(conforms("session-marker", JSON.parse(readFileSync(path, "utf8")))).toEqual([])
    expect(fileMode(path)).toBe(0o600)
    expect(readdirSync(dirname(path))).toHaveLength(1)
  })
})

describe("muse-launch", () => {
  const place = (text: string, pid: number) => {
    const dir = scratch()
    put(join(dir, "launch", `muse-${pid}.json`), text)
    return { SCP_DIR: dir }
  }

  test("readMuseLaunch reads what the launcher left for exactly this process", () => {
    for (const f of good("muse-launch")) {
      const { process: key, ...launch } = JSON.parse(f.text)
      expect(readMuseLaunch(key, place(f.text, Number(key.split(":")[1])))).toEqual(launch)
    }
  })

  test("readMuseLaunch drops fields that are not well formed", () => {
    expect(readMuseLaunch(PK, place(fixture("muse-launch", "tolerated-bad-fields.json").text, 48213))).toEqual({})
  })

  test("readMuseLaunch ignores a file of another process", () => {
    for (const f of bad("muse-launch")) expect(readMuseLaunch(PK, place(f.text, 48213))).toBeUndefined()
  })

  test("writeMuseLaunch writes a conforming private file its remover takes back", () => {
    const env = { SCP_DIR: scratch() }
    const launch = {
      name: "muse-worker",
      grant: "krt_5d6e7f8091a2b3c4",
      under: "me/lead",
      session: "env:spawn-7f3a",
      launcher: "pid:48190:Wed-Nov-4-09:12:40-2026",
    }
    const remove = writeMuseLaunch(PK, launch, env)
    const path = join(env.SCP_DIR, "launch", "muse-48213.json")
    expect(conforms("muse-launch", JSON.parse(readFileSync(path, "utf8")))).toEqual([])
    expect(fileMode(path)).toBe(0o600)
    expect(readMuseLaunch(PK, env)).toEqual(launch)
    remove()
    expect(existsSync(path)).toBe(false)
  })
})

describe("cli-argv", () => {
  test("the schema refuses an empty launch, an empty word and a non-array", () => {
    for (const f of bad("cli-argv")) expect(conforms("cli-argv", JSON.parse(f.text)).length).toBeGreaterThan(0)
  })

  test("the words the CLI hands a native broker as SCP_CLI_ARGV conform", () => {
    expect(conforms("cli-argv", JSON.parse(JSON.stringify(SELF)))).toEqual([])
  })
})

describe("setup-manifest", () => {
  const place = (text: string) => {
    const env = { XDG_CONFIG_HOME: scratch() }
    put(manifestFile(env), text)
    return env
  }

  test("readManifest reads the list of what setup added", () => {
    expect(manifestFile({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/scp/setup.json")
    for (const f of good("setup-manifest")) expect(readManifest(place(f.text))).toEqual(JSON.parse(f.text).added)
  })

  test("readManifest drops malformed items", () => {
    expect(readManifest(place(fixture("setup-manifest", "tolerated-bad-items.json").text))).toEqual([
      { harness: "codex", kind: "mcp", file: "/Users/dev/.codex/config.toml" },
    ])
  })

  test("readManifest refuses a file without an added list, an empty one included", () => {
    for (const f of bad("setup-manifest")) expect(() => readManifest(place(f.text))).toThrow()
    expect(readManifest({ XDG_CONFIG_HOME: scratch() })).toEqual([])
  })

  test("writeManifest writes a conforming file and removes it once empty", () => {
    const env = { XDG_CONFIG_HOME: scratch() }
    const item = { harness: "claude" as const, kind: "mcp" as const, file: "/Users/dev/.claude.json" }
    writeManifest(env, new Date(), (added) => [...added, item])
    expect(conforms("setup-manifest", JSON.parse(readFileSync(manifestFile(env), "utf8")))).toEqual([])
    expect(fileMode(manifestFile(env))).toBe(0o600)
    expect(readManifest(env)).toEqual([item])
    writeManifest(env, new Date(), () => [])
    expect(existsSync(manifestFile(env))).toBe(false)
  })
})

describe("claude-version", () => {
  test("claudeVersion reads the cached version when the payload names none", () => {
    for (const f of good("claude-version")) {
      const env = { XDG_CONFIG_HOME: scratch() }
      put(claudeVersionFile(env), f.text)
      expect(claudeVersion({}, env)).toBe(f.text)
      expect(claudeVersion({ version: "9.9.9" }, env)).toBe("9.9.9")
    }
    expect(stopContinues(fixture("claude-version", "current.txt").text)).toBe(true)
    expect(stopContinues(fixture("claude-version", "before-stop-context.txt").text)).toBe(false)
  })

  test("cacheClaudeVersion writes a conforming file", () => {
    const env = { XDG_CONFIG_HOME: scratch() }
    cacheClaudeVersion("claude", env, () => ({ code: 0, output: "2.1.170 (Claude Code)\n" }))
    expect(conforms("claude-version", readFileSync(claudeVersionFile(env), "utf8"))).toEqual([])
  })
})

describe("runners", () => {
  const place = (text: string) => put(join(scratch(), "runners.json"), text)
  const expected: Record<string, Record<string, Runner>> = {
    "ssh-and-vm.json": {
      box: {
        command: ["ssh", "box.local", "swarm", "spawn-remote"],
        timeout_s: 120,
        stop: ["ssh", "box.local", "swarm", "stop-remote"],
        status: ["ssh", "box.local", "swarm", "status-remote"],
        status_timeout_s: 10,
      },
      "vm-2": { command: ["/opt/scp/bin/vm-runner"], timeout_s: 60 },
    },
    "null-timeout.json": { box: { command: ["ssh", "box.local", "swarm", "spawn-remote"], timeout_s: 60 } },
    "none.json": {},
  }

  test("readRunners reads each runner with its defaults", () => {
    for (const f of good("runners")) {
      const path = place(f.text)
      expect(runnersPath({ SCP_RUNNERS_FILE: path })).toBe(path)
      expect({ ...readRunners(path) }).toEqual(expected[f.name]!)
    }
    expect(readRunners(join(scratch(), "runners.json"))).toEqual({})
  })

  test("readRunners refuses a malformed file", () => {
    for (const f of bad("runners")) expect(() => readRunners(place(f.text))).toThrow()
  })
})

describe("wakers", () => {
  const expected: Record<string, WakerConfigs> = {
    "custom.json": {
      vm: { command: ["/opt/scp/bin/vm-wake"], timeout_s: 300 },
      "claude-bg": { command: ["/usr/local/bin/swarm", "claude-wake"], timeout_s: 60 },
    },
    "null-timeout.json": { vm: { command: ["/opt/scp/bin/vm-wake"], timeout_s: 60 } },
  }

  test("parseWakers reads each waker with its default timeout", () => {
    for (const f of good("wakers")) expect(parseWakers(JSON.parse(f.text))).toEqual(expected[f.name]!)
  })

  test("parseWakers refuses a malformed file", () => {
    for (const f of bad("wakers")) expect(() => parseWakers(JSON.parse(f.text))).toThrow()
  })
})

describe("hold-ref", () => {
  test("parseHoldRef reads each ref", () => {
    for (const f of good("hold-ref")) {
      expect(parseHoldRef(f.text)).toEqual(JSON.parse(f.text))
      expect(refProblem(JSON.stringify(JSON.parse(f.text)))).toBeUndefined()
    }
  })

  test("parseHoldRef refuses a ref it cannot resume", () => {
    for (const f of bad("hold-ref")) expect(parseHoldRef(f.text)).toBeUndefined()
  })

  test("durableRef writes a conforming ref", () => {
    const thread = "0199f3c2-7a1b-7c3d-9e8f-0123456789ab"
    for (const idle of [600, Number.POSITIVE_INFINITY]) {
      const text = durableRef("codex", thread, "/Users/dev/src/app", ["/usr/local/bin/codex", "exec", "resume", thread], idle, "me/lead", {})
      expect(conforms("hold-ref", JSON.parse(text))).toEqual([])
      expect(parseHoldRef(text)).toEqual(JSON.parse(text))
    }
  })
})

describe("config", () => {
  const place = (text: string) => {
    const env = { XDG_CONFIG_HOME: scratch() }
    put(join(env.XDG_CONFIG_HOME, "scp", "config.json"), text)
    return env
  }
  const defaults = { stopAfterS: 120, idleAfterS: 600, remove: "on_stop" }
  const expected: Record<string, { join: string; bg: object; historic?: number; spawn?: number; relay: object }> = {
    "full.json": {
      join: "manual",
      bg: { stopAfterS: 60, idleAfterS: 600, remove: "historic" },
      historic: 7200,
      spawn: 900,
      relay: { url: "https://relay.example.com", source: "config" },
    },
    "join-auto.json": { join: "auto", bg: defaults, relay: { url: "https://app.scp.dev", source: "default" } },
    "lifecycle-only.json": {
      join: "auto",
      bg: { ...defaults, idleAfterS: Number.POSITIVE_INFINITY },
      historic: 86400,
      spawn: Number.POSITIVE_INFINITY,
      relay: { url: "https://app.scp.dev", source: "default" },
    },
    "empty.json": { join: "auto", bg: defaults, relay: { url: "https://app.scp.dev", source: "default" } },
  }

  test("each reader takes its keys", () => {
    for (const f of good("config")) {
      const env = place(f.text)
      const want = expected[f.name]!
      expect(joinMode(env)).toBe(want.join as "auto" | "manual")
      expect(bgConfig(env)).toEqual(want.bg as ReturnType<typeof bgConfig>)
      expect(historicAfterS(env)).toBe(want.historic)
      expect(spawnIdleAfterS(env)).toBe(want.spawn)
      expect(activeRelay(env)).toEqual(want.relay as ReturnType<typeof activeRelay>)
    }
  })

  test("a file that is not an object leaves the defaults, and the relay selection refuses it", () => {
    for (const f of bad("config")) {
      const env = place(f.text)
      expect(joinMode(env)).toBe("auto")
      expect(bgConfig(env)).toEqual(defaults as ReturnType<typeof bgConfig>)
      expect(() => activeRelay(env)).toThrow()
    }
  })

  test("setJoinMode keeps the other keys in a conforming private file", () => {
    const env = place(fixture("config", "full.json").text)
    setJoinMode(env, "auto")
    const path = join(env.XDG_CONFIG_HOME, "scp", "config.json")
    const written = JSON.parse(readFileSync(path, "utf8"))
    expect(conforms("config", written)).toEqual([])
    expect(written).toEqual({ ...JSON.parse(fixture("config", "full.json").text), join: "auto" })
    expect(fileMode(path)).toBe(0o600)
  })
})

describe("credentials", () => {
  const place = (text: string) => {
    const env = { XDG_CONFIG_HOME: scratch() }
    put(join(env.XDG_CONFIG_HOME, "scp", "credentials.json"), text)
    return env
  }

  test("readCredentials reads each login by relay origin", () => {
    for (const f of good("credentials")) expect(readCredentials(place(f.text))).toEqual(JSON.parse(f.text))
    const env = place(fixture("credentials", "two-relays.json").text)
    expect(relayCredential(env, "https://app.scp.dev")).toEqual({ token: "scp_test_token_not_a_secret_1", source: "credentials", problem: null })
  })

  test("readCredentials refuses a file with an invalid login", () => {
    for (const f of bad("credentials")) expect(() => readCredentials(place(f.text))).toThrow()
  })

  test("saveCredential writes a conforming private file under the normalized origin", () => {
    const env = { XDG_CONFIG_HOME: scratch() }
    saveCredential(env, "https://app.scp.dev/", { token: "scp_test_token_not_a_secret_3", kind: "user" })
    const path = join(env.XDG_CONFIG_HOME, "scp", "credentials.json")
    const written = JSON.parse(readFileSync(path, "utf8"))
    expect(conforms("credentials", written)).toEqual([])
    expect(Object.keys(written)).toEqual(["https://app.scp.dev"])
    expect(fileMode(path)).toBe(0o600)
  })
})

describe("cloud", () => {
  const place = (text: string) => {
    const env = { XDG_CONFIG_HOME: scratch() }
    return { env, path: put(cloudFilePath(env), text) }
  }

  test("readCloudFile reads each bridge, the active relay standing in for a missing url", () => {
    for (const f of good("cloud")) {
      const { env, path } = place(f.text)
      const value = JSON.parse(f.text)
      expect(readCloudFile(path, env)).toEqual({ url: "https://app.scp.dev", ...value })
    }
  })

  test("readCloudFile refuses a malformed bridge", () => {
    for (const f of bad("cloud")) {
      const { env, path } = place(f.text)
      expect(() => readCloudFile(path, env)).toThrow()
    }
  })

  test("cloud enable writes a conforming private file", async () => {
    const saved = process.env.XDG_CONFIG_HOME
    const quiet = [spyOn(process.stdout, "write").mockImplementation(() => true), spyOn(process.stderr, "write").mockImplementation(() => true)]
    process.env.XDG_CONFIG_HOME = scratch()
    try {
      expect(await cloudMain(["enable"], { machine: "laptop" }, async () => ({ enabled: false }))).toBe(0)
      const path = cloudFilePath()
      const written = JSON.parse(readFileSync(path, "utf8"))
      expect(conforms("cloud", written)).toEqual([])
      expect(written).toEqual({ bridge: true, machine: "laptop", url: "https://app.scp.dev" })
      expect(fileMode(path)).toBe(0o600)
    } finally {
      for (const spy of quiet) spy.mockRestore()
      process.env.XDG_CONFIG_HOME = saved
    }
  })
})
