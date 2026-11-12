import { describe, expect, it } from "vitest"

import { ApiError } from "@/shared/api"
import { toUploadRefusal } from "./use-upload-resume"

describe("toUploadRefusal", () => {
  it.each([
    [new ApiError(422, "resume_unreadable", "m", "docx_limits"), { kind: "unreadable", reason: "docx_limits" }],
    [new ApiError(422, "resume_unreadable", "m"), { kind: "unreadable", reason: null }],
    [new ApiError(422, "resume_file_invalid", "m"), { kind: "wrong_file" }],
    [new ApiError(413, "payload_too_large", "m"), { kind: "wrong_file" }],
    [new ApiError(503, "resume_storage_unavailable", "m"), { kind: "storage_unavailable" }],
    [new ApiError(503, "ai_provider_not_configured", "m"), { kind: "not_configured" }],
    [new ApiError(409, "ai_provider_not_approved", "m"), { kind: "not_approved" }],
    [new ApiError(409, "resume_drafting_in_progress", "m"), { kind: "drafting_in_progress" }],
    [new ApiError(409, "career_profile_draft_exists", "m"), { kind: "draft_exists" }],
    [new ApiError(500, "internal_error", "m"), { kind: "failed", action: "upload your resume" }],
    [new ApiError(502, null, "HTTP 502"), { kind: "failed", action: "upload your resume" }],
    [new TypeError("Failed to fetch"), { kind: "failed", action: "upload your resume" }],
  ])("%o → %o", (error, refusal) => {
    expect(toUploadRefusal(error)).toEqual(refusal)
  })
})
