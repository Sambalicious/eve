import { ApiException } from "../http/api-exception.js"

/**
 * Threat model P3-12c (EPIC-0007), SEC-E8-02 and SEC-E8-02b (EPIC-0008): the write bodies are JSON only
 * (both verification PUTs and both feed registration POSTs). Session and CSRF guards run first.
 * The Fastify adapter also parses form encodings, which a cross-site form can send; such a
 * body is refused as a plain 400 before validation, with no write.
 */
export function requireJson(contentType: string | undefined): void {
  if (!/^application\/json\s*(;|$)/i.test(contentType ?? "")) throw new ApiException("bad_request")
}
