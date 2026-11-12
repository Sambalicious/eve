import { describe, expect, it } from "vitest"

import { type RetentionRunSummary, aggregate } from "./retention-runner.js"

const base = {
  watDate: "2026-10-20",
  due: 0,
  deleted: 0,
  skippedInFlight: 0,
  skippedPendingDecision: 0,
  skippedLocked: 0,
  failed: 0,
  filesReleased: 0,
  batches: 0,
}
const run = (patch: Partial<RetentionRunSummary>): RetentionRunSummary => ({
  ...base,
  outcome: "completed",
  ...patch,
})

/** Merge 11 (EPIC-0002 A1): one run expires each Candidate in turn; `run()` reports their sum. */
describe("aggregate", () => {
  it("sums every count over the Candidates and drops the Candidate ID", () => {
    const total = aggregate("2026-10-20", [
      run({
        candidateId: "a",
        due: 2,
        deleted: 1,
        filesReleased: 2,
        batches: 1,
      }),
      run({
        candidateId: "b",
        due: 3,
        deleted: 3,
        skippedLocked: 1,
        batches: 1,
      }),
    ])
    expect(total).toEqual({
      ...base,
      outcome: "completed",
      due: 5,
      deleted: 4,
      skippedLocked: 1,
      filesReleased: 2,
      batches: 2,
    })
  })

  it("is failed when any Candidate's run failed", () => {
    expect(
      aggregate("2026-10-20", [run({}), run({ outcome: "failed", failed: 1 })])
        .outcome
    ).toBe("failed")
  })

  it("is completed when one Candidate completed and another is still in launch grace", () => {
    expect(
      aggregate("2026-10-20", [
        run({ outcome: "skipped_launch_grace" }),
        run({}),
      ]).outcome
    ).toBe("completed")
  })

  it("keeps a skip every Candidate shared, and the global pause wins over launch grace", () => {
    expect(
      aggregate("2026-10-20", [run({ outcome: "skipped_launch_grace" })])
        .outcome
    ).toBe("skipped_launch_grace")
    expect(
      aggregate("2026-10-20", [
        run({ outcome: "skipped_global_paused" }),
        run({ outcome: "skipped_launch_grace" }),
      ]).outcome
    ).toBe("skipped_global_paused")
  })

  it("is a completed zero with no Candidates", () => {
    expect(aggregate("2026-10-20", [])).toEqual({
      ...base,
      outcome: "completed",
    })
  })
})
