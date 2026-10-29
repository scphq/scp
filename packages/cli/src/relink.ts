import { CLI_NAME } from "@scp-dev/core"

export type RelinkPair = { from: string; to: string; by: string; live?: boolean; retired?: string }

/** the lines `swarm relink` prints: each pair, the count, and how to confirm the pairs that take a name a live session still holds */
export function relinkReport(pairs: RelinkPair[], dryRun: boolean, live: boolean): string[] {
  const lines = pairs.map((pair) => `me/${pair.from} -> me/${pair.to} (by ${pair.by}${pair.live ? ", held by its idle origin" : ""})`)
  const done = dryRun ? pairs : pairs.filter((pair) => pair.retired !== undefined)
  const held = pairs.filter((pair) => pair.live && (dryRun ? !live : pair.retired === undefined)).length
  if (!pairs.length) return ["nothing to relink"]
  if (done.length) lines.push(`${dryRun ? "would relink" : "relinked"} ${done.length} ${done.length === 1 ? "session" : "sessions"}`)
  if (held)
    lines.push(
      `${held} ${held === 1 ? "takes its name from a session that still holds it" : "take their names from sessions that still hold them"}: confirm with ${CLI_NAME} relink --live, which closes the origin's connections`,
    )
  return lines
}
