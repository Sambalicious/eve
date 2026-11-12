import { describe, expect, it } from "vitest"

import { apiErrorResponseSchema } from "./errors.js"
import {
  ALERT_FEED_FAILURE_PHRASES,
  alertFeedFailurePhrase,
  alertFeedsResponseSchema,
  alertFeedVerificationRequestSchema,
  codePointLength,
  hasDisallowedControlCharacters,
  hiringPostsResponseSchema,
  isAlertFeedUrl,
  isCalendarDate,
  maskAlertFeedUrl,
  registerAlertFeedRequestSchema,
  STACK_POST_CANONICAL_URL_PREFIX,
  STACK_POSTS_PAGE_SIZE,
  stackPostSchema,
  stackPostsFieldProblemSchema,
  stackPostsResponseSchema,
} from "./stack-posts.js"
import { buildStackSearchGroups } from "./stack-search-links.js"

const FEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321"

describe("Alert feed URL pattern (AC 4.2, alert-feeds.feature)", () => {
  it.each([
    "http://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321",
    "https://google.com/alerts/feeds/01234567890123456789/9876543210987654321",
    "https://www.google.co.uk/alerts/feeds/01234567890123456789/9876543210987654321",
    "https://www.google.com.evil.example/alerts/feeds/01234567890123456789/98765432109876",
    "https://WWW.GOOGLE.COM/alerts/feeds/01234567890123456789/9876543210987654321",
    `${FEED_A}/`,
    `${FEED_A}?hl=en`,
    `${FEED_A}#top`,
    "https://user:pw@www.google.com/alerts/feeds/01234567890123456789/9876543210987654321",
    "https://www.google.com:443/alerts/feeds/01234567890123456789/9876543210987654321",
    "https://www.google.com/alerts/feeds/01234567890123456789",
    "https://www.google.com/alerts/feeds/01234567890123456789/98765/4321",
    "https://www.google.com/alerts/feeds//9876543210987654321",
    "https://www.google.com/alerts/feeds/0123456789abcdef/9876543210987654321",
    "https://www.google.com/alerts/feeds/０１２３/9876543210987654321",
    "https://www.google.com/alerts/feed/01234567890123456789/9876543210987654321",
    "https://www.google.com/Alerts/feeds/01234567890123456789/9876543210987654321",
    "https://www.google.com/search?q=react",
    "https://www.google.com/url?url=https://www.linkedin.com/posts/x",
    "https://www.linkedin.com/feed/",
    "https://www.google.com/alerts/feeds/01234567890123456789/98765%2F43210",
    "www.google.com/alerts/feeds/01234567890123456789/9876543210987654321",
    "",
  ])("refuses %j", (url) => {
    expect(isAlertFeedUrl(url)).toBe(false)
    expect(registerAlertFeedRequestSchema.safeParse({ url }).success).toBe(false)
  })

  it("refuses a blank URL after trimming", () => {
    expect(registerAlertFeedRequestSchema.safeParse({ url: "   " }).success).toBe(false)
  })

  it.each([FEED_A, "https://www.google.com/alerts/feeds/1/2", "https://www.google.com/alerts/feeds/0/0", "https://www.google.com/alerts/feeds/12345678901234567890123456789/98765432109876543210987654321"])(
    "accepts %j",
    (url) => {
      expect(isAlertFeedUrl(url)).toBe(true)
    }
  )

  it("trims the URL and the label; a blank label is no label", () => {
    expect(registerAlertFeedRequestSchema.parse({ url: `   ${FEED_A}  `, label: "   React posts   " })).toEqual({ url: FEED_A, label: "React posts" })
    expect(registerAlertFeedRequestSchema.parse({ url: FEED_A, label: "    " })).toEqual({ url: FEED_A, label: null })
    expect(registerAlertFeedRequestSchema.parse({ url: FEED_A })).toEqual({ url: FEED_A, label: null })
    expect(registerAlertFeedRequestSchema.parse({ url: FEED_A, label: null })).toEqual({ url: FEED_A, label: null })
  })

  it.each([
    [1, 0, true],
    [60, 0, true],
    [60, 4, true],
    [61, 0, false],
  ])("label of %d characters with %d spaces each side: accepted %s", (length, padding, accepted) => {
    const label = `${" ".repeat(padding)}${"a".repeat(length)}${" ".repeat(padding)}`
    expect(registerAlertFeedRequestSchema.safeParse({ url: FEED_A, label }).success).toBe(accepted)
  })
})

describe("maskAlertFeedUrl (D-E5-2)", () => {
  it.each([
    [FEED_A, "…654321"],
    ["https://www.google.com/alerts/feeds/1/42", "…142"],
    ["https://www.google.com/alerts/feeds/123456/7", "…234567"],
    ["https://www.google.com/alerts/feeds/98765/4321", "…654321"],
    ["https://www.google.com/alerts/feeds/1/2", "…12"],
  ])("%s -> %s", (url, masked) => {
    expect(maskAlertFeedUrl(url)).toBe(masked)
  })
})

describe("verification request (AC 3.1, 3.2)", () => {
  it.each(["2026-02-30", "2026-13-01", "2025-02-29", "2026-00-10", "20-10-2026", "yesterday", "not-a-date", ""])("refuses the date %j", (verifiedOn) => {
    expect(isCalendarDate(verifiedOn)).toBe(false)
    expect(alertFeedVerificationRequestSchema.safeParse({ verifiedOn, verificationBasis: "x" }).success).toBe(false)
  })

  it.each(["2024-02-29", "2020-01-01", "2026-10-21"])("accepts the date %j", (verifiedOn) => {
    expect(isCalendarDate(verifiedOn)).toBe(true)
  })

  it("stores the basis trimmed and measures it after trimming", () => {
    expect(alertFeedVerificationRequestSchema.parse({ verifiedOn: "2026-10-20", verificationBasis: `     ${"b".repeat(500)}     ` }).verificationBasis).toHaveLength(500)
    expect(alertFeedVerificationRequestSchema.safeParse({ verifiedOn: "2026-10-20", verificationBasis: "b".repeat(501) }).success).toBe(false)
  })

  it.each(["", "   ", "\t\n "])("refuses the blank basis %j", (verificationBasis) => {
    expect(alertFeedVerificationRequestSchema.safeParse({ verifiedOn: "2026-10-20", verificationBasis }).success).toBe(false)
  })

  it("refuses a body that would clear the verification", () => {
    expect(alertFeedVerificationRequestSchema.safeParse({}).success).toBe(false)
    expect(alertFeedVerificationRequestSchema.safeParse({ verifiedOn: null, verificationBasis: null }).success).toBe(false)
  })
})

describe("alert feeds response globalPaused (v1.22.0, OWN-1)", () => {
  const base = { verification: null, feeds: [], limit: 10 }

  it.each([true, false])("accepts globalPaused %s", (globalPaused) => {
    expect(alertFeedsResponseSchema.safeParse({ ...base, globalPaused }).success).toBe(true)
  })

  it("requires a boolean globalPaused and refuses spend data (strict)", () => {
    expect(alertFeedsResponseSchema.safeParse(base).success).toBe(false)
    expect(alertFeedsResponseSchema.safeParse({ ...base, globalPaused: null }).success).toBe(false)
    expect(alertFeedsResponseSchema.safeParse({ ...base, globalPaused: false, spend: { spent: "$0.00" } }).success).toBe(false)
    expect(alertFeedsResponseSchema.safeParse({ ...base, globalPaused: false, globalPausedAt: null }).success).toBe(false)
  })
})

describe("reason phrases (copy deck C-SP-FAIL-*)", () => {
  it("has the six fixed phrases and falls back to Unexpected response", () => {
    expect(ALERT_FEED_FAILURE_PHRASES).toEqual({
      not_reachable: "Not reachable",
      unexpected_response: "Unexpected response",
      redirected: "Redirected (not followed)",
      not_a_feed: "Not a feed",
      too_large: "Too large",
      timed_out: "Timed out",
    })
    expect(alertFeedFailurePhrase("something_new")).toBe("Unexpected response")
  })
})

describe("error envelope (v1.14.0)", () => {
  it("accepts the Stack posts field errors and the new code", () => {
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "url", position: null, problem: "redirected" }] } }).success
    ).toBe(true)
    expect(apiErrorResponseSchema.safeParse({ error: { code: "alert_feeds_not_verified", message: "x" } }).success).toBe(true)
  })
})

describe("buildStackSearchGroups (AC 2.1-2.6, search-links.feature)", () => {
  const decoded = (url: string, key: string) => new URL(url).searchParams.get(key)
  const raw = (url: string, key: string) => new URL(url).search.slice(1).split("&").find((pair) => pair.startsWith(`${key}=`))!.slice(key.length + 1)

  it("orders Frameworks then Technologies, quoted and joined with OR", () => {
    const [group] = buildStackSearchGroups(["Next.js", "NestJS"], ["TypeScript"])
    expect(group!.expression).toBe('("Next.js" OR "NestJS" OR "TypeScript")')
    expect(group!.label).toBe("Next.js, NestJS, TypeScript")
    expect(buildStackSearchGroups(["nestjs", "React"], ["postgreSQL", "AWS"])[0]!.expression).toBe('("nestjs" OR "React" OR "postgreSQL" OR "AWS")')
  })

  it("builds the LinkedIn link with NOT hiring and quoted, encoded sortBy and datePosted", () => {
    const [group] = buildStackSearchGroups(["Next.js", "NestJS"], [])
    expect(group!.linkedin.startsWith("https://www.linkedin.com/search/results/content/?keywords=")).toBe(true)
    expect(decoded(group!.linkedin, "keywords")).toBe('("Next.js" OR "NestJS") NOT hiring')
    expect(decoded(group!.linkedin, "sortBy")).toBe('"date_posted"')
    expect(decoded(group!.linkedin, "datePosted")).toBe('"past-week"')
    expect(raw(group!.linkedin, "sortBy")).toBe("%22date_posted%22")
    expect(raw(group!.linkedin, "datePosted")).toBe("%22past-week%22")
  })

  it("builds the two Google links and the two Alerts query strings", () => {
    const [group] = buildStackSearchGroups(["Next.js", "NestJS"], [])
    expect(group!.googlePosts.startsWith("https://www.google.com/search?")).toBe(true)
    expect(decoded(group!.googlePosts, "q")).toBe('site:linkedin.com/posts ("Next.js" OR "NestJS") -hiring -job')
    expect(decoded(group!.googleArticles, "q")).toBe('site:linkedin.com/pulse ("Next.js" OR "NestJS") -hiring -job')
    expect(decoded(group!.googlePosts, "tbs")).toBe("qdr:w")
    expect(group!.alertsPostsQuery).toBe('site:linkedin.com/posts ("Next.js" OR "NestJS") -hiring -job')
    expect(group!.alertsArticlesQuery).toBe('site:linkedin.com/pulse ("Next.js" OR "NestJS") -hiring -job')
    for (const text of [group!.alertsPostsQuery, group!.alertsArticlesQuery]) {
      expect(text).not.toMatch(/https:\/\/|tbs|qdr:w/)
    }
  })

  it.each([
    ["C#", "#", "%23"],
    ["C++", "+", "%2B"],
    ["CI/CD", "/", "%2F"],
    [".NET", '"', "%22"],
  ])("encodes %s in every link", (term, rawChar, encoded) => {
    const [group] = buildStackSearchGroups([term], [])
    const keywords = raw(group!.linkedin, "keywords")
    expect(keywords).toContain(encoded)
    expect(keywords).not.toContain(rawChar)
    expect(decoded(group!.linkedin, "keywords")).toBe(`("${term}") NOT hiring`)
    expect(decoded(group!.googlePosts, "q")).toBe(`site:linkedin.com/posts ("${term}") -hiring -job`)
    expect(decoded(group!.googleArticles, "q")).toBe(`site:linkedin.com/pulse ("${term}") -hiring -job`)
  })

  it.each([
    [1, 0, 1, 1],
    [0, 1, 1, 1],
    [8, 0, 1, 8],
    [9, 0, 2, 1],
    [5, 4, 2, 1],
    [16, 0, 2, 8],
    [17, 0, 3, 1],
    [20, 19, 5, 7],
    [20, 20, 5, 8],
  ])("%d frameworks + %d technologies -> %d groups, last of %d", (f, t, groups, last) => {
    const built = buildStackSearchGroups(
      Array.from({ length: f }, (_, i) => `F${i + 1}`),
      Array.from({ length: t }, (_, i) => `T${i + 1}`)
    )
    expect(built).toHaveLength(groups)
    expect(built.at(-1)!.terms).toHaveLength(last)
    expect(built.flatMap((g) => g.terms)).toHaveLength(f + t)
  })

  it("spans the Frameworks/Technologies boundary and keeps multi-word terms whole", () => {
    const built = buildStackSearchGroups(["React", "Next.js", "Vue", "Nuxt", "Svelte", "Angular"], ["TypeScript", "GraphQL", "PostgreSQL"])
    expect(built.map((g) => g.label)).toEqual(["React, Next.js, Vue, Nuxt, Svelte, Angular, TypeScript, GraphQL", "PostgreSQL"])
    expect(buildStackSearchGroups([], ["Google Cloud", "React Native"])[0]!.expression).toBe('("Google Cloud" OR "React Native")')
    expect(buildStackSearchGroups(["React"], [])[0]!.expression).toBe('("React")')
  })

  it("returns no group for empty criteria and the same links on every call", () => {
    expect(buildStackSearchGroups([], [])).toEqual([])
    expect(buildStackSearchGroups(["React"], ["TypeScript"])).toEqual(buildStackSearchGroups(["React"], ["TypeScript"]))
  })
})

/** v1.15.1, architecture.r1.md item 4 (CR-E5-04, SEC-E5-06): one length rule and one control-character rule. */
describe("codePointLength (CR-E5-04)", () => {
  it.each([
    ["", 0],
    ["abc", 3],
    ["😀", 1],
    ["🇳🇬", 2],
    ["👨‍👩‍👧", 5],
    ["\r\n", 2],
    ["é", 1],
    ["e\u0301", 2],
    ["\uFFFD", 1],
  ])("%j has %d code points", (text, length) => {
    expect(codePointLength(text)).toBe(length)
  })
})

describe("hasDisallowedControlCharacters (SEC-E5-06)", () => {
  const C0 = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code))
  const LINE_BREAKS = ["\t", "\n", "\r"]

  it.each(C0.map((char) => [char.charCodeAt(0).toString(16), char]))("U+%s is refused in a label", (_hex, char) => {
    expect(hasDisallowedControlCharacters(`a${char}b`, { allowLineBreaks: false })).toBe(true)
  })

  it.each(C0.filter((char) => !LINE_BREAKS.includes(char)).map((char) => [char.charCodeAt(0).toString(16), char]))("U+%s is refused in a basis", (_hex, char) => {
    expect(hasDisallowedControlCharacters(`a${char}b`, { allowLineBreaks: true })).toBe(true)
  })

  it("DEL is refused in both; tab, LF and CR only in a label", () => {
    expect(hasDisallowedControlCharacters("a\u007fb", { allowLineBreaks: true })).toBe(true)
    expect(hasDisallowedControlCharacters("a\u007fb", { allowLineBreaks: false })).toBe(true)
    for (const char of LINE_BREAKS) expect(hasDisallowedControlCharacters(`a${char}b`, { allowLineBreaks: true })).toBe(false)
  })

  /** v1.15.2 (SEC-E5F-02, architecture r4 item 4): C1 controls, bidi controls, U+200B, U+2060 and U+FEFF. */
  const C1 = Array.from({ length: 32 }, (_, offset) => 0x80 + offset)
  const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
  const INVISIBLE = [0x200b, 0x2060, 0xfeff]
  const WIDENED = [...C1, ...BIDI, ...INVISIBLE].map((code) => [code.toString(16).padStart(4, "0"), String.fromCodePoint(code)] as const)

  it.each(WIDENED)("U+%s is refused in a label and in a basis (v1.15.2)", (_hex, char) => {
    expect(hasDisallowedControlCharacters(`a${char}b`, { allowLineBreaks: false })).toBe(true)
    expect(hasDisallowedControlCharacters(`a${char}b`, { allowLineBreaks: true })).toBe(true)
  })

  it.each([
    ["no-break space", "React\u00a0posts"],
    ["ZWNJ in Persian", "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 posts"],
    ["ZWJ family emoji", "👨\u200d👩\u200d👧 posts"],
    ["accents and emoji", "Réact 🚀 posts"],
    ["emoji", "React posts 😀"],
    ["U+00A1 just past C1", "React\u00a1posts"],
    ["U+2065, unassigned between the bidi isolates and the word joiner range", "React\u2065posts"],
    ["U+200A hair space, just before U+200B", "React\u200aposts"],
    ["Arabic text without bidi controls", "\u0645\u0631\u062d\u0628\u0627"],
    ["empty", ""],
  ])("allows %s in a label and in a basis", (_name, text) => {
    expect(hasDisallowedControlCharacters(text, { allowLineBreaks: false })).toBe(false)
    expect(hasDisallowedControlCharacters(text, { allowLineBreaks: true })).toBe(false)
  })
})

describe("label and basis rules in the request schemas (v1.15.1)", () => {
  const emoji = (n: number) => "😀".repeat(n)

  it.each([
    [emoji(60), true],
    [`    ${emoji(60)}    `, true],
    [emoji(61), false],
    [`${"a".repeat(59)}😀`, true],
    [`${"a".repeat(59)}🇳🇬`, false],
  ])("label %#: accepted %s (code points after trimming)", (label, accepted) => {
    expect(registerAlertFeedRequestSchema.safeParse({ url: FEED_A, label }).success).toBe(accepted)
  })

  it.each(["lab\u0000el", "React\tposts", "React\nposts", "React\rposts", "React\u001b[2Jposts", "React\u007fposts", "React\u0085posts", "React\u202eposts", "React\ufeffposts", "React\u2060posts"])("refuses the label %j", (label) => {
    expect(registerAlertFeedRequestSchema.safeParse({ url: FEED_A, label }).success).toBe(false)
  })

  it("a U+FEFF at either end is removed by trimming before the character rule (String.prototype.trim)", () => {
    expect(registerAlertFeedRequestSchema.parse({ url: FEED_A, label: "\ufeffReact posts\ufeff" }).label).toBe("React posts")
  })

  it.each([
    [emoji(500), true],
    [`     ${emoji(500)}     `, true],
    [emoji(501), false],
    [`${"a".repeat(499)}😀`, true],
    [`${"a".repeat(499)}🇳🇬`, false],
    [`${"a".repeat(498)}\r\nb`, false],
  ])("basis %#: accepted %s (code points after trimming)", (verificationBasis, accepted) => {
    expect(alertFeedVerificationRequestSchema.safeParse({ verifiedOn: "2026-10-20", verificationBasis }).success).toBe(accepted)
  })

  it.each(["basis\u0000x", "\u0000", "Reviewed\u001b[31m terms", "Reviewed\u007f terms", "Reviewed\u000b terms", "Reviewed\u0085 terms", "Reviewed\u2067 terms", "Reviewed\u200b terms"])("refuses the basis %j", (verificationBasis) => {
    expect(alertFeedVerificationRequestSchema.safeParse({ verifiedOn: "2026-10-20", verificationBasis }).success).toBe(false)
  })

  it.each([
    ["Reviewed Google Alerts terms.\nSee notes.", "Reviewed Google Alerts terms.\nSee notes."],
    ["Reviewed\r\nGoogle Alerts terms.", "Reviewed\r\nGoogle Alerts terms."],
    ["Reviewed\tGoogle Alerts terms.", "Reviewed\tGoogle Alerts terms."],
    ["\n\tReviewed terms.\r\n", "Reviewed terms."],
  ])("stores the basis %j as %j", (verificationBasis, stored) => {
    expect(alertFeedVerificationRequestSchema.parse({ verifiedOn: "2026-10-20", verificationBasis }).verificationBasis).toBe(stored)
  })

  it("adds the invalid_characters field problem", () => {
    expect(stackPostsFieldProblemSchema.options).toContain("invalid_characters")
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: "bad_request", message: "x", fieldErrors: [{ field: "label", position: null, problem: "invalid_characters" }] } }).success
    ).toBe(true)
  })
})

describe("canonicalUrl is a LinkedIn https URL (v1.20.1, SEC-P3-01 / SEC-E7-05)", () => {
  const item = (canonicalUrl: string) => ({
    id: "a0000000-0000-4000-8000-000000000001",
    canonicalUrl,
    kind: "post",
    title: "T",
    snippet: "S",
    date: "2026-10-24T08:00:00.000Z",
    dateKind: "posted",
    matchedTechnologies: [],
    source: null,
    firstSeenAt: "2026-10-24T08:00:00.000Z",
  })
  const page = (canonicalUrl: string) => ({ items: [item(canonicalUrl)], page: 1, pageSize: STACK_POSTS_PAGE_SIZE, totalCount: 1, totalPages: 1 })

  it.each(["https://www.linkedin.com/posts/ada-obi_react-activity-1-abcd", "https://www.linkedin.com/pulse/why-we-moved-ada-obi", "https://www.linkedin.com/"])(
    "accepts %s (every value the database check allows)",
    (url) => {
      expect(stackPostSchema.safeParse(item(url)).success).toBe(true)
      expect(stackPostsResponseSchema.safeParse(page(url)).success).toBe(true)
      expect(hiringPostsResponseSchema.safeParse(page(url)).success).toBe(true)
    },
  )

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)//https://www.linkedin.com/",
    "data:text/html,<script>alert(1)</script>",
    "http://www.linkedin.com/posts/x",
    "https://www.linkedin.com.evil.example/posts/x",
    "https://evil.example/https://www.linkedin.com/",
    "https://linkedin.com/posts/x",
    "https://www.linkedin.com",
    " https://www.linkedin.com/posts/x",
    "",
  ])("refuses %j", (url) => {
    expect(stackPostSchema.safeParse(item(url)).success).toBe(false)
    expect(stackPostsResponseSchema.safeParse(page(url)).success).toBe(false)
    expect(hiringPostsResponseSchema.safeParse(page(url)).success).toBe(false)
  })

  it("exports the prefix the database checks use", () => {
    expect(STACK_POST_CANONICAL_URL_PREFIX).toBe("https://www.linkedin.com/")
  })
})
