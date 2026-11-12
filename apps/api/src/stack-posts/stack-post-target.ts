import type { StackPostKind } from "@eve/contracts"

/**
 * Pure (architecture "Target, canonical URL, kind"). The entry link and its
 * target are parsed, never requested (AC 5.1).
 */
export const CANONICAL_URL_MAX = 2048

export type StackPostTarget = Readonly<{ canonicalUrl: string; kind: StackPostKind }>

function parse(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** AC 5.1: the `url` parameter of a `https://www.google.com/url` link, else the link itself. */
function targetOf(link: string): URL | null {
  const parsed = parse(link)
  if (!parsed) return null
  if (parsed.protocol === "https:" && parsed.hostname === "www.google.com" && parsed.pathname === "/url") {
    const wrapped = parsed.searchParams.get("url")
    return wrapped ? parse(wrapped) : null
  }
  return parsed
}

/** AC 5.2, 5.3: only https LinkedIn `/posts/…` and `/pulse/…`, canonicalised to www.linkedin.com + path. */
export function stackPostTarget(link: string | null): StackPostTarget | null {
  if (!link) return null
  const target = targetOf(link.trim())
  if (!target) return null
  if (target.protocol !== "https:" || target.port !== "" || target.username !== "" || target.password !== "") return null
  const host = target.hostname
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null
  const kind: StackPostKind | null = /^\/posts\/./.test(target.pathname) ? "post" : /^\/pulse\/./.test(target.pathname) ? "article" : null
  if (!kind) return null
  const path = target.pathname.replace(/\/+$/, "")
  if (path === "/posts" || path === "/pulse") return null
  const canonicalUrl = `https://www.linkedin.com${path}`
  if (canonicalUrl.length > CANONICAL_URL_MAX) return null
  return { canonicalUrl, kind }
}
