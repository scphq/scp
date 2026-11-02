import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { nativeMcpBin, runNativeMcp } from "./mcp-native"

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

test("the native server serves only with SCP_NATIVE=1 and an executable SCP_MCP_BIN", () => {
  const { bin } = fakeServer(0)
  expect(nativeMcpBin({ SCP_MCP_BIN: bin })).toBeUndefined()
  expect(nativeMcpBin({ SCP_NATIVE: "1", SCP_MCP_BIN: bin })).toBe(bin)
  expect(nativeMcpBin({ SCP_NATIVE: "1" })).toBeUndefined()
  expect(nativeMcpBin({ SCP_NATIVE: "1", SCP_MCP_BIN: "server-0" })).toBeUndefined()
  expect(nativeMcpBin({ SCP_NATIVE: "1", SCP_MCP_BIN: root })).toBeUndefined()
  const plain = join(root, "plain")
  writeFileSync(plain, "")
  expect(nativeMcpBin({ SCP_NATIVE: "1", SCP_MCP_BIN: plain })).toBeUndefined()
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
    const child = Bun.spawn([process.execPath, "--no-env-file", entry, "mcp", ...args], {
      env: { ...process.env, ...env },
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
})
