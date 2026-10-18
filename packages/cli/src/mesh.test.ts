import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { meshBrokerOptions } from "./mesh"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function meshDir(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "scp-mesh-"))
  dirs.push(dir)
  if (config !== undefined) writeFileSync(join(dir, "mesh.json"), JSON.stringify(config))
  return dir
}

const missing = () => Promise.reject(new Error("Cannot find package '@scp-dev/mesh'"))

test("a missing or disabled mesh.json never imports the mesh module", async () => {
  let imports = 0
  const importMesh = () => {
    imports++
    return missing()
  }
  expect(await meshBrokerOptions(meshDir(), { importMesh })).toEqual({})
  expect(await meshBrokerOptions(meshDir({ v: 1, enabled: false, account: "a", machine: "m", listen: null, peers: [] }), { importMesh })).toEqual({})
  expect(imports).toBe(0)
})

test("an enabled mesh.json without the mesh module warns once and starts without it", async () => {
  const dir = meshDir({ v: 1, enabled: true, account: "a", machine: "m", listen: null, peers: [] })
  const lines: string[] = []
  expect(await meshBrokerOptions(dir, { importMesh: missing, warn: (line) => lines.push(line) })).toEqual({})
  expect(lines).toEqual([`mesh is enabled in ${join(dir, "mesh.json")} but this CLI has no mesh module; running without it`])
})
