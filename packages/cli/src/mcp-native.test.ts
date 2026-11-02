import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { nativeMcp, runNativeMcp } from "./mcp-native"

const root = mkdtempSync(join(process.env.HOME!, "mcp-native-"))
const entry = join(import.meta.dir, "cli.ts")
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** a stand-in server that records its words and the variables the router hands it, then exits `code` */
function fakeServer(code: number): { bin: string; record: string } {
  const bin = join(root, `server-${code}`)
  const record = join(root, `record-${code}`)
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" "$SCP_SHIM_PPID" "$SCP_CLI_ARGV" > '${record}'\nexit ${code}\n`)
  chmodSync(bin, 0o755)
  return { bin, record }
}

/** a stand-in native swarm that prints `swarm <version>` and records its other words */
function fakeSwarm(version: string): string {
  const bin = join(root, `swarm-${version}`, "swarm")
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = --version ]; then echo "swarm ${version}"; exit 0; fi\nprintf '%s\\n' "$*" > '${bin}.words'\nexit 4\n`)
  chmodSync(bin, 0o755)
  return bin
}

test("the native server serves only with SCP_NATIVE=1: SCP_MCP_BIN when it is an executable file, else the native swarm", () => {
  const { bin } = fakeServer(0)
  expect(nativeMcp({ SCP_MCP_BIN: bin })).toBeUndefined()
  expect(nativeMcp({ SCP_NATIVE: "1", SCP_MCP_BIN: bin })).toEqual({ bin, words: [] })
  expect(nativeMcp({ SCP_NATIVE: "1", SCP_MCP_BIN: "server-0" })).toBeUndefined()
  expect(nativeMcp({ SCP_NATIVE: "1", SCP_MCP_BIN: root })).toBeUndefined()
  const plain = join(root, "plain")
  writeFileSync(plain, "")
  expect(nativeMcp({ SCP_NATIVE: "1", SCP_MCP_BIN: plain })).toBeUndefined()
  const swarm = fakeSwarm("1.2.3")
  expect(nativeMcp({ SCP_SWARM_BIN: swarm }, "1.2.3")).toBeUndefined()
  expect(nativeMcp({ SCP_NATIVE: "1", SCP_SWARM_BIN: swarm }, "1.2.3")).toEqual({ bin: swarm, words: ["mcp"] })
  expect(nativeMcp({ SCP_NATIVE: "1", SCP_SWARM_BIN: swarm, SCP_MCP_BIN: bin }, "1.2.3")).toEqual({ bin, words: [] })
  expect(nativeMcp({ SCP_NATIVE: "1", SCP_SWARM_BIN: swarm }, "1.2.4")).toBeUndefined()
  expect(nativeMcp({ SCP_NATIVE: "1", SCP_SWARM_BIN: join(root, "missing") }, "1.2.3")).toBeUndefined()
})

test("the server gets the words, this process's parent and this CLI, and its exit code is passed on", async () => {
  const { bin, record } = fakeServer(7)
  expect(await runNativeMcp(bin, ["--as", "w"], ["/x/bun", "/x/cli.js"])).toBe(7)
  expect(readFileSync(record, "utf8")).toBe(`--as w\n${process.ppid}\n["/x/bun","/x/cli.js"]\n`)
  expect(await runNativeMcp(join(root, "missing"), [])).toBeUndefined()
})

test("swarm mcp routes to the native server, mcp install and an unusable binary do not", async () => {
  const { bin, record } = fakeServer(3)
  const run = async (args: string[], env: Record<string, string>) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "SCP_MCP_BIN" && key !== "SCP_SWARM_BIN"))
    const child = Bun.spawn([process.execPath, "--no-env-file", entry, "mcp", ...args], {
      env: { ...base, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return { code, stderr, pid: child.pid }
  }
  const routed = await run(["--as", "native-w"], { SCP_NATIVE: "1", SCP_MCP_BIN: bin })
  expect(routed.code).toBe(3)
  const [words, ppid, argv] = readFileSync(record, "utf8").split("\n")
  expect(words).toBe("--as native-w")
  expect(ppid).toBe(String(process.pid))
  expect(JSON.parse(argv!).at(-1)).toBe(entry)
  rmSync(record)
  const install = await run(["install", "--human"], { SCP_NATIVE: "1", SCP_MCP_BIN: bin })
  expect(install.code).toBe(125)
  expect(install.stderr).toContain("mcp install takes --harness H")
  expect(() => readFileSync(record)).toThrow()
  const unusable = await run(["--human"], { SCP_NATIVE: "1", SCP_MCP_BIN: join(root, "missing") })
  expect(unusable.stderr).toContain("no usable native MCP server")
  expect(unusable.stderr).toContain("--human is not available")
  const swarm = fakeSwarm(pkg.version)
  const single = await run(["--as", "native-s"], { SCP_NATIVE: "1", SCP_SWARM_BIN: swarm })
  expect(single.code).toBe(4)
  expect(readFileSync(`${swarm}.words`, "utf8")).toBe("mcp --as native-s\n")
  const none = await run(["--human"], { SCP_NATIVE: "1", SCP_SWARM_BIN: join(root, "missing") })
  expect(none.stderr).toContain("no native swarm")
  expect(none.stderr).toContain("--human is not available")
})
