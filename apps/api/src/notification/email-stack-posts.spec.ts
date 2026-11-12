import { buildStackSearchGroups } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { type Block, type DailySummaryInput, type StackPostsSection, renderDailySummary, renderEmail } from "./email-content.js"

/** EPIC-0005 daily-summary.feature: the "Stack posts" section (AC 8.1-8.5, 1.4, 7.4). */
const BASE = "https://dashboard.test"

const base = (overrides: Partial<DailySummaryInput> = {}): DailySummaryInput => ({
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
  ...overrides,
})

const post = (title: string, overrides: Partial<StackPostsSection["newPosts"][number]> = {}): StackPostsSection["newPosts"][number] => ({
  title,
  kind: "post",
  canonicalUrl: `https://www.linkedin.com/posts/${encodeURIComponent(title.replace(/\s+/g, "-"))}`,
  date: new Date("2026-10-21T06:00:00Z"),
  dateKind: "posted",
  matchedTechnologies: ["React"],
  ...overrides,
})

const section = (overrides: Partial<StackPostsSection> = {}): StackPostsSection => ({
  groups: buildStackSearchGroups(["React"], []),
  verified: true,
  newPosts: [],
  newCount: 0,
  failingFeeds: [],
  hiringVerified: false,
  hiringNewPosts: [],
  hiringNewCount: 0,
  failingHiringFeeds: [],
  ...overrides,
})

const render = (stackPosts: StackPostsSection, overrides: Partial<DailySummaryInput> = {}) => renderDailySummary(base({ ...overrides, stackPosts }), BASE)

describe("Stack posts section placement (AC 8.1, 9.3)", () => {
  it("sits after Not a match and immediately before Spend", () => {
    const { text } = render(section())
    const headings = ["Submitted", "Needs you", "Unsure sends", "Failures", "Not a match", "Stack posts", "Spend"]
    const positions = headings.map((heading) => text.indexOf(`\n${heading}\n`) >= 0 ? text.indexOf(`\n${heading}\n`) : text.indexOf(`${heading}\n`))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it("leaves every earlier section unchanged", () => {
    const input = base({ submitted: [{ role: "Engineer", company: "Acme", requisitionId: "R-1" }], automaticToday: 1 })
    const without = renderDailySummary(input, BASE).text
    const withSection = renderDailySummary({ ...input, stackPosts: section({ newPosts: [post("Hooks")], newCount: 1 }) }, BASE).text
    const before = (text: string, marker: string) => text.slice(0, text.indexOf(marker))
    expect(before(withSection, "Stack posts")).toBe(before(without, "Spend"))
  })
})

describe("search links (AC 8.2, 2.8)", () => {
  it("lists each group's LinkedIn, Google posts and Google articles links, equal to the page's", () => {
    const groups = buildStackSearchGroups(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9"], [])
    const { text, html } = render(section({ groups }))
    expect(text).toContain("F1, F2, F3, F4, F5, F6, F7, F8\nLinkedIn posts: " + groups[0]!.linkedin + "\nGoogle posts: " + groups[0]!.googlePosts + "\nGoogle articles: " + groups[0]!.googleArticles)
    expect(text).toContain("F9\nLinkedIn posts: " + groups[1]!.linkedin)
    expect(text.indexOf("F1, F2")).toBeLessThan(text.indexOf("\nF9\n"))
    expect(html).toContain("Past-week searches from your job criteria. Some results will still be hiring posts or job ads.")
  })

  it("carries all 15 links at 40 terms", () => {
    const groups = buildStackSearchGroups(Array.from({ length: 20 }, (_, i) => `F${i}`), Array.from({ length: 20 }, (_, i) => `T${i}`))
    const { text } = render(section({ groups }))
    expect(text.match(/^LinkedIn posts: /gm)).toHaveLength(5)
    expect(text.match(/^Google posts: /gm)).toHaveLength(5)
    expect(text.match(/^Google articles: /gm)).toHaveLength(5)
  })

  it("opens every LinkedIn and Google link in a new tab without opener or referrer (AC 1.4)", () => {
    // EPIC-0003 made RenderedEmail.html optional (text-only Operator emails); the daily summary always has it.
    const html = render(section({ newPosts: [post("Hooks")], newCount: 1 })).html ?? ""
    const anchors = html.match(/<a [^>]*href="https:\/\/www\.(linkedin|google)\.com[^"]*"[^>]*>/g) ?? []
    expect(anchors.length).toBe(4)
    for (const anchor of anchors) expect(anchor).toContain('target="_blank" rel="noopener noreferrer"')
  })

  it("explains empty criteria with a link to Settings instead of links", () => {
    const { text } = render(section({ groups: [] }))
    expect(text).toContain("Search links need Frameworks or Technologies in your job criteria. Both lists are empty.\n\nAdd job criteria: https://dashboard.test/settings#job-criteria")
    expect(text).not.toContain("LinkedIn posts:")
  })

  it("with empty criteria and no verification holds only the explanation", () => {
    const { text } = render(section({ groups: [], verified: false }))
    const part = text.slice(text.indexOf("Stack posts\n"), text.indexOf("Spend\n"))
    expect(part.trim()).toBe("Stack posts\n\nSearch links need Frameworks or Technologies in your job criteria. Both lists are empty.\n\nAdd job criteria: https://dashboard.test/settings#job-criteria")
  })
})

describe("new posts (AC 8.2-8.5, D-E5-4)", () => {
  it("lists title link, date and technologies, but never the snippet", () => {
    const { text, html } = render(section({ newPosts: [post("Hooks in practice", { matchedTechnologies: ["React", "TypeScript"], date: new Date("2026-10-20T09:00:00Z") })], newCount: 1 }))
    expect(text).toContain("New Stack posts: 1\n\nHooks in practice: https://www.linkedin.com/posts/Hooks-in-practice\nPosted 20 Oct 2026 · React, TypeScript")
    expect(html).toContain(">Hooks in practice</a><br>Posted 20 Oct 2026 · React, TypeScript")
  })

  it("says Found for a post without a feed date and shows only the date without matches", () => {
    const { text } = render(section({ newPosts: [post("Undated", { dateKind: "found", matchedTechnologies: [] })], newCount: 1 }))
    expect(text).toContain("Undated: https://www.linkedin.com/posts/Undated\nFound 21 Oct 2026\n")
  })

  it.each([
    [1, null],
    [9, null],
    [10, null],
    [11, "1 more on your Stack posts page: https://dashboard.test/stack-posts"],
    [57, "47 more on your Stack posts page: https://dashboard.test/stack-posts"],
  ])("%d new posts: 10 at most, remaining line %j", (count, more) => {
    const newPosts = Array.from({ length: Math.min(count, 10) }, (_, i) => post(`Post ${i}`))
    const { text, preheader } = render(section({ newPosts, newCount: count }))
    expect(text.match(/^Posted /gm)).toHaveLength(Math.min(count, 10))
    if (more) expect(text).toContain(more)
    else expect(text).not.toContain("more on your Stack posts page")
    expect(preheader).toBe(`0 not a match, 0 failed, 0 unsure, ${count === 1 ? "1 new Stack post" : `${count} new Stack posts`}.`)
  })

  it("says so when nothing is new", () => {
    expect(render(section()).text).toContain("No new Stack posts.")
  })

  it("orders links, new posts, remaining count, failing feeds", () => {
    const newPosts = Array.from({ length: 10 }, (_, i) => post(`Post ${i}`))
    const { text } = render(section({ newPosts, newCount: 12, failingFeeds: [{ label: "React posts", maskedUrl: "…482913", reason: "not_a_feed" }] }))
    const order = ["LinkedIn posts:", "New Stack posts: 12", "2 more on your Stack posts page", "Failing Alert feeds", "React posts (…482913): Not a feed"].map((marker) => text.indexOf(marker))
    expect(order.every((position) => position >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it("leaves out posts, failures and the count without a verification (AC 8.3)", () => {
    const { text, preheader } = render(section({ verified: false, newPosts: [post("x")], newCount: 1, failingFeeds: [{ label: null, maskedUrl: "…654321", reason: "timed_out" }] }))
    expect(text).toContain("LinkedIn posts:")
    expect(text).not.toMatch(/New Stack posts|No new Stack posts\.|Failing Alert feeds/)
    expect(preheader).toBe("0 not a match, 0 failed, 0 unsure.")
  })

  it.each([
    ["<script>alert(1)</script>React", "&lt;script&gt;alert(1)&lt;/script&gt;React"],
    [`Tom & Jerry's "React" tips`, "Tom &amp; Jerry&#39;s &quot;React&quot; tips"],
    ["<img src=x onerror=alert(1)>", "&lt;img src=x onerror=alert(1)&gt;"],
  ])("escapes the title %j as text", (title, escaped) => {
    const { html } = render(section({ newPosts: [post(title)], newCount: 1 }))
    expect(html).toContain(`>${escaped}</a>`)
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
  })

  it("caps a long title in both parts the way untrusted() caps role and company", () => {
    const { text, html } = render(section({ newPosts: [post("a".repeat(300), { canonicalUrl: "https://www.linkedin.com/posts/long-1" })], newCount: 1 }))
    expect(text).toContain(`${"a".repeat(119)}…:`)
    expect(text).not.toContain("a".repeat(120))
    expect(html).not.toContain("a".repeat(120))
  })

  it("names an untitled post (copy C-SP-UNTITLED-POST)", () => {
    expect(render(section({ newPosts: [post("")], newCount: 1 })).text).toContain("Untitled LinkedIn post: https://www.linkedin.com/posts/")
  })
})

describe("failing feeds (AC 8.2, 7.4)", () => {
  it("lists each failing feed by name and mask with its reason phrase, never the URL", () => {
    const { text, html } = render(section({ failingFeeds: [{ label: null, maskedUrl: "…654321", reason: "not_reachable" }, { label: "React posts", maskedUrl: "…482913", reason: "timed_out" }] }))
    expect(text).toContain("Failing Alert feeds\n\nAlert feed (…654321): Not reachable\nReact posts (…482913): Timed out")
    expect(text + html).not.toContain("alerts/feeds")
  })

  it("shows nothing about failures when no feed is failing", () => {
    expect(render(section()).text).not.toContain("Failing Alert feeds")
  })
})

// daily-summary.feature r3 (D-E5-14, AC 8.5): C-SP-EMAIL-TEXT-SUMMARY ends the text/plain part.
describe("plain-text summary line at the end (D-E5-14, AC 8.5)", () => {
  const counts = { skipped: [1, 2, 3].map((n) => ({ role: `R${n}`, company: "C", reason: "x", manualPossible: false })), uncertain: [{ role: "U", company: "C", submittedAt: new Date("2026-10-21T08:00:00Z"), captchaAfterSubmit: false }] }

  it.each([
    [true, 14, "3 not a match, 0 failed, 1 unsure, 14 new Stack posts."],
    [true, 1, "3 not a match, 0 failed, 1 unsure, 1 new Stack post."],
    [true, 0, "3 not a match, 0 failed, 1 unsure, 0 new Stack posts."],
    [true, 57, "3 not a match, 0 failed, 1 unsure, 57 new Stack posts."],
    [false, 4, "3 not a match, 0 failed, 1 unsure."],
  ])("verified %s, %d new: the text part ends with %j", (verified, newCount, line) => {
    const newPosts = Array.from({ length: Math.min(newCount, 10) }, (_, i) => post(`P${i}`))
    const email = renderDailySummary(base({ ...counts, uncertainCount: 1, stackPosts: section({ verified, newPosts, newCount }) }), BASE)
    const lines = email.text.replace(/\n+$/, "").split("\n")
    expect(lines.at(-1)).toBe(line)
    expect(lines.at(-2)).toBe("")
    expect(lines.at(-3)).toMatch(/^Open your dashboard: /)
    expect(email.preheader).toBe(line)
    expect(email.html).toContain(line)
    expect((email.html ?? "").split(line)).toHaveLength(2)
    expect(email.text).toContain("Links open your Eve dashboard and ask you to sign in.")
  })

  it("without the Stack posts section the line still ends the text part", () => {
    const email = renderDailySummary(base(), BASE)
    expect(email.text.replace(/\n+$/, "").split("\n").at(-1)).toBe("0 not a match, 0 failed, 0 unsure.")
  })
})

// daily-summary.feature r4 (CR-E5F-05, architecture r4 item 4): the dashboard link block is found by identity.
describe("plain-text tail: the dashboard link found by identity, not position (CR-E5F-05)", () => {
  const SUMMARY = "3 not a match, 0 failed, 1 unsure, 2 new Stack posts."
  const FOOTER = "Links open your Eve dashboard and ask you to sign in."
  const dashboard: Block = { kind: "link", label: "Open your dashboard", href: `${BASE}/dashboard`, style: "colon" }
  const stack: Block = { kind: "heading", text: "Stack posts" }
  const spend: Block = { kind: "heading", text: "Spend" }
  const other: Block = { kind: "link", label: "See this month's spend", href: `${BASE}/settings#cost`, style: "colon" }

  it.each([
    ["last, as Eve builds it today", [stack, spend, dashboard], ["Stack posts", "Spend"]],
    ["first", [dashboard, stack, spend], ["Stack posts", "Spend"]],
    ["between the Stack posts section and Spend", [stack, dashboard, spend], ["Stack posts", "Spend"]],
    ["before another link block that comes last", [stack, spend, dashboard, other], ["Stack posts", "Spend", `See this month's spend: ${BASE}/settings#cost`]],
  ] as const)("dashboard link block %s: the footer, the link, a blank line, then the summary line", (_position, blocks, before) => {
    const email = renderEmail("Subject", SUMMARY, blocks, { textTail: { link: dashboard, summaryLine: SUMMARY } })
    expect(email.text).toBe([...before, FOOTER, `Open your dashboard: ${BASE}/dashboard`, SUMMARY].join("\n\n") + "\n")
    expect(email.text.split("Open your dashboard: ")).toHaveLength(2)
  })

  it("an equal but different link object is not the dashboard link: render throws", () => {
    expect(() => renderEmail("Subject", SUMMARY, [stack, { ...dashboard }], { textTail: { link: dashboard, summaryLine: SUMMARY } })).toThrow(/dashboard link block/)
  })

  it("a text tail whose link block is missing from the blocks throws (a programming error; the sender records an unknown failure)", () => {
    expect(() => renderEmail("Subject", SUMMARY, [stack, spend], { textTail: { link: dashboard, summaryLine: SUMMARY } })).toThrow(/dashboard link block/)
  })

  it("the daily summary output is unchanged: footer, dashboard link, blank line, summary line", () => {
    const email = renderDailySummary(base(), BASE)
    expect(email.text.endsWith(`${FOOTER}\n\nOpen your dashboard: ${BASE}/dashboard\n\n0 not a match, 0 failed, 0 unsure.\n`)).toBe(true)
    expect(email.html).toContain(FOOTER)
  })
})
