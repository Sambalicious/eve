import { describe, expect, it } from "vitest"

import { renderDailySummary } from "../src/notification/email-content.js"

/**
 * QA test authoring (gate gap), EPIC-0011 ST:202 / AC-4.6 (status-words.r1.feature, "The daily summary email uses the new
 * posting words"): "Given 2 skipped and 1 excluded posting today, when the daily summary email is built, then it describes
 * them as 'Not a match' and the words 'Skipped' and 'Excluded' do not appear for postings."
 * Pure render, no database. ST:209 ("other email wording is unchanged") is covered by the notification suites, unedited.
 */
const BASE = "https://dashboard.test"
const input = {
  watDay: "2026-11-07",
  automaticToday: 0,
  submitted: [],
  blockedCount: 0,
  uncertainCount: 0,
  uncertain: [],
  failures: [],
  skipped: [
    { role: "Senior Frontend Engineer", company: "Acme", reason: "Your profile backs only 40% of the core responsibilities.", manualPossible: false },
    { role: "Backend Engineer", company: "Globex", reason: "The title doesn't contain your saved keyword.", manualPossible: false },
    { role: "Mobile Engineer", company: "Initech", reason: "Mobile is outside the role families you picked.", manualPossible: false },
  ],
  globalPaused: false,
  costPaused: false,
  costResumedToday: false,
  spend: null,
} as const

describe("ST:202 the daily summary uses the new posting words", () => {
  const email = renderDailySummary(input, BASE)

  it("describes the 3 ruled-out postings as Not a match", () => {
    expect(email.text).toMatch(/Not a match/)
    expect(email.html).toMatch(/Not a match/)
  })

  it("shows neither Skipped nor Excluded as a posting word, in the heading, the lines or the preheader/summary line", () => {
    for (const body of [email.text, email.html, email.subject]) {
      expect(body).not.toMatch(/\bSkipped\b/)
      expect(body).not.toMatch(/\bExcluded\b/)
      expect(body).not.toMatch(/\b\d+ skipped\b/)
    }
  })
})
