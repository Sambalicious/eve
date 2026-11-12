import { z } from "zod"

/** Full-page navigation target that starts Google sign-in. Accepts `?next=`. */
export const SIGN_IN_START_PATH = "/v1/auth/google/start"
/** Redirect URI registered with Google. The browser never calls it directly. */
export const SIGN_IN_CALLBACK_PATH = "/v1/auth/google/callback"
export const LOGOUT_PATH = "/v1/auth/logout"
export const SESSION_PATH = "/v1/session"
export const HEALTH_PATH = "/v1/health"

export const SIGN_IN_PAGE_PATH = "/sign-in"
export const DEFAULT_RETURN_PATH = "/dashboard"

/**
 * Why the backend sent the browser back to the sign-in page.
 * `cancelled` and `failed` map to C-AUTH-1, `account_refused` to C-AUTH-3.
 */
export const signInErrorSchema = z.enum(["cancelled", "failed", "account_refused"])
export type SignInError = z.infer<typeof signInErrorSchema>

/**
 * Query parameters the sign-in page understands. The backend sets `error`,
 * `email` (only with `account_refused`) and `next`. The web app sets
 * `reason=expired` itself when an API call returns `session_expired`.
 */
export const signInPageQuerySchema = z.object({
  next: z.string().optional(),
  error: signInErrorSchema.optional(),
  email: z.string().optional(),
  reason: z.literal("expired").optional(),
})
export type SignInPageQuery = z.infer<typeof signInPageQuerySchema>
