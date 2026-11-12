import { describe, expect, it, vi } from "vitest"

import { TestClock } from "../../test/support/test-clock.js"
import { hashToken } from "./secure-token.js"
import type { SessionRepository } from "./session.repository.js"
import { SessionService } from "./session.service.js"

/** Pins the cutoff the service hands to the repository; the SQL comparison is proven in session-expiry.int-spec.ts. */
describe("SessionService.resume", () => {
  it("asks for sessions active strictly after now minus 14 days", async () => {
    const touchIfActive = vi.fn().mockResolvedValue({ csrfToken: "c", googleSub: "s", candidateId: "00000000-0000-4000-8000-000000000001" })
    const repository = { touchIfActive, delete: vi.fn() } as unknown as SessionRepository
    const clock = new TestClock("2026-10-15T08:00:00Z")

    const result = await new SessionService(repository, clock).resume("raw-id")

    expect(result).toEqual({ kind: "active", session: { csrfToken: "c", candidateId: "00000000-0000-4000-8000-000000000001" } })
    expect(touchIfActive).toHaveBeenCalledWith(
      hashToken("raw-id"),
      new Date("2026-10-15T08:00:00Z"),
      new Date("2026-10-01T08:00:00Z")
    )
  })

  it("reports a missing cookie without touching the database", async () => {
    const touchIfActive = vi.fn()
    const repository = { touchIfActive } as unknown as SessionRepository
    const service = new SessionService(repository, new TestClock("2026-10-15T08:00:00Z"))

    expect(await service.resume(undefined)).toEqual({ kind: "missing" })
    expect(touchIfActive).not.toHaveBeenCalled()
  })
})
