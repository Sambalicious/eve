import { describe, expect, it } from "vitest"

import { epochCandidate, isoCandidate, resolvePostedDate, rfc822Candidate } from "./posted-date.js"

/** EPIC-0006 posted-date.feature (Gherkin r4), AC-5.2 to AC-5.4. Read moment 2026-10-24T08:00:00Z. */
const READ_AT = new Date("2026-10-24T08:00:00Z")
const iso = (value: unknown) => resolvePostedDate([isoCandidate(value, "published")], READ_AT).postedAt?.toISOString() ?? null
const seconds = (value: unknown) => resolvePostedDate([epochCandidate(value, "seconds", "published")], READ_AT).postedAt?.toISOString() ?? null
const millis = (value: unknown) => resolvePostedDate([epochCandidate(value, "milliseconds", "published")], READ_AT).postedAt?.toISOString() ?? null

describe("ISO-8601 values (AC-5.2, AC-5.4)", () => {
  it.each([
    ["2026-10-20T14:30:00-04:00", "2026-10-20T18:30:00.000Z"],
    ["2026-10-20T12:00:00.000+00:00", "2026-10-20T12:00:00.000Z"],
    ["2026-10-20T12:00:00+00:00", "2026-10-20T12:00:00.000Z"],
    ["2026-10-17T16:04:29", "2026-10-17T16:04:29.000Z"],
    ["2026-08-24T23:30:00", "2026-08-24T23:30:00.000Z"],
    ["2026-10-20T12:00:00", "2026-10-20T12:00:00.000Z"],
    ["2026-10-20", "2026-10-19T23:00:00.000Z"],
    ["2026-08-24", "2026-08-23T23:00:00.000Z"],
    ["2026-10-24", "2026-10-23T23:00:00.000Z"],
    ["2026-10-25", "2026-10-24T08:00:00.000Z"],
    ["1999-12-31T23:00:00Z", "1999-12-31T23:00:00.000Z"],
    ["1999-12-31T23:30:00", "1999-12-31T23:30:00.000Z"],
    ["2000-01-01T00:00:00Z", "2000-01-01T00:00:00.000Z"],
    ["2000-01-01", "1999-12-31T23:00:00.000Z"],
  ])("%j is stored as %s", (value, stored) => {
    expect(iso(value)).toBe(stored)
  })

  it.each(["not a date", "", null, "2026-02-30", "2026-13-01T00:00:00Z", "1999-12-31T22:59:59Z", "1970-01-01T00:00:00Z", "2026-10-25T08:00:01Z", "2027-01-01T00:00:00Z", true, {}, "1999-12-31", "2026-10-26", "2026-10-20T24:00:00Z", "20261020", undefined, "0001-01-01", "0001-01-01T00:00:00Z", "2026-10-20T12:00:00+25:00", "2026-10-20T12:60:00Z", "+275760-09-13T00:00:00Z", " 2026-10-20", "2026-10-20 12:00:00"])(
    "%j leaves the posting undated",
    (value) => {
      expect(iso(value)).toBeNull()
    }
  )
})

describe("epoch values (AC-5.2, AC-5.4)", () => {
  it.each([
    [1792497600, "2026-10-20T12:00:00.000Z"],
    [946681200, "1999-12-31T23:00:00.000Z"],
    [1792828800, "2026-10-24T08:00:00.000Z"],
    [1792828801, "2026-10-24T08:00:00.000Z"],
    [1792872000, "2026-10-24T08:00:00.000Z"],
    [1792915200, "2026-10-24T08:00:00.000Z"],
  ])("seconds %j is stored as %s", (value, stored) => {
    expect(seconds(value)).toBe(stored)
  })

  it.each([1792497600000, -1, 0, 946681199, 1792915201, "soon", null, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 9_000_000_000_000, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])("seconds %j is undated", (value) => {
    expect(seconds(value)).toBeNull()
  })

  it.each([
    [1792497600000, "2026-10-20T12:00:00.000Z"],
    [946681200000, "1999-12-31T23:00:00.000Z"],
  ])("milliseconds %j is stored as %s", (value, stored) => {
    expect(millis(value)).toBe(stored)
  })

  it.each([1792497600, -1, 0, 946681199999, 1792915200001, "soon", Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_001])("milliseconds %j is undated", (value) => {
    expect(millis(value)).toBeNull()
  })
})

describe("RFC 822 values (We Work Remotely)", () => {
  it.each([
    ["Tue, 20 Oct 2026 12:00:00 +0000", "2026-10-20T12:00:00.000Z"],
    ["Fri, 23 Oct 2026 07:31:21 +0000", "2026-10-23T07:31:21.000Z"],
    ["20 Oct 2026 13:00:00 +0100", "2026-10-20T12:00:00.000Z"],
    ["Tue, 20 Oct 2026 12:00:00 GMT", "2026-10-20T12:00:00.000Z"],
  ])("%j is stored as %s", (value, stored) => {
    expect(resolvePostedDate([rfc822Candidate(value, "published")], READ_AT).postedAt?.toISOString()).toBe(stored)
  })

  it.each(["2026-10-20T12:00:00Z", "Tue, 31 Feb 2026 12:00:00 +0000", "yesterday", "", undefined, 5])("%j is undated", (value) => {
    expect(resolvePostedDate([rfc822Candidate(value, "published")], READ_AT).postedAt).toBeNull()
  })
})

describe("first valid field wins (AC-5.2, AC-5.3)", () => {
  it("published beats updated when both are valid", () => {
    expect(resolvePostedDate([isoCandidate("2026-09-01T10:00:00Z", "published"), isoCandidate("2026-10-22T10:00:00Z", "updated")], READ_AT)).toEqual({
      postedAt: new Date("2026-09-01T10:00:00Z"),
      postedDateKind: "published",
    })
  })

  it("an out-of-bounds published value falls back to a valid updated value", () => {
    expect(resolvePostedDate([isoCandidate("1999-12-31T22:00:00Z", "published"), isoCandidate("2026-10-22T10:00:00Z", "updated")], READ_AT)).toEqual({
      postedAt: new Date("2026-10-22T10:00:00Z"),
      postedDateKind: "updated",
    })
  })

  it("Remote OK: an invalid date falls back to epoch, still published", () => {
    expect(resolvePostedDate([isoCandidate("not a date", "published"), epochCandidate(1792497600, "seconds", "published")], READ_AT)).toEqual({
      postedAt: new Date("2026-10-20T12:00:00Z"),
      postedDateKind: "published",
    })
  })

  it("nothing valid is undated with no basis", () => {
    expect(resolvePostedDate([isoCandidate(undefined, "published"), isoCandidate("garbage", "updated")], READ_AT)).toEqual({ postedAt: null, postedDateKind: null })
    expect(resolvePostedDate([], READ_AT)).toEqual({ postedAt: null, postedDateKind: null })
  })
})
