import { createHmac } from "node:crypto"
import { isIPv4, isIPv6 } from "node:net"

/**
 * IPv4 as is; IPv4-mapped IPv6 as IPv4; other IPv6 cut to its /64 prefix,
 * because one host can rotate through a whole /64. Anything else is returned
 * unchanged so it still hashes deterministically.
 */
export function normalizeClientIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!
  if (isIPv4(ip) || !isIPv6(ip)) return ip
  return `${expandIPv6(ip).slice(0, 4).join(":")}::/64`
}

/** `hex(HMAC-SHA256(ipKey, normalized))`. Keyed, because the IPv4 space is small enough to brute-force. */
export function hashClientIp(ip: string, ipKey: Buffer): string {
  return createHmac("sha256", ipKey).update(normalizeClientIp(ip)).digest("hex")
}

/** Eight hextets without leading zeros. `ip` must be a valid IPv6 address without an embedded IPv4 tail in the first 64 bits. */
function expandIPv6(ip: string): string[] {
  const withoutZone = ip.split("%")[0]!
  const [head = "", tail] = withoutZone.split("::")
  const left = head === "" ? [] : head.split(":")
  const right = tail === undefined || tail === "" ? [] : tail.split(":")
  // An embedded IPv4 tail occupies two hextets; it never reaches the /64 prefix we keep.
  const rightHextets = right.flatMap((part) => (part.includes(".") ? ["0", "0"] : [part]))
  const zeros = tail === undefined ? [] : Array.from({ length: 8 - left.length - rightHextets.length }, () => "0")
  return [...left, ...zeros, ...rightHextets].map((part) => parseInt(part, 16).toString(16))
}
