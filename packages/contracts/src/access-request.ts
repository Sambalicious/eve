import { z } from "zod"

/**
 * v1.16.0 (EPIC-0003 slice A): the public request-access endpoint. The only
 * unauthenticated write in the API. See api-contract.md "Public request access".
 */
export const ACCESS_REQUEST_PATH = "/v1/public/access-requests"
export const ACCESS_REQUEST_PROOF_PATH = "/v1/public/access-requests/proof"
/** Code points, after trimming. */
export const ACCESS_REQUEST_EMAIL_MAX = 254
/** Code points, after trimming and control stripping. */
export const ACCESS_REQUEST_NOTE_MAX = 500
export const ACCESS_REQUEST_BODY_MAX_BYTES = 4096
/** A fill-time proof must be at least this old when the request arrives. */
export const ACCESS_REQUEST_MIN_FILL_MS = 3000
/** Honeypot field name. Matches no browser autofill heuristic (design-spec r2 S2). */
export const ACCESS_REQUEST_HONEYPOT_FIELD = "kiwi"

/** `GET ACCESS_REQUEST_PROOF_PATH` -> 200. Fetched each time the dialog opens. */
export const accessRequestProofSchema = z.object({ proof: z.string().min(1).max(200) }).strict()
export type AccessRequestProof = z.infer<typeof accessRequestProofSchema>

/**
 * `POST ACCESS_REQUEST_PATH`, `Content-Type: application/json`, at most 4096 bytes.
 * Values are typed `unknown` here; `normalizeAccessRequest` turns them into field codes.
 */
export const accessRequestBodySchema = z
  .object({
    email: z.unknown(),
    /** `""` or absent means no note. */
    note: z.unknown().optional(),
    /** Absent or invalid: a silent drop, never a 400. */
    proof: z.unknown().optional(),
    /** Honeypot. A non-empty string is a silent drop. */
    kiwi: z.unknown().optional(),
  })
  .strict()
export type AccessRequestBody = z.infer<typeof accessRequestBodySchema>

/** `202` for every accepted or silently dropped request: same status, headers and body. */
export const accessRequestAcceptedSchema = z.object({ status: z.literal("received") }).strict()
export type AccessRequestAccepted = z.infer<typeof accessRequestAcceptedSchema>

/** Per-field codes on `400 access_request_invalid`, in field order (email first). */
export const accessRequestFieldCodeSchema = z.enum([
  "email.required",
  "email.format",
  "email.too_long",
  "note.too_long",
  "note.format",
  "body.unknown_field",
  "body.invalid_json",
  "body.too_large",
])
export type AccessRequestFieldCode = z.infer<typeof accessRequestFieldCodeSchema>

export type NormalizedAccessRequest =
  | { ok: true; email: string; emailKey: string; note: string; proof: string | null; honeypot: boolean }
  | { ok: false; fields: AccessRequestFieldCode[] }

/** Whitespace, NBSP, zero-width characters and the BOM, at either end. */
const EDGE_JUNK = /^[\s\u00A0\u200B-\u200D\u2060\uFEFF]+|[\s\u00A0\u200B-\u200D\u2060\uFEFF]+$/g
/**
 * Printable ASCII local part without whitespace, quotes, angle brackets, commas,
 * semicolons, colons, parentheses, brackets or backslash; a dotted DNS domain.
 * CR, LF and U+2028 can never match, so header injection fails here.
 */
const EMAIL_PATTERN = /^[!#-'*+\-./0-9=?A-Z^-~]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/
const LINE_BREAKS = /\r\n|[\r\u2028\u2029]/g
/** C0 and C1 controls except LF, plus the bidi embedding, override and isolate controls. */
// eslint-disable-next-line no-control-regex -- stripping controls is the point
const STRIPPED = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g
const KNOWN_KEYS = new Set(["email", "note", "proof", ACCESS_REQUEST_HONEYPOT_FIELD])

export function countCodePoints(text: string): number {
  return [...text].length
}

/** The trim both the dialog and the server apply to the email. */
export function trimAccessRequestEmail(raw: string): string {
  return raw.replace(EDGE_JUNK, "")
}

/** Pure, shared by the dialog and the server so both sides trim and count the same way. */
export function normalizeAccessRequest(body: unknown): NormalizedAccessRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, fields: ["body.invalid_json"] }
  const record = body as Record<string, unknown>
  if (Object.keys(record).some((key) => !KNOWN_KEYS.has(key))) return { ok: false, fields: ["body.unknown_field"] }

  const email = emailField(record.email)
  const note = noteField(record.note)
  const errors = [email, note].filter((part): part is { error: AccessRequestFieldCode } => "error" in part)
  if (errors.length > 0 || !("value" in email) || !("value" in note)) {
    return { ok: false, fields: errors.map((part) => part.error) }
  }

  const honeypotValue = record[ACCESS_REQUEST_HONEYPOT_FIELD]
  return {
    ok: true,
    email: email.value,
    emailKey: email.value.toLowerCase(),
    note: note.value,
    proof: typeof record.proof === "string" ? record.proof : null,
    honeypot: typeof honeypotValue === "string" && honeypotValue.trim() !== "",
  }
}

type FieldResult = { value: string } | { error: AccessRequestFieldCode }

function emailField(raw: unknown): FieldResult {
  if (raw === undefined) return { error: "email.required" }
  if (typeof raw !== "string") return { error: "email.format" }
  const email = trimAccessRequestEmail(raw)
  if (email === "") return { error: "email.required" }
  if (countCodePoints(email) > ACCESS_REQUEST_EMAIL_MAX) return { error: "email.too_long" }
  return EMAIL_PATTERN.test(email) ? { value: email } : { error: "email.format" }
}

function noteField(raw: unknown): FieldResult {
  if (raw === undefined) return { value: "" }
  if (typeof raw !== "string") return { error: "note.format" }
  const note = raw.replace(LINE_BREAKS, "\n").replace(STRIPPED, "").trim()
  return countCodePoints(note) > ACCESS_REQUEST_NOTE_MAX ? { error: "note.too_long" } : { value: note }
}

/** True when `email` passes the same allow-list the endpoint applies (re-checked at send time). */
export function isSafeAccessRequestEmail(email: string): boolean {
  return email === trimAccessRequestEmail(email) && countCodePoints(email) <= ACCESS_REQUEST_EMAIL_MAX && EMAIL_PATTERN.test(email)
}
