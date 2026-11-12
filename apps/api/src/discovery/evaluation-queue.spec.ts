import { describe, expect, it } from "vitest"

import { CandidateScope } from "../db/candidate-scope.js"
import { EvaluationQueue } from "./evaluation-queue.js"

/**
 * EPIC-0002 A2 rules on EPIC-0006's send-only client: an `evaluate.posting`
 * job names the scope Candidate only, as the sample client does, so a caller
 * cannot queue work for another Candidate. The refusals happen before pg-boss
 * starts, so no connection is opened.
 */
const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"
const queue = () => new EvaluationQueue({ databaseUrl: "postgres://unused@127.0.0.1:1/none" } as never)
const trx = {} as never

describe("EvaluationQueue.enqueue (A2 Candidate job rules)", () => {
  it("refuses outside a Candidate scope", async () => {
    await expect(queue().enqueue(trx, A, ["p"])).rejects.toThrow(/Candidate scope/)
  })

  it("refuses a Candidate ID other than the scope's", async () => {
    await expect(CandidateScope.run(A, () => queue().enqueue(trx, B, ["p"]))).rejects.toThrow(/scope Candidate/)
  })

  it("refuses a malformed Candidate ID", async () => {
    await expect(CandidateScope.run(A, () => queue().enqueue(trx, "not-a-uuid", ["p"]))).rejects.toThrow(/scope Candidate/)
  })

  it("does nothing for no postings, even in scope", async () => {
    await expect(CandidateScope.run(A, () => queue().enqueue(trx, A, []))).resolves.toBeUndefined()
  })
})
