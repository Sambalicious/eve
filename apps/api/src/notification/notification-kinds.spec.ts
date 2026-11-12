import { describe, expect, it } from "vitest"

import { ACCESS_REQUEST_EMAIL_BAND, BAND_BY_KIND } from "./notification-kinds.js"

describe("BAND_BY_KIND (architecture.r1 7.10, EPIC-0002 slice F)", () => {
  it("has an entry for every NotificationKind", () => {
    expect(Object.keys(BAND_BY_KIND).sort()).toEqual(["access_request", "access_request_cap", "blocked", "confirmed", "cost_pause", "daily_summary", "uncertain"])
  })

  it("puts access requests in band 4 beside the daily summary, and the cap alert in band 1", () => {
    expect(ACCESS_REQUEST_EMAIL_BAND).toEqual({ access_request: 4, access_request_cap: 1 })
    expect(BAND_BY_KIND.access_request).toBe(BAND_BY_KIND.daily_summary)
    expect(BAND_BY_KIND.access_request_cap).toBe(BAND_BY_KIND.cost_pause)
  })
})
