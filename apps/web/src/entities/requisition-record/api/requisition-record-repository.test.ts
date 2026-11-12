import { DELETE_DETAILS_PATH, deleteDetailsRequestSchema } from "@eve/contracts"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { server, TEST_CSRF_TOKEN } from "@/shared/testing"
import { deleteDetailedRecords } from "./requisition-record-repository"

const ids = (n: number) => Array.from({ length: n }, (_, i) => `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`)

describe("deleteDetailedRecords (CR7-01: never more than 100 IDs per request)", () => {
  it("splits 250 IDs into requests of 100, 100 and 50 that the server schema accepts, and adds up deletedCount", async () => {
    const sent: string[][] = []
    server.use(
      http.post(DELETE_DETAILS_PATH, async ({ request }) => {
        const parsed = deleteDetailsRequestSchema.safeParse(await request.json())
        if (!parsed.success) return HttpResponse.json({ error: { code: "bad_request", message: "Bad request." } }, { status: 400 })
        sent.push(parsed.data.applicationIds)
        return HttpResponse.json({ deletedCount: parsed.data.applicationIds.length - 1 })
      })
    )
    const all = ids(250)
    expect(await deleteDetailedRecords(all, TEST_CSRF_TOKEN)).toBe(247)
    expect(sent.map((s) => s.length)).toEqual([100, 100, 50])
    expect(sent.flat()).toEqual(all)
  })
})

describe("deleteDetailedRecords: a later batch fails", () => {
  it("throws PartialDeletionError with the count the earlier batches deleted", async () => {
    let call = 0
    server.use(
      http.post(DELETE_DETAILS_PATH, () => {
        call++
        if (call === 1) return HttpResponse.json({ deletedCount: 100 })
        return HttpResponse.json({ error: { code: "application_state_conflict", message: "An attempt is in flight." } }, { status: 409 })
      })
    )
    await expect(deleteDetailedRecords(ids(150), TEST_CSRF_TOKEN)).rejects.toMatchObject({ name: "PartialDeletionError", deletedCount: 100 })
  })
})
