import { describe, expect, it } from "vitest"

import { toDrafting } from "./career-profile-view.js"
import type { ResumeUploadRow, VersionRow } from "./career-profile.repository.js"

const STARTED = new Date("2026-10-16T12:00:00.000Z")
const LATER = new Date("2026-10-16T12:01:00.000Z")
const EARLIER = new Date("2026-10-16T11:59:00.000Z")

function upload(status: ResumeUploadRow["status"], failureReason: string | null): ResumeUploadRow {
  return {
    candidate_id: "c1",
    id: "u1",
    original_filename: "ada.pdf",
    media_type: "application/pdf",
    byte_size: 10,
    sha256: "x",
    storage_name: "u1.pdf",
    status,
    failure_reason: failureReason,
    started_at: STARTED,
    finished_at: status === "drafting" ? null : STARTED,
  }
}

function draftCreatedAt(createdAt: Date): VersionRow {
  return { candidate_id: "c1", version: 1, status: "draft", source: "edit", resume_upload_id: null, sections: [], rejected_fact_count: 0, created_at: createdAt, approved_at: null }
}

// QA-2B-01: which failed attempt GET /v1/career-profile reports.
describe("toDrafting", () => {
  it("shows draft_exists although the draft is newer than the upload (it always is in that race)", () => {
    expect(toDrafting(upload("failed", "draft_exists"), draftCreatedAt(LATER))).toEqual({
      status: "failed",
      filename: "ada.pdf",
      startedAt: STARTED.toISOString(),
      failureReason: "draft_exists",
    })
  })

  it.each(["provider_error", "invalid_output", "no_verified_facts", "timed_out", "storage_error"])(
    "hides a %s failure once a newer draft exists (the Candidate has moved on)",
    (reason) => {
      expect(toDrafting(upload("failed", reason), draftCreatedAt(LATER))).toBeNull()
    }
  )

  it("shows any failure when the draft is older than the upload", () => {
    expect(toDrafting(upload("failed", "provider_error"), draftCreatedAt(EARLIER))?.failureReason).toBe("provider_error")
  })

  it("shows a failure when there is no draft", () => {
    expect(toDrafting(upload("failed", "no_verified_facts"), undefined)?.failureReason).toBe("no_verified_facts")
  })

  it("shows drafting in progress with no reason, and nothing once drafted or with no upload", () => {
    expect(toDrafting(upload("drafting", null), draftCreatedAt(LATER))).toMatchObject({ status: "drafting", failureReason: null })
    expect(toDrafting(upload("drafted", null), draftCreatedAt(LATER))).toBeNull()
    expect(toDrafting(undefined, undefined)).toBeNull()
  })
})
