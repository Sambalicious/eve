import { buildStackSearchGroups } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { hiringLinksPart } from "../stack-posts/stack-posts-summary.js"
import { type DailySummaryInput, type StackPostsSection, renderDailySummary } from "./email-content.js"

/**
 * EPIC-0007 Phase 3, daily-summary-hiring.feature @phase3 (AC 9.1, 9.2) r4: the "Hiring posts"
 * part and the plain-text Hiring count, gated by the summary Candidate's own record
 * (`hiringVerified`) only. Copy from copy-deck r2 (C-HP-EMAIL-*, C-HP-NOTCHECKED).
 */
const BASE = "https://dashboard.test"
const POST_1 = "https://www.linkedin.com/posts/acme_hiring-activity-7250000000000000001-aaaa"

const input = (stackPosts: StackPostsSection): DailySummaryInput => ({
  watDay: "2026-10-24",
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
  spend: null,
  stackPosts,
})

type Post = NonNullable<StackPostsSection["hiringNewPosts"]>[number]
const post = (title: string, overrides: Partial<Post> = {}): Post => ({
  title,
  kind: "post",
  canonicalUrl: POST_1,
  date: new Date("2026-10-24T08:30:00Z"),
  dateKind: "posted",
  matchedTechnologies: ["React"],
  ...overrides,
})

const STACK_POST = { title: "STACK-POST-TITLE", kind: "post" as const, canonicalUrl: "https://www.linkedin.com/posts/stack-1", date: new Date("2026-10-24T08:00:00Z"), dateKind: "posted" as const, matchedTechnologies: [] }

const section = (overrides: Partial<StackPostsSection> = {}): StackPostsSection => ({
  groups: buildStackSearchGroups(["React"], []),
  hiring: hiringLinksPart(["senior_frontend"], ["React"], [], []),
  verified: true,
  newPosts: [STACK_POST],
  newCount: 4,
  failingFeeds: [{ label: "React posts", maskedUrl: "…654321", reason: "redirected" }],
  hiringVerified: true,
  hiringNewPosts: [],
  hiringNewCount: 0,
  failingHiringFeeds: [],
  ...overrides,
})

const render = (overrides: Partial<StackPostsSection> = {}) => renderDailySummary(input(section(overrides)), BASE)
const summaryLine = (text: string) => text.replace(/\s+$/, "").split("\n").at(-1)

describe("Hiring posts part (AC 9.1)", () => {
  it("DSH:142 follows the hiring links part and the Stack posts parts", () => {
    const { text } = render({ hiringNewPosts: [post("We're hiring a frontend engineer")], hiringNewCount: 1 })
    expect(text.indexOf("Hiring search links")).toBeLessThan(text.indexOf("New Hiring posts: 1"))
    expect(text.indexOf("Failing Alert feeds")).toBeLessThan(text.indexOf("New Hiring posts: 1"))
  })

  it("DSH:150 shows title link, posted date, matched technologies and Not vetted, and no snippet", () => {
    const { text, html } = render({ hiringNewPosts: [post("We're hiring a frontend engineer")], hiringNewCount: 1 })
    expect(text).toContain("We're hiring a frontend engineer")
    expect(text).toContain("Posted 24 Oct 2026 · React · Not vetted")
    expect(html).toContain(`href="${POST_1}"`)
    expect(text).not.toContain("Not checked yet")
  })

  it("C-HP-EMAIL-POST-META: no match leaves the technologies out; a found date says Found", () => {
    const { text } = render({ hiringNewPosts: [post("A", { matchedTechnologies: [], dateKind: "found" })], hiringNewCount: 1 })
    expect(text).toContain("Found 24 Oct 2026 · Not vetted")
  })

  it.each([
    [1, 1, null],
    [10, 10, null],
    [11, 10, "1 more on the Hiring view"],
    [57, 10, "47 more on the Hiring view"],
  ])("DSH:159 %i new: lists %i, remaining line %s", (count, listed, more) => {
    const posts = Array.from({ length: listed }, (_, i) => post(`Hiring post ${i + 1}`, { canonicalUrl: `${POST_1}-${i}` }))
    const { text, html } = render({ hiringNewPosts: posts, hiringNewCount: count })
    expect(text).toContain(`New Hiring posts: ${count}`)
    expect(posts.every((item) => text.includes(item.title))).toBe(true)
    if (more === null) expect(text).not.toMatch(/more on the Hiring view/)
    else {
      expect(text).toContain(more)
      expect(html).toContain(`href="${BASE}/stack-posts?view=hiring#hiring-posts"`)
    }
  })

  it("DSH:174 with no new Hiring posts says so", () => {
    expect(render().text).toContain("No new Hiring posts.")
  })

  it("DSH:196, DSH:205 failing Hiring Alert feeds listed with name, mask and reason, in their own part", () => {
    const { text } = render({ failingHiringFeeds: [{ label: "Frontend hiring", maskedUrl: "…123456", reason: "timed_out" }, { label: null, maskedUrl: "…777888", reason: "not_a_feed" }] })
    expect(text).toContain("Failing Hiring Alert feeds")
    expect(text).toContain("Frontend hiring (…123456): Timed out")
    expect(text).toContain("Hiring Alert feed (…777888): Not a feed")
    expect(text).toContain("React posts (…654321): Redirected (not followed)")
    expect(text.indexOf("Failing Alert feeds")).toBeLessThan(text.indexOf("Failing Hiring Alert feeds"))
  })

  it("DSH:214 titles are escaped in HTML and capped as untrusted text", () => {
    const title = `<script>alert(1)</script>${"a".repeat(400)}`
    const { html, text } = render({ hiringNewPosts: [post(title)], hiringNewCount: 1 })
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;")
    expect(text).not.toContain("a".repeat(400))
    expect(text).toContain("…")
  })

  it("an empty title uses the untitled copy", () => {
    expect(render({ hiringNewPosts: [post("")], hiringNewCount: 1 }).text).toContain("Untitled LinkedIn post")
  })
})

describe("the own-record gate (AC 9.1, 9.2; DSH:222, DSH:239, DSH:267, DSH:319)", () => {
  it.each([true, false])("DSH:222 without her own record (shared record %s): no Hiring posts part and no Hiring count", (shared) => {
    const { text } = render({ verified: shared, hiringVerified: false, hiringNewPosts: [post("SHOULD-NOT-SHOW")], hiringNewCount: 2, failingHiringFeeds: [{ label: "HIDDEN", maskedUrl: "…1", reason: "timed_out" }] })
    expect(text).toContain("Hiring search links")
    expect(text).not.toMatch(/Hiring posts|SHOULD-NOT-SHOW|HIDDEN|Failing Hiring Alert feeds/)
    expect(summaryLine(text)).not.toMatch(/Hiring/)
    if (shared) expect(text).toContain("New Stack posts: 4")
    else expect(text).not.toContain("New Stack posts")
  })

  it("DSH:239 own record and no shared record: Hiring part shown, Stack posts parts left out, the Hiring count stands alone", () => {
    const { text } = render({ verified: false, hiringNewPosts: [post("A"), post("B", { canonicalUrl: `${POST_1}-b` })], hiringNewCount: 2 })
    expect(text).toContain("New Hiring posts: 2")
    expect(text).not.toContain("New Stack posts")
    expect(text).not.toContain("Failing Alert feeds")
    expect(summaryLine(text)).toBe("0 not a match, 0 failed, 0 unsure, 2 new Hiring posts.")
  })

  it.each([true, false])("DSH:267 the Stack posts parts are byte-identical with or without her own record (shared %s)", (shared) => {
    // Remove the Hiring posts part (its title through the line before the next heading or the dashboard link) and the Hiring count.
    const strip = (text: string) => text.replace(/\n+New Hiring posts: 1\n[\s\S]*?Not vetted\n/, "\n").replace(/, 1 new Hiring post\./g, ".")
    const withRecord = render({ verified: shared, hiringVerified: true, hiringNewPosts: [post("X")], hiringNewCount: 1 }).text
    const without = render({ verified: shared, hiringVerified: false }).text
    expect(withRecord).toContain("New Hiring posts: 1")
    expect(strip(withRecord)).toBe(without)
  })

  it("DSH:298 the Hiring count follows the Stack posts count as a separate count", () => {
    expect(summaryLine(render({ hiringNewCount: 12 }).text)).toBe("0 not a match, 0 failed, 0 unsure, 4 new Stack posts, 12 new Hiring posts.")
  })

  it.each([
    [0, "0 new Hiring posts"],
    [1, "1 new Hiring post"],
    [2, "2 new Hiring posts"],
  ])("DSH:306 %i gives %s", (n, count) => {
    expect(summaryLine(render({ hiringNewCount: n }).text)).toContain(`, ${count}.`)
  })

  it("DSH:319 without her own record the line ends with the Stack posts count", () => {
    expect(summaryLine(render({ hiringVerified: false, newCount: 3 }).text)).toBe("0 not a match, 0 failed, 0 unsure, 3 new Stack posts.")
  })

  it("DSH:330 a section with no Hiring record and no Hiring posts renders as before EPIC-0007 Phase 3", () => {
    // CR-P3-02: the Phase 3 fields are required; "no Hiring record" is now hiringVerified false with empty lists.
    const legacy: StackPostsSection = { groups: section().groups, hiring: section().hiring, verified: true, newPosts: [STACK_POST], newCount: 4, failingFeeds: [], hiringVerified: false, hiringNewPosts: [], hiringNewCount: 0, failingHiringFeeds: [] }
    const { text } = renderDailySummary(input(legacy), BASE)
    expect(text).not.toMatch(/Hiring posts/)
    expect(summaryLine(text)).toBe("0 not a match, 0 failed, 0 unsure, 4 new Stack posts.")
  })
})
