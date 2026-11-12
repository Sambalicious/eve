import type { CookieSerializeOptions } from "@fastify/cookie"

/** `__Host-` makes the browser require Secure, Path=/ and no Domain attribute. */
export const SESSION_COOKIE = "__Host-ja_session"
export const SIGN_IN_ATTEMPT_COOKIE = "__Host-ja_signin"

export const SIGN_IN_ATTEMPT_TTL_MS = 10 * 60 * 1000

const baseCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
} satisfies CookieSerializeOptions

/** No Max-Age: the server decides expiry, and the browser drops the cookie on close only if the Candidate's browser does so. */
export const sessionCookieOptions: CookieSerializeOptions = { ...baseCookieOptions }

export const signInAttemptCookieOptions: CookieSerializeOptions = {
  ...baseCookieOptions,
  maxAge: SIGN_IN_ATTEMPT_TTL_MS / 1000,
}

export const clearCookieOptions: CookieSerializeOptions = { ...baseCookieOptions }
