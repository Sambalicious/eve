import { describe, expect, it } from "vitest"

import { checkFeedForm, checkVerification, todayWat } from "./validation"

const FEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321"
const NOW = new Date("2026-10-21T12:00:00Z")

describe("todayWat", () => {
  it.each([
    ["2026-10-21T12:00:00Z", "2026-10-21"],
    ["2026-10-21T22:59:59Z", "2026-10-21"],
    ["2026-10-21T23:00:00Z", "2026-10-22"],
  ])("%s is %s in WAT", (now, day) => {
    expect(todayWat(new Date(now))).toBe(day)
  })
})

describe("checkVerification (AFV)", () => {
  const basis = "Reviewed Google Alerts terms."
  it.each(["2026-02-30", "2026-13-01", "2025-02-29", "2026-00-10", "20-10-2026", ""])("date %j is refused", (date) => {
    expect(checkVerification({ date, basis }, NOW).date).toBe("Enter the verification date.")
  })
  it.each(["2026-10-21", "2020-01-01", "2024-02-29"])("date %s is accepted", (date) => {
    expect(checkVerification({ date, basis }, NOW)).toEqual({})
  })
  it("today in WAT is the limit", () => {
    expect(checkVerification({ date: "2026-10-22", basis }, NOW).date).toBe("Enter today or an earlier date.")
    expect(checkVerification({ date: "2026-10-22", basis }, new Date("2026-10-21T23:30:00Z"))).toEqual({})
    expect(checkVerification({ date: "2026-10-22", basis }, new Date("2026-10-21T22:59:59Z")).date).toBe("Enter today or an earlier date.")
  })
  it.each(["", "   ", "\t\n "])("basis %j is blank", (b) => {
    expect(checkVerification({ date: "2026-10-20", basis: b }, NOW).basis).toBe("Enter the basis for your confirmation.")
  })
  it("all failing fields are reported together (CR-E5-01)", () => {
    expect(checkVerification({ date: "2026-10-22", basis: "   " }, NOW)).toEqual({
      date: "Enter today or an earlier date.",
      basis: "Enter the basis for your confirmation.",
    })
  })
  const CHARS = "The basis has hidden characters Eve can't save. Type it again or paste it as plain text."
  it.each(["basis\u0000x", "Reviewed\u0001 terms", "Reviewed\u0007 terms", "Reviewed\u001b[31m terms", "Reviewed\u000b terms", "Reviewed\u000c terms", "Reviewed\u007f terms"])(
    "basis %j has a control character (SEC-E5-06)",
    (b) => {
      expect(checkVerification({ date: "2026-10-20", basis: b }, NOW).basis).toBe(CHARS)
    }
  )
  it.each(["\u0085", "\u0080", "\u009f", "\u061c", "\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069", "\u200b", "\u2060", "\ufeff"])("basis with U+%s inside is refused: C1, bidi or invisible (SEC-E5F-02, v1.15.2)", (ch) => {
    expect(checkVerification({ date: "2026-10-20", basis: `Reviewed${ch} terms` }, NOW).basis).toBe(CHARS)
  })
  it("a U+FEFF at either end is trimmed first; inside it is refused", () => {
    expect(checkVerification({ date: "2026-10-20", basis: "\ufeffReviewed terms" }, NOW)).toEqual({})
    expect(checkVerification({ date: "2026-10-20", basis: "Reviewed\ufeff terms" }, NOW).basis).toBe(CHARS)
  })
  it.each(["Reviewed\u00a0Google Alerts terms.", "Reviewed terms with \u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", "Reviewed by the team \u{1f468}\u200d\u{1f469}\u200d\u{1f467}"])(
    "basis %j with ZWNJ, ZWJ or a no-break space is allowed (SEC-E5F-02)",
    (b) => {
      expect(checkVerification({ date: "2026-10-20", basis: b }, NOW)).toEqual({})
    }
  )
  it("invalid_characters comes before too_long; tab and line breaks are allowed", () => {
    expect(checkVerification({ date: "2026-10-20", basis: `${"a".repeat(501)}\u0000` }, NOW).basis).toBe(CHARS)
    expect(checkVerification({ date: "2026-10-20", basis: "Reviewed\tGoogle\r\nAlerts terms.\n" }, NOW)).toEqual({})
  })
  it("basis length counts code points (CR-E5-04)", () => {
    expect(checkVerification({ date: "2026-10-20", basis: "😀".repeat(500) }, NOW)).toEqual({})
    expect(checkVerification({ date: "2026-10-20", basis: "😀".repeat(501) }, NOW).basis).toBe("Use 500 characters or fewer.")
    expect(checkVerification({ date: "2026-10-20", basis: `${"a".repeat(499)}🇳🇬` }, NOW).basis).toBe("Use 500 characters or fewer.")
    expect(checkVerification({ date: "2026-10-20", basis: `${"a".repeat(498)}\r\na` }, NOW).basis).toBe("Use 500 characters or fewer.")
  })
  it("basis length is measured after trimming", () => {
    expect(checkVerification({ date: "2026-10-20", basis: `     ${"a".repeat(500)}     ` }, NOW)).toEqual({})
    expect(checkVerification({ date: "2026-10-20", basis: "a".repeat(501) }, NOW).basis).toBe("Use 500 characters or fewer.")
  })
})

describe("checkFeedForm (AF, design-spec F4 step 3 order)", () => {
  const empty = 0
  it("accepts FEED_A with spaces around it, and short digit runs", () => {
    expect(checkFeedForm({ url: `   ${FEED_A}  `, label: "React posts" }, empty)).toEqual({})
    expect(checkFeedForm({ url: "https://www.google.com/alerts/feeds/1/2", label: "" }, empty)).toEqual({})
  })
  it.each([
    "http://www.google.com/alerts/feeds/1/2",
    "https://WWW.GOOGLE.COM/alerts/feeds/1/2",
    `${FEED_A}/`,
    `${FEED_A}?hl=en`,
    "https://www.google.com/alerts/feeds/０１２３/9876543210987654321",
    "https://www.google.com/search?q=x",
    "",
    "   ",
  ])("refuses %j with the format line", (url) => {
    expect(checkFeedForm({ url, label: "" }, empty).url).toBe(
      "This isn't a Google Alerts feed URL. Those start with https://www.google.com/alerts/feeds/"
    )
  })
  it("limit comes before format (duplicates need the stored URL, so only the server checks them); label separately", () => {
    expect(checkFeedForm({ url: "nope", label: "" }, 10).url).toBe("The limit is 10 Alert feeds. Remove one to add another.")
    expect(checkFeedForm({ url: FEED_A, label: ` ${"a".repeat(60)} ` }, empty)).toEqual({})
    expect(checkFeedForm({ url: FEED_A, label: "a".repeat(61) }, empty).label).toBe("Use 60 characters or fewer.")
  })
  const LABEL_CHARS = "The label has a tab or hidden character. Type it again."
  it.each(["lab\u0000el", "React\tposts", "React\nposts", "React\rposts", "React\u001b[2Jposts", "React\u007fposts"])(
    "label %j has a control character (SEC-E5-06)",
    (label) => {
      expect(checkFeedForm({ url: FEED_A, label }, empty).label).toBe(LABEL_CHARS)
    }
  )
  it("label invalid_characters comes before too_long; URL and label errors together", () => {
    expect(checkFeedForm({ url: FEED_A, label: `${"a".repeat(30)}\t${"a".repeat(31)}` }, empty).label).toBe(LABEL_CHARS)
    expect(checkFeedForm({ url: "https://www.google.com/search?q=react", label: "lab\u0000el" }, empty)).toEqual({
      url: "This isn't a Google Alerts feed URL. Those start with https://www.google.com/alerts/feeds/",
      label: LABEL_CHARS,
    })
  })
  it.each(["\u0085", "\u0080", "\u009f", "\u061c", "\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069", "\u200b", "\u2060", "\ufeff"])("label with U+%s inside is refused: C1, bidi or invisible (SEC-E5F-02, v1.15.2)", (ch) => {
    expect(checkFeedForm({ url: FEED_A, label: `React${ch}posts` }, empty).label).toBe(LABEL_CHARS)
  })
  it("a label starting with U+202E is refused; one starting with U+FEFF is trimmed first", () => {
    expect(checkFeedForm({ url: FEED_A, label: "\u202eReact posts" }, empty).label).toBe(LABEL_CHARS)
    expect(checkFeedForm({ url: FEED_A, label: "\ufeffReact posts" }, empty)).toEqual({})
  })
  it.each([
    "React\u00a0posts",
    "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 posts",
    "Family \u{1f468}\u200d\u{1f469}\u200d\u{1f467} posts",
    "Réact 🚀 posts",
    "React posts 😀",
  ])("label %j is allowed: printable characters, ZWNJ, ZWJ and the no-break space", (label) => {
    expect(checkFeedForm({ url: FEED_A, label }, empty)).toEqual({})
  })
  it("label length counts code points (CR-E5-04)", () => {
    expect(checkFeedForm({ url: FEED_A, label: ` ${"😀".repeat(60)} ` }, empty)).toEqual({})
    expect(checkFeedForm({ url: FEED_A, label: "😀".repeat(61) }, empty).label).toBe("Use 60 characters or fewer.")
    expect(checkFeedForm({ url: FEED_A, label: `${"a".repeat(59)}🇳🇬` }, empty).label).toBe("Use 60 characters or fewer.")
  })
})
