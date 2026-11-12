import { landingCopy } from "./copy"

const m = landingCopy.meta

/** The committed `public/og-image.png` (scripts/og-image/generate.mjs). */
export const OG_IMAGE = { width: 1200, height: 630, type: "image/png" } as const

export interface HeadTag {
  tag: "meta" | "link"
  attrs: Record<string, string>
}

/** A valid `https://` origin with no path, or null (architecture r0 section 5 step 3). */
export function parsePublicOrigin(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/, "")) return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Head tags for the prerendered `/` and `/about` (AC 9.1, 9.2). Canonical,
 * `og:url`, `og:image` (with its width, height and type) and `twitter:image`
 * appear only with a valid origin (design-spec.r3-og.md "Emission"), so they
 * never point at a placeholder; `/about` is canonical to `/`.
 */
export function landingHead(path: "/" | "/about", publicOrigin: string | undefined): { title: string; tags: HeadTag[] } {
  const meta = (attrs: Record<string, string>): HeadTag => ({ tag: "meta", attrs })
  const tags: HeadTag[] = [
    meta({ name: "description", content: m.description }),
    meta({ property: "og:title", content: m.ogTitle }),
    meta({ property: "og:description", content: m.ogDescription }),
    meta({ property: "og:type", content: "website" }),
    meta({ property: "og:image:alt", content: m.ogImageAlt }),
    meta({ name: "twitter:card", content: "summary_large_image" }),
    meta({ name: "twitter:title", content: m.ogTitle }),
    meta({ name: "twitter:description", content: m.ogDescription }),
    meta({ name: "twitter:image:alt", content: m.ogImageAlt }),
  ]
  const origin = parsePublicOrigin(publicOrigin)
  if (origin) {
    tags.push(
      { tag: "link", attrs: { rel: "canonical", href: `${origin}/` } },
      meta({ property: "og:url", content: `${origin}${path === "/about" ? "/about" : "/"}` }),
      meta({ property: "og:image", content: `${origin}/og-image.png` }),
      meta({ property: "og:image:width", content: String(OG_IMAGE.width) }),
      meta({ property: "og:image:height", content: String(OG_IMAGE.height) }),
      meta({ property: "og:image:type", content: OG_IMAGE.type }),
      meta({ name: "twitter:image", content: `${origin}/og-image.png` })
    )
  }
  return { title: m.title, tags }
}
