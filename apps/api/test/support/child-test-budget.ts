import { EXTRACTION_LIMITS } from "../../src/career-profile/resume-text.js"

/**
 * Time a test that spawns the extraction child may take, derived from the product's
 * own limits instead of Vitest's 5 s default: the start-up allowance plus the parse
 * deadline (both documented in EXTRACTION_LIMITS), plus a margin for building the
 * fixture and the parent's bookkeeping. Under CPU contention a one-page resume took
 * 8.5-20.4 s end to end here, all within the product's limits, so a 5 s test budget
 * failed tests the product would pass.
 *
 * A test that spawns the child more than once multiplies this by its spawn count.
 */
export const CHILD_TEST_MARGIN_MS = 10_000
export const CHILD_TEST_BUDGET_MS = EXTRACTION_LIMITS.startupTimeoutMs + EXTRACTION_LIMITS.timeoutMs + CHILD_TEST_MARGIN_MS

export function childTestBudget(spawns: number): number {
  return spawns * (EXTRACTION_LIMITS.startupTimeoutMs + EXTRACTION_LIMITS.timeoutMs) + CHILD_TEST_MARGIN_MS
}
