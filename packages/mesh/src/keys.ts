import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, randomBytes, sign, verify } from "node:crypto"

/** an Ed25519 key pair as base64url JWK members: `public` is x, `private` is d */
export interface KeyPair {
  public: string
  private: string
}

export const SIGN_DOMAIN = {
  cert: "scp/1 mesh cert",
  record: "scp/1 mesh record",
  auth: "scp/1 mesh auth",
} as const

export type SignDomain = (typeof SIGN_DOMAIN)[keyof typeof SIGN_DOMAIN]

const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/

export function generateKeyPair(): KeyPair {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" })
  return { public: jwk.x!, private: jwk.d! }
}

export function validKeyPair(value: unknown): value is KeyPair {
  const pair = value as KeyPair
  return typeof pair?.public === "string" && typeof pair.private === "string" && KEY_TEXT.test(pair.public) && KEY_TEXT.test(pair.private)
}

export function validPublicKey(value: unknown): value is string {
  return typeof value === "string" && KEY_TEXT.test(value)
}

function privateKeyOf(pair: KeyPair): KeyObject {
  return createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: pair.public, d: pair.private }, format: "jwk" })
}

/** sorted keys at every level, undefined members dropped; throws on a value JSON can't carry exactly */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON has no non-finite numbers")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
  }
  throw new TypeError(`canonical JSON has no ${typeof value}`)
}

function signedBytes(domain: SignDomain, payload: unknown): Buffer {
  return Buffer.from(`${domain}\n${canonicalJson(payload)}`, "utf8")
}

/** a base64url Ed25519 signature over the domain, a newline and the payload's canonical JSON */
export function signPayload(pair: KeyPair, domain: SignDomain, payload: unknown): string {
  return sign(null, signedBytes(domain, payload), privateKeyOf(pair)).toString("base64url")
}

export function verifyPayload(publicKey: string, domain: SignDomain, payload: unknown, signature: unknown): boolean {
  if (!validPublicKey(publicKey) || typeof signature !== "string") return false
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" })
    return verify(null, signedBytes(domain, payload), key, Buffer.from(signature, "base64url"))
  } catch {
    return false
  }
}

/** the account id a shared account key names: `acct_` and 32 hex characters of the public key's sha256 */
export function accountId(accountPublic: string): string {
  return `acct_${createHash("sha256").update(accountPublic).digest("hex").slice(0, 32)}`
}

export function newNonce(): string {
  return randomBytes(32).toString("base64url")
}
