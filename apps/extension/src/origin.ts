/**
 * The one address the extension will talk to. The Eve session and CSRF token
 * cross this origin, so it must be TLS: plain http is allowed only for a
 * loopback address a developer runs on their own machine.
 */

export type EveOriginResult = Readonly<{ ok: true; origin: string }> | Readonly<{ ok: false; reason: "invalid" | "insecure" }>

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"])

/** Parses the Candidate's Eve address, or says why it is refused. */
export function eveOriginOf(raw: string): EveOriginResult {
  const trimmed = raw.trim()
  if (trimmed === "") return { ok: false, reason: "invalid" }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: "invalid" }
  }
  // A credential in the address would be stored and shown; Eve never needs one.
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "invalid" }
  if (url.protocol === "https:") return { ok: true, origin: url.origin }
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return { ok: true, origin: url.origin }
  return { ok: false, reason: "insecure" }
}
