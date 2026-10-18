import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * What the broker last decided about a harness session, by its session key: whether it joined or left, and the handle it goes by. Hooks and
 * the MCP shim read it before they claim, so a session that never joined (manual join mode) or left stays off the relay without a broker
 * round trip, and a renamed session claims its own name. The broker writes it; the endpoint rows stay the source of truth.
 */
export interface SessionMarker {
  joined: boolean
  handle?: string
}

function markerPath(dir: string, session: string): string {
  return join(dir, "sessions", `${createHash("sha256").update(session).digest("hex").slice(0, 32)}.json`)
}

export function readSessionMarker(dir: string, session: string): SessionMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(markerPath(dir, session), "utf8")) as Partial<SessionMarker>
    if (typeof value?.joined !== "boolean") return undefined
    return { joined: value.joined, ...(typeof value.handle === "string" ? { handle: value.handle } : {}) }
  } catch {
    return undefined
  }
}

export function writeSessionMarker(dir: string, session: string, marker: SessionMarker): void {
  const path = markerPath(dir, session)
  mkdirSync(join(dir, "sessions"), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(marker), { mode: 0o600 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}
