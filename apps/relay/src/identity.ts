import type { GraphMachine, HubGraph } from "@scp-dev/hub";

/** how the graph shows the member who bound a machine: the email's local part (the whole address when two members share it), initials and a colour slot */
export interface Identity {
  name: string;
  initials: string;
  tone: number;
}

/** colour slots, `--id-0` to `--id-7` in the graph stylesheet */
export const TONES = 8;

/** the graph with each machine's member resolved to what the Members page shows, and no member ids */
export type IdentifiedGraph = Omit<HubGraph, "machines"> & { machines: (Omit<GraphMachine, "actor"> & { identity: Identity | null })[] };

const fnv = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

function initials(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? name).slice(0, 1);
  return letters.toUpperCase() || "?";
}

/** member user ids to identities; a tone follows the name, stepping past a slot another member already holds while slots remain */
export function identities(members: { user_id: string; email: string }[]): Map<string, Identity> {
  const local = (email: string) => email.split("@")[0] || email;
  const counts = new Map<string, number>();
  for (const m of members) counts.set(local(m.email), (counts.get(local(m.email)) ?? 0) + 1);
  const named = members.map((m) => ({ id: m.user_id, name: counts.get(local(m.email))! > 1 ? m.email : local(m.email) }));
  named.sort((a, b) => a.name.localeCompare(b.name));
  const taken = new Set<number>();
  const out = new Map<string, Identity>();
  for (const { id, name } of named) {
    let tone = fnv(name) % TONES;
    for (let i = 0; i < TONES && taken.has(tone); i++) tone = (tone + 1) % TONES;
    taken.add(tone);
    out.set(id, { name, initials: initials(name), tone });
  }
  return out;
}

/** swaps each machine's member id for its identity; a former member's machine has none */
export function identify(g: HubGraph, who: Map<string, Identity>): IdentifiedGraph {
  return { ...g, machines: g.machines.map(({ actor, ...m }) => ({ ...m, identity: (actor !== null && who.get(actor)) || null })) };
}

export async function orgIdentities(db: D1Database, orgId: string): Promise<Map<string, Identity>> {
  const { results } = await db
    .prepare("SELECT u.id AS user_id, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?")
    .bind(orgId)
    .all<{ user_id: string; email: string }>();
  return identities(results);
}
