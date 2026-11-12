import { z } from "zod"

import { hiringHintTermSchema } from "./stack-search-links.js"

/**
 * v1.14.0 (EPIC-0005): Stack posts. v1.15.1: label and basis lengths in code
 * points, control characters refused with `invalid_characters`. Alert feed verification, registration,
 * removal and listing, and the stored Stack posts list. Every route needs the
 * Candidate's session; writes need the CSRF header.
 *
 * v1.22.0 (EPIC-0008): each Candidate has their own Stack posts Alert feed verification. The verification PUT has no role check and writes the caller's own record; GET alert-feeds returns it.
 * v1.22.0 (OWN-1): the alert-feeds and hiring-feeds responses (GET and the verification PUT) carry `globalPaused`, so every Candidate learns the global pause without `GET /v1/controls`.
 */
export const STACK_POSTS_PATH = "/v1/stack-posts"
export const ALERT_FEEDS_PATH = "/v1/stack-posts/alert-feeds"
/** v1.22.0 (EPIC-0008): the session Candidate's own Stack posts feed verification. Any Candidate; no role check. */
export const ALERT_FEED_VERIFICATION_PATH = "/v1/stack-posts/alert-feeds/verification"

/**
 * v1.19.0 (EPIC-0007 Phase 1): the hint terms for the Hiring view's search links,
 * from the session Candidate's Job Preferences. `GET`, session only, no CSRF.
 */
export const HIRING_SEARCH_INPUTS_PATH = "/v1/stack-posts/hiring-search-inputs"

export const hiringSearchInputsResponseSchema = z
  .object({
    /** In AC 2.5 order, unique. [] when the Candidate has no Job Preferences row or it cannot be read. */
    hintTerms: z.array(hiringHintTermSchema).max(3),
  })
  .strict()
export type HiringSearchInputsResponse = z.infer<typeof hiringSearchInputsResponseSchema>

/**
 * v1.20.0 (EPIC-0007 Phase 3): Hiring Alert feeds and Hiring posts. Each
 * Candidate has their own Hiring feed verification (D14); v1.22.0: Stack posts also use a per-Candidate record (EPIC-0008); the two records are separate. Every route needs the session; writes
 * need the CSRF header. No role check.
 */
export const HIRING_ALERT_FEEDS_PATH = "/v1/stack-posts/hiring-feeds"
/** v1.20.0 (D14): the session Candidate's own Hiring feed verification. Any Candidate. */
export const HIRING_FEED_VERIFICATION_PATH = "/v1/stack-posts/hiring-feeds/verification"
export const HIRING_POSTS_PATH = "/v1/stack-posts/hiring-posts"
/** D5: per Candidate, separate from ALERT_FEED_LIMIT. */
export const HIRING_ALERT_FEED_LIMIT = 10

/** AC 4.2 (ADR 0012): the only accepted feed URL shape, checked after trimming. */
export const ALERT_FEED_URL_PATTERN = /^https:\/\/www\.google\.com\/alerts\/feeds\/[0-9]+\/[0-9]+$/
export const ALERT_FEED_URL_MAX_LENGTH = 512
export const ALERT_FEED_LIMIT = 10
export const ALERT_FEED_LABEL_MAX = 60
export const VERIFICATION_BASIS_MAX = 500
export const STACK_POSTS_PAGE_SIZE = 50
/** AC 5.5: caps on the stored plain text, in code points after cleaning. */
export const STACK_POST_TITLE_MAX = 300
export const STACK_POST_SNIPPET_MAX = 1000

/**
 * v1.15.1 (CR-E5-04): the one length rule for a label or basis, used by the
 * web form, the API and the zod schemas. Unicode code points, the unit
 * Postgres `char_length` counts in a UTF-8 database: "😀" is 1, the flag
 * "🇳🇬" is 2, CRLF is 2. Callers trim first.
 */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * v1.15.2 (SEC-E5F-02, architecture r4 item 4): refused in both fields after trimming. C1 controls
 * U+0080 to U+009F (NEL included), the Unicode `Bidi_Control` set (U+061C, U+200E, U+200F, U+202A to
 * U+202E, U+2066 to U+2069) and the invisible U+200B, U+2060 and U+FEFF. ZWNJ (U+200C), ZWJ (U+200D)
 * and U+00A0 stay allowed: Persian and Indic text and emoji sequences need them.
 */
const WIDENED = "\\u0080-\\u009F\\u061C\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2060\\u2066-\\u2069\\uFEFF"
const ANY_DISALLOWED = new RegExp(`[\\u0000-\\u001F\\u007F${WIDENED}]`, "u")
const DISALLOWED_EXCEPT_LINE_BREAKS = new RegExp(`[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F${WIDENED}]`, "u")

/**
 * v1.15.1 (SEC-E5-06): true when `text` holds a character in U+0000 to
 * U+001F or U+007F. With `allowLineBreaks` (the basis textarea), TAB, LF and
 * CR are allowed. A label is one line, so it allows none. v1.15.2 (SEC-E5F-02):
 * also true for C1 controls, bidi controls, U+200B, U+2060 and U+FEFF, in both.
 */
export function hasDisallowedControlCharacters(text: string, options: Readonly<{ allowLineBreaks: boolean }>): boolean {
  return (options.allowLineBreaks ? DISALLOWED_EXCEPT_LINE_BREAKS : ANY_DISALLOWED).test(text)
}

/** True when `url` (already trimmed) is an Alert feed URL Eve may register and read. */
export function isAlertFeedUrl(url: string): boolean {
  return url.length <= ALERT_FEED_URL_MAX_LENGTH && ALERT_FEED_URL_PATTERN.test(url)
}

/**
 * D-E5-2: "…" plus the last 6 digits of the whole URL, slashes ignored.
 * "/alerts/feeds/1/42" gives "…142"; "/1/2" gives "…12". The server computes it;
 * the web app never has a full URL after registration (D-E5-5).
 */
export function maskAlertFeedUrl(url: string): string {
  return `…${url.replace(/[^0-9]/g, "").slice(-6)}`
}

/** The six read failures, shared by registration and scheduled reads (D-E5-1, ADR 0012). */
export const alertFeedFailureReasonSchema = z.enum(["not_reachable", "unexpected_response", "redirected", "not_a_feed", "too_large", "timed_out"])
export type AlertFeedFailureReason = z.infer<typeof alertFeedFailureReasonSchema>

/**
 * Copy deck C-SP-FAIL-*: the reason phrase for the page row, the start of the
 * registration field error and the email. An unknown code reads as
 * "Unexpected response".
 */
export const ALERT_FEED_FAILURE_PHRASES: Readonly<Record<AlertFeedFailureReason, string>> = {
  not_reachable: "Not reachable",
  unexpected_response: "Unexpected response",
  redirected: "Redirected (not followed)",
  not_a_feed: "Not a feed",
  too_large: "Too large",
  timed_out: "Timed out",
}

export function alertFeedFailurePhrase(reason: string): string {
  const parsed = alertFeedFailureReasonSchema.safeParse(reason)
  return parsed.success ? ALERT_FEED_FAILURE_PHRASES[parsed.data] : ALERT_FEED_FAILURE_PHRASES.unexpected_response
}

export const stackPostsFieldSchema = z.enum(["url", "label", "verifiedOn", "verificationBasis", "page"])
export const stackPostsFieldProblemSchema = z.enum([
  "invalid",
  "missing",
  "too_long",
  "future_date",
  "invalid_format",
  "duplicate",
  "limit_reached",
  /** v1.15.1: `label` or `verificationBasis` holds a disallowed control character (SEC-E5-06); v1.15.2 adds C1, bidi and invisible characters (SEC-E5F-02). */
  "invalid_characters",
  /** v1.20.0 (EPIC-0007 Phase 3): the trimmed URL is already registered in the caller's OTHER feed list. */
  "in_other_list",
  ...alertFeedFailureReasonSchema.options,
])

/** One field-level error on `400 bad_request` from a Stack posts route. Never echoes a value. */
export const stackPostsFieldErrorSchema = z
  .object({ field: stackPostsFieldSchema, position: z.null(), problem: stackPostsFieldProblemSchema })
  .strict()
export type StackPostsFieldError = z.infer<typeof stackPostsFieldErrorSchema>

const isoDate = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar date in `YYYY-MM-DD` form (AC 3.2). */
export function isCalendarDate(value: string): boolean {
  if (!isoDate.test(value)) return false
  const [year, month, day] = value.split("-").map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/**
 * `PUT /v1/stack-posts/alert-feeds/verification`. Both fields are required, so
 * a body cannot clear a recorded verification (AC 3.1, 3.4). The server also
 * refuses a date after today in WAT (`future_date`). The basis is counted in
 * code points after trimming and may hold TAB, LF and CR but no other control
 * character (v1.15.1), and no C1, bidi or invisible character (v1.15.2).
 */
export const alertFeedVerificationRequestSchema = z
  .object({
    verifiedOn: z.string().refine(isCalendarDate),
    verificationBasis: z
      .string()
      .trim()
      .min(1)
      .refine((basis) => !hasDisallowedControlCharacters(basis, { allowLineBreaks: true }))
      .refine((basis) => codePointLength(basis) <= VERIFICATION_BASIS_MAX),
  })
  .strict()
export type AlertFeedVerificationRequest = z.infer<typeof alertFeedVerificationRequestSchema>

export const alertFeedVerificationSchema = z
  .object({ verifiedOn: z.string().regex(isoDate), verificationBasis: z.string(), updatedAt: z.iso.datetime() })
  .strict()
export type AlertFeedVerification = z.infer<typeof alertFeedVerificationSchema>

/**
 * `POST /v1/stack-posts/alert-feeds`. `url` is trimmed; `label` is trimmed and
 * blank means none. The label is counted in code points and may hold no
 * control character, tab and line breaks included (v1.15.1), and no C1, bidi
 * or invisible character (v1.15.2).
 */
export const registerAlertFeedRequestSchema = z
  .object({
    url: z.string().trim().refine(isAlertFeedUrl),
    label: z
      .string()
      .trim()
      .refine((label) => !hasDisallowedControlCharacters(label, { allowLineBreaks: false }))
      .refine((label) => codePointLength(label) <= ALERT_FEED_LABEL_MAX)
      .nullish()
      .transform((value) => (value ? value : null)),
  })
  .strict()
export type RegisterAlertFeedRequest = z.infer<typeof registerAlertFeedRequestSchema>

export const alertFeedSchema = z
  .object({
    id: z.uuid(),
    label: z.string().nullable(),
    /** D-E5-2, e.g. "…654321". */
    maskedUrl: z.string(),
    createdAt: z.iso.datetime(),
    /** Last successful read; the registration fetch counts. */
    lastReadAt: z.iso.datetime().nullable(),
    failure: z.object({ reason: alertFeedFailureReasonSchema, at: z.iso.datetime() }).strict().nullable(),
  })
  .strict()
export type AlertFeed = z.infer<typeof alertFeedSchema>

export const alertFeedsResponseSchema = z
  .object({
    /** v1.22.0: the caller's own record, or null. Feeds may be non-empty while null (feeds saved before EPIC-0008). */
    verification: alertFeedVerificationSchema.nullable(),
    /** Oldest first. Never carries a full URL (D-E5-5). */
    feeds: z.array(alertFeedSchema),
    limit: z.literal(ALERT_FEED_LIMIT),
    /** v1.22.0 (OWN-1): the global pause flag, the same value `GET /v1/controls` returns. Pause flag only, no spend data. Any Candidate. */
    globalPaused: z.boolean(),
  })
  .strict()
export type AlertFeedsResponse = z.infer<typeof alertFeedsResponseSchema>

/** `201` from registration: the only response that carries the full feed URL (D-E5-5). */
export const registerAlertFeedResponseSchema = z
  .object({ feed: alertFeedSchema.extend({ url: z.string() }).strict(), storedPosts: z.int().min(0) })
  .strict()
export type RegisterAlertFeedResponse = z.infer<typeof registerAlertFeedResponseSchema>

export const stackPostKindSchema = z.enum(["post", "article"])
export type StackPostKind = z.infer<typeof stackPostKindSchema>

/**
 * v1.20.1 (SEC-P3-01 / SEC-E7-05): every stored `canonicalUrl` starts with this
 * prefix (the `stack_post` and `hiring_post` database checks use the same
 * `like 'https://www.linkedin.com/%'`). Clients use the value as an `href`, so
 * the schema refuses anything else, such as a `javascript:` URL.
 */
export const STACK_POST_CANONICAL_URL_PREFIX = "https://www.linkedin.com/"

export const stackPostSchema = z
  .object({
    id: z.uuid(),
    canonicalUrl: z.string().startsWith(STACK_POST_CANONICAL_URL_PREFIX),
    kind: stackPostKindSchema,
    title: z.string(),
    snippet: z.string(),
    /** Published (else updated) date from the feed, or the first-seen time when the feed had none. */
    date: z.iso.datetime(),
    /** "posted": from the feed; "found": the first-seen time (AC 5.7). */
    dateKind: z.enum(["posted", "found"]),
    /** Job criteria entries in the Candidate's entered form, fixed when first stored (AC 5.6). */
    matchedTechnologies: z.array(z.string()),
    /** Null: the source feed was removed ("Removed feed"). */
    source: z.object({ label: z.string().nullable(), maskedUrl: z.string() }).strict().nullable(),
    firstSeenAt: z.iso.datetime(),
  })
  .strict()
export type StackPost = z.infer<typeof stackPostSchema>

export const stackPostsResponseSchema = z
  .object({
    items: z.array(stackPostSchema),
    page: z.int().positive(),
    pageSize: z.literal(STACK_POSTS_PAGE_SIZE),
    totalCount: z.int().min(0),
    /** 0 when there are no posts. */
    totalPages: z.int().min(0),
  })
  .strict()
export type StackPostsResponse = z.infer<typeof stackPostsResponseSchema>

/** v1.20.0: `GET`/`PUT` Hiring feeds. `verification` is the caller's own record, or null until they record it. */
export const hiringAlertFeedsResponseSchema = z
  .object({
    verification: alertFeedVerificationSchema.nullable(),
    /** Oldest first. Never a full URL (D-E5-5). Empty while verification is null. */
    feeds: z.array(alertFeedSchema),
    limit: z.literal(HIRING_ALERT_FEED_LIMIT),
    /** v1.22.0 (OWN-1): the global pause flag, as on `alertFeedsResponseSchema`. */
    globalPaused: z.boolean(),
  })
  .strict()
export type HiringAlertFeedsResponse = z.infer<typeof hiringAlertFeedsResponseSchema>

/** v1.20.0: same fields and meaning as stackPostsResponseSchema. */
export const hiringPostsResponseSchema = z
  .object({
    items: z.array(stackPostSchema),
    page: z.int().positive(),
    pageSize: z.literal(STACK_POSTS_PAGE_SIZE),
    totalCount: z.int().min(0),
    /** 0 when there are no posts. */
    totalPages: z.int().min(0),
  })
  .strict()
export type HiringPostsResponse = z.infer<typeof hiringPostsResponseSchema>

/** `?page=` value: a positive integer written in digits, at most 9 of them. Omitted means 1. */
export const STACK_POSTS_PAGE_PATTERN = /^[1-9][0-9]{0,8}$/
