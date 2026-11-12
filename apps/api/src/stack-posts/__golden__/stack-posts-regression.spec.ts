import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { STACK_POSTS_SNAPSHOT_FILE, buildStackPostsSnapshot } from "./stack-posts-regression.js"

const SNAPSHOT = fileURLToPath(new URL(STACK_POSTS_SNAPSHOT_FILE, import.meta.url))

type Post = Readonly<{ canonicalUrl: string; kind: string; title: string; snippet: string; publishedAt: string | null; matchedTechnologies: string[] }>
type Group = Readonly<{ label: string; alertsPostsQuery: string; alertsArticlesQuery: string; linkedin: string; googlePosts: string; googleArticles: string }>
type Section = Readonly<{ text: string; html: string; preheader: string }>
type Snapshot = Readonly<{
  capturedOn: string
  criteria: unknown
  posts: Post[]
  searchGroups: Group[]
  dailySummary: Readonly<{ verified: Section; unverified: Section; noCriteria: Section }>
}>

function snapshot(): Snapshot {
  return JSON.parse(buildStackPostsSnapshot()) as Snapshot
}

describe("owner Stack posts golden (EPIC-0002 A0 item 9, r5; r5-new-tables-isolation.feature @slice-A0 @ac-6.3)", () => {
  it("uses criteria set 2's lists", () => {
    expect(snapshot().criteria).toEqual({ frameworks: ["React"], technologies: ["TypeScript"] })
  })

  // Expected values worked out from the fixture and EPIC-0005 AC 5.1-5.7, not from the code.
  it("keeps LinkedIn posts and articles only, the first entry per canonical URL, canonicalised", () => {
    expect(snapshot().posts.map((post) => [post.canonicalUrl, post.kind])).toEqual([
      ["https://www.linkedin.com/posts/ada-obi_react-activity-7254-abcd", "post"],
      ["https://www.linkedin.com/pulse/ts-at-scale-chidi-eze", "article"],
      ["https://www.linkedin.com/posts/kofi-mensah_vue-activity-7255-efgh", "post"],
      ["https://www.linkedin.com/pulse/typed-react-hooks-wanjiru-k", "article"],
    ])
  })

  it("records plain-text title and snippet, dates and matched technologies through the alias table", () => {
    const [first, second, third, fourth] = snapshot().posts
    expect(first).toMatchObject({ title: "Why we moved to React Server Components", publishedAt: "2026-10-21T06:12:00.000Z", matchedTechnologies: ["React", "TypeScript"] })
    expect(first?.snippet).not.toContain("<")
    expect(second).toMatchObject({ title: "TS at scale", matchedTechnologies: ["React", "TypeScript"] })
    expect(third).toMatchObject({ title: "", publishedAt: "2026-10-19T12:00:00.000Z", matchedTechnologies: [] })
    expect(fourth).toMatchObject({ publishedAt: null, matchedTechnologies: ["React", "TypeScript"] })
  })

  it("records the search links and the Alerts query strings built from the criteria", () => {
    const [group, ...rest] = snapshot().searchGroups
    expect(rest).toEqual([])
    expect(group).toMatchObject({
      label: "React, TypeScript",
      alertsPostsQuery: 'site:linkedin.com/posts ("React" OR "TypeScript") -hiring -job',
      alertsArticlesQuery: 'site:linkedin.com/pulse ("React" OR "TypeScript") -hiring -job',
    })
    expect(group?.linkedin.startsWith("https://www.linkedin.com/search/results/content/?keywords=")).toBe(true)
    expect(group?.googlePosts.startsWith("https://www.google.com/search?q=")).toBe(true)
  })

  it("records the rendered daily-summary Stack posts section", () => {
    const { verified, unverified, noCriteria } = snapshot().dailySummary
    expect(verified.text.startsWith("Stack posts\n")).toBe(true)
    expect(verified.text).toContain("New Stack posts: 4")
    expect(verified.text).toContain("Untitled LinkedIn post")
    expect(verified.text).toContain("Failing Alert feeds")
    expect(verified.html.startsWith("<h2")).toBe(true)
    expect(verified.preheader).toContain("4 new Stack posts")
    expect(unverified.text).not.toContain("New Stack posts")
    expect(noCriteria.text).toContain("Both lists are empty.")
  })

  it("the snapshot header names the base commit it was captured on", () => {
    expect(snapshot().capturedOn).toMatch(/^main [0-9a-f]{7}\b/)
  })

  it("is byte-equal to the committed snapshot", () => {
    const current = buildStackPostsSnapshot()
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(SNAPSHOT, current)
    expect(current).toBe(readFileSync(SNAPSHOT, "utf8"))
  })
})
