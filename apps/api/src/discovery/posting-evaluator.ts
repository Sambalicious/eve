import { Inject, Injectable, Logger } from "@nestjs/common"

import { ModelGateway } from "../ai/model-gateway.js"
import type { StoredSection } from "../db/schema.js"
import { atsFit, atsKeywords } from "../ats/ats-score.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { Semaphore } from "../shared/semaphore.js"
import { DiscoveryRepository } from "./discovery.repository.js"
import { FX_RATES } from "./fx-rates.js"
import {
  type CareerFact,
  POSTING_EXTRACTION_EFFORT,
  POSTING_EXTRACTION_MAX_OUTPUT_TOKENS,
  POSTING_EXTRACTION_PURPOSE,
  POSTING_EXTRACTION_SYSTEM_PROMPT,
  POSTING_EXTRACTION_TIMEOUT_MS,
  buildExtractionPrompt,
  postingExtractionSchema,
} from "./posting-extraction.js"
import { assessPosting, finishVerdict } from "./posting-verdict.js"
import { canonicalEntries, decisionCriteria } from "./rules/job-criteria.js"
import type { StructuredFields } from "./rules/eligibility.js"
import { RULE_NAMES } from "./rules/rule-result.js"
import { tenureMonths } from "./rules/tenure.js"
import { EMPTY_STRUCTURED } from "./sources/discovered-posting.js"

export type EvaluationResult = "evaluated" | "waiting" | "failed" | "not_claimed" | "hidden"

/**
 * SEC-601: evaluations this process runs at once. Each holds one pooled
 * connection for the TM-04 session lock and needs at most one more for its
 * short transactions, so 4 use at most 8 of the 10 pool connections and leave
 * room for requests and /v1/health. The rest wait here, holding no connection.
 */
export const EVALUATION_SLOTS = 4

/**
 * Evaluates one stored Job Posting (architecture r1, `evaluate.posting`): one
 * metered ModelGateway call behind the provider approval gate, then every
 * decision in code. During the cost pause nothing is sent; the posting waits
 * (Candidate decision r3, 2026-10-17). A global pause alone does not stop
 * evaluation (r3: pasted links are evaluated and queued).
 *
 * EPIC-0006 (AC-7.1): the first steps, before the cost-pause check, are the
 * D13 rule (`evaluationAllowed`: a non-Operator's row returns to waiting) and
 * the visibility gate for the scope Candidate. A hidden posting reserves nothing,
 * calls no model and returns "hidden"; its row goes back to the state the
 * attempt found (`DiscoveryRepository.hideIfHidden`). A model call already in
 * flight when a posting becomes hidden finishes and records its verdict.
 */
@Injectable()
export class PostingEvaluator {
  private readonly logger = new Logger(PostingEvaluator.name)
  private readonly slots = new Semaphore(EVALUATION_SLOTS)

  constructor(
    private readonly repository: DiscoveryRepository,
    private readonly gateway: ModelGateway,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async evaluate(postingId: string): Promise<EvaluationResult> {
    const result = await this.slots.use(() => this.repository.exclusiveEvaluation(postingId, () => this.evaluateOnce(postingId)))
    return result === "locked" ? "not_claimed" : result
  }

  private async evaluateOnce(postingId: string): Promise<EvaluationResult> {
    // TM-05 / CHK-38: the same D13 rule as Check again and the worker, before anything that could spend.
    if (await this.repository.deferIfNotAllowed(postingId)) return "waiting"
    const hidden = await this.repository.hideIfHidden(postingId, this.clock.now())
    if (hidden === undefined) return "not_claimed"
    if (hidden !== null) {
      this.logger.log(JSON.stringify({ event: "posting.evaluation_skipped_hidden", postingId, reason: hidden }))
      return "hidden"
    }
    const control = await this.repository.readControl()
    if (control.cost_paused) {
      await this.repository.markWaitingIfClaimable(postingId)
      return "waiting"
    }
    if (!(await this.repository.moveToChecking(postingId, ["checking", "waiting_to_be_checked", "evaluation_failed"], this.clock.now()))) {
      return "not_claimed"
    }
    const posting = await this.repository.findPosting(postingId)
    if (!posting) return "not_claimed"
    // EPIC-0002 B1 (R6-2 steps 2 and 3): an excluded family or a saved keyword the title lacks skips here, before any
    // reservation or model call. The verdict transaction re-applies both under the then-current version (AC 5.10 widening).
    // EPIC-0010 (architecture "Evaluation reuse"): a pasted description takes no early exit, so its keywords, Eligibility
    // and Match are always recorded; the verdict transaction still records the same preference skip.
    const pasted = posting.origin === "pasted_description"
    const preferenceSkip = pasted ? null : await this.repository.skipByPreferences(postingId, this.clock.now())
    if (preferenceSkip !== null) {
      this.logger.log(JSON.stringify({ event: "posting.skipped_by_preferences", postingId, reason: preferenceSkip }))
      return "evaluated"
    }
    // B1 (r1 E4): one preferences version per evaluation, read at its start; the Eligibility rules use only it.
    const { version: preferencesVersion, preferences } = await this.repository.readEligibilityPreferences()
    const profile = await this.repository.approvedFacts()
    if (!profile) {
      await this.repository.markFailed(postingId, "no_career_profile", this.clock.now())
      return "failed"
    }
    const facts = careerFacts(profile.sections)
    try {
      const result = await this.gateway.generateObject({
        purpose: POSTING_EXTRACTION_PURPOSE,
        system: POSTING_EXTRACTION_SYSTEM_PROMPT,
        prompt: buildExtractionPrompt(posting.posting_text, facts),
        schema: postingExtractionSchema,
        maxOutputTokens: POSTING_EXTRACTION_MAX_OUTPUT_TOKENS,
        effort: POSTING_EXTRACTION_EFFORT,
        timeoutMs: POSTING_EXTRACTION_TIMEOUT_MS,
        jobPostingId: postingId,
        cost: { action: "Eligibility and Match check" },
      })
      if (!result.ok && result.failure === "cost_paused") {
        // cost-ceiling.feature @r4: the link stays saved and unevaluated until the cost pause ends.
        await this.repository.markWaiting(postingId)
        return "waiting"
      }
      if (!result.ok) {
        await this.repository.markFailed(postingId, result.failure, this.clock.now())
        return "failed"
      }
      const evaluatedAt = this.clock.now()
      // AC 4.3, 5.6: everything up to here reads no Job criteria. They are read under lock when the verdict is written.
      const assessment = assessPosting({
        tenureMonths: tenureMonths(profile.sections, evaluatedAt),
        title: posting.title,
        postingText: posting.posting_text,
        structured: structuredOf(posting.structured),
        extraction: result.object,
        approvedFactIds: new Set(facts.map((fact) => fact.id)),
        preferences,
        rates: FX_RATES,
        evaluatedOn: evaluatedAt,
      })
      const { rules } = assessment.eligibility
      const { match } = assessment
      const criteria = await this.repository.recordEvaluation(
        postingId,
        {
          roleFamily: assessment.roleFamily,
          preferencesVersion,
          eligibility: {
            arrangement: assessment.eligibility.arrangement,
            relocationCountry: assessment.eligibility.relocationCountry,
            employmentType: assessment.eligibility.employmentType,
            rules: RULE_NAMES.map((rule) => ({ rule, result: rules[rule].result, quote: rules[rule].quote })),
            eligible: assessment.decision.eligible,
            normalizedMonthlyMaxUsd: rules.pay.normalizedMonthlyMaxUsd,
            fxRateDate: rules.pay.fxRateDate,
          },
          match: {
            careerProfileVersion: profile.version,
            coveredCount: match.coveredCount,
            totalCount: match.totalCount,
            // `byTenure` stays in memory: the stored item keeps factId null, which is still true (no single fact covers it).
            items: [
              ...match.core.map((item) => ({ group: "core" as const, text: item.text, factId: item.factId })),
              ...match.mandatory.map((item) => ({ group: "mandatory" as const, text: item.text, factId: item.factId })),
              ...match.niceToHave.map((item) => ({ group: "nice_to_have" as const, ...item })),
            ],
          },
          technologies: assessment.technologies,
          keySkills: assessment.keySkills,
          // EPIC-0012 rule 4: a pasted description stays null (the paste path never fills it).
          forwardStatements: pasted ? [] : assessment.forwardStatements,
          atsFit: atsFitOf(assessment, posting.company, profile.sections),
          evaluatedAt,
        },
        (stored) => {
          const verdict = finishVerdict(assessment, decisionCriteria(stored))
          return {
            status: verdict.status,
            skipReason: verdict.skipReason,
            skipDetail: verdict.skipDetail,
            verdict: verdict.matchVerdict.verdict,
            weakReason: verdict.matchVerdict.weakReason,
            criteriaTechnologies: canonicalEntries(stored.frameworks, stored.technologies),
          }
        }
      )
      this.logger.log(
        JSON.stringify({
          event: "posting.evaluated",
          postingId,
          criteriaVersion: criteria.version,
          technologies: assessment.technologies === null ? null : assessment.technologies.length,
          droppedQuoteCount: assessment.droppedQuoteCount,
          technologyItemsDropped: assessment.droppedTechnologyCount,
          technologyItemsDroppedByBudget: assessment.budgetDroppedTechnologyCount,
        })
      )
      return "evaluated"
    } catch (error) {
      this.logger.error(`Evaluating posting ${postingId} failed: ${error instanceof Error ? error.name : "unknown"}`)
      await this.repository.markFailed(postingId, "provider_error", this.clock.now()).catch(() => undefined)
      return "failed"
    }
  }
}

export function careerFacts(sections: readonly StoredSection[]): CareerFact[] {
  return sections.flatMap((section) => section.facts.map((fact) => ({ id: fact.id, text: fact.text, section: sectionLabel(section) })))
}

/** "Senior Frontend Engineer, Acme · Feb 2023 – Nov 2023" for a role; the bare title otherwise. */
function sectionLabel(section: StoredSection): string {
  const role = section.organization ? `${section.title}, ${section.organization}` : section.title
  // The dates let the model judge dated requirements ("3+ years in cloud computing"); total years are
  // decided in rules/tenure.ts, never by the model.
  return section.period ? `${role} · ${section.period}` : role
}

function structuredOf(value: Record<string, unknown>): StructuredFields {
  return { ...EMPTY_STRUCTURED, ...(value as Partial<StructuredFields>) }
}

/** ATS fit of the posting against the approved profile (titles and facts), or null when the posting names no keywords. */
function atsFitOf(assessment: Readonly<{ technologies: readonly { name: string; quote: string }[] | null; keySkills: readonly { name: string; quote: string }[] | null }>, company: string | null, sections: readonly StoredSection[]): number | null {
  const keywords = atsKeywords(assessment.technologies, assessment.keySkills, company)
  if (keywords.length === 0) return null
  return atsFit(keywords, sections.flatMap((section) => [section.title, ...section.facts.map((fact) => fact.text)]).join("\n"))
}
