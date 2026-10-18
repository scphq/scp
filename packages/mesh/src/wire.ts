import { ACCOUNT_HANDLE } from "@scp-dev/core"
import { MACHINE_NAME } from "@scp-dev/hub"
import type { AccountKey } from "./config"
import { accountId, type KeyPair, SIGN_DOMAIN, signPayload, validPublicKey, verifyPayload } from "./keys"

export const MESH_PATH = "/scp/mesh"
export const MESH_FRAME_BYTES = 262_144

export interface MachineCert {
  v: 1
  acct: string
  account: string
  machine: string
  key: string
  sig: string
}

export interface MachineRecord {
  v: 1
  acct: string
  machine: string
  epoch: number
  seq: number
  endpoints: unknown[]
  cert: MachineCert
  sig: string
}

export function issueCert(account: AccountKey, machine: string, machineKey: KeyPair): MachineCert {
  const payload = { v: 1 as const, acct: accountId(account.public), account: account.account, machine, key: machineKey.public }
  return { ...payload, sig: signPayload(account, SIGN_DOMAIN.cert, payload) }
}

export function verifyCert(cert: unknown, account: { acct: string; public: string }): cert is MachineCert {
  if (!cert || typeof cert !== "object" || Array.isArray(cert)) return false
  const c = cert as MachineCert
  if (
    c.v !== 1 ||
    c.acct !== account.acct ||
    c.acct !== accountId(account.public) ||
    typeof c.account !== "string" ||
    !ACCOUNT_HANDLE.test(c.account) ||
    typeof c.machine !== "string" ||
    !MACHINE_NAME.test(c.machine) ||
    !validPublicKey(c.key)
  )
    return false
  const { sig, ...payload } = c
  return verifyPayload(account.public, SIGN_DOMAIN.cert, payload, sig)
}

export function signRecord(machineKey: KeyPair, record: Omit<MachineRecord, "sig">): MachineRecord {
  const payload = { ...record } as Omit<MachineRecord, "sig"> & { sig?: string }
  delete payload.sig
  return { ...payload, sig: signPayload(machineKey, SIGN_DOMAIN.record, payload) }
}

export function verifyRecord(record: unknown, account: { acct: string; public: string }): record is MachineRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false
  const r = record as MachineRecord
  if (
    r.v !== 1 ||
    r.acct !== account.acct ||
    !verifyCert(r.cert, account) ||
    r.machine !== r.cert.machine ||
    !Number.isInteger(r.epoch) ||
    r.epoch < 0 ||
    !Number.isInteger(r.seq) ||
    r.seq < 0 ||
    !Array.isArray(r.endpoints) ||
    r.endpoints.length > 512
  )
    return false
  const { sig, ...payload } = r
  return verifyPayload(r.cert.key, SIGN_DOMAIN.record, payload, sig)
}
