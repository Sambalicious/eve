import { describe, expect, it } from "vitest"

import type { PostingStatus } from "./job-posting"
import { postingWord, postingWordCopy, waitingReasonLine } from "./plain-status"

const word = (status: PostingStatus, hiddenReason: Parameters<typeof postingWord>[0]["hiddenReason"] = null) => postingWordCopy[postingWord({ status, hiddenReason })]

describe("postingWord (ST posting words, AC-4.1)", () => {
  it.each([
    ["checking", "Checking"],
    ["waiting_to_be_checked", "Checking"],
    ["ranked", "Good match"],
    ["skipped", "Not a match"],
    ["excluded", "Not a match"],
    ["evaluation_failed", "Couldn't check"],
    ["not_checked", "Couldn't check"],
  ] as const)("%s -> %s", (status, expected) => {
    expect(word(status)).toBe(expected)
  })

  it.each(["off_target", "below_seniority_floor", "undated", "older_than_60_days"] as const)("hidden by %s wins over every status", (reason) => {
    for (const status of ["checking", "ranked", "skipped", "not_checked", "evaluation_failed"] as const) {
      expect(word(status, reason)).toBe("Hidden")
    }
  })

  it("only the six posting words exist", () => {
    expect(Object.values(postingWordCopy).sort()).toEqual(["Checking", "Couldn't check", "Good match", "Hidden", "Manual apply", "Not a match"])
  })

  it("v1.28.0: a job Eve cannot submit for is a manual lead, not a rejection", () => {
    expect(postingWord({ status: "skipped", hiddenReason: null, skipReason: "unsupported_application_system" })).toBe("manualApply")
    // Every other skip still reads as a rejection.
    for (const skipReason of ["weak_core_match", "uncovered_mandatory_prerequisite", "no_core_responsibilities", "not_software_role", "excluded_role_family", "keyword_mismatch", "violated_rule"] as const) {
      expect(postingWord({ status: "skipped", hiddenReason: null, skipReason }), skipReason).toBe("notMatch")
    }
  })

  it("a waiting posting shows why it waits", () => {
    expect(waitingReasonLine("waiting_to_be_checked", "cost_pause")).toMatch(/ceiling/)
    expect(waitingReasonLine("waiting_to_be_checked", "checks_not_enabled")).toMatch(/turned on for your account/)
    expect(waitingReasonLine("waiting_to_be_checked", null)).toMatch(/turn/)
    expect(waitingReasonLine("ranked", null)).toBeNull()
  })
})
