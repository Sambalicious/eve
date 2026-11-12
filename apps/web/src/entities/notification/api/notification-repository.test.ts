import { NOTIFICATION_STATUS_PATH } from "@eve/contracts"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { server, signedInSession } from "@/shared/testing"
import { fetchNotificationStatus } from "./notification-repository"

const APP_ID = "0b6f7a52-3c1d-4f4e-9a8b-2c6d1e0f9a11"

describe("notification repository (v1.10.0)", () => {
  it("maps an Application email failure to a link to that Application", async () => {
    server.use(
      signedInSession,
      http.get(NOTIFICATION_STATUS_PATH, () =>
        HttpResponse.json({
          senderConfigured: true,
          pendingCount: 2,
          latestFailure: { failedAt: "2026-10-20T09:15:00.000Z", emailType: "blocked_application", applicationId: APP_ID, watDay: null },
        })
      )
    )
    expect(await fetchNotificationStatus()).toEqual({
      senderConfigured: true,
      pendingCount: 2,
      latestFailure: { failedAt: "2026-10-20T09:15:00.000Z", emailType: "blocked_application", targetPath: `/applications/${APP_ID}` },
      // v1.16.0: absent from this response, so no access-request counts.
      accessRequests: null,
    })
  })

  it("maps v1.16.0 accessRequests counts", async () => {
    server.use(
      http.get(NOTIFICATION_STATUS_PATH, () =>
        HttpResponse.json({ senderConfigured: false, pendingCount: 0, latestFailure: null, accessRequests: { waiting: 2, failed: 1 } })
      )
    )
    expect((await fetchNotificationStatus()).accessRequests).toEqual({ waiting: 2, failed: 1 })
  })

  it("a failed daily summary links to Home (it has no page of its own)", async () => {
    server.use(
      http.get(NOTIFICATION_STATUS_PATH, () =>
        HttpResponse.json({
          senderConfigured: true,
          pendingCount: 0,
          latestFailure: { failedAt: "2026-10-20T20:05:00.000Z", emailType: "daily_summary", applicationId: null, watDay: "2026-10-20" },
        })
      )
    )
    expect((await fetchNotificationStatus()).latestFailure?.targetPath).toBe("/dashboard")
  })

  it("a failed cost-pause email (v1.11.0 costPauseEmailFailedAt) links to /settings#cost", async () => {
    server.use(
      http.get(NOTIFICATION_STATUS_PATH, () =>
        HttpResponse.json({ senderConfigured: true, pendingCount: 0, latestFailure: null, costPauseEmailFailedAt: "2026-10-25T11:00:00.000Z" })
      )
    )
    expect((await fetchNotificationStatus()).latestFailure).toEqual({ failedAt: "2026-10-25T11:00:00.000Z", emailType: "cost_pause", targetPath: "/settings#cost" })
  })

  it("C-NOTIFY-1 shows only the latest failure: the newer of the cost-pause email and the other emails", async () => {
    const other = { failedAt: "2026-10-25T12:00:00.000Z", emailType: "blocked_application", applicationId: APP_ID, watDay: null }
    server.use(
      http.get(NOTIFICATION_STATUS_PATH, () =>
        HttpResponse.json({ senderConfigured: true, pendingCount: 0, latestFailure: other, costPauseEmailFailedAt: "2026-10-25T11:00:00.000Z" })
      )
    )
    expect((await fetchNotificationStatus()).latestFailure?.emailType).toBe("blocked_application")
    server.use(
      http.get(NOTIFICATION_STATUS_PATH, () =>
        HttpResponse.json({ senderConfigured: true, pendingCount: 0, latestFailure: other, costPauseEmailFailedAt: "2026-10-25T13:00:00.000Z" })
      )
    )
    expect((await fetchNotificationStatus()).latestFailure?.emailType).toBe("cost_pause")
  })

  it("refuses a response with fields the contract doesn't have (no address or password ever reaches the page)", async () => {
    server.use(
      http.get(NOTIFICATION_STATUS_PATH, () =>
        HttpResponse.json({ senderConfigured: true, pendingCount: 0, latestFailure: null, smtpUser: "eve@example.test" })
      )
    )
    await expect(fetchNotificationStatus()).rejects.toThrow()
  })
})
