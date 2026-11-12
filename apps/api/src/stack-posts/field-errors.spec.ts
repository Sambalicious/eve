import { describe, expect, it } from "vitest"

import { registrationFieldErrors, verificationFieldErrors } from "./field-errors.js"

/**
 * v1.15.1: CR-E5-01 (every field error together, future date included),
 * CR-E5-04 (code points after trimming) and SEC-E5-06 (`invalid_characters`).
 * Per field the first that applies: missing, then invalid_characters, then too_long.
 */
const TODAY = "2026-10-21"
const FEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321"
const err = (field: string, problem: string) => ({ field, position: null, problem })

describe("verificationFieldErrors", () => {
  it.each([
    [{ verifiedOn: "2026-10-22", verificationBasis: "   " }, [err("verifiedOn", "future_date"), err("verificationBasis", "missing")]],
    [{ verifiedOn: "2026-02-30", verificationBasis: "b".repeat(501) }, [err("verifiedOn", "invalid"), err("verificationBasis", "too_long")]],
    [{ verifiedOn: "2099-01-01", verificationBasis: "basis\u0000x" }, [err("verifiedOn", "future_date"), err("verificationBasis", "invalid_characters")]],
    [{}, [err("verifiedOn", "missing"), err("verificationBasis", "missing")]],
    [{ verifiedOn: TODAY, verificationBasis: "ok" }, []],
    [{ verifiedOn: "2026-10-22", verificationBasis: "ok" }, [err("verifiedOn", "future_date")]],
  ])("%j -> %j", (body, expected) => {
    expect(verificationFieldErrors(body, TODAY)).toEqual(expected)
  })

  it.each([
    ["basis\u0000x", "invalid_characters"],
    ["\u0000", "invalid_characters"],
    ["Reviewed\u001b[31m terms", "invalid_characters"],
    ["Reviewed\u007f terms", "invalid_characters"],
    ["Reviewed\u000b terms", "invalid_characters"],
    // v1.15.2 (SEC-E5F-02): C1, bidi and invisible characters
    ["Reviewed\u0085 terms", "invalid_characters"],
    ["Reviewed\u202e terms", "invalid_characters"],
    ["Reviewed\u2066 terms", "invalid_characters"],
    ["Reviewed\u200b terms", "invalid_characters"],
    ["Reviewed\ufeff terms", "invalid_characters"],
    [`${"a".repeat(501)}\u2060`, "invalid_characters"],
    ["   ", "missing"],
    [`${"a".repeat(500)}\u0000`, "invalid_characters"],
    [`${"a".repeat(501)}\u0000`, "invalid_characters"],
    ["😀".repeat(501), "too_long"],
    [`${"a".repeat(499)}🇳🇬`, "too_long"],
    [`${"a".repeat(498)}\r\nb`, "too_long"],
  ])("basis %#: %s", (verificationBasis, problem) => {
    expect(verificationFieldErrors({ verifiedOn: "2026-10-20", verificationBasis }, TODAY)).toEqual([err("verificationBasis", problem)])
  })

  it.each(["😀".repeat(500), `     ${"😀".repeat(500)}     `, `${"a".repeat(499)}😀`, "Reviewed\r\nGoogle\tAlerts terms.\n", "Reviewed\u00a0terms \u200c\u200d"])("basis %#: no error", (verificationBasis) => {
    expect(verificationFieldErrors({ verifiedOn: "2026-10-20", verificationBasis }, TODAY)).toEqual([])
  })
})

describe("registrationFieldErrors", () => {
  it.each([
    ["lab\u0000el", "invalid_characters"],
    ["React\tposts", "invalid_characters"],
    ["React\nposts", "invalid_characters"],
    ["React\rposts", "invalid_characters"],
    ["React\u001b[2Jposts", "invalid_characters"],
    ["React\u007fposts", "invalid_characters"],
    // v1.15.2 (SEC-E5F-02): C1, bidi and invisible characters
    ["React\u0085posts", "invalid_characters"],
    ["React\u0080posts", "invalid_characters"],
    ["React\u009fposts", "invalid_characters"],
    ["React\u061cposts", "invalid_characters"],
    ["React\u200eposts", "invalid_characters"],
    ["React\u202eposts", "invalid_characters"],
    ["React\u2069posts", "invalid_characters"],
    ["React\u200bposts", "invalid_characters"],
    ["React\u2060posts", "invalid_characters"],
    ["React\ufeffposts", "invalid_characters"],
    [`${"l".repeat(61)}\u0000`, "invalid_characters"],
    [`${"l".repeat(61)}\u202e`, "invalid_characters"],
    ["😀".repeat(61), "too_long"],
    [`${"a".repeat(59)}🇳🇬`, "too_long"],
  ])("label %j: %s", (label, problem) => {
    expect(registrationFieldErrors({ url: FEED_A, label })).toEqual([err("label", problem)])
  })

  it.each(["😀".repeat(60), `    ${"😀".repeat(60)}    `, `${"a".repeat(59)}😀`, "React\u00a0posts", "Réact 🚀 posts", "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 posts", "👨\u200d👩\u200d👧 posts"])("label %j: no error", (label) => {
    expect(registrationFieldErrors({ url: FEED_A, label })).toEqual([])
  })

  it("reports the URL and label errors together (CR-E5-01)", () => {
    expect(registrationFieldErrors({ url: "https://www.google.com/search?q=react", label: "lab\u0000el" })).toEqual([err("url", "invalid_format"), err("label", "invalid_characters")])
    expect(registrationFieldErrors({ url: "nope", label: "😀".repeat(40) })).toEqual([err("url", "invalid_format")])
  })
})
