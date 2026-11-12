import { createHash, randomBytes } from "node:crypto"

const TOKEN_BYTES = 32

/** 256 random bits, base64url encoded. */
export function generateSecureToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url")
}

/** The database stores only this hash, so a leaked row cannot be replayed as a cookie. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
