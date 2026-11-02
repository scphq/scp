import { type AuditRow, CLI_NAME, type LocalAgent } from "@scp-dev/core"

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

export type BgSession = { id: string; handle?: string }

/**
 * the lines `swarm relink --check` prints, a read-only report: each endpoint at a background session's name, or one a rehome moved off that
 * name, that a harness session holds which is none of the sessions given that name (a short id is its session's first 8 characters) nor a
 * fork of one
 */
export function mismatchReport(
  sessions: BgSession[],
  agents: Pick<LocalAgent, "id" | "address" | "handle" | "harness_session" | "harness_origin">[],
  rehomes: Pick<AuditRow, "endpoint" | "detail">[] = [],
): string[] {
  const named = new Map<string, string[]>()
  for (const { id, handle } of sessions) if (handle !== undefined) named.set(handle, [...(named.get(handle) ?? []), id])
  const given = (name: string, session: string | null) => session !== null && named.get(name)!.some((id) => session.startsWith(id))
  const byHandle = new Map(agents.map((agent) => [agent.handle, agent]))
  const byRef = new Map(agents.flatMap((agent) => [[agent.address, agent] as const, [agent.id, agent] as const]))
  const lines = new Map<string, string>()
  const check = (agent: (typeof agents)[number], name: string) => {
    const by = agent.harness_session
    if (by === null || lines.has(agent.id) || given(name, by) || given(name, agent.harness_origin)) return
    const was = agent.handle === name ? "" : ` (was me/${name})`
    lines.set(agent.id, `${agent.address} ${agent.id}${was}: bg ${named.get(name)!.join(", ")} but held by session ${by.slice(0, 8)}`)
  }
  for (const name of named.keys()) {
    const agent = byHandle.get(name)
    if (agent) check(agent, name)
  }
  for (const row of rehomes) {
    const from = row.detail.from
    const agent = row.endpoint === null ? undefined : byRef.get(row.endpoint)
    if (typeof from === "string" && named.has(from) && agent) check(agent, from)
  }
  return lines.size ? [...lines.values()] : ["no mismatched endpoints"]
}
