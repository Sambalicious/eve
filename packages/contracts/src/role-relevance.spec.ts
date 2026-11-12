import { describe, expect, it } from "vitest"

import {
  DEFAULT_SENIORITY_FLOOR,
  DEFAULT_TARGET_ROLE_FAMILIES,
  JOB_POSTINGS_CHECK_AGAIN_PATH,
  checkAgainRequestSchema,
  checkAgainResponseSchema,
  hiddenCountsSchema,
  hiddenReasonSchema,
  jobPostingStatusSchema,
  jobPostingSummarySchema,
  jobPostingsQuerySchema,
  jobPostingsResponseSchema,
  postedDateKindSchema,
  roleFamilySchema,
  seniorityFloorSchema,
  waitingReasonSchema,
} from "./discovery.js"
import { apiErrorCodeSchema, apiErrorResponseSchema } from "./errors.js"
import { DEFAULT_JOB_CRITERIA, jobCriteriaFieldErrors, jobCriteriaRequestSchema, jobCriteriaResponseSchema } from "./job-criteria.js"

/** EPIC-0006 api-contract.r1 v1.18.0. Expected values are copied from the contract, not derived from the schemas. */
const THIRTEEN = [
  "senior_frontend", "technical_lead", "fullstack", "product_engineering", "software_engineering",
  "backend", "mobile", "platform_engineering", "devops_platform", "people_management",
  "data_ml", "solutions_customer", "other",
]
const NINE_DEFAULTS = [
  "senior_frontend", "technical_lead", "fullstack", "product_engineering", "software_engineering",
  "backend", "mobile", "platform_engineering", "people_management",
]

describe("v1.18.0 shared schemas (AC-1.1, 1.2, 1.6, 2.1)", () => {
  it("role families are the 13 keys in AC-1.2 display order", () => {
    expect(roleFamilySchema.options).toEqual(THIRTEEN)
  })

  it("the default targets are the nine AC-1.6 families and the floor hides entry level", () => {
    expect([...DEFAULT_TARGET_ROLE_FAMILIES]).toEqual(NINE_DEFAULTS)
    expect(DEFAULT_SENIORITY_FLOOR).toBe("hide_entry_level")
    expect(Object.isFrozen(DEFAULT_TARGET_ROLE_FAMILIES)).toBe(true)
    expect(DEFAULT_JOB_CRITERIA).toEqual({ minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: NINE_DEFAULTS, seniorityFloor: "hide_entry_level" })
  })

  it("status gains not_checked; hidden reasons, date kinds, floors and waiting reasons are fixed enums", () => {
    expect(jobPostingStatusSchema.options).toEqual(["checking", "waiting_to_be_checked", "not_checked", "ranked", "excluded", "skipped", "evaluation_failed"])
    expect(hiddenReasonSchema.options).toEqual(["off_target", "below_seniority_floor", "undated", "older_than_60_days"])
    expect(postedDateKindSchema.options).toEqual(["published", "updated"])
    expect(seniorityFloorSchema.options).toEqual(["all_levels", "hide_entry_level"])
    expect(waitingReasonSchema.options).toEqual(["cost_pause", "checks_not_enabled"])
  })

  it("hidden counts are strict non-negative integers", () => {
    const counts = { offTarget: 1, belowSeniorityFloor: 0, undated: 2, olderThan60Days: 0, total: 3 }
    expect(hiddenCountsSchema.safeParse(counts).success).toBe(true)
    expect(hiddenCountsSchema.safeParse({ ...counts, total: -1 }).success).toBe(false)
    expect(hiddenCountsSchema.safeParse({ ...counts, extra: 0 }).success).toBe(false)
  })

  it("posting_hidden is an error code after rate_limited_global", () => {
    const codes: readonly string[] = apiErrorCodeSchema.options
    // Run a2e merge: EPIC-0002 A2's v1.21.0 `feature_not_yet_available` now follows it (me.spec.ts).
    const at = codes.indexOf("posting_hidden")
    expect(at).toBeGreaterThan(0)
    expect(codes[at - 1]).toBe("rate_limited_global")
    // v1.24.0 (apply anyway bounds) appends five after A2's code, v1.25.0 (EPIC-0002 B1) two more, v1.27.0 (EPIC-0010) nine, v1.28.0 (EPIC-0011) one, and v1.31.0 (EPIC-0014) one.
    expect(codes.slice(at + 1)).toEqual(["feature_not_yet_available", "override_not_allowed", "override_acknowledgement_missing", "override_decision_changed", "override_application_state", "sample_not_allowed", "preferences_stale", "timezone_change_rate_limited", "job_description_too_short", "job_description_too_long", "job_title_required", "job_title_too_long", "company_required", "company_too_long", "employer_page_unreadable", "posting_still_checking", "manual_application_only", "advanced_locked", "outreach_reader_name_invalid"])
  })

  it("the families query accepts every one of the 13 keys", () => {
    expect(jobPostingsQuerySchema.parse({ families: THIRTEEN.join(",") }).families).toEqual(THIRTEEN)
    expect(jobPostingsQuerySchema.safeParse({ families: "robotics" }).success).toBe(false)
  })
})

const summary = {
  id: "8f0b2b1e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
  title: "Senior Frontend Engineer",
  company: "Acme",
  applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
  requisitionId: "1",
  applicationSystem: "Greenhouse",
  applyUrl: "https://boards.greenhouse.io/acme/jobs/1",
  applyMode: "automatic",
  origin: "employer_board",
  attribution: null,
  status: "not_checked",
  skipReason: null,
  skipDetail: null,
  evaluationFailure: null,
  roleFamily: "data_ml",
  rank: null,
  unverifiedLabels: [],
  match: null,
  technologiesNotChecked: false,
  discoveredAt: "2026-10-20T08:00:00.000Z",
  postedAt: "2026-09-23T22:30:00.000Z",
  postedOn: "2026-09-23",
  postedDateKind: "published",
  ageDays: 31,
  hiddenReason: null,
}

describe("v1.18.0 JobPostingSummary and JobPostingsResponse", () => {
  it("requires postedAt, postedOn, postedDateKind, ageDays and hiddenReason", () => {
    expect(jobPostingSummarySchema.safeParse(summary).success).toBe(true)
    for (const key of ["postedAt", "postedOn", "postedDateKind", "ageDays", "hiddenReason"]) {
      const rest: Record<string, unknown> = { ...summary }
      delete rest[key]
      expect(jobPostingSummarySchema.safeParse(rest).success, key).toBe(false)
    }
    expect(jobPostingSummarySchema.safeParse({ ...summary, postedAt: null, postedOn: null, postedDateKind: null, ageDays: null, hiddenReason: "undated" }).success).toBe(true)
    expect(jobPostingSummarySchema.safeParse({ ...summary, ageDays: -1 }).success).toBe(false)
    expect(jobPostingSummarySchema.safeParse({ ...summary, postedOn: "23/09/2026" }).success).toBe(false)
  })

  const response = {
    postings: [summary],
    waitingToBeCheckedCount: 0,
    nextCursor: null,
    totalCount: 1,
    criteriaEmptyState: false,
    hiddenCounts: { offTarget: 0, belowSeniorityFloor: 0, undated: 0, olderThan60Days: 0, total: 0 },
    recheckableCount: 1,
    targetRoleFamilies: NINE_DEFAULTS,
    waitingReason: null,
  }

  it("requires hiddenCounts, recheckableCount, targetRoleFamilies and waitingReason", () => {
    expect(jobPostingsResponseSchema.safeParse(response).success).toBe(true)
    for (const key of ["hiddenCounts", "recheckableCount", "targetRoleFamilies", "waitingReason"]) {
      const rest: Record<string, unknown> = { ...response }
      delete rest[key]
      expect(jobPostingsResponseSchema.safeParse(rest).success, key).toBe(false)
    }
    expect(jobPostingsResponseSchema.safeParse({ ...response, waitingToBeCheckedCount: 2, waitingReason: "checks_not_enabled" }).success).toBe(true)
    expect(jobPostingsResponseSchema.safeParse({ ...response, targetRoleFamilies: [] }).success).toBe(false)
  })
})

describe("v1.18.0 POST /v1/job-postings/check-again", () => {
  it("has the path constant", () => {
    expect(JOB_POSTINGS_CHECK_AGAIN_PATH).toBe("/v1/job-postings/check-again")
  })

  it.each([[{}, true], [{ postingIds: [] }, false], [{ candidateId: "x" }, false], [[], false], [null, false], ["x", false]])("request %j -> %s", (body, ok) => {
    expect(checkAgainRequestSchema.safeParse(body).success).toBe(ok)
  })

  it("responds with queued and movedTo only", () => {
    expect(checkAgainResponseSchema.safeParse({ queued: 4, movedTo: "checking" }).success).toBe(true)
    expect(checkAgainResponseSchema.safeParse({ queued: 0, movedTo: "waiting_to_be_checked" }).success).toBe(true)
    expect(checkAgainResponseSchema.safeParse({ queued: 4 }).success).toBe(false)
    expect(checkAgainResponseSchema.safeParse({ queued: -1, movedTo: "checking" }).success).toBe(false)
    expect(checkAgainResponseSchema.safeParse({ queued: 1, movedTo: "checking", ids: [] }).success).toBe(false)
  })
})

describe("v1.18.0 Job criteria targets and floor (AC-1.5, 1.9, 2.1)", () => {
  const body = { minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: ["senior_frontend"], seniorityFloor: "all_levels" }
  const errorsFor = (value: unknown) => {
    const parsed = jobCriteriaRequestSchema.safeParse(value)
    return jobCriteriaFieldErrors(value, parsed.success ? [] : parsed.error.issues)
  }
  const fam = (position: number | null, problem: string) => ({ field: "targetRoleFamilies", position, problem })
  const floor = { field: "seniorityFloor", position: null, problem: "invalid" }

  it("stores families in catalog order whatever order they arrive in", () => {
    expect(jobCriteriaRequestSchema.parse({ ...body, targetRoleFamilies: ["other", "data_ml", "senior_frontend"] }).targetRoleFamilies).toEqual(["senior_frontend", "data_ml", "other"])
    expect(jobCriteriaRequestSchema.parse({ ...body, targetRoleFamilies: [...THIRTEEN].reverse() }).targetRoleFamilies).toEqual(THIRTEEN)
  })

  it.each<[string, unknown, unknown[]]>([
    ["a valid body", body, []],
    ["families missing", { ...body, targetRoleFamilies: undefined }, [fam(null, "invalid")]],
    ["families null", { ...body, targetRoleFamilies: null }, [fam(null, "invalid")]],
    ["families a string", { ...body, targetRoleFamilies: "backend" }, [fam(null, "invalid")]],
    ["families a number", { ...body, targetRoleFamilies: 3 }, [fam(null, "invalid")]],
    ["families an object", { ...body, targetRoleFamilies: { a: 1 } }, [fam(null, "invalid")]],
    ["families a boolean", { ...body, targetRoleFamilies: true }, [fam(null, "invalid")]],
    ["families empty", { ...body, targetRoleFamilies: [] }, [fam(null, "too_few_entries")]],
    ["14 families", { ...body, targetRoleFamilies: [...THIRTEEN, "other"] }, [fam(null, "too_many_entries")]],
    ["14 unknown families", { ...body, targetRoleFamilies: Array.from({ length: 14 }, () => "robotics") }, [fam(null, "too_many_entries")]],
    [
      "unknown keys",
      { ...body, targetRoleFamilies: ["robotics", "Senior_Frontend", "senior-frontend", "frontend", ""] },
      [fam(1, "unknown_entry"), fam(2, "unknown_entry"), fam(3, "unknown_entry"), fam(4, "unknown_entry"), fam(5, "unknown_entry")],
    ],
    ["non-string entries", { ...body, targetRoleFamilies: [null, 1, true, [], {}] }, [1, 2, 3, 4, 5].map((n) => fam(n, "invalid"))],
    ["a duplicate", { ...body, targetRoleFamilies: ["backend", "mobile", "backend"] }, [fam(3, "duplicate_entry")]],
    ["floor missing", { ...body, seniorityFloor: undefined }, [floor]],
    ["floor null", { ...body, seniorityFloor: null }, [floor]],
    ["floor empty", { ...body, seniorityFloor: "" }, [floor]],
    ["floor true", { ...body, seniorityFloor: true }, [floor]],
    ["floor unknown", { ...body, seniorityFloor: "senior_and_above" }, [floor]],
    ["both wrong", { ...body, targetRoleFamilies: [], seniorityFloor: "x" }, [fam(null, "too_few_entries"), floor]],
    ["an unknown key with a bad family", { ...body, targetRoleFamilies: [], candidateId: "x" }, []],
    ["a version key", { ...body, version: 3 }, []],
  ])("%s", (_name, value, expected) => {
    expect(errorsFor(value)).toEqual(expected)
  })

  it("the envelope accepts the new fields and problems", () => {
    const base = { code: "bad_request", message: "The request is not valid." }
    expect(apiErrorResponseSchema.safeParse({ error: { ...base, fieldErrors: [fam(null, "too_few_entries"), fam(2, "unknown_entry"), floor] } }).success).toBe(true)
  })

  it("the response carries targets and floor", () => {
    const response = { minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: NINE_DEFAULTS, seniorityFloor: "hide_entry_level", version: 1 }
    expect(jobCriteriaResponseSchema.safeParse(response).success).toBe(true)
    expect(jobCriteriaResponseSchema.safeParse({ ...response, seniorityFloor: undefined }).success).toBe(false)
    expect(jobCriteriaResponseSchema.safeParse({ ...response, targetRoleFamilies: [] }).success).toBe(false)
  })
})
