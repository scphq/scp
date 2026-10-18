import type { HubGrant } from "@scp-dev/hub";
import { type HubGrant as Credential, revalidate } from "../credentials";

/** what the Worker proved about the bearer, set by the Worker only */
export const GRANT_HEADER = "x-scp-hub-grant";
/** the org handle, the address user part (`acme` in `acme/laptop/main`), set by the Worker only */
export const ORG_HEADER = "x-scp-hub-org";
/** the member a dashboard event stream is opened for */
export const DASH_HEADER = "x-scp-dash-user";

const ROLES = new Set(["owner", "admin", "member"]);
/** a credential without an expiry gets a far bound; the hub still revalidates it every few minutes */
const OPEN_ENDED_MS = 365 * 86_400_000;

/** the org is the hub account, the member its actor; an API token acts as a scoped member with its labels */
export function hubGrant(cred: Credential, now: number): HubGrant {
  return {
    tokenId: cred.credentialId,
    userId: cred.orgId,
    actorId: cred.userId,
    expiresAt: cred.expiresAt ?? now + OPEN_ENDED_MS,
    scoped: cred.ambient,
    role: cred.role,
    ...(Object.keys(cred.endpointLabels).length ? { labels: cred.endpointLabels } : {}),
  };
}

const isLabels = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

/** the Worker's grant header, or null when anything is off */
export function parseGrant(raw: string | null): HubGrant | null {
  if (!raw) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof v.tokenId !== "string" || typeof v.userId !== "string" || typeof v.actorId !== "string") return null;
  if (typeof v.expiresAt !== "number" || typeof v.scoped !== "boolean" || !ROLES.has(v.role as string)) return null;
  if (v.labels !== undefined && !isLabels(v.labels)) return null;
  return {
    tokenId: v.tokenId,
    userId: v.userId,
    actorId: v.actorId,
    expiresAt: v.expiresAt,
    scoped: v.scoped,
    role: v.role as HubGrant["role"],
    ...(v.labels ? { labels: v.labels } : {}),
  };
}

/** whether an open socket's grant still holds (`scoped` is set exactly for API tokens, so it names the credential's table): the same credential, unrevoked and unexpired, of a member with the same role */
export async function grantValid(db: D1Database, grant: HubGrant, now: number): Promise<boolean> {
  if (grant.expiresAt <= now) return false;
  const auth = await revalidate(db, { kind: grant.scoped ? "token" : "device", credentialId: grant.tokenId }, now);
  if (!auth.ok) return false;
  const fresh = hubGrant(auth.grant, now);
  return fresh.userId === grant.userId && fresh.actorId === grant.actorId && fresh.role === grant.role && fresh.scoped === grant.scoped;
}
