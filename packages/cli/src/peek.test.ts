import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"
import { PREAMBLE } from "@scp-dev/core"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"
import { RELAY_HELP } from "./main"
import { grantParams, RelayUsage } from "./common"
import { processKey } from "./identity"

setDefaultTimeout(30_000)

const entry = join(import.meta.dir, "cli.ts")

async function swarm(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

const envLines = (stdout: string) =>
  Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  )

describe("swarm peek", () => {
  let broker: Broker
  let lead: RelayClient
  const dir = join(process.env.HOME!, "peek-relay")
  const env = { SCP_DIR: dir }
  const id = (address: string) => broker.core.list({ all: true }).find((e) => e.address === address)!.id

  beforeAll(async () => {
    broker = await startBroker({ dir, idleMs: 0, policyPath: join(process.env.HOME!, "peek-policy.json"), log: () => {} })
    lead = await RelayClient.connect(broker.socket)
    await lead.hello({ claim: { handle: "peek-lead", harness: "codex", process: processKey(process.pid), lineage: [processKey(process.pid)] } })
  })
  afterAll(async () => {
    lead.close()
    await broker.stop()
  })

  test("the help names peek, set-peek, log --peek and spawn-env --peek local", () => {
    expect(RELAY_HELP).toContain("swarm peek <ep> [--turns N] [--full]")
    expect(RELAY_HELP).toContain("swarm peek --who [ep]")
    expect(RELAY_HELP).toContain("swarm set-peek on|off [ep]")
    expect(RELAY_HELP).toContain("--peek local")
    expect(RELAY_HELP).toMatch(/log .*--peek/)
  })

  test("set-peek opts an agent in; a peer then sees it peekable in list and peers and peeks its turns behind the preamble, wrapped; --who and log --peek show the peek", async () => {
    expect((await swarm(["set-peek", "on", "--as", "pk-a"], env)).stdout).toBe("me/pk-a: peek local\n")
    broker.core.peekTurn(id("me/pk-a"), { role: "user", text: "PROMPT-MARKER fix the parser" })
    broker.core.peekTurn(id("me/pk-a"), { role: "assistant", text: `REPLY-MARKER ${"word ".repeat(300)}` })
    await swarm(["whoami", "--as", "pk-b"], env)

    const list = await swarm(["list", "--all", "--as", "pk-b"], env)
    expect(list.stdout).toMatch(/^ADDRESS .* PEEK *$/m)
    expect(list.stdout).toMatch(/me\/pk-a .* local *$/m)
    const peers = await swarm(["peers", "--all", "--as", "pk-b"], env)
    expect(peers.stdout).toMatch(/^ADDRESS .* PEEK *$/m)
    expect(peers.stdout).toMatch(/me\/pk-a .* local *$/m)
    const listed = JSON.parse((await swarm(["list", "--all", "--json", "--as", "pk-b"], env)).stdout) as { endpoints: { address: string; peekable?: string }[] }
    expect(listed.endpoints.find((e) => e.address === "me/pk-a")!.peekable).toBe("local")

    const peeked = await swarm(["peek", "pk-a", "--as", "pk-b"], env)
    expect([peeked.code, peeked.stderr]).toEqual([0, ""])
    expect(peeked.stdout.startsWith(`${PREAMBLE}\n\n<relay-peek of="me/pk-a"`)).toBe(true)
    expect(peeked.stdout).toContain("PROMPT-MARKER")
    expect(peeked.stdout.trimEnd().endsWith("</relay-peek>")).toBe(true)

    type Peeked = { preamble: string; endpoint: string; turns: { role: string; text: string }[] }
    const short = JSON.parse((await swarm(["peek", "pk-a", "--turns", "1", "--json", "--as", "pk-b"], env)).stdout) as Peeked
    expect(short).toMatchObject({ preamble: PREAMBLE, endpoint: "me/pk-a" })
    expect(short.turns.map((t) => t.role)).toEqual(["assistant"])
    const full = JSON.parse((await swarm(["peek", "pk-a", "--turns", "1", "--full", "--json", "--as", "pk-b"], env)).stdout) as Peeked
    expect(full.turns[0]!.text.length).toBeGreaterThan(short.turns[0]!.text.length)

    const who = await swarm(["peek", "--who", "--as", "pk-a"], env)
    expect(who.code).toBe(0)
    expect(who.stdout).toContain("me/pk-b")
    const whoJson = JSON.parse((await swarm(["peek", "--who", "--json", "--as", "pk-a"], env)).stdout) as { peeked_by: { by: string }[] }
    expect(whoJson.peeked_by.map((p) => p.by)).toContain("me/pk-b")

    const log = await swarm(["log", "--peek", "--human"], env)
    const rows = log.stdout.trim().split("\n")
    expect(rows.some((row) => / peek /.test(row))).toBe(true)
    expect(rows.every((row) => / peek(_set)? /.test(row))).toBe(true)
    expect(log.stdout).not.toContain("PROMPT-MARKER")

    expect((await swarm(["set-peek", "off", "--as", "pk-a"], env)).stdout).toBe("me/pk-a: peek off\n")
    const refused = await swarm(["peek", "pk-a", "--as", "pk-b"], env)
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toBe((await swarm(["peek", "pk-zz", "--as", "pk-b"], env)).stderr.replace("pk-zz", "pk-a"))
    expect((await swarm(["list", "--all", "--as", "pk-b"], env)).stdout).not.toMatch(/ PEEK/)
  })

  test("peek and set-peek check their arguments", async () => {
    for (const args of [
      ["peek", "--as", "pk-args"],
      ["peek", "a", "b", "--as", "pk-args"],
      ["peek", "pk-args", "--turns", "0", "--as", "pk-args"],
      ["peek", "pk-args", "--turns", "11", "--as", "pk-args"],
      ["peek", "pk-args", "--turns", "x", "--as", "pk-args"],
      ["peek", "--who", "--turns", "2", "--as", "pk-args"],
      ["peek", "--who", "--full", "--as", "pk-args"],
      ["set-peek", "--as", "pk-args"],
      ["set-peek", "maybe", "--as", "pk-args"],
      ["set-peek", "on", "a", "b", "--as", "pk-args"],
      ["log", "--peek", "--scope", "--human"],
    ]) {
      const result = await swarm(args, env)
      expect(result.code).not.toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).not.toBe("")
    }
    expect((await swarm(["peek", "pk-args", "--turns", "11", "--as", "pk-args"], env)).stderr).toContain("--turns")
  })

  test("spawn-env --peek local makes the spawned agent peekable from its start; any other level is refused", async () => {
    expect(grantParams({ peek: "local", name: "w" })).toEqual({ name: "w", peek: "local" })
    expect(() => grantParams({ peek: "on" })).toThrow(RelayUsage)
    const spawned = await swarm(["spawn-env", "--name", "pk-kid", "--peek", "local"], env)
    expect([spawned.code, spawned.stderr]).toEqual([0, ""])
    const grant = envLines(spawned.stdout)
    expect((await swarm(["whoami"], { ...env, ...grant })).stdout.split("\n")[0]).toBe("me/pk-kid (agent, cli)")
    expect(broker.core.peekState(id("me/pk-kid")).peek).toBe("local")
    expect((await swarm(["spawn-env", "--peek", "account"], env)).stderr).toContain("--peek")

    const plain = await swarm(["spawn-env", "--name", "pk-plain"], env)
    await swarm(["whoami"], { ...env, ...envLines(plain.stdout) })
    expect(broker.core.peekState(id("me/pk-plain")).peek).toBeNull()
  })
})
