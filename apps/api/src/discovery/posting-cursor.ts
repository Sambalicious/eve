import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto"

import type { PostingsTabValue, RoleFamilyValue } from "@eve/contracts"
import { z } from "zod"

import { type RoleFamily, TIER } from "./rules/ranking.js"

/**
 * Slice 8 (8P.9, 8P.10, D8-3, D8-7): the opaque `cursor` of
 * `GET /v1/job-postings`.
 *
 * Text form: `base64url(JSON payload) "." base64url(HMAC-SHA-256(payload))`.
 * The payload holds a version, a binding hash and the keyset position (the
 * sort key of the last row served). Nothing in it is secret; the MAC only
 * makes a cursor the server did not issue detectable, so a forged or edited
 * cursor is a 400 and can never select another tab or another order.
 *
 * The binding hash covers the tab, the normalised family set (deduplicated, in
 * display order) and the folded keyword (`foldForKeywords` of the trimmed
 * keyword), so a cursor is accepted with the same filter written another way
 * ("mobile,backend", "  react  ", "REACT", "Réact") and refused with any other.
 * Hashing keeps the cursor short whatever the keyword (a 100-character keyword
 * can fold to far more characters).
 *
 * EPIC-0002 A1 (architecture r4 "A1: cursor", C30, C40): version 2. The binding
 * also covers the Candidate and a hash of the tier map the page was ranked
 * with, so another Candidate's cursor, or one from before a tier change, is a
 * 400 like any bad cursor (the client reloads page 1). Version 1 cursors are
 * refused (one reload after deploy). The key is HKDF under the v2 label.
 */

/** Sort key of the Skipped and All tabs: newest first, then id. `discoveredUs` is microseconds since the epoch, as decimal text. */
export type NewestKey = Readonly<{ kind: "newest"; discoveredUs: string; id: string }>
/** Sort key of the Ranked tab, the `rankPostings` order. `covered`/`total` are the Match counts (0/0 without evidence). */
export type RankedKey = Readonly<{
  kind: "ranked"
  tier: number
  /** ATS fit 0 to 100 (0029); -1 without one. Ranked after the tier, before coverage. */
  atsFit: number
  covered: number
  total: number
  fromEmployerBoard: boolean
  discoveredUs: string
  id: string
}>
export type PostingKey = NewestKey | RankedKey

export type CursorBinding = Readonly<{
  tab: PostingsTabValue
  families: readonly RoleFamilyValue[]
  foldedKeyword: string | null
  /** The session's Candidate. */
  candidateId: string
  /** `tierMapHash` of the tier map the page used. In A1 every Candidate ranks by the built TIER (`TIER_HASH`); slice B passes the preferences version's map. */
  tierHash: string
}>

/** A stable hash of a tier map (families in schema order), so a cursor is bound to the ranking it was issued under. */
export function tierMapHash(tiers: Readonly<Record<RoleFamily, number>>): string {
  const families = Object.keys(TIER) as RoleFamily[]
  return createHash("sha256")
    .update(JSON.stringify(families.map((family) => [family, tiers[family]])), "utf8")
    .digest("base64url")
    .slice(0, 22)
}

/** The built TIER's hash: the tier binding of every A1 cursor. */
export const TIER_HASH = tierMapHash(TIER)

const CURSOR_VERSION = 2
const KEY_LABEL = "eve/job-postings-cursor/v2"
/**
 * The timestamp bounds (architecture r4 "A1: cursor", C40; SEC-801):
 * 1970-01-01T00:00:00Z to 2200-01-01T00:00:00Z in microseconds, both
 * inclusive. Well inside Postgres `timestamptz`, bigint and JavaScript `Date`,
 * so a MAC-valid cursor outside them is a 400 before any SQL, never a 500.
 */
export const MIN_CURSOR_MICROS = 0n
export const MAX_CURSOR_MICROS = 7258118400000000n
const MICROS_PATTERN = /^-?\d{1,19}$/
/**
 * CR8D-01: one refine that tests the digit pattern first. zod 4 runs every
 * check even after `.regex` fails, so a separate range refine would call
 * `BigInt` on "abc" and throw a SyntaxError (a 500 that echoes the value).
 */
const micros = z.string().refine((value) => {
  if (!MICROS_PATTERN.test(value)) return false
  const us = BigInt(value)
  return us >= MIN_CURSOR_MICROS && us <= MAX_CURSOR_MICROS
})
const count = z.int().min(0).max(1_000_000)

const keySchema = z.union([
  z.tuple([z.literal("n"), micros, z.uuid()]),
  z.tuple([z.literal("r"), z.int().min(0).max(9), z.int().min(-1).max(100), count, count, z.union([z.literal(0), z.literal(1)]), micros, z.uuid()]),
])
const payloadSchema = z.object({ v: z.literal(CURSOR_VERSION), b: z.string().length(22), k: keySchema }).strict()

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid job postings cursor")
    this.name = "InvalidCursorError"
  }
}

export class PostingCursorCodec {
  private readonly key: Buffer

  /**
   * `secret` is a server-only value. The key is derived with HKDF under a
   * label used for nothing else, so the cursor MAC never reuses the secret's
   * own key material for another purpose.
   */
  constructor(secret: string | undefined) {
    this.key =
      secret === undefined
        ? randomBytes(32)
        : Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), KEY_LABEL, 32))
  }

  encode(binding: CursorBinding, key: PostingKey): string {
    const k =
      key.kind === "newest"
        ? ["n", key.discoveredUs, key.id]
        : ["r", key.tier, key.atsFit, key.covered, key.total, key.fromEmployerBoard ? 1 : 0, key.discoveredUs, key.id]
    const payload = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, b: bindingHash(binding), k }), "utf8").toString("base64url")
    return `${payload}.${this.mac(payload)}`
  }

  /** Throws InvalidCursorError for anything the server did not issue for exactly this binding. */
  decode(cursor: string, binding: CursorBinding): PostingKey {
    const parts = cursor.split(".")
    if (parts.length !== 2) throw new InvalidCursorError()
    const [payload, mac] = parts as [string, string]
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) throw new InvalidCursorError()
    const expected = Buffer.from(this.mac(payload), "utf8")
    const presented = Buffer.from(mac, "utf8")
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) throw new InvalidCursorError()
    let json: unknown
    try {
      json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    } catch {
      throw new InvalidCursorError()
    }
    const parsed = payloadSchema.safeParse(json)
    if (!parsed.success || parsed.data.b !== bindingHash(binding)) throw new InvalidCursorError()
    const k = parsed.data.k
    const expectedKind = binding.tab === "ranked" ? "r" : "n"
    if (k[0] !== expectedKind) throw new InvalidCursorError()
    if (k[0] === "n") return { kind: "newest", discoveredUs: k[1], id: k[2] }
    return { kind: "ranked", tier: k[1], atsFit: k[2], covered: k[3], total: k[4], fromEmployerBoard: k[5] === 1, discoveredUs: k[6], id: k[7] }
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.key).update(payload, "utf8").digest("base64url")
  }
}

function bindingHash(binding: CursorBinding): string {
  return createHash("sha256")
    .update(JSON.stringify([binding.tab, [...binding.families], binding.foldedKeyword, binding.candidateId, binding.tierHash]), "utf8")
    .digest("base64url")
    .slice(0, 22)
}
