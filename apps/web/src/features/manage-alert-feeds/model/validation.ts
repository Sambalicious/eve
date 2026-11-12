import {
  ALERT_FEED_LABEL_MAX,
  ALERT_FEED_LIMIT,
  codePointLength,
  hasDisallowedControlCharacters,
  isAlertFeedUrl,
  isCalendarDate,
  VERIFICATION_BASIS_MAX,
} from "@eve/contracts"

import { stackPostsCopy as c } from "@/entities/stack-post"
import { HIRING_ALERT_FEED_LIMIT } from "@/shared/lib/hiring-contracts"
import { FEED_LIST_COPY, type FeedList } from "./feed-list"
import type { FeedFieldMessages, VerificationFieldMessages } from "./write-failure"

/** Today in WAT (UTC+1, no DST) as `YYYY-MM-DD`: the date input's default and `max`. */
export function todayWat(now: Date = new Date()): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * Verification dialog checks on submit (design-spec F3 step 4). Mirrors the
 * server rules of api-contract v1.15.2 (invalid characters include C1, bidi,
 * U+200B, U+2060 and U+FEFF through the shared helper): every failing field is reported at
 * once, and per field the first of missing, invalid characters, too long.
 * Lengths are code points after trimming. The server still decides.
 */
export function checkVerification(input: { date: string; basis: string }, now: Date = new Date()): VerificationFieldMessages {
  const errors: VerificationFieldMessages = {}
  if (!isCalendarDate(input.date)) errors.date = c.verifyDateErr
  else if (input.date > todayWat(now)) errors.date = c.verifyDateFuture
  const basis = input.basis.trim()
  if (basis === "") errors.basis = c.verifyBasisErr
  else if (hasDisallowedControlCharacters(basis, { allowLineBreaks: true })) errors.basis = c.verifyBasisErrChars
  else if (codePointLength(basis) > VERIFICATION_BASIS_MAX) errors.basis = c.verifyBasisLong
  return errors
}

/**
 * Registration checks on submit (design-spec F4 step 3): the 10-feed limit,
 * then the URL pattern, then the label (invalid characters before too long,
 * both in code points after trimming). A duplicate needs the stored URL, which
 * the page never holds after registration (D-E5-5), so only the server checks
 * it. The form is never disabled at 10, so the limit line stays reachable.
 * Each list has its own limit of 10 and its own limit line (EPIC-0007 D5).
 */
export function checkFeedForm(
  input: { url: string; label: string },
  existingCount: number,
  list: FeedList = "stack"
): FeedFieldMessages {
  const errors: FeedFieldMessages = {}
  const limit = list === "hiring" ? HIRING_ALERT_FEED_LIMIT : ALERT_FEED_LIMIT
  if (existingCount >= limit) errors.url = FEED_LIST_COPY[list].errLimit
  else if (!isAlertFeedUrl(input.url.trim())) errors.url = c.feedUrlErrFormat
  const label = input.label.trim()
  if (hasDisallowedControlCharacters(label, { allowLineBreaks: false })) errors.label = c.feedLabelErrChars
  else if (codePointLength(label) > ALERT_FEED_LABEL_MAX) errors.label = c.feedLabelErrLong
  return errors
}
