import { describe, expect, it } from "vitest"

import { prepareResultMessage } from "./use-prepare-samples"

describe("prepareResultMessage", () => {
  it.each([
    [{ created: 3, stoppedBy: null }, "Prepared 3 samples for your review.", true],
    [{ created: 1, stoppedBy: "no_candidates" }, "Prepared 1 sample for your review.", true],
    [{ created: 0, stoppedBy: "career_profile_not_approved" }, "Approve your Career Profile first. Samples are prepared from it.", false],
    [{ created: 0, stoppedBy: "gate_passed" }, "No new samples are needed right now.", true],
    [{ created: 0, stoppedBy: null }, "No new samples are needed right now.", true],
  ] as const)("%o", (result, text, ok) => {
    expect(prepareResultMessage(result)).toEqual({ text, ok })
  })
})
