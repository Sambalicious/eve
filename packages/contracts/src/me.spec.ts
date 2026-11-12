import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { apiErrorCodeSchema, apiErrorResponseSchema } from "./errors.js"
import { ME_PATH, capabilitySchema, convertedFeatureSchema, meResponseSchema } from "./me.js"

/**
 * EPIC-0002 A2, contract v1.21.0 (D19 applied to the contract version): main
 * took v1.18.0 (EPIC-0006, `posting_hidden`, run a2e F-CR-03), then v1.19.0 and
 * v1.20.0 (EPIC-0007 Phases 1 and 3, run a2i F-CR-06), so A2's `GET /v1/me` and
 * `feature_not_yet_available` are the next free minor version (architecture r6: one minor bump per slice,
 * numbered from main at merge time). Expected values come from the contract
 * handoff, not from the schemas.
 */
const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8")
const KOFI = "5b7c2a1e-3f4d-4e6a-9b8c-1d2e3f4a5b6c"

describe("v1.21.0 GET /v1/me", () => {
  it("path, features and capabilities", () => {
    expect(ME_PATH).toBe("/v1/me")
    expect(convertedFeatureSchema.options).toEqual(["submission", "notifications", "spend"])
    expect(capabilitySchema.options).toEqual(["available", "not_yet"])
  })

  it("accepts the A2 body and refuses unknown keys", () => {
    const body = { candidateId: KOFI, email: "kofi@example.test", isOperator: false, capabilities: { submission: "not_yet", notifications: "not_yet", spend: "not_yet" }, advancedEnabled: false, advancedLocked: false, simplerNoteDue: false, improveListDismissed: false }
    expect(meResponseSchema.parse(body)).toEqual(body)
    expect(meResponseSchema.safeParse({ ...body, extra: 1 }).success).toBe(false)
    expect(meResponseSchema.safeParse({ ...body, capabilities: { ...body.capabilities, spend: "soon" } }).success).toBe(false)
  })
})

describe("v1.21.0 feature_not_yet_available", () => {
  it("follows v1.18.0's posting_hidden in the code list", () => {
    const codes = apiErrorCodeSchema.options
    // v1.24.0 (apply anyway bounds) appends five override codes after it, v1.25.0 (EPIC-0002 B1) two more, v1.27.0 (EPIC-0010) nine, v1.28.0 (EPIC-0011) one, and v1.31.0 (EPIC-0014) one.
    expect(codes.slice(-20)).toEqual(["posting_hidden", "feature_not_yet_available", "override_not_allowed", "override_acknowledgement_missing", "override_decision_changed", "override_application_state", "sample_not_allowed", "preferences_stale", "timezone_change_rate_limited", "job_description_too_short", "job_description_too_long", "job_title_required", "job_title_too_long", "company_required", "company_too_long", "employer_page_unreadable", "posting_still_checking", "manual_application_only", "advanced_locked", "outreach_reader_name_invalid"])
  })

  it("the envelope carries feature only as a converted feature", () => {
    expect(apiErrorResponseSchema.parse({ error: { code: "feature_not_yet_available", message: "m", feature: "spend" } }).error.feature).toBe("spend")
    expect(apiErrorResponseSchema.safeParse({ error: { code: "feature_not_yet_available", message: "m", feature: "other" } }).success).toBe(false)
  })

  it("source comments label A2's additions v1.21.0, never v1.18.0, v1.19.0 or v1.20.0", () => {
    const me = source("./me.ts")
    expect(me).toMatch(/EPIC-0002 A2 \(contract v1\.21\.0\)/)
    expect(me).not.toMatch(/v1\.(18|19|20)\.0/)
    const errors = source("./errors.ts")
    expect(errors).toMatch(/v1\.21\.0: EPIC-0002 A2/)
    expect(errors).toMatch(/`feature` \(v1\.21\.0\)/)
    expect(errors).not.toMatch(/v1\.(18|19|20)\.0[^\n]*(EPIC-0002|feature_not_yet_available|`feature`)/)
  })
})
