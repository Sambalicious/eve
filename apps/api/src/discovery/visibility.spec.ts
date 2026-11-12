import { DEFAULT_TARGET_ROLE_FAMILIES, roleFamilySchema } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { type VisibilityContext, type VisibilityFacts, ageDays, buildVisibilityContext, hiddenReason, watDate } from "./visibility.js"

/** EPIC-0006 visibility rule (api-contract.r1 "Visibility rule"; posting-age.feature; hidden-postings-board.feature). */
const NOW = new Date("2026-10-24T08:00:00Z") // 09:00 WAT on 2026-10-24
const defaults = (now = NOW): VisibilityContext =>
  buildVisibilityContext({ targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: "hide_entry_level" }, now)
const facts = (patch: Partial<VisibilityFacts> = {}): VisibilityFacts => ({
  pastedDescription: false,
  titled: true,
  prefilterSkip: null,
  roleFamily: "senior_frontend",
  seniorityMarker: "none",
  postedAt: new Date("2026-10-20T12:00:00Z"),
  ...patch,
})
/** 00:00 WAT on a calendar date, plus an optional WAT time. */
const wat = (date: string, time = "00:00") => new Date(`${date}T${time}:00+01:00`)

describe("ageDays and watDate (AC-6.1)", () => {
  it.each([
    ["2026-09-23T23:59:00+01:00", 0],
    ["2026-09-24T00:00:00+01:00", 1],
    ["2026-09-23T23:00:00Z", 1],
    ["2026-09-23T22:59:59Z", 0],
  ])("posted 2026-09-23 23:30 WAT is age %s at %s", (now, age) => {
    expect(ageDays(new Date("2026-09-23T23:30:00+01:00"), new Date(now))).toBe(age)
  })

  it.each([
    ["2026-09-23T23:00:00Z", 30],
    ["2026-09-23T22:59:59Z", 31],
    ["2026-08-24T23:00:00Z", 60],
    ["2026-08-24T22:59:59Z", 61],
  ])("posted at %s is age %i on 2026-10-24 WAT", (posted, age) => {
    expect(ageDays(new Date(posted), NOW)).toBe(age)
  })

  it("watDate is the WAT calendar date", () => {
    expect(watDate(new Date("2026-08-24T23:30:00Z"))).toBe("2026-08-25")
    expect(watDate(new Date("2026-08-24T22:59:59Z"))).toBe("2026-08-24")
  })
})

describe("hiddenReason (AC-1.7, AC-2.2, AC-3.1, AC-3.4, AC-5.5, AC-6.2)", () => {
  it("a dated, on-target, non-entry titled posting is visible", () => {
    expect(hiddenReason(facts(), defaults())).toBeNull()
  })

  it.each([
    ["2026-10-24", "09:00", null],
    ["2026-09-24", "00:00", null],
    ["2026-09-23", "23:59", null],
    ["2026-08-25", "00:00", null],
    ["2026-08-25", "23:59", null],
    ["2026-08-24", "23:59", "older_than_60_days"],
    ["2026-08-24", "00:00", "older_than_60_days"],
    ["2026-07-01", "12:00", "older_than_60_days"],
  ])("posted %s %s WAT: %s (AC-6.6)", (date, time, reason) => {
    expect(hiddenReason(facts({ postedAt: wat(date, time) }), defaults())).toBe(reason)
  })

  it("undated is hidden", () => {
    expect(hiddenReason(facts({ postedAt: null }), defaults())).toBe("undated")
  })

  it.each(["devops_platform", "data_ml", "solutions_customer", "other"] as const)("%s is off-target under the defaults", (family) => {
    expect(hiddenReason(facts({ roleFamily: family }), defaults())).toBe("off_target")
  })

  it("a not_software_role skip is off-target whatever the targets", () => {
    const every = buildVisibilityContext({ targetRoleFamilies: [...roleFamilySchema.options], seniorityFloor: "all_levels" }, NOW)
    expect(hiddenReason(facts({ prefilterSkip: "not_software_role", roleFamily: null }), every)).toBe("off_target")
  })

  it("a titled posting with no family is off-target; an untitled one never is", () => {
    expect(hiddenReason(facts({ roleFamily: null }), defaults())).toBe("off_target")
    expect(hiddenReason(facts({ titled: false, roleFamily: null, seniorityMarker: null }), defaults())).toBeNull()
  })

  it("entry level is hidden only when the floor hides it, and never untitled", () => {
    expect(hiddenReason(facts({ seniorityMarker: "entry" }), defaults())).toBe("below_seniority_floor")
    const all = buildVisibilityContext({ targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: "all_levels" }, NOW)
    expect(hiddenReason(facts({ seniorityMarker: "entry" }), all)).toBeNull()
    expect(hiddenReason(facts({ seniorityMarker: "mid_plus" }), defaults())).toBeNull()
  })

  it("reports the first reason in AC-3.4 order", () => {
    const all = facts({ roleFamily: "data_ml", seniorityMarker: "entry", postedAt: null })
    expect(hiddenReason(all, defaults())).toBe("off_target")
    expect(hiddenReason({ ...all, roleFamily: "backend" }, defaults())).toBe("below_seniority_floor")
    expect(hiddenReason({ ...all, roleFamily: "backend", seniorityMarker: "none" }, defaults())).toBe("undated")
  })

  it("the cutoff is 00:00 WAT today minus 60 days and does not move during the WAT day", () => {
    expect(defaults().cutoff.toISOString()).toBe("2026-08-24T23:00:00.000Z")
    expect(defaults(new Date("2026-10-24T22:59:59Z")).cutoff.toISOString()).toBe("2026-08-24T23:00:00.000Z")
    expect(defaults(new Date("2026-10-24T23:00:00Z")).cutoff.toISOString()).toBe("2026-08-25T23:00:00.000Z")
  })
})
