import { DEFAULT_RETURN_PATH, SIGN_IN_PAGE_PATH } from "./auth.js"

const MAX_RETURN_PATH_LENGTH = 2048
const PLACEHOLDER_ORIGIN = "https://return-path.invalid"
const DEL = 0x7f
const FIRST_PRINTABLE = 0x20

/**
 * Returns a same-origin dashboard path (path, query, and hash) to send the
 * Candidate to after sign-in, or `/dashboard` when `candidate` is missing,
 * absolute, protocol-relative, an API path, the sign-in page, or malformed.
 */
export function toSafeReturnPath(candidate: unknown): string {
  if (typeof candidate !== "string") return DEFAULT_RETURN_PATH
  if (!isSyntacticallySafe(candidate)) return DEFAULT_RETURN_PATH

  const normalised = normaliseOnPlaceholderOrigin(candidate)
  if (normalised === undefined) return DEFAULT_RETURN_PATH
  // URL parsing collapses dot segments ("/.//x", "/%2e%2e//x") after the raw
  // checks ran, so the result must pass the same rules again and resolve to itself.
  if (!isSyntacticallySafe(normalised)) return DEFAULT_RETURN_PATH
  if (normaliseOnPlaceholderOrigin(normalised) !== normalised) return DEFAULT_RETURN_PATH

  return normalised
}

/** Path, query, and hash of `path` resolved on a fixed origin, or undefined if it leaves that origin or is not a dashboard path. */
function normaliseOnPlaceholderOrigin(path: string): string | undefined {
  const resolved = new URL(path, PLACEHOLDER_ORIGIN)
  if (resolved.origin !== PLACEHOLDER_ORIGIN) return undefined
  if (!isDashboardPath(resolved.pathname)) return undefined
  return `${resolved.pathname}${resolved.search}${resolved.hash}`
}

function isSyntacticallySafe(candidate: string): boolean {
  return (
    candidate.length > 0 &&
    candidate.length <= MAX_RETURN_PATH_LENGTH &&
    candidate.startsWith("/") &&
    !candidate.startsWith("//") &&
    !hasUnsafeCharacter(candidate)
  )
}

/** C0 controls and DEL are stripped by URL parsers; browsers read "\\" as "/". */
function hasUnsafeCharacter(candidate: string): boolean {
  for (const character of candidate) {
    const code = character.charCodeAt(0)
    if (code < FIRST_PRINTABLE || code === DEL || character === "\\") return true
  }
  return false
}

/**
 * Fastify routes percent-encoded paths to the decoded route (CR-01: "/%76%31/session"
 * reaches /v1/session), so the rule applies to the decoded pathname. A malformed
 * escape is refused rather than guessed at.
 */
function isDashboardPath(encodedPathname: string): boolean {
  const pathname = decodePathname(encodedPathname)
  if (pathname === undefined) return false
  const isApi = pathname === "/v1" || pathname.startsWith("/v1/")
  const isSignIn =
    pathname === SIGN_IN_PAGE_PATH || pathname.startsWith(`${SIGN_IN_PAGE_PATH}/`)
  return !isApi && !isSignIn
}

function decodePathname(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return undefined
  }
}
