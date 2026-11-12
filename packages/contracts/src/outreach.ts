import { z } from "zod"

import type { ApiErrorCode } from "./errors.js"

/**
 * v1.31.0 EPIC-0014 Outreach messages (api-contract.md sections 4, 5 and 7;
 * architecture r1). Three private dashboard routes on one Application:
 *
 * - `GET  /v1/applications/{id}/outreach`                 the three items and `approvedProfileVersion`.
 * - `POST /v1/applications/{id}/outreach/{kind}/write`   202; no body; the Run continues in the api.
 * - `PUT  /v1/applications/{id}/outreach/{kind}/reader-name`  save or clear the Reader name.
 *
 * `:kind` is the kebab path slug and the JSON value is snake case (section 4).
 * Every object is `.strict()`: an unknown key is rejected on both sides.
 */

/** The three Kinds, in the fixed display and response order (section 5.1). */
export const OUTREACH_KINDS = ["referral_request", "introduction", "application_note"] as const
export type OutreachKind = (typeof OUTREACH_KINDS)[number]

/** Path slug for each Kind: the only path segments the routes accept (section 4). */
export const OUTREACH_KIND_SLUGS = {
  referral_request: "referral-request",
  introduction: "introduction",
  application_note: "application-note",
} as const

/** Code-point budgets per Kind: the whole composed text, and the model-derived body without the greeting (section 5.1). */
export const OUTREACH_BUDGETS = {
  referral_request: { total: 600, body: 550 },
  introduction: { total: 800, body: 750 },
  application_note: { total: 500, body: 450 },
} as const

/** Code points reserved for the greeting and its blank line, inside the whole-text budget (section 5.1). */
export const OUTREACH_GREETING_RESERVE = 50

/** The Reader name limit, in code points (section 5.1). */
export const READER_NAME_MAX = 40

/** The raw Reader name request bound, in UTF-16 units; a parse bound only (sections 4.3 and 5.1). */
export const READER_NAME_RAW_MAX = 500

/** The first failed sentence limit, in code points (section 5.1). */
export const OUTREACH_FIRST_FAILED_SENTENCE_MAX = 400

/**
 * The known failure causes, for typing and narrowing only. The wire type of
 * `lastFailure` is an open string (`OUTREACH_CAUSE_PATTERN`), so a client maps
 * any value outside this list to the generic cause notice (AC 11.3).
 */
export const OUTREACH_FAILURE_CAUSES = [
  "not_approved",
  "not_configured",
  "no_career_profile",
  "provider_error",
  "timed_out",
  "invalid_output",
  "blocked",
  "over_budget",
  "interrupted",
  "unexpected",
] as const
export type OutreachFailureCause = (typeof OUTREACH_FAILURE_CAUSES)[number]

/** The shape of `lastFailure` on the wire: a cause code, never text (section 5.1). */
export const OUTREACH_CAUSE_PATTERN = /^[a-z][a-z_]{0,39}$/

/** The whole encoded `mailto:` href limit, in characters (section 5.1; web only). */
export const OUTREACH_MAILTO_MAX = 2000

/** The longest subject the `mailto:` forms may produce, before encoding (architecture r1 G11). */
export const OUTREACH_SUBJECT_MAX = 120

/** One of the three Kinds. */
export const outreachKindSchema = z.enum(OUTREACH_KINDS)
export type OutreachKindValue = z.infer<typeof outreachKindSchema>

/** The run status: `running` exactly while a Run is in flight and under 10 minutes old (section 5.2). */
export const outreachRunStatusSchema = z.enum(["idle", "running"])
export type OutreachRunStatus = z.infer<typeof outreachRunStatusSchema>

/**
 * One Outreach item (section 5.2). `firstFailedSentence` is a required key with
 * a nullable value on every item; the api guarantees it is non-null only with
 * `lastFailure: "blocked"` (invariants I1 to I5), and a client reads it only
 * through `quotableFailedSentence`.
 */
export const outreachItemSchema = z
  .object({
    kind: outreachKindSchema,
    status: outreachRunStatusSchema,
    readerName: z.string().min(1).max(READER_NAME_MAX * 2).nullable(),
    text: z.string().min(1).nullable(),
    profileVersion: z.int().positive().nullable(),
    writtenAt: z.iso.datetime({ offset: true }).nullable(),
    lastFailure: z.string().regex(OUTREACH_CAUSE_PATTERN).nullable(),
    firstFailedSentence: z.string().min(1).max(OUTREACH_FIRST_FAILED_SENTENCE_MAX * 2).nullable(),
  })
  .strict()
export type OutreachItem = z.infer<typeof outreachItemSchema>

/** The `GET` response: always exactly three items in the fixed order, plus the approved profile version (section 5.3). */
export const outreachResponseSchema = z
  .object({
    items: z.array(outreachItemSchema).length(3),
    approvedProfileVersion: z.int().positive().nullable(),
  })
  .strict()
export type OutreachResponse = z.infer<typeof outreachResponseSchema>

/** The `PUT …/reader-name` body. `null`, `""` or spaces and tabs only clears the name (sections 5.4 and 7.1). */
export const readerNameRequestSchema = z
  .object({ readerName: z.string().max(READER_NAME_RAW_MAX).nullable() })
  .strict()
export type ReaderNameRequest = z.infer<typeof readerNameRequestSchema>

/** The outcome of `validateReaderName`: a normalised value, `null` to clear, or a refusal (section 7.1). */
export type ReaderNameResult = Readonly<{ ok: true; value: string | null }> | Readonly<{ ok: false }>

/** `GET`/`POST`/`PUT` route for the three items of one Application. */
export function applicationOutreachPath(applicationId: string): string {
  return `/v1/applications/${applicationId}/outreach`
}

/** `POST …/write` route for one Kind. Takes the snake `kind` and emits the kebab slug. */
export function applicationOutreachWritePath(applicationId: string, kind: OutreachKind): string {
  return `${applicationOutreachPath(applicationId)}/${OUTREACH_KIND_SLUGS[kind]}/write`
}

/** `PUT …/reader-name` route for one Kind. Takes the snake `kind` and emits the kebab slug. */
export function applicationOutreachReaderNamePath(applicationId: string, kind: OutreachKind): string {
  return `${applicationOutreachPath(applicationId)}/${OUTREACH_KIND_SLUGS[kind]}/reader-name`
}

/**
 * The one counting unit for every figure in the epic: Unicode code points
 * (`Array.from`), equal to Postgres `char_length`. A line break counts as one.
 * Never use `.length` or grapheme counting for a budget, a limit or a shown
 * count (section 7.3).
 */
export function outreachLength(text: string): number {
  return Array.from(text).length
}

/**
 * The exact text the page shows and copies (section 7.4): `Hi {name},` or
 * `Hello,`, one blank line, then the body. An Application note with no name is
 * the body alone.
 */
export function composeOutreachText(input: { kind: OutreachKind; readerName: string | null; body: string }): string {
  if (input.readerName !== null) return `Hi ${input.readerName},\n\n${input.body}`
  if (input.kind === "application_note") return input.body
  return `Hello,\n\n${input.body}`
}

/** U+0000 to U+001F, U+007F to U+009F, U+2028 and U+2029: refused in a Reader name (section 7.1, rule 2). */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const READER_NAME_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u
/** Space, tab only: a value made only of these clears the name (section 7.1, rule 1). */
const READER_NAME_BLANK = /^[ \t]*$/u
/** The code points a name may hold (section 7.1, rule 5). */
const READER_NAME_ALLOWED = /^[\p{L}\p{M} \-'’.]$/u
/** At least one letter (section 7.1, rule 6). */
const READER_NAME_LETTER = /\p{L}/u
/** Link-shaped text, such as `ada.dev` (section 7.1, rule 7). */
const READER_NAME_LINK_SHAPED = /\p{L}{2,}\.\p{L}{2,}/u

/**
 * Validate and normalise a Reader name (section 7.1). Steps run in order and the
 * first refusal wins. `value: null` means clear the name. The api is the
 * authority; the web runs the same function before sending.
 */
export function validateReaderName(input: string | null): ReaderNameResult {
  if (input === null || READER_NAME_BLANK.test(input)) return { ok: true, value: null }
  if (READER_NAME_CONTROL.test(input)) return { ok: false }

  const value = input.replace(/^ +| +$/gu, "").replace(/ {2,}/gu, " ")
  const length = outreachLength(value)
  if (length < 1 || length > READER_NAME_MAX) return { ok: false }

  for (const character of value) {
    if (!READER_NAME_ALLOWED.test(character)) return { ok: false }
  }
  if (!READER_NAME_LETTER.test(value)) return { ok: false }
  if (READER_NAME_LINK_SHAPED.test(value)) return { ok: false }
  return { ok: true, value }
}

/** Codepoints that may not appear in a subject: CR, LF and every other C0 and C1 control (section 7.5). */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const SUBJECT_CONTROL = /[\u0000-\u001F\u007F-\u009F]+/gu
/** A link-shaped target, such as `Booking.com` (architecture r1 D5). */
const DOMAIN_SHAPED_TOKEN = /\p{L}+\.\p{L}+/gu

/** Control characters, line breaks and the Unicode line and paragraph separators: none may reach the text, the subject or the judge. */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const TARGET_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u

function collapseSubjectControls(value: string): string {
  return value.replace(SUBJECT_CONTROL, " ").trim()
}

/**
 * Whether a role title or company may be filled into the text and the subject
 * (architecture r1 D5, G11): not null, at most 120 code points, no control
 * character or line break, no bracket, no `://`, `www.` or `@`, and no
 * domain-shaped token whose suffix is not `js`, `ts` or `net`. A value that
 * fails falls back to "the role", "the company" or the subject form without it.
 */
export function usableTarget(value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false
  if (TARGET_CONTROL.test(value)) return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  if (outreachLength(trimmed) > OUTREACH_SUBJECT_MAX) return false
  if (/[[\]{}<>]/u.test(trimmed)) return false
  if (trimmed.includes("://") || trimmed.includes("@")) return false
  if (/www\./iu.test(trimmed)) return false
  for (const match of trimmed.matchAll(new RegExp(DOMAIN_SHAPED_TOKEN))) {
    const suffix = match[0].slice(match[0].lastIndexOf(".") + 1).toLowerCase()
    if (suffix !== "js" && suffix !== "ts" && suffix !== "net") return false
  }
  return true
}

const SUBJECT_TEMPLATES: Readonly<
  Record<OutreachKind, Readonly<{ both: (role: string, company: string) => string; noRole: (company: string) => string; noCompany: (role: string) => string; neither: string }>>
> = {
  referral_request: {
    both: (role, company) => `Referral request for ${role} at ${company}`,
    noRole: (company) => `Referral request for a role at ${company}`,
    noCompany: (role) => `Referral request for ${role}`,
    neither: "Referral request",
  },
  introduction: {
    both: (role, company) => `Interested in ${role} at ${company}`,
    noRole: (company) => `Interested in a role at ${company}`,
    noCompany: (role) => `Interested in ${role}`,
    neither: "A short introduction",
  },
  application_note: {
    both: (role, company) => `Applying for ${role} at ${company}`,
    noRole: (company) => `Applying for a role at ${company}`,
    noCompany: (role) => `Applying for ${role}`,
    neither: "Applying for a role",
  },
}

/**
 * The `mailto:` subject for a Kind (section 7.5, copy deck C-OM-44 to C-OM-46).
 * The first form whose inputs are usable and whose filled length is at most 120
 * code points, in the order role and company, no role, no company, neither. The
 * role is never shortened. CR, LF and every other control are collapsed to one
 * space.
 */
export function outreachSubject(kind: OutreachKind, roleTitle: string | null, company: string | null): string {
  const templates = SUBJECT_TEMPLATES[kind]
  const role = usableTarget(roleTitle) ? collapseSubjectControls(roleTitle) : null
  const employer = usableTarget(company) ? collapseSubjectControls(company) : null
  for (const candidate of [
    role !== null && employer !== null ? templates.both(role, employer) : null,
    employer !== null ? templates.noRole(employer) : null,
    role !== null ? templates.noCompany(role) : null,
  ]) {
    if (candidate !== null && outreachLength(candidate) <= OUTREACH_SUBJECT_MAX) return candidate
  }
  return templates.neither
}

/**
 * The `mailto:` link for a text (section 7.5): `mailto:?subject=<s>&body=<b>`,
 * no recipient, cc or bcc. At most `OUTREACH_MAILTO_MAX` characters of the whole
 * encoded href is offered; above it the builder returns null and the link is not
 * rendered. The string is ASCII after encoding, so `.length` is exact.
 */
export function outreachMailtoHref(input: { kind: OutreachKind; text: string; roleTitle: string | null; company: string | null }): string | null {
  const subject = encodeURIComponent(outreachSubject(input.kind, input.roleTitle, input.company))
  const body = encodeURIComponent(input.text).replace(/%0A/gu, "%0D%0A")
  const href = `mailto:?subject=${subject}&body=${body}`
  return href.length > OUTREACH_MAILTO_MAX ? null : href
}

/** An unfilled placeholder token such as `{role_phrase}` (section 5.2). */
const UNFILLED_TOKEN = /\{[^{}\s]*\}/u

/**
 * Whether a sentence holds an unfilled `{...}` placeholder token. The api stores
 * a blocked Run's sentence as the model wrote it, token included; this is the one
 * test that keeps such a sentence off the page (CURRENT.md decision 8).
 */
export function hasUnfilledPlaceholder(text: string): boolean {
  return UNFILLED_TOKEN.test(text)
}

/**
 * The quote to render, or null (section 5.2; AC 11.3 and CURRENT.md decision 8).
 * Returns the sentence only with `lastFailure: "blocked"`, when it is non-null,
 * and when it holds no unfilled `{...}` placeholder. Otherwise the cause line
 * shows alone, with no label.
 */
export function quotableFailedSentence(item: OutreachItem): string | null {
  if (item.lastFailure !== "blocked") return null
  if (item.firstFailedSentence === null) return null
  if (hasUnfilledPlaceholder(item.firstFailedSentence)) return null
  return item.firstFailedSentence
}

/** Whether an open `lastFailure` string is one of the known causes (section 5.2). */
export function isOutreachFailureCause(value: string | null): value is OutreachFailureCause {
  return value !== null && (OUTREACH_FAILURE_CAUSES as readonly string[]).includes(value)
}

/**
 * v1.31.0: the exact message of `outreach_reader_name_invalid`, byte for byte
 * from the copy deck (`C-OM-37`). The api sends it; the web and its MSW handlers
 * import it instead of retyping prose.
 */
export const OUTREACH_ERROR_MESSAGES = {
  outreach_reader_name_invalid: "Use letters, spaces, hyphens, apostrophes and full stops, up to 40 characters.",
} as const satisfies Partial<Record<ApiErrorCode, string>>
