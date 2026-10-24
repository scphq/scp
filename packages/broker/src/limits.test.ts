import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brokerLimits } from "./server"

test("broker merges config, legacy daily cap and environment limits", () => {
  const root = mkdtempSync(join(tmpdir(), "scp-limits-"))
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config") }
  const path = join(env.XDG_CONFIG_HOME, "scp", "config.json")
  try {
    expect(brokerLimits(env)).toEqual({})
    mkdirSync(join(env.XDG_CONFIG_HOME, "scp"), { recursive: true })
    writeFileSync(path, JSON.stringify({ limits: { pairBurst: 7, userPerDay: 11 } }))
    expect(brokerLimits({ ...env, SCP_DAILY_CAP: "13" })).toEqual({ pairBurst: 7, userPerDay: 13 })
    expect(brokerLimits({ ...env, SCP_DAILY_CAP: "13", SCP_LIMITS: '{"pairBurst":0,"userPerDay":17}' })).toEqual({ pairBurst: Infinity, userPerDay: 17 })
    expect(brokerLimits({ ...env, SCP_LIMITS: '{"userPerDay":null}' })).toEqual({ pairBurst: 7, userPerDay: Infinity })
    writeFileSync(path, '{"limits":{"typo":1}}')
    expect(() => brokerLimits(env)).toThrow("unknown limit typo")
    writeFileSync(path, '{"limits":[]}')
    expect(() => brokerLimits(env)).toThrow("limits must be a JSON object")
    writeFileSync(path, "invalid")
    expect(() => brokerLimits(env)).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
