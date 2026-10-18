import type { Role } from "./env";
import { randomSecret, sha256 } from "./util";

/** both match the core secret scanner's `scp_` implementation-token kind */
export const DEVICE_PREFIX = "scp_d_";
export const TOKEN_PREFIX = "scp_t_";

export interface Minted {
  secret: string;
  hash: string;
  prefix: string;
  last4: string;
}

export async function mint(prefix: string): Promise<Minted> {
  const secret = randomSecret(prefix);
  return { secret, hash: await sha256(secret), prefix: secret.slice(0, prefix.length + 4), last4: secret.slice(-4) };
}

/** what the hub needs to admit a bearer: the Worker builds it from D1 and the hub Durable Object trusts it */
export interface HubGrant {
  kind: "device" | "token";
  credentialId: string;
  userId: string;
  email: string;
  orgId: string;
  org: string;
  /** a device acts with its user's role; an API token always as a member */
  role: Role;
  /** device: the machine label from `scp login`; token: the token name */
  label: string;
  /** true for API tokens: headless agents with no person at a terminal */
  ambient: boolean;
  /** labels the hub applies to every endpoint this credential creates */
  endpointLabels: Record<string, string>;
  expiresAt: number | null;
}

export type AuthFailure = "missing" | "invalid" | "revoked" | "expired";
export type AuthResult = { ok: true; grant: HubGrant } | { ok: false; reason: AuthFailure };

interface Row {
  id: string;
  user_id: string;
  email: string;
  org_id: string;
  handle: string;
  label: string;
  role: Role | null;
  expires_at: number | null;
  revoked_at: number | null;
}

const SELECT = {
  device:
    "SELECT c.id, c.user_id, u.email, c.org_id, o.handle, c.label, m.role, c.expires_at, c.revoked_at FROM device_credentials c JOIN users u ON u.id = c.user_id JOIN orgs o ON o.id = c.org_id LEFT JOIN memberships m ON m.org_id = c.org_id AND m.user_id = c.user_id WHERE c.",
  token:
    "SELECT c.id, c.created_by AS user_id, u.email, c.org_id, o.handle, c.name AS label, m.role, c.expires_at, c.revoked_at FROM api_tokens c JOIN users u ON u.id = c.created_by JOIN orgs o ON o.id = c.org_id LEFT JOIN memberships m ON m.org_id = c.org_id AND m.user_id = c.created_by WHERE c.",
} as const;

const TABLE = { device: "device_credentials", token: "api_tokens" } as const;

async function lookup(db: D1Database, kind: HubGrant["kind"], by: "token_hash" | "id", value: string, now: number): Promise<AuthResult> {
  const row = await db.prepare(`${SELECT[kind]}${by} = ?`).bind(value).first<Row>();
  if (!row) return { ok: false, reason: "invalid" };
  if (row.revoked_at !== null || row.role === null) return { ok: false, reason: "revoked" };
  if (row.expires_at !== null && row.expires_at <= now) return { ok: false, reason: "expired" };
  const ambient = kind === "token";
  return {
    ok: true,
    grant: {
      kind,
      credentialId: row.id,
      userId: row.user_id,
      email: row.email,
      orgId: row.org_id,
      org: row.handle,
      role: ambient ? "member" : row.role,
      label: row.label,
      ambient,
      endpointLabels: ambient ? { token: row.label } : {},
      expiresAt: row.expires_at,
    },
  };
}

export function bearerOf(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return m?.[1] ?? null;
}

/** authenticates a device credential or an API token from an `Authorization: Bearer` header */
export async function authenticate(db: D1Database, header: string | null, now = Date.now()): Promise<AuthResult> {
  const secret = bearerOf(header);
  if (!secret) return { ok: false, reason: "missing" };
  const kind = secret.startsWith(DEVICE_PREFIX) ? "device" : secret.startsWith(TOKEN_PREFIX) ? "token" : null;
  if (!kind || secret.length > 128) return { ok: false, reason: "invalid" };
  const result = await lookup(db, kind, "token_hash", await sha256(secret), now);
  if (result.ok) {
    await db
      .prepare(`UPDATE ${TABLE[kind]} SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`)
      .bind(now, result.grant.credentialId, now - 60_000)
      .run();
  }
  return result;
}

/** re-reads a grant's credential, for the hub's periodic revalidation of open sockets */
export async function revalidate(db: D1Database, grant: Pick<HubGrant, "kind" | "credentialId">, now = Date.now()): Promise<AuthResult> {
  return lookup(db, grant.kind, "id", grant.credentialId, now);
}
