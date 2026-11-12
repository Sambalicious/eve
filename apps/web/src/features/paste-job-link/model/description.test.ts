import { describe, expect, it } from "vitest"

import type { JobPosting, PasteResult } from "@/entities/job-posting"
import { descriptionLength, isDescriptionOverLimit, pasteFieldProblems, pasteRequestOf } from "./description"
import { descriptionResultLine } from "./description-result"
import { pasteCopy } from "./paste-copy"

const TEXT = "About the role. ".repeat(20) // 320 characters
const fields = (o: Partial<{ link: string; description: string; title: string; company: string }> = {}) => ({
  link: "",
  description: TEXT,
  title: "Senior Frontend Engineer",
  company: "Paystack",
  ...o,
})

describe("pasteFieldProblems: design r1 client validation order (PD-1.1, PD-1.3, PD-1.4)", () => {
  it("PD:112 both blank → C-PD-20 on the link only", () => {
    expect(pasteFieldProblems(fields({ description: " \n\t ", title: "", company: "" }))).toEqual({ link: "Paste a link or the job description." })
  })

  it("an invalid link with a description is the existing link error, checked with the fields", () => {
    expect(pasteFieldProblems(fields({ link: "boards.greenhouse.io/x", description: "short", title: "" }))).toEqual({
      link: "Enter a full link that starts with https:// or http://.",
      description: "Too short to check. Paste the full description, at least 200 characters.",
    })
  })

  it("PD:191 a description-only paste needs a Job title and a Company", () => {
    expect(pasteFieldProblems(fields({ title: "  ", company: "" }))).toEqual({ title: "Enter the job title.", company: "Enter the company." })
  })

  it("PD:205 with a link the client sends names as typed and the server decides", () => {
    expect(pasteFieldProblems(fields({ link: "https://www.linkedin.com/jobs/view/4012345678", title: "", company: "" }))).toEqual({})
  })

  it("PD:222 names over 200 after cleaning are refused, never cut, with or without a link", () => {
    const long = "x".repeat(201)
    expect(pasteFieldProblems(fields({ link: "https://jobs.lever.co/acme/1", title: long, company: long }))).toEqual({
      title: "Job title is over 200 characters. Shorten it.",
      company: "Company is over 200 characters. Shorten it.",
    })
    expect(pasteFieldProblems(fields({ title: "x".repeat(200) }))).toEqual({})
  })

  it("PD:133 the bounds apply after normalising: 199 refused, 200 and 30,000 accepted, 30,001 refused", () => {
    expect(pasteFieldProblems(fields({ description: `  ${"a".repeat(199)}  ` })).description).toBe(
      "Too short to check. Paste the full description, at least 200 characters."
    )
    expect(pasteFieldProblems(fields({ description: "a".repeat(200) }))).toEqual({})
    expect(pasteFieldProblems(fields({ description: "a".repeat(30_000) }))).toEqual({})
    expect(pasteFieldProblems(fields({ description: "a".repeat(30_001) })).description).toBe(
      "Over the 30,000-character limit. Shorten it to check this job."
    )
  })
})

describe("descriptionLength and the over-limit check (C-PD-6)", () => {
  it("counts the normalised text: CRLF is one character, outer spaces don't count", () => {
    expect(descriptionLength("  a\r\nb  ")).toBe(3)
    expect(isDescriptionOverLimit("a".repeat(30_000))).toBe(false)
    expect(isDescriptionOverLimit("a".repeat(30_001))).toBe(true)
  })

  it("formats the counter with grouped digits and its accessible text", () => {
    expect(pasteCopy.count(0)).toBe("0 / 30,000")
    expect(pasteCopy.count(1240)).toBe("1,240 / 30,000")
    expect(pasteCopy.countSr(31204)).toBe("31,204 of 30,000 characters")
  })
})

describe("pasteRequestOf (PD-1.2, I-1)", () => {
  it("PD:99 a description of only spaces and line breaks with a link is a link-only paste: exactly { url }", () => {
    expect(pasteRequestOf(fields({ link: " https://jobs.lever.co/acme/1 ", description: " \n \n " }))).toEqual({ url: "https://jobs.lever.co/acme/1" })
  })

  it("a description-only paste sends no url key", () => {
    expect(pasteRequestOf(fields())).toEqual({ description: TEXT, title: "Senior Frontend Engineer", company: "Paystack" })
  })

  it("blank names are left out rather than sent empty", () => {
    expect(pasteRequestOf(fields({ link: "https://jobs.lever.co/acme/1", title: " ", company: "" }))).toEqual({
      url: "https://jobs.lever.co/acme/1",
      description: TEXT,
    })
  })
})

describe("descriptionResultLine: one line per descriptionOutcome and waitingReason (design r1 B1 table)", () => {
  const posting = { id: "p-1" } as JobPosting
  const result = (o: Partial<PasteResult>): PasteResult => ({
    created: true,
    posting,
    descriptionOutcome: "stored",
    applicationId: null,
    waitingReason: null,
    ...o,
  })
  const NOW = new Date("2026-11-02T10:00:00Z")

  it.each([
    ["stored", "Saved from your description. Eve is checking it.", false],
    ["stored_lookup_failed", "Eve couldn't read the employer's page, so it used your description. You'll apply to this one yourself.", false],
    ["attached", "Your description is now on the Job Posting you already had. Eve is checking it again.", false],
    ["replaced", "Your description is now on the Job Posting you already had. Eve is checking it again.", false],
    ["already_pasted", "You already have this Job Posting. Nothing changed.", true],
    ["employer_page_used", "Eve read the job from the employer's page and used that. Your description wasn't saved.", false],
  ] as const)("%s → its line, the status badge and View it", (outcome, text, keepValues) => {
    expect(descriptionResultLine(result({ descriptionOutcome: outcome }), NOW)).toEqual({
      text,
      badgePosting: posting,
      link: { to: "/postings/p-1", label: "View it" },
      keepValues,
    })
  })

  it("unchanged_has_application → C-PD-34 with 'Go to that Application', no posting badge, values kept", () => {
    expect(descriptionResultLine(result({ descriptionOutcome: "unchanged_has_application", applicationId: "a-9" }), NOW)).toEqual({
      text: "You already have an Application for this job. Its description, documents and ATS score are unchanged.",
      badgePosting: null,
      link: { to: "/applications/a-9", label: "Go to that Application" },
      keepValues: true,
    })
  })

  it.each(["stored", "stored_lookup_failed", "attached", "replaced"] as const)(
    "SAFE:152 cost_pause replaces the %s line with C-PD-36 dated the 1st of next month WAT",
    (outcome) => {
      expect(descriptionResultLine(result({ descriptionOutcome: outcome, waitingReason: "cost_pause" }), NOW)?.text).toBe(
        "Saved. Eve checks it when paid automation resumes on 1 Dec 2026, or sooner if the ceiling is raised."
      )
    }
  )

  it("SAFE:152 in December the resume date is 1 Jan of the next year", () => {
    expect(descriptionResultLine(result({ waitingReason: "cost_pause" }), new Date("2026-12-31T22:30:00Z"))?.text).toContain("on 1 Jan 2027,")
  })

  it("SAFE:195 checks_not_enabled → C-PD-37", () => {
    expect(descriptionResultLine(result({ waitingReason: "checks_not_enabled" }), NOW)?.text).toBe(
      "Saved. It's checked once the person who runs your Eve turns on checks for you."
    )
  })

  it("link-only (null) has no description line", () => {
    expect(descriptionResultLine(result({ descriptionOutcome: null }), NOW)).toBeNull()
  })
})
