import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { meshBrokerOptions } from "./broker"
import { type MeshIo, meshCommand } from "./cli"
import { readAccountKey, readConfig } from "./config"
import { accountId } from "./keys"

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scp-mesh-cli-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function capture() {
  const out: string[] = []
  const err: string[] = []
  const io: MeshIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  }
  return { io, out, err }
}

async function init(dir: string, extra: string[] = []): Promise<ReturnType<typeof capture>> {
  const captured = capture()
  const code = await meshCommand(["init", "--account", "ada", ...extra], { io: captured.io, dir })
  expect(code).toBe(0)
  return captured
}

describe("mesh cli", () => {
  test("init writes the three files with mode 0600 and refuses a second init without --force", async () => {
    const dir = tempDir()
    const { io, out } = capture()
    expect(await meshCommand(["init", "--account", "ada"], { io, dir })).toBe(0)
    expect(out.join("\n")).toContain("ada")
    for (const name of ["mesh.json", "account.key", "machine.key"]) {
      expect(existsSync(join(dir, name))).toBe(true)
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600)
    }
    expect(readConfig(dir)).toMatchObject({ v: 1, enabled: true, account: "ada", listen: null, peers: [] })

    const second = capture()
    expect(await meshCommand(["init", "--account", "ada"], { io: second.io, dir })).not.toBe(0)
  })

  test("--force keeps machine.key and peers", async () => {
    const dir = tempDir()
    await init(dir)
    const added = capture()
    expect(await meshCommand(["add-peer", "127.0.0.1:9001"], { io: added.io, dir })).toBe(0)
    const machineKey = readFileSync(join(dir, "machine.key"), "utf8")

    const forced = capture()
    expect(await meshCommand(["init", "--account", "ada", "--force"], { io: forced.io, dir })).toBe(0)
    expect(readFileSync(join(dir, "machine.key"), "utf8")).toBe(machineKey)
    expect(readConfig(dir)?.peers).toEqual(["127.0.0.1:9001"])
  })

  test("init --account-key on a second dir copies the account key and gives the same accountId", async () => {
    const first = tempDir()
    const second = tempDir()
    await init(first)

    const copied = capture()
    expect(await meshCommand(["init", "--account-key", join(first, "account.key"), "--machine", "other-machine"], { io: copied.io, dir: second })).toBe(0)
    expect(readAccountKey(second)).toEqual(readAccountKey(first))
    expect(accountId(readAccountKey(second).public)).toBe(accountId(readAccountKey(first).public))
    expect(readConfig(second)?.account).toBe("ada")
    expect(readConfig(second)?.machine).toBe("other-machine")
  })

  test("a mismatched --account with --account-key fails", async () => {
    const first = tempDir()
    const second = tempDir()
    await init(first)

    const run = capture()
    expect(await meshCommand(["init", "--account", "bob", "--account-key", join(first, "account.key")], { io: run.io, dir: second })).not.toBe(0)
    expect(existsSync(join(second, "mesh.json"))).toBe(false)
  })

  test("add-peer dedupes and rejects nohost", async () => {
    const dir = tempDir()
    await init(dir)

    const first = capture()
    expect(await meshCommand(["add-peer", "127.0.0.1:9001"], { io: first.io, dir })).toBe(0)
    const again = capture()
    expect(await meshCommand(["add-peer", "127.0.0.1:9001"], { io: again.io, dir })).toBe(0)
    expect(readConfig(dir)?.peers).toEqual(["127.0.0.1:9001"])

    const bad = capture()
    expect(await meshCommand(["add-peer", "nohost"], { io: bad.io, dir })).not.toBe(0)
    expect(readConfig(dir)?.peers).toEqual(["127.0.0.1:9001"])
  })

  test("rm-peer, listen off, off and on update the file", async () => {
    const dir = tempDir()
    await init(dir, ["--listen", "127.0.0.1:9000"])
    expect(readConfig(dir)?.listen).toBe("127.0.0.1:9000")

    const added = capture()
    expect(await meshCommand(["add-peer", "127.0.0.1:9001"], { io: added.io, dir })).toBe(0)
    const removed = capture()
    expect(await meshCommand(["rm-peer", "127.0.0.1:9001"], { io: removed.io, dir })).toBe(0)
    expect(readConfig(dir)?.peers).toEqual([])

    const listenOff = capture()
    expect(await meshCommand(["listen", "off"], { io: listenOff.io, dir })).toBe(0)
    expect(readConfig(dir)?.listen).toBeNull()

    const off = capture()
    expect(await meshCommand(["off"], { io: off.io, dir })).toBe(0)
    expect(readConfig(dir)?.enabled).toBe(false)
    const on = capture()
    expect(await meshCommand(["on"], { io: on.io, dir })).toBe(0)
    expect(readConfig(dir)?.enabled).toBe(true)
  })

  test("status --json with no broker prints live null", async () => {
    const dir = tempDir()
    await init(dir)

    const run = capture()
    const socket = join(dir, "no-broker.sock")
    expect(await meshCommand(["status", "--json"], { io: run.io, dir, socket })).toBe(0)
    const parsed = JSON.parse(run.out.join("\n")) as { config: { account: string }; live: unknown }
    expect(parsed.config.account).toBe("ada")
    expect(parsed.live).toBeNull()
  })

  test("meshBrokerOptions returns {} with no config and with enabled false, and machine plus link when enabled", async () => {
    const dir = tempDir()
    expect(await meshBrokerOptions(dir)).toEqual({})

    await init(dir)
    const off = capture()
    expect(await meshCommand(["off"], { io: off.io, dir })).toBe(0)
    expect(await meshBrokerOptions(dir)).toEqual({})

    const on = capture()
    expect(await meshCommand(["on"], { io: on.io, dir })).toBe(0)
    const options = await meshBrokerOptions(dir)
    expect(options.machine).toBe(readConfig(dir)?.machine)
    expect(typeof options.link).toBe("function")
  })
})
