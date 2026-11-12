import { describe, expect, it } from "vitest"

import { applicationListItemSchema, applicationsResponseSchema, boardOutcomeTypeSchema } from "./application-board.js"
import { applicationSummarySchema } from "./documents.js"
import { ADVANCED_ERROR_MESSAGES, apiErrorCodeSchema, apiErrorResponseSchema } from "./errors.js"
import { ME_ADVANCED_PATH, ME_PATH, meNoteDismissPath, meNoteSchema, meResponseSchema, setAdvancedRequestSchema } from "./me.js"
import { outcomeRequestSchema, outcomeTypeSchema } from "./records.js"

/** EPIC-0011 Simplify Eve, contract v1.28.0. Expected values come from the contract handoff, not the schemas. */
const KOFI = "5b7c2a1e-3f4d-4e6a-9b8c-1d2e3f4a5b6c"
const APP = "3c9a2f1e-5b6d-4c1a-9e2f-7a8b9c0d1e2f"
const OUTCOME = "a1b2c3d4-0000-4000-8000-000000000001"

const me = {
  candidateId: KOFI,
  email: "kofi@example.test",
  isOperator: false,
  capabilities: {
    submission: "not_yet",
    notifications: "not_yet",
    spend: "not_yet",
  },
  advancedEnabled: false,
  advancedLocked: false,
  simplerNoteDue: true,
  improveListDismissed: false,
}

const summary = {
  id: APP,
  jobPostingId: "8b0e1a2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c",
  company: "Paystack",
  roleTitle: "Senior Frontend Engineer",
  requisitionId: "4012345",
  applicationUrl: "https://boards.greenhouse.io/paystack/jobs/4012345",
  pastedDescription: false,
  manualOnly: false,
  state: "prepared",
  careerProfileVersion: null,
  blockedDocument: null,
  blockedClaim: null,
  failure: null,
  coverLetterStatus: "not_submitted",
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-07T10:05:00.000Z",
  detailsDeletedAt: null,
  expiresOn: "2027-11-01",
  override: null,
}
const board = {
  submissionState: null,
  submissionKind: null,
  sampleState: null,
  latestOutcome: null,
  requestForAction: false,
}

describe("v1.28.0 C1 offer Outcome type", () => {
  it("appends offer last without moving a value", () => {
    expect(outcomeTypeSchema.options).toEqual(["confirmation", "rejection", "interview_invitation", "request_for_action", "offer"])
    expect(outcomeRequestSchema.parse({ type: "offer" })).toEqual({
      type: "offer",
    })
    expect(outcomeRequestSchema.safeParse({ type: "promotion" }).success).toBe(false)
    expect(outcomeRequestSchema.safeParse({ type: "offer", extra: 1 }).success).toBe(false)
  })
})

describe("v1.28.0 C2 GET /v1/me, PUT /v1/me/advanced, note dismissal", () => {
  it("paths and note names", () => {
    expect(ME_PATH).toBe("/v1/me")
    expect(ME_ADVANCED_PATH).toBe("/v1/me/advanced")
    expect(meNoteSchema.options).toEqual(["simpler_now", "improve_results"])
    expect(meNoteDismissPath("improve_results")).toBe("/v1/me/notes/improve_results/dismiss")
    expect(meNoteSchema.safeParse("everything").success).toBe(false)
  })

  it("requires the four new keys and refuses unknown ones", () => {
    expect(meResponseSchema.parse(me)).toEqual(me)
    for (const key of ["advancedEnabled", "advancedLocked", "simplerNoteDue", "improveListDismissed"] as const) {
      const rest: Record<string, unknown> = { ...me }
      delete rest[key]
      expect(meResponseSchema.safeParse(rest).success).toBe(false)
      expect(meResponseSchema.safeParse({ ...me, [key]: "yes" }).success).toBe(false)
    }
    expect(meResponseSchema.safeParse({ ...me, extra: 1 }).success).toBe(false)
  })

  it("setAdvancedRequestSchema takes only a boolean enabled", () => {
    expect(setAdvancedRequestSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    })
    for (const bad of [{}, { enabled: null }, { enabled: "true" }, { enabled: 1 }, { enabled: true, candidateId: KOFI }]) {
      expect(setAdvancedRequestSchema.safeParse(bad).success).toBe(false)
    }
  })

  it("advanced_locked keeps its exact message after the v1.31.0 code", () => {
    // v1.31.0 (EPIC-0014) appends `outreach_reader_name_invalid` after it.
    expect(apiErrorCodeSchema.options.at(-2)).toBe("advanced_locked")
    expect(apiErrorCodeSchema.options.at(-1)).toBe("outreach_reader_name_invalid")
    expect(ADVANCED_ERROR_MESSAGES.advanced_locked).toBe("Advanced stays on while automatic applying is on. Turn off automatic applying first.")
    expect(
      apiErrorResponseSchema.safeParse({
        error: {
          code: "advanced_locked",
          message: ADVANCED_ERROR_MESSAGES.advanced_locked,
        },
      }).success
    ).toBe(true)
  })
})

describe("v1.28.0 C4 applications list row", () => {
  it("board outcome type excludes request_for_action", () => {
    expect(boardOutcomeTypeSchema.options).toEqual(["confirmation", "rejection", "interview_invitation", "offer"])
  })

  it("requires the five board keys", () => {
    expect(applicationListItemSchema.parse({ ...summary, ...board })).toEqual({
      ...summary,
      ...board,
    })
    for (const key of Object.keys(board)) {
      const rest: Record<string, unknown> = { ...summary, ...board }
      delete rest[key]
      expect(applicationListItemSchema.safeParse(rest).success).toBe(false)
    }
  })

  it("accepts a filled row and refuses bad values", () => {
    const full = {
      ...summary,
      submissionState: "manual",
      submissionKind: null,
      sampleState: "rejected",
      latestOutcome: {
        id: OUTCOME,
        type: "offer",
        createdAt: "2026-11-06T12:00:00.000Z",
      },
      requestForAction: true,
    }
    expect(applicationListItemSchema.parse(full)).toEqual(full)
    expect(
      applicationListItemSchema.safeParse({
        ...full,
        latestOutcome: { ...full.latestOutcome, type: "request_for_action" },
      }).success
    ).toBe(false)
    expect(
      applicationListItemSchema.safeParse({
        ...full,
        latestOutcome: { ...full.latestOutcome, extra: 1 },
      }).success
    ).toBe(false)
    expect(applicationListItemSchema.safeParse({ ...full, submissionKind: "manual" }).success).toBe(false)
    expect(applicationListItemSchema.safeParse({ ...full, sampleState: "pending" }).success).toBe(false)
    expect(applicationListItemSchema.safeParse({ ...full, extra: 1 }).success).toBe(false)
  })

  it("the list wraps list items while ApplicationSummary is unchanged", () => {
    expect(
      applicationsResponseSchema.parse({
        applications: [{ ...summary, ...board }],
      }).applications
    ).toHaveLength(1)
    expect(applicationsResponseSchema.safeParse({ applications: [summary] }).success).toBe(false)
    expect(applicationSummarySchema.safeParse(summary).success).toBe(true)
    expect(applicationSummarySchema.safeParse({ ...summary, ...board }).success).toBe(false)
  })
})
