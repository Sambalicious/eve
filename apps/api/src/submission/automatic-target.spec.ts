import { describe, expect, it } from "vitest"

import { isAutomaticTarget } from "./submission.service.js"

const posting = (over: Partial<{ apply_mode: string; apply_url: string; application_url: string }> = {}) => ({
  apply_mode: "automatic",
  apply_url: "https://jobs.lever.co/acme/123/apply",
  application_url: "https://jobs.lever.co/acme/123",
  ...over,
})

describe("isAutomaticTarget", () => {
  it("accepts an automatic posting whose apply_url is on the application_url host", () => {
    expect(isAutomaticTarget(posting())).toBe(true)
  })

  it("compares hosts without regard to case", () => {
    expect(isAutomaticTarget(posting({ apply_url: "https://JOBS.Lever.co/acme/123/apply" }))).toBe(true)
  })

  it("refuses an apply_url on a different host than the one automatic mode was decided from", () => {
    expect(isAutomaticTarget(posting({ apply_url: "https://evil.example/acme/123/apply" }))).toBe(false)
  })

  it("refuses a look-alike host that only shares a suffix", () => {
    expect(isAutomaticTarget(posting({ apply_url: "https://jobs.lever.co.evil.example/acme/123" }))).toBe(false)
  })

  it("refuses a manual posting and an unparseable URL", () => {
    expect(isAutomaticTarget(posting({ apply_mode: "manual" }))).toBe(false)
    expect(isAutomaticTarget(posting({ apply_url: "not a url" }))).toBe(false)
  })
})
