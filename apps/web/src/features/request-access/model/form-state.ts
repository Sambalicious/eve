import {
  ACCESS_REQUEST_MIN_FILL_MS,
  ACCESS_REQUEST_NOTE_MAX,
  countCodePoints,
  normalizeAccessRequest,
  trimAccessRequestEmail,
  type AccessRequestFieldCode,
} from "@eve/contracts"

import { ApiError } from "@/shared/api"

/** True when no HTTP response arrived (offline, DNS, timeout): the panel shows `WifiOff`. */
export function isNoResponse(error: unknown): boolean {
  return !(error instanceof ApiError)
}

export type EmailError = "required" | "format" | "too_long"
export type NoteError = "too_long"
export interface FieldErrors {
  email?: EmailError
  note?: NoteError
}
export type FieldName = keyof FieldErrors
/** The alert panel after a failed send (design-spec r2 S2 reading order item 5). */
export type SendPanel = "network" | "rate_ip" | "rate_global" | "rejected"

export type SendOutcome = { kind: "fields"; fields: FieldErrors } | { kind: "panel"; panel: SendPanel }

const FIELD_CODE: Partial<Record<AccessRequestFieldCode, [FieldName, EmailError | NoteError]>> = {
  "email.required": ["email", "required"],
  "email.format": ["email", "format"],
  "email.too_long": ["email", "too_long"],
  "note.too_long": ["note", "too_long"],
}

/**
 * Maps a failed send to what the dialog shows (design-spec r2 feedback matrix):
 * field codes to inline errors; each 429 code to its panel; any other 4xx to
 * the rejected panel; 5xx, a timeout or no response to the network panel.
 */
export function outcomeOf(error: unknown): SendOutcome {
  if (!(error instanceof ApiError)) return { kind: "panel", panel: "network" }
  if (error.status >= 500) return { kind: "panel", panel: "network" }
  if (error.code === "rate_limited_ip") return { kind: "panel", panel: "rate_ip" }
  if (error.code === "rate_limited_global") return { kind: "panel", panel: "rate_global" }
  const fields: FieldErrors = {}
  for (const code of error.fields) {
    const mapped = FIELD_CODE[code]
    if (mapped && !fields[mapped[0]]) Object.assign(fields, { [mapped[0]]: mapped[1] })
  }
  if (error.code === "access_request_invalid" && (fields.email || fields.note)) return { kind: "fields", fields }
  return { kind: "panel", panel: "rejected" }
}

export type Validation =
  | { ok: true; email: string; note: string }
  | { ok: false; errors: FieldErrors; first: FieldName }

/** Client checks with the server's own normalizer, so trimming and counting can't drift. */
export function validateForm(email: string, note: string): Validation {
  const result = normalizeAccessRequest({ email, note })
  if (result.ok) return { ok: true, email: result.email, note: result.note }
  const errors = outcomeOf(new ApiError(400, "access_request_invalid", "", null, result.fields))
  const fields = errors.kind === "fields" ? errors.fields : {}
  return { ok: false, errors: fields, first: fields.email ? "email" : "note" }
}

/** The blur rule: an untouched or blank field shows nothing; otherwise format or length. */
export function emailErrorFor(value: string): EmailError | null {
  if (trimAccessRequestEmail(value) === "") return null
  const result = normalizeAccessRequest({ email: value })
  if (result.ok) return null
  return result.fields.includes("email.too_long") ? "too_long" : "format"
}

const COUNTER_FROM = 400

export type NoteHelper = { kind: "hint" } | { kind: "left"; count: number } | { kind: "over"; count: number }

/** The row under the note: the hint below 400 code points, then left or over (design-spec r2 S2). */
export function noteHelper(note: string): NoteHelper {
  const length = countCodePoints(note.trim())
  if (length < COUNTER_FROM) return { kind: "hint" }
  if (length <= ACCESS_REQUEST_NOTE_MAX) return { kind: "left", count: ACCESS_REQUEST_NOTE_MAX - length }
  return { kind: "over", count: length - ACCESS_REQUEST_NOTE_MAX }
}

/** Margin over the server's 3 s minimum, for clock skew within one session. */
const PROOF_MARGIN_MS = 250

/**
 * Architecture r1 7.6 alignment rule. Before 3 s since the dialog opened the
 * request posts at once (and is silently dropped, as AC 11.11 intends).
 * After that, a visitor is never dropped because the chunk or proof arrived
 * late: the send waits until the proof is 3.25 s old.
 */
export function proofWaitMs({ openedAt, proofAt, now }: { openedAt: number; proofAt: number; now: number }): number {
  if (now - openedAt < ACCESS_REQUEST_MIN_FILL_MS) return 0
  return Math.max(0, proofAt + ACCESS_REQUEST_MIN_FILL_MS + PROOF_MARGIN_MS - now)
}
