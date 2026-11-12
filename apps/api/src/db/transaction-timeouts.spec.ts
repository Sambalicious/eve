import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { VERDICT_TIMEOUTS } from "../discovery/discovery.repository.js"
import { CREATE_TIMEOUTS } from "../documents/documents.repository.js"
import { SAVE_TIMEOUTS } from "../job-criteria/job-criteria.repository.js"
import { SUMMARY_READ_TIMEOUTS } from "../stack-posts/stack-posts-summary.js"
import { REGISTER_FEED_TIMEOUTS } from "../stack-posts/stack-posts.repository.js"
import { PREPARE_TIMEOUTS } from "../submission/sample.repository.js"
import { CLAIM_TIMEOUTS } from "../submission/submission.repository.js"
import { API_STATEMENT_TIMEOUT_MS } from "./create-database.js"
import { transactionTimeouts } from "./transaction-timeouts.js"

/**
 * QA-G5-2: a lock wait must end with lock_not_available (55P03), which callers
 * retry or map, never with query_canceled (57014) from statement_timeout. That
 * holds only while every lock_timeout is strictly shorter than the
 * statement_timeout in force for the same statement.
 */
describe("transaction timeout hierarchy (QA-G5-2)", () => {
  it.each([
    ["verdict (DiscoveryRepository.recordEvaluation)", VERDICT_TIMEOUTS],
    ["save (JobCriteriaRepository.saveAndRedecide)", SAVE_TIMEOUTS],
    ["create (DocumentsRepository.createIfRanked)", CREATE_TIMEOUTS],
    ["sample preparation (SampleRepository.transaction)", PREPARE_TIMEOUTS],
    ["automatic claim and pre-open re-check (SubmissionRepository, SEC-014)", CLAIM_TIMEOUTS],
    ["Alert feed registration (StackPostsRepository.insertFeedWithPosts, SEC-E5F-04)", REGISTER_FEED_TIMEOUTS],
    ["daily summary window read (StackPostsSummaryReader.summary, SEC-E5F-04)", SUMMARY_READ_TIMEOUTS],
  ])("%s: lock_timeout is strictly shorter than its local statement_timeout", (_name, timeouts) => {
    expect(timeouts.lockTimeoutMs).toBeGreaterThan(0)
    expect(timeouts.lockTimeoutMs).toBeLessThan(timeouts.statementTimeoutMs)
  })

  // Why each transaction sets its own statement_timeout: the evaluator runs in both processes, and the api pool's
  // 5 s statement_timeout alone would not leave room for the verdict's 5 s lock wait. The local `set local` pair
  // makes the pool values irrelevant inside the transaction, so no test couples these values to the pools
  // (G7 CR-01, QA-G7-1); the strict lock < statement test above is the rule.
  it("keeps architecture.r1.md's values: verdict lock 5 s, save lock 3 s, both statements 10 s", () => {
    expect(VERDICT_TIMEOUTS).toEqual({ lockTimeoutMs: 5_000, statementTimeoutMs: 10_000 })
    expect(SAVE_TIMEOUTS).toEqual({ lockTimeoutMs: 3_000, statementTimeoutMs: 10_000 })
  })

  it("g6 r1: create and sample preparation use the verdict pair, 5 s lock and 10 s statement", () => {
    expect(CREATE_TIMEOUTS).toEqual(VERDICT_TIMEOUTS)
    expect(PREPARE_TIMEOUTS).toEqual(VERDICT_TIMEOUTS)
  })

  it("SEC-014: the automatic claim uses the verdict pair, 5 s lock and 10 s statement", () => {
    expect(CLAIM_TIMEOUTS).toEqual(VERDICT_TIMEOUTS)
  })

  it("EPIC-0005 r4 item 3: registration 3 s lock / 10 s statement, summary read 5 s / 10 s", () => {
    expect(REGISTER_FEED_TIMEOUTS).toEqual({ lockTimeoutMs: 3_000, statementTimeoutMs: 10_000 })
    expect(REGISTER_FEED_TIMEOUTS).toEqual(SAVE_TIMEOUTS)
    expect(SUMMARY_READ_TIMEOUTS).toEqual({ lockTimeoutMs: 5_000, statementTimeoutMs: 10_000 })
    expect(SUMMARY_READ_TIMEOUTS).toEqual(CLAIM_TIMEOUTS)
    // The registration's lock bound fires before the api pool's 5 s statement bound would.
    expect(REGISTER_FEED_TIMEOUTS.lockTimeoutMs).toBeLessThan(API_STATEMENT_TIMEOUT_MS)
  })

  it.each([
    [5_000, 5_000],
    [6_000, 5_000],
    [0, 5_000],
    [-1, 5_000],
    [1.5, 5_000],
  ])("rejects lock %d ms with statement %d ms", (lock, statement) => {
    expect(() => transactionTimeouts(lock, statement)).toThrow(/lock_timeout/)
  })

  it("no source file sets lock_timeout except through the transaction-timeouts helper", () => {
    const root = join(import.meta.dirname, "..")
    const offenders = sourceFiles(root)
      .filter((file) => !file.endsWith("transaction-timeouts.ts"))
      .filter((file) => /\bset\s+(local\s+|session\s+)?lock_timeout|set_config\(\s*'lock_timeout'/i.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length + 1))
    expect(offenders).toEqual([])
  })
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith(".ts") && !path.endsWith(".spec.ts") ? [path] : []
  })
}
