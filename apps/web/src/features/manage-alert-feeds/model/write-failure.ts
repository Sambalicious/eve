import { stackPostsCopy as c } from "@/entities/stack-post"
import { ApiError, isUnauthorizedError } from "@/shared/api"
import { stackPostsFieldErrorSchema, type StackPostsFieldError } from "@/shared/lib/hiring-contracts"
import { FEED_LIST_COPY, type FeedList } from "./feed-list"

/** Why a write on the Stack posts page failed, in the terms the page shows (design-spec r1, Error routing). */
export type WriteFailure =
  /** 400 with field errors: each goes to its field. */
  | { readonly kind: "fields"; readonly fieldErrors: readonly StackPostsFieldError[] }
  /** Other 4xx with a message: shown verbatim (C-SP-ERR-API). */
  | { readonly kind: "message"; readonly message: string }
  /**
   * v1.15.2: 503 `service_unavailable`, a database lock wait timed out. Registration shows
   * C-SP-FEED-ERR-BUSY; the other writes set no lock timeout and treat it as `retry`.
   */
  | { readonly kind: "busy" }
  /** Any other Eve 5xx, a network failure, an unparseable body or a 4xx without a message: the write's `*-ERR-NET` line. */
  | { readonly kind: "retry" }
  /** 401: the app-wide handler sends the Candidate to sign-in; the page shows nothing. */
  | { readonly kind: "signed_out" }

/**
 * EPIC-0004 r1 routing, no exception (design-spec r1): a 5xx server message is
 * never shown. A 400 without `fieldErrors` (body not nameable by field) shows
 * its message like any other 4xx.
 */
export function toWriteFailure(error: unknown): WriteFailure {
  if (isUnauthorizedError(error)) return { kind: "signed_out" }
  if (!(error instanceof ApiError) || error.code === null) return { kind: "retry" }
  if (error.status === 503 && error.code === "service_unavailable") return { kind: "busy" }
  if (error.status >= 500 || error.status < 400) return { kind: "retry" }
  const fieldErrors = error.fieldErrors.filter(
    (item): item is StackPostsFieldError => stackPostsFieldErrorSchema.safeParse(item).success
  )
  if (error.code === "bad_request" && fieldErrors.length > 0) return { kind: "fields", fieldErrors }
  return error.message.trim() === "" ? { kind: "retry" } : { kind: "message", message: error.message }
}

const URL_MESSAGES: Partial<Record<StackPostsFieldError["problem"], string>> = {
  invalid_format: c.feedUrlErrFormat,
  duplicate: c.feedUrlErrDup,
  not_reachable: c.feedErrUnreachable,
  unexpected_response: c.feedErrUnexpected,
  redirected: c.feedErrRedirect,
  not_a_feed: c.feedErrNotFeed,
  too_large: c.feedErrTooLarge,
  timed_out: c.feedErrTimeout,
}

export type FeedFieldMessages = { url?: string; label?: string }
export type VerificationFieldMessages = { date?: string; basis?: string }

/**
 * Registration field errors to copy deck lines (api-contract v1.15.1, Mapping to copy; EPIC-0007
 * api-contract.r1 "Problem → copy"). The first per field wins. `limit_reached` and `in_other_list`
 * name the list whose endpoint answered (design-spec r2 H6a step 3).
 */
export function feedFieldMessages(fieldErrors: readonly StackPostsFieldError[], list: FeedList = "stack"): FeedFieldMessages {
  const copy = FEED_LIST_COPY[list]
  const listMessages: Partial<Record<StackPostsFieldError["problem"], string>> = {
    limit_reached: copy.errLimit,
    in_other_list: copy.errOtherList,
  }
  const messages: FeedFieldMessages = {}
  for (const { field, problem } of fieldErrors) {
    if (field === "url") messages.url ??= listMessages[problem] ?? URL_MESSAGES[problem] ?? c.feedUrlErrFormat
    if (field === "label") messages.label ??= problem === "invalid_characters" ? c.feedLabelErrChars : c.feedLabelErrLong
  }
  return messages
}

const BASIS_MESSAGES: Partial<Record<StackPostsFieldError["problem"], string>> = {
  too_long: c.verifyBasisLong,
  invalid_characters: c.verifyBasisErrChars,
}

/** Verification field errors to copy deck lines. A 400 lists every bad field (v1.15.1), so both fields can be set. */
export function verificationFieldMessages(fieldErrors: readonly StackPostsFieldError[]): VerificationFieldMessages {
  const messages: VerificationFieldMessages = {}
  for (const { field, problem } of fieldErrors) {
    if (field === "verifiedOn") messages.date ??= problem === "future_date" ? c.verifyDateFuture : c.verifyDateErr
    if (field === "verificationBasis") messages.basis ??= BASIS_MESSAGES[problem] ?? c.verifyBasisErr
  }
  return messages
}
