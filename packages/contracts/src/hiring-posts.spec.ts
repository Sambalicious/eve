import { describe, expect, it } from "vitest"

import { apiErrorResponseSchema } from "./errors.js"
import {
  ALERT_FEED_LIMIT,
  HIRING_ALERT_FEEDS_PATH,
  HIRING_ALERT_FEED_LIMIT,
  HIRING_FEED_VERIFICATION_PATH,
  HIRING_POSTS_PATH,
  hiringAlertFeedsResponseSchema,
  hiringPostsResponseSchema,
  stackPostsFieldProblemSchema,
} from "./stack-posts.js"

/** EPIC-0007 Phase 3 contract additions (api-contract.r1.md, v1.20.0). */
describe("Hiring Alert feeds contract (v1.20.0)", () => {
  it("names the three Phase 3 paths and a separate limit of 10 (D5)", () => {
    expect(HIRING_ALERT_FEEDS_PATH).toBe("/v1/stack-posts/hiring-feeds")
    expect(HIRING_FEED_VERIFICATION_PATH).toBe("/v1/stack-posts/hiring-feeds/verification")
    expect(HIRING_POSTS_PATH).toBe("/v1/stack-posts/hiring-posts")
    expect(HIRING_ALERT_FEED_LIMIT).toBe(10)
    expect(HIRING_ALERT_FEED_LIMIT).toBe(ALERT_FEED_LIMIT)
  })

  it("adds in_other_list after invalid_characters and before the failure reasons", () => {
    const options = stackPostsFieldProblemSchema.options
    expect(options.indexOf("in_other_list")).toBe(options.indexOf("invalid_characters") + 1)
    expect(options.indexOf("in_other_list")).toBeLessThan(options.indexOf("not_reachable"))
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "url", position: null, problem: "in_other_list" }] } }).success
    ).toBe(true)
  })

  it("accepts the no-record response and a recorded one, and refuses canRecordVerification or another limit", () => {
    expect(hiringAlertFeedsResponseSchema.safeParse({ verification: null, feeds: [], limit: 10, globalPaused: false }).success).toBe(true)
    const recorded = { verification: { verifiedOn: "2026-10-21", verificationBasis: "Read terms.", updatedAt: "2026-10-21T10:15:00.000Z" }, feeds: [], limit: 10, globalPaused: true }
    expect(hiringAlertFeedsResponseSchema.safeParse(recorded).success).toBe(true)
    expect(hiringAlertFeedsResponseSchema.safeParse({ ...recorded, canRecordVerification: true }).success).toBe(false)
    expect(hiringAlertFeedsResponseSchema.safeParse({ ...recorded, limit: 11 }).success).toBe(false)
    expect(hiringAlertFeedsResponseSchema.safeParse({ verification: { verifiedOn: "2026-10-21" }, feeds: [], limit: 10, globalPaused: false }).success).toBe(false)
  })

  it("OWN-1: requires a boolean globalPaused and carries no spend data", () => {
    const base = { verification: null, feeds: [], limit: 10 }
    expect(hiringAlertFeedsResponseSchema.safeParse(base).success).toBe(false)
    expect(hiringAlertFeedsResponseSchema.safeParse({ ...base, globalPaused: "true" }).success).toBe(false)
    expect(hiringAlertFeedsResponseSchema.safeParse({ ...base, globalPaused: true, spend: {} }).success).toBe(false)
  })

  it("hiring posts page has the Stack posts list shape", () => {
    expect(hiringPostsResponseSchema.safeParse({ items: [], page: 3, pageSize: 50, totalCount: 60, totalPages: 2 }).success).toBe(true)
    expect(hiringPostsResponseSchema.safeParse({ items: [], page: 1, pageSize: 25, totalCount: 0, totalPages: 0 }).success).toBe(false)
  })
})
