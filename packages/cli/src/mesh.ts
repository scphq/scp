import { existsSync } from "node:fs"
import { join } from "node:path"
import { type LinkFactory, relayDir } from "@scp-dev/broker"
import { RelayUsage } from "./common"

type MeshModule = typeof import("@scp-dev/mesh")

/** the experimental mesh is a dev dependency, never bundled: it loads only from a source checkout */
const MESH_MODULE = "@scp-dev/mesh"

async function load(): Promise<MeshModule> {
  try {
    return (await import(MESH_MODULE)) as MeshModule
  } catch {
    throw new RelayUsage("swarm mesh is experimental and runs only from a source checkout of the swarm CLI")
  }
}

export async function meshCommand(argv: string[]): Promise<number> {
  return (await load()).meshCommand(argv)
}

/** what the daemon adds to its broker options; nothing, and no import, until `swarm mesh init` wrote a config */
export async function meshBrokerOptions(): Promise<{ machine?: string; link?: LinkFactory }> {
  if (!existsSync(join(relayDir(), "mesh", "mesh.json"))) return {}
  return (await load()).meshBrokerOptions()
}
