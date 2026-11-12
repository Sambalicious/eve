import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { buildStackSearchGroups, maskAlertFeedUrl } from "@eve/contracts"

import { type DailySummaryInput, type StackPostsSection, renderDailySummary } from "../../notification/email-content.js"
import { parseAlertFeed } from "../alert-feed-parser.js"
import { type CandidateStackPost, toStackPosts } from "../stack-post-builder.js"

/**
 * EPIC-0002 A0 item 9 (r5 "Should A0 cover job criteria and Stack posts?"):
 * the owner's Stack posts output, pure code only (no database, no AI call, no
 * request). The checked-in Atom fixture is parsed and built with criteria set
 * 2; the search groups come from the same lists; the daily summary's Stack
 * posts section is rendered from those posts. A1, B and F rerun it.
 */
export const STACK_POSTS_SNAPSHOT_FILE = "stack-posts.snap.json"
export const STACK_POSTS_FIXTURE_FILE = "owner-alerts.atom.xml"

/** The commit the snapshot was captured on: main before A1, then proved equal on the candidate. */
export const STACK_POSTS_SNAPSHOT_BASE = "main 86637ae (pre-A1), proved on epic-0002/a0-gap"

/** Criteria set 2 (the same values as the owner Job criteria golden): only the lists matter here. */
export const STACK_CRITERIA = Object.freeze({ frameworks: Object.freeze(["React"]), technologies: Object.freeze(["TypeScript"]) })

/** The build time `toStackPosts` judges dates against (AC 5.7), and the stored first-seen time of every post. */
const NOW = new Date("2026-10-21T07:00:00.000Z")
const FIRST_SEEN = NOW
const BASE_URL = "https://dashboard.test"
const FAILING_FEED = "https://www.google.com/alerts/feeds/11111111111111111111/2222222222222333"

/** Every other daily-summary part empty and fixed, so only the Stack posts section varies. */
const SUMMARY: DailySummaryInput = {
  watDay: "2026-10-21",
  automaticToday: 0,
  submitted: [],
  blockedCount: 0,
  uncertainCount: 0,
  uncertain: [],
  failures: [],
  skipped: [],
  globalPaused: false,
  costPaused: false,
  costResumedToday: false,
  spend: { spentMicros: 1_000_000, ceilingMicros: 50_000_000 },
}

export function readStackPostsFixture(): string {
  return readFileSync(fileURLToPath(new URL(STACK_POSTS_FIXTURE_FILE, import.meta.url)), "utf8")
}

/**
 * The section the summary reader would return for these posts: newest first by
 * `coalesce(published_at, first_seen_at)`, then first seen, then canonical URL
 * as the stand-in for the row ID (`StackPostsSummaryReader`).
 */
function sectionFor(posts: readonly CandidateStackPost[], groups: StackPostsSection["groups"], verified: boolean): StackPostsSection {
  const newPosts = posts
    .map((post) => ({
      title: post.title,
      kind: post.kind,
      canonicalUrl: post.canonicalUrl,
      date: post.publishedAt ?? FIRST_SEEN,
      dateKind: post.publishedAt ? ("posted" as const) : ("found" as const),
      matchedTechnologies: post.matchedTechnologies,
    }))
    .sort((a, b) => b.date.getTime() - a.date.getTime() || b.canonicalUrl.localeCompare(a.canonicalUrl))
  return {
    groups,
    verified,
    newPosts: verified ? newPosts : [],
    newCount: verified ? newPosts.length : 0,
    failingFeeds: verified ? [{ label: null, maskedUrl: maskAlertFeedUrl(FAILING_FEED), reason: "timed_out" }] : [],
    // EPIC-0007 Phase 3 (CR-P3-02): no Hiring record, so no Hiring part; the recorded EPIC-0005 output is unchanged.
    hiringVerified: false,
    hiringNewPosts: [],
    hiringNewCount: 0,
    failingHiringFeeds: [],
  }
}

/** The Stack posts section of the rendered summary: text from its heading to "Spend", HTML from its h2 to the next h2. */
function renderedSection(section: StackPostsSection): Readonly<{ text: string; html: string; preheader: string }> {
  const email = renderDailySummary({ ...SUMMARY, stackPosts: section }, BASE_URL)
  const text = email.text.slice(email.text.indexOf("\n\nStack posts\n") + 2, email.text.indexOf("\n\nSpend\n"))
  const html = email.html ?? ""
  const start = html.indexOf(">Stack posts</h2>")
  const htmlSection = html.slice(html.lastIndexOf("<h2", start), html.indexOf("<h2", start))
  return { text, html: htmlSection, preheader: email.preheader }
}

/** Returned as the exact file text, so the spec compares bytes. */
export function buildStackPostsSnapshot(): string {
  const posts = toStackPosts(parseAlertFeed(readStackPostsFixture()), STACK_CRITERIA, NOW)
  const groups = buildStackSearchGroups(STACK_CRITERIA.frameworks, STACK_CRITERIA.technologies)
  const snapshot = {
    note: "EPIC-0002 A0 item 9 owner Stack posts golden (r5). Regenerate only in its own commit with a reason.",
    capturedOn: STACK_POSTS_SNAPSHOT_BASE,
    fixture: STACK_POSTS_FIXTURE_FILE,
    criteria: STACK_CRITERIA,
    now: NOW.toISOString(),
    posts: posts.map((post) => ({
      canonicalUrl: post.canonicalUrl,
      kind: post.kind,
      title: post.title,
      snippet: post.snippet,
      publishedAt: post.publishedAt?.toISOString() ?? null,
      matchedTechnologies: post.matchedTechnologies,
    })),
    searchGroups: groups,
    dailySummary: {
      verified: renderedSection(sectionFor(posts, groups, true)),
      unverified: renderedSection(sectionFor(posts, groups, false)),
      noCriteria: renderedSection(sectionFor(posts, buildStackSearchGroups([], []), true)),
    },
  }
  return `${JSON.stringify(snapshot, null, 2)}\n`
}
