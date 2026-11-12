import { createHmac, timingSafeEqual } from "node:crypto"

import { ACCESS_REQUEST_MIN_FILL_MS } from "@eve/contracts"

/** A proof older than this is expired. */
export const PROOF_MAX_AGE_MS = 24 * 3_600_000
const SIG_BYTES = 16
const PROOF_PATTERN = /^(\d{1,15})\.([A-Za-z0-9_-]{22})$/

/** `<issuedAtMs>.<base64url HMAC-SHA256(key, "ar1." + issuedAtMs), first 16 bytes>`. Stateless. */
export function issueProof(nowMs: number, key: Buffer): string {
  return `${nowMs}.${sign(nowMs, key).toString("base64url")}`
}

/** True when the signature matches and the proof is 3000 ms to 24 h old by the server clock. */
export function verifyProof(proof: string | null, nowMs: number, key: Buffer): boolean {
  const match = proof === null ? null : PROOF_PATTERN.exec(proof)
  if (!match) return false
  const issuedAtMs = Number(match[1])
  const presented = Buffer.from(match[2]!, "base64url")
  if (presented.length !== SIG_BYTES || !timingSafeEqual(presented, sign(issuedAtMs, key))) return false
  const age = nowMs - issuedAtMs
  return age >= ACCESS_REQUEST_MIN_FILL_MS && age <= PROOF_MAX_AGE_MS
}

function sign(issuedAtMs: number, key: Buffer): Buffer {
  return createHmac("sha256", key).update(`ar1.${issuedAtMs}`).digest().subarray(0, SIG_BYTES)
}
