import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** Synthetic Google Alerts feeds for tests. No real alert, person or post; never fetched from Google. */
export const FEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321"
export const FEED_A_DIGITS = "01234567890123456789/9876543210987654321"
export const FEED_B = "https://www.google.com/alerts/feeds/11111111111111111111/2222222222222333"

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/alert-feeds/${name}`, import.meta.url)), "utf8")
}

export type FixtureEntry = {
  title?: string
  /** Raw XML-escaped content is produced from this text. */
  titleHtml?: boolean
  link?: string | null
  published?: string | null
  updated?: string | null
  content?: string
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** An Atom feed in the Google Alerts shape. Titles and content are `type="html"` like Google's. */
export function atomFeed(entries: readonly FixtureEntry[]): string {
  const body = entries
    .map((entry, index) => {
      const parts = [`<id>tag:google.com,2013:googlealerts/feed:${index + 1}</id>`]
      parts.push(`<title type="html">${escapeXml(entry.title ?? "")}</title>`)
      if (entry.link !== null) parts.push(`<link href="${escapeXml(entry.link ?? `https://www.linkedin.com/posts/fixture_${index + 1}`)}"/>`)
      if (entry.published) parts.push(`<published>${escapeXml(entry.published)}</published>`)
      if (entry.updated) parts.push(`<updated>${escapeXml(entry.updated)}</updated>`)
      parts.push(`<content type="html">${escapeXml(entry.content ?? "")}</content>`)
      parts.push("<author><name/></author>")
      return `  <entry>${parts.join("")}</entry>`
    })
    .join("\n")
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <title>Google Alert - fixture</title>\n${body}\n</feed>\n`
}

/** A Google redirect link wrapping `target`, as Google Alerts entries carry. */
export function googleRedirect(target: string): string {
  return `https://www.google.com/url?rct=j&sa=t&url=${encodeURIComponent(target)}&ct=ga&usg=AOvVaw0`
}

/** A valid Atom feed of exactly `bytes` UTF-8 bytes (padding in an XML comment). */
export function atomFeedOfBytes(bytes: number): string {
  const base = atomFeed([{ title: "Padded", link: "https://www.linkedin.com/posts/padded-1" }])
  const overhead = Buffer.byteLength(base) + "<!--".length + "-->".length
  return base + `<!--${"x".repeat(bytes - overhead)}-->`
}
