import { Inject, Injectable } from "@nestjs/common"
import {
  type FormAnswersResponse,
  type PrepareSamplesResult,
  REQUIRED_SAMPLES,
  type RuleNameValue,
  type SampleStateValue,
  type SamplesResponse,
  type SubmissionSummary,
} from "@eve/contracts"

import { summaryOf } from "../documents/documents.service.js"
import { overridesFor } from "../documents/override-reader.js"
import { readGraceEnd } from "../records/retention-view.js"
import type { StoredRule } from "../db/schema.js"
import { rankApplications } from "./rank-applications.js"
import { ApiException } from "../http/api-exception.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { previewAnswers } from "./answer-preview.js"
import { SampleRepository } from "./sample.repository.js"
import { submissionOf } from "./submission-state.service.js"
import { SubmissionRepository } from "./submission.repository.js"

/**
 * Activation Gate samples (AC 2.1, FE5-B1). Before the gate passes, the best-
 * ranked eligible strong-Match Applications with ready documents become
 * samples awaiting review, only as many as the five still need. One company
 * gets at most one sample, and recorded existing applications are skipped.
 */
@Injectable()
export class SampleService {
  constructor(
    private readonly samples: SampleRepository,
    private readonly submissions: SubmissionRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Under the activation row lock, so two runs (api action and the worker's daily job) add the needed samples once. */
  prepare(): Promise<PrepareSamplesResult> {
    return this.samples.transaction(async (trx) => {
      const activation = await this.samples.lockActivation(trx)
      if (activation.gate_passed_at !== null) return { created: 0, stoppedBy: "gate_passed" as const }
      const control = await this.samples.readControl(trx)
      if (control.global_paused || control.cost_paused) return { created: 0, stoppedBy: "paused" as const }
      if (!(await this.samples.hasApprovedProfile(trx))) return { created: 0, stoppedBy: "career_profile_not_approved" as const }
      const needed = REQUIRED_SAMPLES - (await this.samples.openSamples(trx))
      if (needed <= 0) return { created: 0, stoppedBy: null }
      // SEC-002 (AC 5.8): candidates must be ranked under committed criteria; a save re-deciding them finishes first.
      await this.samples.shareCriteria(trx)
      // EPIC-0006 (AC-3.9): only postings visible for this Candidate become samples.
      const rows = await this.samples.candidates(trx, await this.samples.visibilityContext(trx, this.clock.now()))
      const byId = new Map(rows.map((row) => [row.id, row]))
      // Slice 8d (RF-28): the Ranked tab order, tie broken on the posting id.
      const order = rankApplications(rows, await this.samples.tierMap(trx))
      const companies = new Set<string>()
      const picked: string[] = []
      for (const id of order) {
        if (picked.length === needed) break
        const company = (byId.get(id)?.company ?? "").trim().toLowerCase()
        if (company !== "" && companies.has(company)) continue
        if (company !== "") companies.add(company)
        picked.push(id)
      }
      await this.samples.markAwaiting(trx, picked, this.clock.now())
      return { created: picked.length, stoppedBy: picked.length < needed ? ("no_candidates" as const) : null }
    })
  }

  awaitingWithoutFormRead(): Promise<string[]> {
    return this.samples.awaitingWithoutFormRead()
  }

  async list(state: SampleStateValue): Promise<SamplesResponse> {
    const rows = await this.samples.listByState(state)
    const now = this.clock.now()
    const { graceEnd, overrides } = await this.submissions.run(async (tx, candidateId) => ({ graceEnd: await readGraceEnd(tx, candidateId, now), overrides: await overridesFor(tx, candidateId, rows, now) }))
    return {
      rows: rows.map((row) => ({
        application: summaryOf(row, graceEnd, overrides.get(row.id) ?? null),
        submission: submissionOf(row, overrides.get(row.id) ?? null),
        applicationSystem: row.application_system,
        match: row.covered_count === null || row.total_count === null ? null : { coveredCount: row.covered_count, totalCount: row.total_count },
        unverifiedLabels: unverified(row.rules),
      })),
    }
  }

  async summary(): Promise<SubmissionSummary> {
    const counts = await this.samples.summary()
    return {
      samples: { awaitingReview: Number(counts.awaiting), approved: Number(counts.approved), rejected: Number(counts.rejected) },
      blocked: Number(counts.blocked),
      held: Number(counts.held),
      uncertain: Number(counts.uncertain),
    }
  }

  /** The planned answers for the form as last read by the worker, from the Candidate's current answers and settings. */
  async formAnswers(applicationId: string): Promise<FormAnswersResponse> {
    if (!(await this.samples.applicationExists(applicationId))) throw new ApiException("not_found")
    const read = await this.samples.findFormRead(applicationId)
    if (!read) return { available: false, readAt: null, answers: [] }
    const sources = await this.submissions.loadAnswerSources(applicationId)
    return { available: true, readAt: read.read_at.toISOString(), answers: previewAnswers(read.controls, sources) }
  }
}

function unverified(rules: readonly StoredRule[] | null): RuleNameValue[] {
  return (rules ?? []).filter((rule) => rule.result === "unverified").map((rule) => rule.rule as RuleNameValue)
}
