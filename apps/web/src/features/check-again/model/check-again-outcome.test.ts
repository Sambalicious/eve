import { describe, expect, it } from "vitest"

import { ApiError } from "@/shared/api"
import { checkAgainFailure, checkAgainToast } from "./check-again-outcome"

describe("checkAgainToast (api-contract.r1 Web mapping)", () => {
  it("queued 0 is the nothing-new info toast, whatever movedTo", () => {
    for (const movedTo of ["checking", "waiting_to_be_checked"] as const) {
      expect(checkAgainToast({ queued: 0, movedTo })).toEqual({
        tone: "info",
        text: "Nothing new to check. Those postings are already queued.",
        announce: null,
      })
    }
  })

  it("checking is the success toast, mirrored in the status region", () => {
    expect(checkAgainToast({ queued: 929, movedTo: "checking" })).toEqual({
      tone: "success",
      text: "929 postings queued for a check.",
      announce: "929 postings queued for a check.",
    })
    expect(checkAgainToast({ queued: 1, movedTo: "checking" }).text).toBe("1 posting queued for a check.")
  })

  it("waiting is the info waiting toast, never the queued one", () => {
    const outcome = checkAgainToast({ queued: 1204, movedTo: "waiting_to_be_checked" })
    expect(outcome.tone).toBe("info")
    expect(outcome.text).toBe(
      "1,204 postings moved to waiting. They aren't checked until the person who runs your Eve turns on checks for you."
    )
    expect(outcome.announce).toBe(outcome.text)
  })
})

describe("checkAgainFailure", () => {
  const net = { kind: "alert", message: "Couldn't queue the checks. Nothing changed. Try again." }
  it.each([
    [new ApiError(500, "internal_error", "Something went wrong."), net],
    [new ApiError(502, null, "HTTP 502"), net],
    [new TypeError("Failed to fetch"), net],
    [new ApiError(400, "bad_request", ""), net],
    [new ApiError(403, "csrf_invalid", "The request is missing a valid CSRF token."), { kind: "alert", message: "The request is missing a valid CSRF token." }],
    [new ApiError(401, "session_expired", "Your session ended."), { kind: "signed_out" }],
  ])("%s maps to %o", (error, expected) => {
    expect(checkAgainFailure(error)).toEqual(expected)
  })
})
