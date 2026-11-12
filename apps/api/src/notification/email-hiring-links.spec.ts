import { buildHiringSearchGroups, buildStackSearchGroups, hiringHintTerms } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { hiringLinksPart } from "../stack-posts/stack-posts-summary.js"
import { type DailySummaryInput, type StackPostsSection, renderDailySummary } from "./email-content.js"

/**
 * EPIC-0007 Phase 1, daily-summary-hiring.feature @phase1 (AC 4.1, 4.2): the
 * "Hiring search links" part of the Stack posts section. Copy from copy-deck r1.
 */
const BASE = "https://dashboard.test"
const INTRO_FRONTEND = "Past-week search hints for Frontend roles. Some results won't fit, and Eve can't check pay, hours or sponsorship from them."
const NO_FAMILY = "Hiring searches need job titles, and Other has none. Choose another role family in your job criteria."
const HIRING = '("we\'re hiring" OR "we are hiring" OR "now hiring" OR "join our team")'
const FRONTEND = '("frontend engineer" OR "frontend developer" OR "front-end engineer")'
const ALL_HINTS = hiringHintTerms({ remoteAccepted: true, relocationAccepted: true, sponsorshipNeededForRelocation: true })

const input = (stackPosts: StackPostsSection): DailySummaryInput => ({
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
  stackPosts,
})

const section = (hiring: StackPostsSection["hiring"], overrides: Partial<StackPostsSection> = {}): StackPostsSection => ({
  groups: buildStackSearchGroups(["React"], []),
  hiring,
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

const render = (hiring: StackPostsSection["hiring"], overrides: Partial<StackPostsSection> = {}) => renderDailySummary(input(section(hiring, overrides)), BASE)
const linksIn = (text: string, label: string) => (text.match(new RegExp(`^${label}: (.*)$`, "gm")) ?? []).map((line) => line.slice(label.length + 2))

describe("hiringLinksPart (D6, AC 4.1, 4.2)", () => {
  it("uses the first target family with phrases in catalog order", () => {
    const part = hiringLinksPart(["backend", "fullstack", "senior_frontend"], ["React"], [], [])
    expect(part).toMatchObject({ family: "senior_frontend", hasOtherFamilies: true })
  })

  it("one family with phrases has no other families; Other does not count", () => {
    expect(hiringLinksPart(["senior_frontend", "other"], ["React"], [], [])).toMatchObject({ family: "senior_frontend", hasOtherFamilies: false })
  })

  it("only Other gives the no-family part", () => {
    expect(hiringLinksPart(["other"], ["React"], [], ALL_HINTS)).toEqual({ family: null })
  })

  it("builds the same groups as the Hiring view for the same inputs (AC 3.1)", () => {
    const part = hiringLinksPart(["senior_frontend"], ["React"], ["TypeScript"], ALL_HINTS)
    expect(part).toEqual({
      family: "senior_frontend",
      hasOtherFamilies: false,
      groups: buildHiringSearchGroups({ family: "senior_frontend", frameworks: ["React"], technologies: ["TypeScript"], hintTerms: ALL_HINTS }),
    })
  })
})

describe("rendered hiring links part (daily-summary-hiring.feature @phase1)", () => {
  it('follows the Stack posts search links inside the "Stack posts" section, before Spend', () => {
    const { text } = render(hiringLinksPart(["senior_frontend", "fullstack"], ["React"], [], []))
    const stackLinks = text.indexOf("Google articles: ")
    const title = text.indexOf("\n\nHiring search links\n\n")
    expect(text.indexOf("\n\nStack posts\n\n")).toBeLessThan(stackLinks)
    expect(stackLinks).toBeLessThan(title)
    expect(title).toBeLessThan(text.indexOf("\n\nSpend\n"))
  })

  it("names the first target family and uses its role clause", () => {
    const { text, html } = render(hiringLinksPart(["backend", "fullstack", "senior_frontend"], ["React"], [], []))
    expect(text).toContain(INTRO_FRONTEND)
    expect(html).toContain("Past-week search hints for Frontend roles. Some results won&#39;t fit, and Eve can&#39;t check pay, hours or sponsorship from them.")
    for (const href of linksIn(text, "LinkedIn posts").slice(1)) expect(new URL(href).searchParams.get("keywords")).toContain(FRONTEND)
  })

  it("one group labelled by its terms with one LinkedIn and one Google link, the AC 3.4 keywords, and no query string", () => {
    const part = hiringLinksPart(["senior_frontend"], ["React"], ["TypeScript"], ALL_HINTS)
    const { text, html } = render(part)
    const hiringText = text.slice(text.indexOf("Hiring search links"))
    expect(hiringText).toContain("\nReact, TypeScript\nLinkedIn posts: ")
    const linkedin = linksIn(hiringText, "LinkedIn posts")
    const google = linksIn(hiringText, "Google posts")
    expect(linkedin).toHaveLength(1)
    expect(google).toHaveLength(1)
    expect(new URL(linkedin[0]!).searchParams.get("keywords")).toBe(`${HIRING} AND ${FRONTEND} AND ("React" OR "TypeScript") AND ("remote" OR "relocation" OR "visa sponsorship")`)
    expect(new URL(google[0]!).searchParams.get("q")!.startsWith("site:linkedin.com/posts ")).toBe(true)
    expect(linksIn(hiringText, "Google articles")).toEqual([])
    // No plain-text Google Alerts query string: "site:" appears only inside an encoded link.
    expect(text).not.toContain("site:linkedin.com/posts (")
    expect(html).not.toContain("site:linkedin.com/posts (")
  })

  it("links to the Hiring view for other families, in HTML and plain text", () => {
    const { text, html } = render(hiringLinksPart(["senior_frontend", "backend"], ["React"], [], []))
    expect(text).toContain("Searches for your other role families: https://dashboard.test/stack-posts?view=hiring")
    expect(html).toContain('<a href="https://dashboard.test/stack-posts?view=hiring"')
    const lastGroup = text.lastIndexOf("Google posts: ")
    expect(lastGroup).toBeLessThan(text.indexOf("Searches for your other role families"))
  })

  it("leaves the other-families link out with one family", () => {
    expect(render(hiringLinksPart(["senior_frontend"], ["React"], [], [])).text).not.toContain("Searches for your other role families")
  })

  it("carries one LinkedIn and one Google link per group: 10 groups of 4 at 40 terms", () => {
    const frameworks = Array.from({ length: 20 }, (_, i) => `F${i}`)
    const technologies = Array.from({ length: 20 }, (_, i) => `T${i}`)
    const part = hiringLinksPart(["senior_frontend"], frameworks, technologies, [])
    const { text } = render(part, { groups: buildStackSearchGroups(frameworks, technologies) })
    const hiringText = text.slice(text.indexOf("Hiring search links"))
    expect(linksIn(hiringText, "LinkedIn posts")).toHaveLength(10)
    expect(linksIn(hiringText, "Google posts")).toHaveLength(10)
    const groups = buildHiringSearchGroups({ family: "senior_frontend", frameworks, technologies, hintTerms: [] })
    expect(linksIn(hiringText, "LinkedIn posts")).toEqual(groups.map((group) => group.linkedin))
    expect(groups.every((group) => group.terms.length === 4)).toBe(true)
  })

  it('empty technology lists give one group labelled "Any technology" with no technology clause', () => {
    const { text } = render(hiringLinksPart(["senior_frontend"], [], [], []), { groups: [] })
    const hiringText = text.slice(text.indexOf("Hiring search links"))
    expect(hiringText).toContain("\nAny technology\nLinkedIn posts: ")
    expect(new URL(linksIn(hiringText, "LinkedIn posts")[0]!).searchParams.get("keywords")).toBe(`${HIRING} AND ${FRONTEND}`)
  })

  it('every linkedin.com and google.com hiring link opens in a new tab with rel "noopener noreferrer"', () => {
    const { html } = render(hiringLinksPart(["senior_frontend", "backend"], ["React", "C#"], [], ALL_HINTS))
    const hiringHtml = html!.slice(html!.indexOf("Hiring search links"))
    const anchors = hiringHtml.match(/<a [^>]*href="https:\/\/www\.(linkedin|google)\.com[^"]*"[^>]*>/g) ?? []
    expect(anchors).toHaveLength(2)
    for (const anchor of anchors) expect(anchor).toContain('target="_blank" rel="noopener noreferrer"')
    // P1-4: every hiring href starts with a fixed https base.
    const hrefs = [...hiringHtml.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!)
    for (const href of hrefs.filter((value) => !value.startsWith(BASE))) {
      expect(href.startsWith("https://www.linkedin.com/search/results/content/?") || href.startsWith("https://www.google.com/search?")).toBe(true)
    }
  })

  it("only Other targeted: the explanation and a Settings link instead of links", () => {
    const { text, html } = render(hiringLinksPart(["other"], ["React"], [], ALL_HINTS))
    const hiringText = text.slice(text.indexOf("Hiring search links"))
    expect(hiringText).toContain(`${NO_FAMILY}\n\nChoose role families: https://dashboard.test/settings#job-criteria`)
    expect(linksIn(hiringText, "LinkedIn posts")).toEqual([])
    expect(linksIn(hiringText, "Google posts")).toEqual([])
    expect(html).toContain(">Choose role families</a>")
  })

  it("is shown without a verification (AC 4.1), and adds no Hiring count to the summary line", () => {
    const email = render(hiringLinksPart(["senior_frontend"], ["React"], [], []), { verified: false })
    expect(email.text).toContain(INTRO_FRONTEND)
    expect(email.preheader).toBe("0 not a match, 0 failed, 0 unsure.")
    expect(render(hiringLinksPart(["senior_frontend"], ["React"], [], [])).preheader).toBe("0 not a match, 0 failed, 0 unsure, 0 new Stack posts.")
  })

  it("escapes a hostile term in HTML and keeps the link inside its base (P1-1, P1-4)", () => {
    const { html } = render(hiringLinksPart(["senior_frontend"], ['<b>"x"</b>'], [], []))
    expect(html).not.toContain("<b>")
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;")
  })

  it("leaves everything outside the hiring part byte-equal (AC 10.4)", () => {
    const without = renderDailySummary(input(section(undefined)), BASE)
    const withPart = renderDailySummary(input(section(hiringLinksPart(["senior_frontend"], ["React"], [], ALL_HINTS))), BASE)
    const cut = (text: string) => text.replace(/\n\nHiring search links\n\n[\s\S]*?(?=\n\nNo new Stack posts\.)/, "")
    expect(cut(withPart.text)).toBe(without.text)
    expect(withPart.subject).toBe(without.subject)
    expect(withPart.preheader).toBe(without.preheader)
  })
})
