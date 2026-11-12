import {
  signInErrorSchema,
  signInPageQuerySchema,
  toSafeReturnPath,
  type SignInError,
} from "@eve/contracts"

/** What the sign-in card tells the Candidate before they try again. */
export type SignInNotice =
  | { kind: "failed" }
  | { kind: "expired" }
  | { kind: "refused"; email: string | null }

export interface SignInQuery {
  /** Safe dashboard path to return to after sign-in. */
  next: string
  notice: SignInNotice | null
}

const reasonSchema = signInPageQuerySchema.shape.reason

/**
 * Reads the sign-in page's query string. Each parameter is parsed on its own,
 * so one unknown value does not discard the others. A backend `error` wins
 * over the app's `reason=expired`, because it describes the latest attempt.
 */
export function parseSignInQuery(params: URLSearchParams): SignInQuery {
  return {
    next: toSafeReturnPath(params.get("next")),
    notice: readNotice(params),
  }
}

function readNotice(params: URLSearchParams): SignInNotice | null {
  const error = signInErrorSchema.safeParse(params.get("error"))
  if (error.success) return noticeForError(error.data, params.get("email"))
  const reason = reasonSchema.safeParse(params.get("reason") ?? undefined)
  if (reason.success && reason.data === "expired") return { kind: "expired" }
  return null
}

function noticeForError(error: SignInError, email: string | null): SignInNotice {
  switch (error) {
    case "cancelled":
    case "failed":
      return { kind: "failed" }
    case "account_refused":
      return { kind: "refused", email: email?.trim() || null }
    default: {
      const exhaustive: never = error
      return exhaustive
    }
  }
}
