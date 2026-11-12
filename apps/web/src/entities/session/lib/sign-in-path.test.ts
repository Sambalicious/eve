import { describe, expect, it } from "vitest"

import { ApiError } from "@/shared/api"
import { buildSignInPath, signInPathAfterUnauthorized } from "./sign-in-path"

const at = (pathname: string, search = "", hash = "") => ({ pathname, search, hash })

describe("buildSignInPath", () => {
  it("carries the full location as next", () => {
    expect(buildSignInPath(at("/applications/R-1042", "?tab=docs", "#resume"))).toBe(
      "/sign-in?next=%2Fapplications%2FR-1042%3Ftab%3Ddocs%23resume"
    )
  })

  it("never points next back at the sign-in page", () => {
    expect(buildSignInPath(at("/sign-in", "?next=%2Fblocked"))).toBe("/sign-in?next=%2Fdashboard")
  })
})

describe("signInPathAfterUnauthorized", () => {
  it("adds reason=expired for session_expired", () => {
    const error = new ApiError(401, "session_expired", "")
    expect(signInPathAfterUnauthorized(error, at("/blocked"))).toBe(
      "/sign-in?next=%2Fblocked&reason=expired"
    )
  })

  it("adds no reason for unauthenticated", () => {
    const error = new ApiError(401, "unauthenticated", "")
    expect(signInPathAfterUnauthorized(error, at("/blocked"))).toBe("/sign-in?next=%2Fblocked")
  })
})
