/**
 * True when the trimmed link's host is linkedin.com or a subdomain of it
 * (design-spec r1 H4 step 3b, AC 5.5). Client-side only: the API stores such a
 * link as any other unsupported host (D7). Lookalikes such as
 * `linkedin.com.evil.example` or a path or query naming LinkedIn do not match.
 */
export function isLinkedInHost(input: string): boolean {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return false
  }
  // URL lowercases the host; a trailing root dot names the same host.
  const host = url.hostname.replace(/\.$/, "")
  return host === "linkedin.com" || host.endsWith(".linkedin.com")
}
