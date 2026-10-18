import { CLI_NAME } from "@scp-dev/core"
import { readSessionMarker, relayDir } from "@scp-dev/broker"
import { joinMode } from "./relay"

type Env = Record<string, string | undefined>

/** whether a harness session is on the relay now: off it (`dark`, saying why) after a leave, or in manual join mode before a join; else the handle it joined under */
export function membership(env: Env, session: string): { dark: string } | { handle?: string } {
  const marker = readSessionMarker(relayDir(env as NodeJS.ProcessEnv), session)
  if (marker?.joined === false) return { dark: `this session left the relay; ${CLI_NAME} join (or relay_join) joins it again` }
  if (!marker?.joined && joinMode(env) === "manual") return { dark: `this session has not joined the relay; ${CLI_NAME} join <name> (or relay_join) joins it` }
  return marker?.handle ? { handle: marker.handle } : {}
}
