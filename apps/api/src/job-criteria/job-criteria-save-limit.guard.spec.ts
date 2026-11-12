import type { ExecutionContext } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import { SESSION_COOKIE } from "../auth/cookies.js"
import { hashToken } from "../auth/secure-token.js"
import { ApiException } from "../http/api-exception.js"
import type { Clock } from "../shared/clock.js"
import {
  JOB_CRITERIA_SAVES_PER_WINDOW,
  JOB_CRITERIA_SAVE_WINDOW_MS,
  JobCriteriaSaveLimitGuard,
  JobCriteriaSaveLimiter,
} from "./job-criteria-save-limit.guard.js"

class HandClock implements Clock {
  constructor(private ms: number) {}
  now(): Date {
    return new Date(this.ms)
  }
  set(iso: string): void {
    this.ms = Date.parse(iso)
  }
}

function contextFor(cookie: string | undefined): ExecutionContext {
  const request = { cookies: cookie === undefined ? {} : { [SESSION_COOKIE]: cookie } }
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext
}

function setup() {
  const clock = new HandClock(Date.parse("2026-10-22T09:00:00.000Z"))
  const guard = new JobCriteriaSaveLimitGuard(new JobCriteriaSaveLimiter(), clock)
  return { clock, guard }
}

function refusal(guard: JobCriteriaSaveLimitGuard, cookie: string): ApiException {
  try {
    guard.canActivate(contextFor(cookie))
  } catch (error) {
    if (error instanceof ApiException) return error
    throw error
  }
  throw new Error("expected a refusal")
}

describe("JobCriteriaSaveLimitGuard (SEC-006)", () => {
  it("is 10 saves per 60 s", () => {
    expect([JOB_CRITERIA_SAVES_PER_WINDOW, JOB_CRITERIA_SAVE_WINDOW_MS]).toEqual([10, 60_000])
  })

  it("lets 10 saves through, then refuses with too_many_requests, 429 and a Retry-After in seconds", () => {
    const { clock, guard } = setup()
    for (let index = 0; index < 10; index += 1) expect(guard.canActivate(contextFor("session-a"))).toBe(true)
    clock.set("2026-10-22T09:00:12.300Z")
    const error = refusal(guard, "session-a")
    expect(error.code).toBe("too_many_requests")
    expect(error.getStatus()).toBe(429)
    expect(error.retryAfterSeconds).toBe(48)
  })

  it("resets one window after the first counted save", () => {
    const { clock, guard } = setup()
    for (let index = 0; index < 10; index += 1) guard.canActivate(contextFor("session-a"))
    clock.set("2026-10-22T09:01:00.000Z")
    expect(guard.canActivate(contextFor("session-a"))).toBe(true)
  })

  it("keys by session: another session cookie has its own 10", () => {
    const { guard } = setup()
    for (let index = 0; index < 10; index += 1) guard.canActivate(contextFor("session-a"))
    expect(refusal(guard, "session-a").code).toBe("too_many_requests")
    for (let index = 0; index < 10; index += 1) expect(guard.canActivate(contextFor("session-b"))).toBe(true)
  })

  it("never keeps the raw session ID: the limiter key is its SHA-256 hash", () => {
    const limiter = new JobCriteriaSaveLimiter()
    const guard = new JobCriteriaSaveLimitGuard(limiter, new HandClock(0))
    guard.canActivate(contextFor("raw-session-id"))
    expect(limiter.keys()).toEqual([hashToken("raw-session-id")])
  })

  it("without a session cookie (the global guard should already have refused) it refuses as unauthenticated", () => {
    const { guard } = setup()
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(expect.objectContaining({ code: "unauthenticated" }))
  })
})
