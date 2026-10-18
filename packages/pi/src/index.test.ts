import { expect, test } from "bun:test"
import { shimArgv, toolResult } from "./index"

test("the shim runs swarm mcp for harness pi with channels, named by SCP_NAME", () => {
  expect(shimArgv({})).toEqual(["swarm", "mcp", "--harness", "pi", "--channels"])
  expect(shimArgv({ SCP_NAME: "demo", SCP_PI_SWARM: '["bun","cli.ts"]' })).toEqual(["bun", "cli.ts", "mcp", "--harness", "pi", "--channels", "--as", "demo"])
  expect(() => shimArgv({ SCP_PI_SWARM: '"swarm"' })).toThrow("JSON array")
})

test("an MCP tool result becomes pi content, and an error result fails the call", () => {
  expect(toolResult({ content: [{ type: "text", text: "ok" }, { type: "audio" }] })).toEqual({ content: [{ type: "text", text: "ok" }], details: {} })
  expect(() => toolResult({ content: [{ type: "text", text: "not_found: nobody" }], isError: true })).toThrow("not_found: nobody")
})
