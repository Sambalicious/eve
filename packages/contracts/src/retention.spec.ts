import { describe, expect, it } from "vitest"

import { applicationSummarySchema } from "./documents.js"
import { applicationsRetentionFilterSchema, minimalRecordSchema, retentionResponseSchema } from "./records.js"

const retention = {
  rule: { months: 12 },
  dueNext30Days: { count: 3, earliestOn: "2026-10-24" },
  overdueDue: { count: 0 },
  waitingForDecision: { count: 1 },
  graceEndsOn: null,
  lastRun: { watDate: "2026-10-20", outcome: "completed", deletedCount: 2 },
  lastFailure: null,
}

describe("v1.17.0 automatic expiry contract (E5.3, E5.6, E5.7)", () => {
  it("retentionResponseSchema accepts the documented shape, including the empty state", () => {
    expect(retentionResponseSchema.parse(retention)).toEqual(retention)
    const empty = { ...retention, dueNext30Days: { count: 0, earliestOn: null }, waitingForDecision: { count: 0 }, graceEndsOn: "2026-12-01", lastRun: null, lastFailure: { watDate: "2026-10-20" } }
    expect(retentionResponseSchema.parse(empty)).toEqual(empty)
  })

  it("retentionResponseSchema refuses extra fields, instants for dates, a running outcome and negative counts", () => {
    expect(retentionResponseSchema.safeParse({ ...retention, companies: ["Acme"] }).success).toBe(false)
    expect(retentionResponseSchema.safeParse({ ...retention, graceEndsOn: "2026-12-01T00:00:00Z" }).success).toBe(false)
    expect(retentionResponseSchema.safeParse({ ...retention, lastRun: { ...retention.lastRun, outcome: "running" } }).success).toBe(false)
    expect(retentionResponseSchema.safeParse({ ...retention, overdueDue: { count: -1 } }).success).toBe(false)
    expect(retentionResponseSchema.safeParse({ ...retention, rule: { months: 6 } }).success).toBe(false)
  })

  it("MinimalRecord.deletedBy is candidate or expiry", () => {
    const record = { applicationId: "6f1c2a4e-0000-4000-8000-000000000001", company: "Acme Payments", applicationUrl: "https://boards.greenhouse.io/acme/jobs/1042", requisitionId: "R-1042", createdAt: "2025-10-20T08:15:00.000Z", detailsDeletedAt: "2026-10-20T02:00:00.000Z", finalStatus: "rejection" }
    expect(minimalRecordSchema.parse({ ...record, deletedBy: "expiry" }).deletedBy).toBe("expiry")
    expect(minimalRecordSchema.parse({ ...record, deletedBy: "candidate" }).deletedBy).toBe("candidate")
    expect(minimalRecordSchema.safeParse({ ...record, deletedBy: "system" }).success).toBe(false)
  })

  it("ApplicationSummary.expiresOn is a calendar date or null", () => {
    const summary = {
      id: "6f1c2a4e-0000-4000-8000-000000000001",
      jobPostingId: "6f1c2a4e-0000-4000-8000-000000000002",
      company: "Acme Payments",
      roleTitle: "Senior Backend Engineer",
      requisitionId: "R-1042",
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/1042",
      // v1.27.0 (EPIC-0010): required on every summary.
      pastedDescription: false,
      manualOnly: false,
      state: "documents_ready",
      careerProfileVersion: 1,
      blockedDocument: null,
      blockedClaim: null,
      failure: null,
      coverLetterStatus: "not_submitted",
      createdAt: "2025-10-19T23:30:00.000Z",
      updatedAt: "2025-10-19T23:30:00.000Z",
      detailsDeletedAt: null,
      override: null,
    }
    expect(applicationSummarySchema.parse({ ...summary, expiresOn: "2026-10-20" }).expiresOn).toBe("2026-10-20")
    expect(applicationSummarySchema.parse({ ...summary, expiresOn: null }).expiresOn).toBeNull()
    expect(applicationSummarySchema.safeParse({ ...summary, expiresOn: "2026-10-20T00:00:00Z" }).success).toBe(false)
  })

  it("the retention filter takes exactly due and waiting", () => {
    expect(applicationsRetentionFilterSchema.options).toEqual(["due", "waiting"])
    for (const value of ["overdue", "DUE", "", "due,waiting"]) expect(applicationsRetentionFilterSchema.safeParse(value).success).toBe(false)
  })
})
