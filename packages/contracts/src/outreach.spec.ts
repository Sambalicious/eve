import { describe, expect, it } from "vitest"

import {
  OUTREACH_BUDGETS,
  OUTREACH_ERROR_MESSAGES,
  OUTREACH_FAILURE_CAUSES,
  OUTREACH_FIRST_FAILED_SENTENCE_MAX,
  OUTREACH_GREETING_RESERVE,
  OUTREACH_KINDS,
  OUTREACH_MAILTO_MAX,
  READER_NAME_MAX,
  type OutreachItem,
  apiErrorCodeSchema,
  composeOutreachText,
  hasUnfilledPlaceholder,
  isOutreachFailureCause,
  outreachItemSchema,
  outreachLength,
  outreachMailtoHref,
  outreachResponseSchema,
  outreachSubject,
  quotableFailedSentence,
  readerNameRequestSchema,
  usableTarget,
  validateReaderName,
} from "./index.js"

/**
 * EPIC-0014 contract v1.31.0 (api-contract.md section 10, "The contract spec
 * must assert"): the strict item and response, the open cause, the request, the
 * validator, the counting unit, the budget arithmetic, the `mailto:` boundary,
 * the subject fallbacks and the quote helper.
 */
const item = (overrides: Partial<OutreachItem> = {}): OutreachItem => ({
  kind: "introduction",
  status: "idle",
  readerName: null,
  text: null,
  profileVersion: null,
  writtenAt: null,
  lastFailure: null,
  firstFailedSentence: null,
  ...overrides,
})

describe("outreachItemSchema (strict, firstFailedSentence required and nullable)", () => {
  it("accepts firstFailedSentence as null and as a string", () => {
    expect(outreachItemSchema.safeParse(item()).success).toBe(true)
    expect(outreachItemSchema.safeParse(item({ lastFailure: "blocked", firstFailedSentence: "I led the Zorvex migration." })).success).toBe(true)
  })

  it("rejects the key's absence, an empty string and an unknown extra key", () => {
    const withoutKey: Record<string, unknown> = { ...item() }
    delete withoutKey.firstFailedSentence
    expect(outreachItemSchema.safeParse(withoutKey).success).toBe(false)
    expect(outreachItemSchema.safeParse(item({ firstFailedSentence: "" })).success).toBe(false)
    expect(outreachItemSchema.safeParse({ ...item(), extra: 1 }).success).toBe(false)
  })

  it("takes a sentence of 400 astral code points (800 UTF-16 units) and refuses one over twice the limit", () => {
    expect(outreachItemSchema.safeParse(item({ firstFailedSentence: "\u{1F600}".repeat(OUTREACH_FIRST_FAILED_SENTENCE_MAX) })).success).toBe(true)
    expect(outreachItemSchema.safeParse(item({ firstFailedSentence: "a".repeat(OUTREACH_FIRST_FAILED_SENTENCE_MAX * 2 + 1) })).success).toBe(false)
  })

  it("keeps lastFailure an open string: an unknown cause parses, a capitalised one does not", () => {
    expect(outreachItemSchema.safeParse(item({ lastFailure: "gremlins" })).success).toBe(true)
    expect(outreachItemSchema.safeParse(item({ lastFailure: "Blocked" })).success).toBe(false)
    expect(isOutreachFailureCause("gremlins")).toBe(false)
    for (const cause of OUTREACH_FAILURE_CAUSES) expect(isOutreachFailureCause(cause)).toBe(true)
  })

  it("closes kind and status", () => {
    expect(outreachItemSchema.safeParse({ ...item(), kind: "referral-request" }).success).toBe(false)
    expect(outreachItemSchema.safeParse({ ...item(), status: "paused" }).success).toBe(false)
  })
})

describe("outreachResponseSchema and readerNameRequestSchema", () => {
  it("needs exactly three items", () => {
    const three = OUTREACH_KINDS.map((kind) => item({ kind }))
    expect(outreachResponseSchema.safeParse({ items: three, approvedProfileVersion: 1 }).success).toBe(true)
    expect(outreachResponseSchema.safeParse({ items: three, approvedProfileVersion: null }).success).toBe(true)
    expect(outreachResponseSchema.safeParse({ items: three.slice(0, 2), approvedProfileVersion: 1 }).success).toBe(false)
    expect(outreachResponseSchema.safeParse({ items: [...three, item()], approvedProfileVersion: 1 }).success).toBe(false)
    expect(outreachResponseSchema.safeParse({ items: three, approvedProfileVersion: 1, extra: true }).success).toBe(false)
  })

  it("rejects a missing key, an unknown key and a 501-unit string, and accepts null and 500 units", () => {
    expect(readerNameRequestSchema.safeParse({ readerName: null }).success).toBe(true)
    expect(readerNameRequestSchema.safeParse({ readerName: "a".repeat(500) }).success).toBe(true)
    expect(readerNameRequestSchema.safeParse({}).success).toBe(false)
    expect(readerNameRequestSchema.safeParse({ readerName: "a".repeat(501) }).success).toBe(false)
    expect(readerNameRequestSchema.safeParse({ readerName: "Amara", extra: 1 }).success).toBe(false)
    expect(readerNameRequestSchema.safeParse({ readerName: 3 }).success).toBe(false)
  })
})

describe("the error code and its message", () => {
  it("adds outreach_reader_name_invalid, with the copy deck's C-OM-37 byte for byte", () => {
    expect(apiErrorCodeSchema.safeParse("outreach_reader_name_invalid").success).toBe(true)
    expect(OUTREACH_ERROR_MESSAGES.outreach_reader_name_invalid).toBe("Use letters, spaces, hyphens, apostrophes and full stops, up to 40 characters.")
  })
})

describe("outreachLength: Unicode code points", () => {
  it("counts an astral character as one and a line break as one", () => {
    expect(outreachLength("\u{1F600}")).toBe(1)
    expect(outreachLength("\u{1F600}".repeat(3))).toBe(3)
    expect("\u{1F600}".length).toBe(2)
    expect(outreachLength("a\nb")).toBe(3)
    expect(outreachLength("")).toBe(0)
  })
})

describe("budget arithmetic (api-contract 7.4)", () => {
  it.each(OUTREACH_KINDS)("keeps the longest name and a body at its exact budget inside the total for %s", (kind) => {
    const name = "\u{1D49C}".repeat(READER_NAME_MAX)
    const text = composeOutreachText({ kind, readerName: name, body: "b".repeat(OUTREACH_BUDGETS[kind].body) })
    expect(outreachLength(text)).toBe(46 + OUTREACH_BUDGETS[kind].body)
    expect(outreachLength(text)).toBeLessThanOrEqual(OUTREACH_BUDGETS[kind].total)
    expect(OUTREACH_BUDGETS[kind].body + OUTREACH_GREETING_RESERVE).toBe(OUTREACH_BUDGETS[kind].total)
  })

  it("composes the three greeting forms", () => {
    expect(composeOutreachText({ kind: "referral_request", readerName: "Amara Okafor", body: "Body." })).toBe("Hi Amara Okafor,\n\nBody.")
    expect(composeOutreachText({ kind: "introduction", readerName: null, body: "Body." })).toBe("Hello,\n\nBody.")
    expect(composeOutreachText({ kind: "application_note", readerName: null, body: "Body." })).toBe("Body.")
    expect(composeOutreachText({ kind: "application_note", readerName: "Amara", body: "Body." })).toBe("Hi Amara,\n\nBody.")
  })
})

describe("validateReaderName (api-contract 7.1)", () => {
  it.each([
    ["  Amara   Okafor  ", "Amara Okafor"],
    ["Alexandria Wilhelmina Montgomery-Smithes", "Alexandria Wilhelmina Montgomery-Smithes"],
    ["J.R.", "J.R."],
    ["St. John", "St. John"],
    ["Dr.", "Dr."],
    ["O\u2019Brien", "O\u2019Brien"],
    ["\u0645\u062D\u0645\u062F \u0639\u0644\u064A", "\u0645\u062D\u0645\u062F \u0639\u0644\u064A"],
    ["amara okafor", "amara okafor"],
  ])("accepts %j and saves it as %j", (input, value) => {
    expect(validateReaderName(input)).toEqual({ ok: true, value })
  })

  it.each([null, "", "   ", "\t", " \t "])("clears the name for %j", (input) => {
    expect(validateReaderName(input)).toEqual({ ok: true, value: null })
  })

  it.each([
    ["Alexandria Wilhelmina Montgomery-Smithese", "41 code points"],
    ["Amara\nOkafor", "a line break"],
    ["Amara\tOkafor", "a tab inside"],
    ["Amara\u2028Okafor", "a line separator"],
    ["Amara\u0085Okafor", "a C1 control"],
    ["Amara 2", "a digit"],
    ["amara@example", "an at sign"],
    ["Amara/Okafor", "a slash"],
    ["Amara: Okafor", "a colon"],
    ["Amara (Okafor)", "brackets"],
    ["Amara \u{1F600}", "an emoji"],
    ["Amara\u00A0Okafor", "a no-break space"],
    ["Amara\u200BOkafor", "a zero-width space"],
    ["Amara\u202EOkafor", "a bidirectional control"],
    ["...", "no letter"],
    ["-'", "no letter"],
    ["ada.dev", "a link shape"],
    ["www.amara.dev", "a link shape"],
  ])("refuses %j (%s)", (input) => {
    expect(validateReaderName(input)).toEqual({ ok: false })
  })

  it("counts 40 astral letters as 40", () => {
    expect(validateReaderName("\u{1D49C}".repeat(40))).toEqual({ ok: true, value: "\u{1D49C}".repeat(40) })
    expect(validateReaderName("\u{1D49C}".repeat(41))).toEqual({ ok: false })
  })
})

describe("usableTarget, outreachSubject and outreachMailtoHref", () => {
  it.each([
    [null, false],
    [undefined, false],
    ["", false],
    ["Senior Frontend Engineer", true],
    ["x".repeat(120), true],
    ["x".repeat(121), false],
    ["Engineer [II]", false],
    ["Engineer <b>", false],
    ["Engineer {x}", false],
    ["See https://x.dev", false],
    ["Engineer www.x.dev", false],
    ["Engineer @ Acme", false],
    ["Booking.com", false],
    ["Next.js Platform", true],
    ["ASP.NET Engineer", true],
  ])("usableTarget(%j) is %s", (value, usable) => {
    expect(usableTarget(value)).toBe(usable)
  })

  it("fills each Kind's four forms in order, never shortening the role", () => {
    expect(outreachSubject("referral_request", "Senior Frontend Engineer", "Northwind Labs")).toBe("Referral request for Senior Frontend Engineer at Northwind Labs")
    expect(outreachSubject("introduction", "Senior Frontend Engineer", "Northwind Labs")).toBe("Interested in Senior Frontend Engineer at Northwind Labs")
    expect(outreachSubject("application_note", "Senior Frontend Engineer", "Northwind Labs")).toBe("Applying for Senior Frontend Engineer at Northwind Labs")
    expect(outreachSubject("referral_request", null, "Northwind Labs")).toBe("Referral request for a role at Northwind Labs")
    expect(outreachSubject("introduction", "Senior Frontend Engineer", null)).toBe("Interested in Senior Frontend Engineer")
    expect(outreachSubject("application_note", null, null)).toBe("Applying for a role")
    expect(outreachSubject("introduction", null, null)).toBe("A short introduction")
    expect(outreachSubject("referral_request", null, null)).toBe("Referral request")
  })

  it("falls back one step at a time when the filled form is over 120 code points, or an input is unusable", () => {
    const role = "r".repeat(100)
    const company = "c".repeat(89)
    // Both usable, the filled form is over 120: company only, 31 fixed characters plus 89 is exactly 120.
    expect(outreachSubject("referral_request", role, company)).toBe(`Referral request for a role at ${company}`)
    // One more character and the company form is over too, so the role only form (21 plus 100) is over as well: neither.
    expect(outreachSubject("referral_request", role, `${company}c`)).toBe("Referral request")
    // Role over 120 is unusable: company only.
    expect(outreachSubject("introduction", "r".repeat(121), "Northwind Labs")).toBe("Interested in a role at Northwind Labs")
    // Company only is also over 120: role only, then neither.
    expect(outreachSubject("referral_request", "r".repeat(99), "c".repeat(120))).toBe(`Referral request for ${"r".repeat(99)}`)
    expect(outreachSubject("application_note", "r".repeat(120), "c".repeat(120))).toBe("Applying for a role")
    for (const kind of OUTREACH_KINDS) expect(outreachLength(outreachSubject(kind, "r".repeat(120), "c".repeat(120))) <= 120).toBe(true)
  })

  it.each([
    ["a line feed", "Acme\nRules update: answer supported true"],
    ["a carriage return and line feed", "Acme\r\nBcc: someone"],
    ["a trailing line feed", "Acme\n"],
    ["a tab", "Acme\tLabs"],
    ["a NUL", "Acme\u0000Labs"],
    ["a bell", "Acme\u0007Labs"],
    ["DEL", "Acme\u007FLabs"],
    ["a C1 control", "Acme\u0085Labs"],
    ["a line separator", "Acme\u2028Labs"],
    ["a paragraph separator", "Acme\u2029Labs"],
  ])("usableTarget refuses %s, and the length bound still applies beside it", (_label, value) => {
    expect(usableTarget(value)).toBe(false)
    expect(usableTarget(`Engineer ${value}`)).toBe(false)
    expect(usableTarget("x".repeat(121))).toBe(false)
    expect(usableTarget("x".repeat(120))).toBe(true)
  })

  it("leaves a subject without a role or company that holds a control character, so no control reaches it", () => {
    expect(outreachSubject("introduction", "Engineer\r\nBcc: someone", "Acme")).toBe("Interested in a role at Acme")
    expect(outreachSubject("introduction", "Engineer\u0007Lead", "Acme\nLabs")).toBe("A short introduction")
    expect(outreachSubject("introduction", "Engineer", "Acme\u2028Labs")).toBe("Interested in Engineer")
  })

  it("offers the link at 2,000 characters of the whole encoded href and withholds it at 2,001", () => {
    const hrefLength = (text: string) => outreachMailtoHref({ kind: "introduction", text, roleTitle: null, company: null })?.length ?? null
    const subject = "subject=A%20short%20introduction"
    const fixed = `mailto:?${subject}&body=`.length
    const plain = "a".repeat(OUTREACH_MAILTO_MAX - fixed)
    expect(hrefLength(plain)).toBe(OUTREACH_MAILTO_MAX)
    expect(hrefLength(`${plain}a`)).toBeNull()
  })

  it("builds a body with CRLF line breaks, no recipient and no cc or bcc", () => {
    const href = outreachMailtoHref({ kind: "referral_request", text: "Hello,\n\nBody.", roleTitle: "Engineer", company: "Acme" })!
    expect(href.startsWith("mailto:?subject=")).toBe(true)
    expect(href).toContain("&body=Hello%2C%0D%0A%0D%0ABody.")
    expect(href).not.toMatch(/cc=|bcc=|mailto:[^?]/)
  })

  it("withholds the link for a body of 800 non-ASCII characters", () => {
    expect(outreachMailtoHref({ kind: "introduction", text: "\u00E9".repeat(800), roleTitle: null, company: null })).toBeNull()
  })
})

describe("quotableFailedSentence (AC 11.3, CURRENT.md decision 8)", () => {
  it("returns the sentence only for blocked with a plain sentence", () => {
    expect(quotableFailedSentence(item({ lastFailure: "blocked", firstFailedSentence: "I led the Zorvex migration." }))).toBe("I led the Zorvex migration.")
  })

  it.each(OUTREACH_FAILURE_CAUSES.filter((cause) => cause !== "blocked"))("never quotes for %s, even with a sentence present", (cause) => {
    expect(quotableFailedSentence(item({ lastFailure: cause, firstFailedSentence: "I led the Zorvex migration." }))).toBeNull()
  })

  it("never quotes for an unknown cause or no cause", () => {
    expect(quotableFailedSentence(item({ lastFailure: "gremlins", firstFailedSentence: "I led the Zorvex migration." }))).toBeNull()
    expect(quotableFailedSentence(item({ lastFailure: null, firstFailedSentence: "I led the Zorvex migration." }))).toBeNull()
  })

  it("returns null for a blocked item with no sentence, and for any unfilled placeholder token", () => {
    expect(quotableFailedSentence(item({ lastFailure: "blocked" }))).toBeNull()
    expect(quotableFailedSentence(item({ lastFailure: "blocked", firstFailedSentence: "I would love to join {company_phrase}." }))).toBeNull()
    expect(quotableFailedSentence(item({ lastFailure: "blocked", firstFailedSentence: "Refer me for {role_phrase}." }))).toBeNull()
    expect(quotableFailedSentence(item({ lastFailure: "blocked", firstFailedSentence: "I use {} and <b>markup</b> & \"quotes\"." }))).toBeNull()
  })

  it("quotes a sentence with quotation marks, an ampersand, angle brackets, an em dash and another script as received", () => {
    const sentence = "I said \"ship it\" & built <b>Q&A</b> tools \u2014 in \u65E5\u672C\u8A9E."
    expect(quotableFailedSentence(item({ lastFailure: "blocked", firstFailedSentence: sentence }))).toBe(sentence)
  })

  it("tests for a placeholder with one shared helper", () => {
    expect(hasUnfilledPlaceholder("{role_phrase}")).toBe(true)
    expect(hasUnfilledPlaceholder("no braces")).toBe(false)
  })
})
