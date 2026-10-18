import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type LinkFactory, relayDir } from "@scp-dev/broker"
import { RelayUsage } from "./common"

type MeshModule = typeof import("@scp-dev/mesh")
type MeshOptions = { machine?: string; link?: LinkFactory }

/** the experimental mesh is a dev dependency, never bundled: it loads only from a source checkout */
const MESH_MODULE = "@scp-dev/mesh"

async function importMesh(): Promise<MeshModule> {
  return (await import(MESH_MODULE)) as MeshModule
}

async function load(): Promise<MeshModule> {
  try {
    return await importMesh()
  } catch {
    throw new RelayUsage("swarm mesh is experimental and runs only from a source checkout of the swarm CLI")
  }
}

export async function meshCommand(argv: string[]): Promise<number> {
  return (await load()).meshCommand(argv)
}

/** `enabled` of mesh.json without the mesh module: false when absent, true when unreadable so the module reports it */
function meshEnabled(path: string): boolean {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return false
  }
  try {
    return (JSON.parse(text) as { enabled?: unknown } | null)?.enabled === true
  } catch {
    return true
  }
}

/** what the daemon adds to its broker options; the mesh module loads only when mesh.json enables it, and its absence only warns */
export async function meshBrokerOptions(
  dir: string = join(relayDir(), "mesh"),
  options: { importMesh?: () => Promise<MeshModule>; warn?: (line: string) => void } = {},
): Promise<MeshOptions> {
  const path = join(dir, "mesh.json")
  if (!meshEnabled(path)) return {}
  let mesh: MeshModule
  try {
    mesh = await (options.importMesh ?? importMesh)()
  } catch {
    const warn = options.warn ?? console.error
    warn(`mesh is enabled in ${path} but this CLI has no mesh module; running without it`)
    return {}
  }
  return mesh.meshBrokerOptions(dir)
}
