import { describe, expect, it } from "vitest"

import { notificationStatusSchema } from "./notifications.js"

describe("notificationStatusSchema (v1.10.0, C-NOTIFY-1)", () => {
  it("accepts no failure, and a failure about an Application or a daily summary", () => {
    expect(notificationStatusSchema.parse({ senderConfigured: false, pendingCount: 0, latestFailure: null }).latestFailure).toBeNull()
    for (const latestFailure of [
      { failedAt: "2026-10-20T09:15:00.000Z", emailType: "blocked_application", applicationId: "6f1c2a4e-0000-4000-8000-000000000001", watDay: null },
      { failedAt: "2026-10-20T20:00:00+00:00", emailType: "daily_summary", applicationId: null, watDay: "2026-10-20" },
    ]) {
      expect(notificationStatusSchema.parse({ senderConfigured: true, pendingCount: 2, latestFailure }).latestFailure).toEqual(latestFailure)
    }
  })

  it("refuses extra fields, so no address or password can ride along", () => {
    expect(notificationStatusSchema.safeParse({ senderConfigured: true, pendingCount: 0, latestFailure: null, user: "ada.okafor@gmail.com" }).success).toBe(false)
  })

  it("refuses an unknown email type and a negative count", () => {
    expect(notificationStatusSchema.safeParse({ senderConfigured: true, pendingCount: -1, latestFailure: null }).success).toBe(false)
    expect(
      notificationStatusSchema.safeParse({ senderConfigured: true, pendingCount: 0, latestFailure: { failedAt: "2026-10-20T09:15:00Z", emailType: "cost_pause", applicationId: null, watDay: null } }).success
    ).toBe(false)
  })
})
