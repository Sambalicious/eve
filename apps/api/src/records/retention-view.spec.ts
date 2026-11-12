import { describe, expect, it } from "vitest"

import { expiresOn, retentionClass } from "./retention-view.js"

const GRACE_OVER = "2026-07-01"
const live = (created: string, extra: Partial<{ state: string; submission_state: string | null; sample_state: string | null }> = {}) => ({
  created_at: new Date(`${created}T10:00:00+01:00`),
  state: "documents_ready",
  submission_state: null,
  sample_state: null,
  details_deleted_at: null,
  ...extra,
})

describe("retention classes (E5.2, E5.5, E5.6, E5.8)", () => {
  it("E5.2: due counts expiry dates from today to today + 30", () => {
    const today = "2026-10-20"
    expect(["2025-10-24", "2025-11-03", "2025-11-19"].map((c) => retentionClass(live(c), today, GRACE_OVER))).toEqual(["due", "due", "due"])
    expect(retentionClass(live("2025-11-20"), today, GRACE_OVER)).toBeNull()
    expect(retentionClass(live("2025-10-20"), today, GRACE_OVER)).toBe("due")
  })

  it("overdue: not busy, not waiting, past its date; an in-flight one is in no count", () => {
    expect(retentionClass(live("2025-11-30"), "2026-12-01", GRACE_OVER)).toBe("overdue")
    expect(retentionClass(live("2025-11-30", { state: "generating" }), "2026-12-01", GRACE_OVER)).toBeNull()
  })

  it.each([
    ["2026-10-21", null],
    ["2026-11-18", null],
    ["2026-11-19", "waiting"],
  ])("E5.5, E5.8: a Blocked Application expiring 2026-10-20 on %s is %s", (today, expected) => {
    expect(retentionClass(live("2025-10-20", { submission_state: "blocked" }), today, GRACE_OVER)).toBe(expected)
  })

  it.each([["uncertain"], ["queued"]])("a %s submission waits too; so does a sample awaiting review", (state) => {
    expect(retentionClass(live("2025-10-20", { submission_state: state }), "2026-12-01", GRACE_OVER)).toBe("waiting")
    expect(retentionClass(live("2025-10-20", { sample_state: "awaiting_review" }), "2026-12-01", GRACE_OVER)).toBe("waiting")
  })

  it("E4.6: during the grace an earlier expiry date reads as the grace end; a deleted row has no date", () => {
    expect(expiresOn(live("2025-09-15"), "2026-12-01")).toBe("2026-12-01")
    expect(expiresOn({ created_at: new Date("2025-09-15T10:00:00Z"), details_deleted_at: new Date() }, "2026-12-01")).toBeNull()
    expect(retentionClass(live("2025-09-15"), "2026-11-10", "2026-12-01")).toBe("due")
  })
})
