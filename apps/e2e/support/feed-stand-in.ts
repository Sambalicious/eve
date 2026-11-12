import { stackState } from "./db.ts"

/**
 * Test-side client for support/feed-stand-in.mjs (EPIC-0007 Phase 3). Feeds are
 * addressed by their real Google URL; only the path reaches the stand-in.
 */
export type FeedReply =
  | Readonly<{ kind: "body"; status?: number; body: string }>
  | Readonly<{ kind: "status"; status: number }>
  | Readonly<{ kind: "redirect"; status: number; location: string }>
  | Readonly<{ kind: "hang" }>

function origin(): string {
  const value = stackState().feedStandInOrigin
  if (!value) throw new Error("No feed stand-in: set E2E_FEED_STAND_IN_ORIGIN when E2E_BASE_URL points at your own stack")
  return value
}

export async function resetFeeds(): Promise<void> {
  const response = await fetch(`${origin()}/__control/reset`, { method: "POST" })
  if (response.status !== 204) throw new Error(`feed stand-in reset failed: ${response.status}`)
}

export async function onFeed(feedUrl: string, reply: FeedReply): Promise<void> {
  const response = await fetch(`${origin()}/__control/feeds`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: new URL(feedUrl).pathname, reply }),
  })
  if (response.status !== 204) throw new Error(`feed stand-in set failed: ${response.status}`)
}

/** Requests the api made to the stand-in for `feedUrl` (by path), or to any feed when omitted. */
export async function feedRequests(feedUrl?: string): Promise<{ path: string; at: string }[]> {
  const all = (await (await fetch(`${origin()}/__control/requests`)).json()) as { path: string; at: string }[]
  return feedUrl === undefined ? all : all.filter((request) => request.path === new URL(feedUrl).pathname)
}

/** Synthetic Hiring and Stack posts Alert feed URLs (hiring-alert-feeds.feature header). Never fetched from Google. */
export const HFEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555123456"
export const HFEED_B = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555777888"
export const SFEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321"
/** The n-th extra Hiring feed URL, for the cap scenarios (distinct path per n). */
export const hiringFeedUrl = (n: number) => `https://www.google.com/alerts/feeds/02222222222222222222/${String(700000000 + n)}`
export const stackFeedUrl = (n: number) => `https://www.google.com/alerts/feeds/03333333333333333333/${String(800000000 + n)}`

export type FeedEntry = Readonly<{ title?: string; link: string; published?: string; content?: string }>

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** A Google redirect link wrapping `target`, as Google Alerts entries carry. Never requested. */
export function googleRedirect(target: string): string {
  return `https://www.google.com/url?rct=j&sa=t&url=${encodeURIComponent(target)}&ct=ga&usg=AOvVaw0`
}

/** An Atom feed in the Google Alerts shape (html-typed title and content). */
export function atomFeed(entries: readonly FeedEntry[]): string {
  const body = entries
    .map((entry, i) => {
      const parts = [
        `<id>tag:google.com,2013:googlealerts/feed:${i + 1}</id>`,
        `<title type="html">${escapeXml(entry.title ?? "")}</title>`,
        `<link href="${escapeXml(entry.link)}"/>`,
        entry.published ? `<published>${escapeXml(entry.published)}</published>` : "",
        `<content type="html">${escapeXml(entry.content ?? "")}</content>`,
      ]
      return `  <entry>${parts.join("")}</entry>`
    })
    .join("\n")
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <title>Google Alert - fixture</title>\n${body}\n</feed>\n`
}

/** hiring-posts.feature header POST_1, POST_2 and ART_1. */
export const POST_1 = "https://www.linkedin.com/posts/acme_hiring-activity-7250000000000000001-aaaa"
export const POST_2 = "https://www.linkedin.com/posts/beta_frontend-activity-7250000000000000002-bbbb"
export const ART_1 = "https://www.linkedin.com/pulse/were-hiring-frontend-engineers-ada-obi"

/** Two LinkedIn post entries behind Google redirect links. */
export function twoPostFeed(): string {
  return atomFeed([
    { title: "We're hiring a frontend engineer", link: googleRedirect(POST_1), published: "2026-10-24T08:30:00Z", content: "Remote, React and TypeScript" },
    { title: "Join our team", link: googleRedirect(POST_2), published: "2026-10-23T08:30:00Z", content: "Frontend role" },
  ])
}
