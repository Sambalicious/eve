import { describe, expect, it } from "vitest"

import { ApiError } from "@/shared/api"
import { toSaveFailure } from "./use-save-job-criteria"

const RETRY = { kind: "message", message: "Couldn't save your job criteria. Nothing changed. Try again." }

describe("toSaveFailure (design-spec.r1 J2 step 4)", () => {
  it.each([
    ["500 with a message", new ApiError(500, "internal_error", "Something went wrong.")],
    ["503 with a message", new ApiError(503, "service_unavailable", "The service is unavailable. Try again shortly.")],
    ["502 that isn't the envelope", new ApiError(502, null, "HTTP 502")],
    ["a 4xx without a message", new ApiError(403, "csrf_invalid", "")],
    ["a 4xx with a blank message", new ApiError(422, "bad_request", "   ")],
    ["a network failure", new TypeError("Failed to fetch")],
  ])("%s shows the C-JC-SAVE-ERR-NET line", (_, error) => {
    expect(toSaveFailure(error)).toEqual(RETRY)
  })

  it.each([
    ["403 CSRF", new ApiError(403, "csrf_invalid", "The request is missing a valid CSRF token.")],
    ["400 with no field errors", new ApiError(400, "bad_request", "The request is not valid.")],
    ["422 other refusal", new ApiError(422, "bad_request", "Some refusal.")],
  ])("%s shows the API message verbatim", (_, error) => {
    expect(toSaveFailure(error)).toEqual({ kind: "message", message: error.message })
  })

  it("401 leaves it to the sign-in redirect", () => {
    expect(toSaveFailure(new ApiError(401, "session_expired", "Your session ended."))).toEqual({ kind: "signed_out" })
  })

  it("409 is the conflict, with C-JC-CONFLICT when there is no message", () => {
    expect(toSaveFailure(new ApiError(409, "application_state_conflict", ""))).toEqual({
      kind: "conflict",
      message: "Job criteria changed elsewhere. Reload to see the saved values. Your edits here aren't saved.",
    })
  })

  it("400 with field errors goes to the fields", () => {
    const fieldErrors = [{ field: "frameworks", position: 1, problem: "duplicate_entry" }] as const
    expect(toSaveFailure(new ApiError(400, "bad_request", "The request is not valid.", null, [], fieldErrors))).toMatchObject({ kind: "fields", fieldErrors })
  })
})
