import { Inject, Injectable } from "@nestjs/common"

import { CLOCK, type Clock } from "../shared/clock.js"
import { SubmissionRepository } from "./submission.repository.js"
import { type SubmitOutcome, SubmissionService } from "./submission.service.js"

export type SampleRunOutcome = SubmitOutcome | Readonly<{ result: "skipped" }> | Readonly<{ result: "returned_to_review"; refusal: string }>

/**
 * Runs one approved sample's submission in the worker (F-QA5-01, AC 2.2).
 * Only an approved sample that has not entered submission is attempted, so a
 * stale or second job does nothing. When nothing was sent (paused, no browser,
 * the Application not ready), the sample goes back to awaiting review so the
 * Candidate can approve it again (C-SAMPLE-13). A duplicate stays not
 * submitted. There is no retry.
 */
@Injectable()
export class SampleSubmissionRunner {
  constructor(
    private readonly submissions: SubmissionService,
    private readonly repository: SubmissionRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async run(applicationId: string): Promise<SampleRunOutcome> {
    const row = await this.repository.findApplication(applicationId)
    if (!row || row.sample_state !== "approved" || row.submission_state !== null) return { result: "skipped" }
    let outcome: SubmitOutcome
    try {
      outcome = await this.submissions.submit(applicationId, "sample")
    } catch (error) {
      await this.repository.returnSampleToReview(applicationId, this.clock.now())
      throw error
    }
    // v1.24.0 (AA-3.3): a sample dropped at its pre-click check ended not submitted; it is not returned to review.
    if (outcome.result !== "refused" || outcome.refusal === "duplicate" || outcome.refusal === "posting_closed") return outcome
    await this.repository.returnSampleToReview(applicationId, this.clock.now())
    return { result: "returned_to_review", refusal: outcome.refusal }
  }
}
