import { describe, expect, it, vi } from "vitest"

import { accessRequestKeys } from "./access-request-keys.js"
import type { AccessRequestRepository, SubmissionInput, SubmissionOutcome } from "./access-request.repository.js"
import { AccessRequestService } from "./access-request.service.js"
import { issueProof } from "./fill-proof.js"
import type { AppConfig } from "../config/env.js"

const NOW = new Date("2026-10-21T10:00:00.000Z")
const keys = accessRequestKeys("unit-test-access-request-secret-000000")
const config = (trustProxy = 1) => ({ accessRequest: { trustProxy, limits: { perIpHour: 3, perIpDay: 10, globalDay: 50 }, keys } }) as unknown as AppConfig
const body = (overrides: Record<string, unknown> = {}) => ({ email: "ada@example.com", proof: issueProof(NOW.getTime() - 5_000, keys.proofKey()), kiwi: "", ...overrides })

function service(submit: (input: SubmissionInput) => Promise<SubmissionOutcome>, trustProxy = 1) {
  const repository = { submit: vi.fn(submit) } as unknown as AccessRequestRepository & { submit: ReturnType<typeof vi.fn> }
  return { svc: new AccessRequestService(config(trustProxy), { now: () => NOW }, repository), repository }
}

const accepted: SubmissionOutcome = { kind: "accepted", windowId: "w", newWindow: true }

describe("AccessRequestService", () => {
  it("a third concurrent request gets 503 at once", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { svc, repository } = service(async () => {
      await gate
      return accepted
    })
    const a = svc.submit(body(), "198.51.100.1")
    const b = svc.submit(body(), "198.51.100.2")
    await expect(svc.submit(body(), "198.51.100.3")).rejects.toMatchObject({ code: "service_unavailable" })
    release()
    await Promise.all([a, b])
    expect(repository.submit).toHaveBeenCalledTimes(2)
    await expect(svc.submit(body(), "198.51.100.4")).resolves.toBeUndefined()
  })

  it("a lock timeout is 503 and frees the slot", async () => {
    const { svc } = service(async () => Promise.reject(Object.assign(new Error("lock"), { code: "55P03" })))
    for (let i = 0; i < 3; i++) await expect(svc.submit(body(), "198.51.100.1")).rejects.toMatchObject({ code: "service_unavailable" })
  })

  it("an invalid body never reaches the repository", async () => {
    const { svc, repository } = service(async () => accepted)
    await expect(svc.submit({ email: "bad" }, "198.51.100.1")).rejects.toMatchObject({ code: "access_request_invalid", fields: ["email.format"] })
    expect(repository.submit).not.toHaveBeenCalled()
  })

  it("passes the drop reason: honeypot first, then fill time", async () => {
    const { svc, repository } = service(async () => ({ kind: "dropped" }))
    await svc.submit(body({ kiwi: "x", proof: "bad" }), "198.51.100.1")
    await svc.submit(body({ proof: "bad" }), "198.51.100.1")
    await svc.submit(body(), "198.51.100.1")
    expect(repository.submit.mock.calls.map(([input]) => (input as SubmissionInput).drop)).toEqual(["honeypot", "fill_time", null])
  })

  it("TRUST_PROXY=0 turns the per-IP rule off and keeps the global cap", async () => {
    const { svc, repository } = service(async () => accepted, 0)
    await svc.submit(body(), "10.0.0.2")
    expect((repository.submit.mock.calls[0]![0] as SubmissionInput).limits).toMatchObject({ perIpEnabled: false, globalDay: 50 })
  })

  it("maps the two limits to 429 codes with Retry-After", async () => {
    const ip = service(async () => ({ kind: "rate_limited_ip", retryAfterSeconds: 600 })).svc
    await expect(ip.submit(body(), "198.51.100.1")).rejects.toMatchObject({ code: "rate_limited_ip", retryAfterSeconds: 600 })
    const global = service(async () => ({ kind: "rate_limited_global", retryAfterSeconds: 50_400 })).svc
    await expect(global.submit(body(), "198.51.100.1")).rejects.toMatchObject({ code: "rate_limited_global", retryAfterSeconds: 50_400 })
  })
})
