import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto"
import { canonicalJson, validPublicKey } from "./keys"

/** what sealing adds to a frame: the AES-256-GCM tag */
export const SEAL_TAG_BYTES = 16

const KEY_INFO = "scp/1 mesh key"

/** an X25519 key pair for one link: `public` is the 43-character base64url JWK x */
export interface Exchange {
  public: string
  key: KeyObject
}

/** what both ends know about one direction of a link, bound into its key */
export interface Direction {
  acct: string
  from: string
  to: string
  from_nonce: string
  to_nonce: string
  from_kx: string
  to_kx: string
}

export interface Channel {
  seal(text: string): Buffer
  /** the frame's text; throws when it was altered, replayed, reordered or dropped */
  open(frame: Buffer): string
}

export function newExchange(): Exchange {
  const { privateKey } = generateKeyPairSync("x25519")
  return { public: privateKey.export({ format: "jwk" }).x!, key: privateKey }
}

function directionKey(shared: Buffer, direction: Direction): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from(`${KEY_INFO}\n${canonicalJson(direction)}`, "utf8"), 32))
}

function iv(counter: bigint): Buffer {
  const bytes = Buffer.alloc(12)
  bytes.writeBigUInt64BE(counter, 4)
  return bytes
}

/** the sealed channel of one authenticated link: a key per direction, and per direction a frame counter as the GCM nonce */
export function openChannel(exchange: Exchange, peerKx: string, send: Direction, receive: Direction): Channel {
  if (!validPublicKey(peerKx)) throw new Error("invalid key exchange")
  const shared = diffieHellman({
    privateKey: exchange.key,
    publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: peerKx }, format: "jwk" }),
  })
  if (shared.every((byte) => byte === 0)) throw new Error("invalid key exchange")
  const sendKey = directionKey(shared, send)
  const receiveKey = directionKey(shared, receive)
  let sent = 0n
  let received = 0n
  return {
    seal(text) {
      const cipher = createCipheriv("aes-256-gcm", sendKey, iv(sent++))
      return Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()])
    },
    open(frame) {
      if (frame.length < SEAL_TAG_BYTES) throw new Error("short sealed frame")
      const decipher = createDecipheriv("aes-256-gcm", receiveKey, iv(received))
      decipher.setAuthTag(frame.subarray(frame.length - SEAL_TAG_BYTES))
      const text = Buffer.concat([decipher.update(frame.subarray(0, frame.length - SEAL_TAG_BYTES)), decipher.final()]).toString("utf8")
      received++
      return text
    },
  }
}
