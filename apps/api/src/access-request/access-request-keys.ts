import { hkdfSync } from "node:crypto"

/**
 * The two HMAC subkeys derived from `ACCESS_REQUEST_SECRET` (HKDF-SHA256). Held in
 * a closure, like `AnthropicConfig`, so serialising or inspecting never shows them.
 */
export type AccessRequestKeys = Readonly<{ ipKey(): Buffer; proofKey(): Buffer }>

export const ACCESS_REQUEST_KEYS = Symbol("ACCESS_REQUEST_KEYS")

export function accessRequestKeys(secret: string): AccessRequestKeys {
  const ipKey = derive(secret, "eve/access-request/ip/v1")
  const proofKey = derive(secret, "eve/access-request/proof/v1")
  return Object.freeze({
    ipKey: () => Buffer.from(ipKey),
    proofKey: () => Buffer.from(proofKey),
    toJSON: () => ({}),
    [Symbol.for("nodejs.util.inspect.custom")]: () => "AccessRequestKeys {}",
  })
}

function derive(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), info, 32))
}
