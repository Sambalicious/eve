import {
  ALERT_FEED_LABEL_MAX,
  STACK_POSTS_PAGE_PATTERN,
  type StackPostsFieldError,
  VERIFICATION_BASIS_MAX,
  codePointLength,
  hasDisallowedControlCharacters,
  isAlertFeedUrl,
  isCalendarDate,
} from "@eve/contracts"

/**
 * Field-level errors for the Stack posts request bodies (architecture
 * "Error codes"). Computed from the raw body, all at once, never echoing a
 * value. v1.15.1: every field rule is here, including the WAT future-date
 * check (CR-E5-01); lengths are code points after trimming (CR-E5-04); per
 * field the first of missing, invalid_characters, too_long (SEC-E5-06). An empty list means the body cannot be named by field (not an
 * object, or an unknown key): the caller sends a plain `bad_request`.
 */
type Problem = StackPostsFieldError["problem"]
const error = (field: StackPostsFieldError["field"], problem: Problem): StackPostsFieldError => ({ field, position: null, problem })

function plainObject(body: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null
  if (Object.keys(body).some((key) => !keys.includes(key))) return null
  return body as Record<string, unknown>
}

/** `today` is the WAT calendar day (`YYYY-MM-DD`) the date may not be after. */
export function verificationFieldErrors(body: unknown, today: string): StackPostsFieldError[] {
  const value = plainObject(body, ["verifiedOn", "verificationBasis"])
  if (!value) return []
  const errors: StackPostsFieldError[] = []
  const { verifiedOn, verificationBasis } = value
  if (verifiedOn === undefined || verifiedOn === null || verifiedOn === "") errors.push(error("verifiedOn", "missing"))
  else if (typeof verifiedOn !== "string" || !isCalendarDate(verifiedOn)) errors.push(error("verifiedOn", "invalid"))
  else if (verifiedOn > today) errors.push(error("verifiedOn", "future_date"))
  if (verificationBasis === undefined || verificationBasis === null) errors.push(error("verificationBasis", "missing"))
  else if (typeof verificationBasis !== "string") errors.push(error("verificationBasis", "invalid"))
  else {
    const problem = textProblem(verificationBasis, VERIFICATION_BASIS_MAX, { allowLineBreaks: true, required: true })
    if (problem) errors.push(error("verificationBasis", problem))
  }
  return errors
}

export function registrationFieldErrors(body: unknown): StackPostsFieldError[] {
  const value = plainObject(body, ["url", "label"])
  if (!value) return []
  const errors: StackPostsFieldError[] = []
  if (typeof value["url"] !== "string" || !isAlertFeedUrl(value["url"].trim())) errors.push(error("url", "invalid_format"))
  const label = value["label"]
  if (label !== undefined && label !== null) {
    if (typeof label !== "string") errors.push(error("label", "invalid"))
    else {
      const problem = textProblem(label, ALERT_FEED_LABEL_MAX, { allowLineBreaks: false, required: false })
      if (problem) errors.push(error("label", problem))
    }
  }
  return errors
}

function textProblem(raw: string, max: number, options: Readonly<{ allowLineBreaks: boolean; required: boolean }>): Problem | null {
  const text = raw.trim()
  if (options.required && text === "") return "missing"
  if (hasDisallowedControlCharacters(text, options)) return "invalid_characters"
  if (codePointLength(text) > max) return "too_long"
  return null
}

/** `?page=`: omitted means 1; otherwise digits only, no leading zero (AC 7.1). */
export function parsePage(raw: unknown): number | null {
  if (raw === undefined) return 1
  if (typeof raw !== "string" || !STACK_POSTS_PAGE_PATTERN.test(raw)) return null
  return Number(raw)
}
