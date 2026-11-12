import { Inject, Injectable, Logger } from "@nestjs/common"
import {
  DEFAULT_JOB_CRITERIA,
  normaliseTechnologyName,
  type CheckAgainResponse,
  type EligibilitySettings,
  type HiddenReason,
  type WaitingReason,
  type JobPostingDetail,
  type JobPostingSummary,
  type JobPostingsQuery,
  type JobPostingsResponse,
  type JobSourcesResponse,
  type PasteDescriptionOutcome,
  type PasteJobLinkRequest,
  type PasteJobLinkResponse,
  type VerifyJobSourceRequest,
  cleanPastedName,
  isOverridableDecision,
  normalisePastedDescription,
  pasteFieldErrors,
  ruleNameSchema,
} from "@eve/contracts"

import { APP_CONFIG } from "../config/config.module.js"
import { CandidateScope } from "../db/candidate-scope.js"
import type { AppConfig, SharedRuntimeConfig } from "../config/env.js"
import type { StoredSection } from "../db/schema.js"
import { ApiException } from "../http/api-exception.js"
import { decisionOf, isMarkable } from "../documents/override.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { applicationSystemName, checkPastedLink, locateAts, normaliseApplicationUrl } from "./application-url.js"
import { type PastedDescriptionInput, publicLink } from "./pasted-description-store.js"
import { DiscoveryPipeline } from "./discovery-pipeline.js"
import { DiscoveryRepository, TierMapChangedError } from "./discovery.repository.js"
import { EvaluationQueue } from "./evaluation-queue.js"
import { type CandidatePostingView, type PageFilter, type PageRow, keyOf } from "./job-postings-query.js"
import { PostingEvaluator, careerFacts } from "./posting-evaluator.js"
import type { StoredJobCriteria } from "./discovery.repository.js"
import { type CursorBinding, InvalidCursorError, PostingCursorCodec } from "./posting-cursor.js"
import { visibilityFactsOf } from "./discovery.repository.js"
import { ageDays, hiddenReason, watDate } from "./visibility.js"
import { canonicalEntries } from "./rules/job-criteria.js"
import { foldForKeywords } from "./rules/rule-result.js"
import { boardUrl } from "./sources/ats-readers.js"

type PostingRow = Readonly<
  CandidatePostingView & {
    posting_text?: string
    structured?: unknown
    technologies_missing: boolean
  }
>

/** A single posting read with its visibility facts (detail, pasted link). */
type DetailRow = PostingRow & Readonly<{ title_folded: string | null; prefilter_skip: string | null; seniority_marker: string | null }>

type MatchCounts = NonNullable<JobPostingSummary["match"]>

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name)
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly cursors: PostingCursorCodec

  constructor(
    private readonly repository: DiscoveryRepository,
    private readonly pipeline: DiscoveryPipeline,
    private readonly evaluator: PostingEvaluator,
    private readonly queue: EvaluationQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) config: AppConfig | SharedRuntimeConfig
  ) {
    // The cursor MAC key is derived (HKDF, own label) from the server's OAuth client secret, so cursors survive an
    // api restart. Without it (worker config) a per-process random key is used; the worker serves no list.
    this.cursors = new PostingCursorCodec("googleClientSecret" in config ? config.googleClientSecret : undefined)
  }

  async jobSources(): Promise<JobSourcesResponse> {
    const [state, boards, remote] = await Promise.all([
      this.repository.readEmployerListState(),
      this.repository.listEmployerBoards(),
      this.repository.listRemoteBoards(),
    ])
    return {
      employerList: {
        status: state.approved_at === null ? "draft" : "approved",
        approvedAt: state.approved_at?.toISOString() ?? null,
        companies: boards.map((board) => ({
          id: board.id,
          position: board.position,
          company: board.company,
          applicationSystem: board.application_system,
          boardToken: board.board_token,
          boardUrl: boardUrl({ applicationSystem: board.application_system, boardToken: board.board_token }),
          flag: board.flag,
          note: board.note,
        })),
      },
      remoteBoards: remote.map((board) => ({
        key: board.key,
        name: board.name,
        order: board.position,
        verifiedOn: dateOnly(board.verified_on),
        verificationBasis: board.verification_basis,
        enabled: board.enabled,
        available: board.available,
        unavailableReason: board.unavailable_reason,
        attributionName: board.attribution_name,
        attributionUrl: board.attribution_url,
      })),
      scheduledDiscoveryOn: state.approved_at !== null,
    }
  }

  async approveEmployerList(): Promise<JobSourcesResponse> {
    await this.repository.approveEmployerList(this.clock.now())
    return this.jobSources()
  }

  async verifyRemoteBoard(key: string, request: VerifyJobSourceRequest): Promise<JobSourcesResponse> {
    const board = await this.repository.findRemoteBoard(key)
    if (!board) throw new ApiException("not_found")
    if (!board.available) throw new ApiException("job_source_unavailable")
    await this.repository.verifyRemoteBoard(board.key, request.verifiedOn, request.basis.trim())
    return this.jobSources()
  }

  async setRemoteBoardEnabled(key: string, enabled: boolean): Promise<JobSourcesResponse> {
    const board = await this.repository.findRemoteBoard(key)
    if (!board) throw new ApiException("not_found")
    if (enabled && !board.available) throw new ApiException("job_source_unavailable")
    if (enabled && board.verified_on === null) throw new ApiException("job_source_not_verified")
    await this.repository.setRemoteBoardEnabled(board.key, enabled)
    return this.jobSources()
  }

  /**
   * Slice 8: one keyset page of a tab under the Posting filter (8P, 8F, 8K).
   * Any cursor the server did not issue for this tab and normalised filter is
   * a 400, never a 500 and never another order (8P.9, 8P.10).
   *
   * EPIC-0004 (decision D1, AC 6.1, 6.3): the Posting filter narrows the
   * criteria-decided tabs; `criteriaEmptyState` is computed from counts over
   * every posting with no tab, filter or cursor applied.
   */
  async listPostings(query: JobPostingsQuery): Promise<JobPostingsResponse> {
    const filter: PageFilter = { families: query.families, foldedKeyword: query.keyword === null ? null : foldForKeywords(query.keyword) }
    // A1 (C30) and B1: bound to the session's Candidate and the tier map of the preferences version this request reads.
    const bindingFor = (tierHash: string): CursorBinding => ({ tab: query.tab, families: filter.families, foldedKeyword: filter.foldedKeyword, candidateId: CandidateScope.require(), tierHash })
    const currentHash = await this.repository.currentTierHash()
    let after = null
    if (query.cursor !== null) {
      try {
        after = this.cursors.decode(query.cursor, bindingFor(currentHash))
      } catch (error) {
        if (error instanceof InvalidCursorError) throw new ApiException("bad_request")
        throw error
      }
    }
    const now = this.clock.now()
    const page$ = this.repository.listPage({ tab: query.tab, filter, after, limit: query.limit, now, tierHash: currentHash })
    const { rows, totalCount, aggregate, criteria, operator, tierHash } = await page$.catch((error: unknown) => {
      if (error instanceof TierMapChangedError) throw new ApiException("bad_request")
      throw error
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    const nextCursor = rows.length > query.limit && last ? this.cursors.encode(bindingFor(tierHash), keyOf(query.tab, last)) : null
    // EPIC-0006 (AC-3.2): the empty-state counts cover visible postings only.
    const criteriaEmptyState = aggregate.ranked === 0 && aggregate.criteriaSkipped > 0 && !isDefaultCriteria(criteria)
    const { hidden } = aggregate
    return {
      // Every list row is visible: its hiddenReason is null.
      postings: await this.pageSummaries(page, criteria, now),
      waitingToBeCheckedCount: aggregate.waiting,
      nextCursor,
      totalCount,
      criteriaEmptyState,
      hiddenCounts: { ...hidden, total: hidden.offTarget + hidden.belowSeniorityFloor + hidden.undated + hidden.olderThan60Days },
      recheckableCount: aggregate.recheckable,
      targetRoleFamilies: criteria.targetRoleFamilies,
      waitingReason: waitingReason(aggregate.waiting, operator),
    }
  }

  async posting(id: string): Promise<JobPostingDetail> {
    const row = await this.repository.findPosting(id)
    if (!row) throw new ApiException("not_found")
    const criteria = await this.repository.readCriteria()
    // EPIC-0006 (AC-3.8): a hidden posting still opens; its hiddenReason is set and its rank is null.
    const [summary] = await this.summaries([row], criteria)
    const [eligibility, match, profile, technologies, application] = await Promise.all([
      this.repository.findEligibility(id),
      this.repository.findMatch(id),
      this.repository.approvedFacts(),
      this.repository.findTechnologies(id),
      this.repository.findRequisitionApplication(id),
    ])
    // v1.24.0 (AA-1.1, AA-1.4, AA-6): offered only for a visible, overridable decision and no Application or a
    // markable one. Unlocked: the create re-checks everything. v1.27.0: never for a pasted description.
    const decision = decisionOf(row, eligibility?.rules ?? null)
    const pasted = row.origin === "pasted_description"
    const offered = !pasted && summary!.hiddenReason === null && isOverridableDecision(decision) && (application === undefined || isMarkable(application))
    // v1.27.0 (PD-3.1, OQ-6): a finished pasted posting with no Application offers "Prepare documents" with no dialog.
    const pastedPrepareOffered = pasted && (row.status === "ranked" || row.status === "skipped" || row.status === "excluded") && application === undefined
    const entries = new Set(canonicalEntries(criteria.frameworks, criteria.technologies))
    const factText = new Map(careerFacts((profile?.sections ?? []) as StoredSection[]).map((fact) => [fact.id, fact.text]))
    const items = (group: "core" | "mandatory" | "nice_to_have") =>
      (match?.items ?? [])
        .filter((item) => item.group === group)
        .map((item) => ({ text: item.text, factId: item.factId, factText: item.factId === null ? null : (factText.get(item.factId) ?? null) }))
    return {
      ...(summary as JobPostingSummary),
      postingText: row.posting_text ?? "",
      // AC 4.4, 3.6: listed whether or not the criterion is on; inCriteria is false when it is off.
      technologies:
        technologies?.map((technology) => ({ name: technology.name, quote: technology.quote, inCriteria: entries.has(normaliseTechnologyName(technology.name)) })) ??
        null,
      employmentType: eligibility?.employment_type ?? null,
      eligibility: eligibility
        ? {
            arrangement: eligibility.arrangement,
            relocationCountry: eligibility.relocation_country,
            // v1.24.0 (Gherkin apply-anyway.feature:110): a stored rule outside the five (e.g. commute) is left out of
            // this list so the detail still parses; `applyAnyway` reads every violated rule from the stored result.
            rules: eligibility.rules
              .filter((rule) => ruleNameSchema.safeParse(rule.rule).success)
              .map((rule) => ({
                rule: rule.rule as "location",
                result: rule.result as "met",
                quote: rule.quote,
              })),
            normalizedMonthlyMaxUsd: eligibility.normalized_monthly_max_usd === null ? null : Number(eligibility.normalized_monthly_max_usd).toFixed(2),
            fxRateDate: dateOnly(eligibility.fx_rate_date),
            evaluatedAt: eligibility.evaluated_at.toISOString(),
          }
        : null,
      match: match
        ? {
            verdict: match.verdict,
            weakReason: match.weak_reason as "unmet_mandatory" | null,
            coveredCount: match.covered_count,
            totalCount: match.total_count,
            thresholdPercent: Math.round(Number(match.threshold) * 100),
            atsFit: match.ats_fit ?? null,
            careerProfileVersion: match.career_profile_version,
            coreResponsibilities: items("core"),
            mandatoryPrerequisites: items("mandatory"),
            niceToHave: items("nice_to_have"),
          }
        : null,
      applyAnyway: offered ? { offered: true, decision } : null,
      applicationId: application?.id ?? null,
      pastedPrepareOffered,
    }
  }

  /**
   * `POST /v1/job-postings/links` (contract v1.27.0 "Processing order"). Without a usable
   * description it is today's link paste, byte for byte, plus the three new keys. With one, the
   * link (if any) and the fields are checked, an unheld Greenhouse, Lever or Ashby link is looked
   * up, and the description is stored as a private posting under the re-paste rules. Nothing is
   * stored on any refusal. The description is never logged.
   */
  async paste(body: PasteJobLinkRequest): Promise<PasteJobLinkResponse> {
    const description = body.description === undefined ? "" : normalisePastedDescription(body.description)
    const linkGiven = body.url !== undefined && body.url.trim() !== ""
    if (description === "") {
      if (linkGiven) return this.withPostingFields(await this.pasteLink(body.url!), null, null)
      if (body.description !== undefined) throw ApiException.pasteFields([{ field: "description", position: null, problem: "too_short" }])
      throw new ApiException("job_link_empty")
    }
    let link: PastedDescriptionInput["link"] = null
    if (linkGiven) {
      const check = checkPastedLink(body.url!)
      if (!check.ok) throw new ApiException("job_link_invalid")
      link = { normalised: normaliseApplicationUrl(check.url), raw: check.url, applicationSystem: applicationSystemName(check.url), ats: locateAts(check.url) !== null }
    }
    const fieldErrors = pasteFieldErrors({ description: body.description!, title: body.title, company: body.company, namesRequired: link === null || !link.ats })
    if (fieldErrors.length > 0) throw ApiException.pasteFields(fieldErrors)
    const title = cleanPastedName(body.title ?? "")
    const company = cleanPastedName(body.company ?? "")

    if (link?.ats && (await this.repository.findByUrl(link.normalised)) === undefined) {
      const resolved = await this.pipeline.lookUpForDescription(link.raw)
      if (resolved !== null) {
        // OQ-3: the employer's page wins; the description is discarded and never stored.
        const stored = await this.pipeline.storeResolvedLink(resolved)
        this.startEvaluation(stored.id, stored.evaluate)
        return this.pasteResponse(stored.id, stored.created, "employer_page_used", null)
      }
      // I-6: the lookup failed, so the text is the description; both names are then needed.
      const missing = (["title", "company"] as const).filter((field) => (field === "title" ? title : company) === "")
      if (missing.length > 0) throw ApiException.pasteFields(missing.map((field) => ({ field, position: null, problem: "required" as const })), "employer_page_unreadable")
    }

    const result = await this.repository.storePastedDescription({ text: description, title, company, link, discoveredAt: this.clock.now() })
    if (result.kind === "still_checking") throw new ApiException("posting_still_checking")
    if (result.kind === "names_missing") throw ApiException.pasteFields(result.fieldErrors, "employer_page_unreadable")
    this.logger.log(JSON.stringify({ event: "job_postings.pasted_description", postingId: result.id, outcome: result.outcome }))
    this.startEvaluation(result.id, result.evaluate)
    return this.pasteResponse(result.id, result.created, result.outcome, result.applicationId)
  }

  /** The paste response for a stored or held posting (its summary as now stored). */
  private async pasteResponse(id: string, created: boolean, outcome: PasteDescriptionOutcome, applicationId: string | null): Promise<PasteJobLinkResponse> {
    const row = await this.repository.findPosting(id)
    if (!row) throw new ApiException("internal_error")
    const [summary] = await this.summaries([row], await this.repository.readCriteria())
    return this.withPostingFields({ created, posting: summary as JobPostingSummary }, outcome, applicationId)
  }

  /** v1.27.0: `waitingReason` is set exactly when the returned posting waits: checks not enabled (D13), else the cost pause. */
  private async withPostingFields(
    result: Readonly<{ created: boolean; posting: JobPostingSummary }>,
    descriptionOutcome: PasteDescriptionOutcome | null,
    applicationId: string | null
  ): Promise<PasteJobLinkResponse> {
    const waiting = result.posting.status === "waiting_to_be_checked"
    const reason: WaitingReason | null = waiting ? ((await this.repository.evaluationAllowedNow()) ? "cost_pause" : "checks_not_enabled") : null
    return { created: result.created, posting: result.posting, descriptionOutcome, applicationId, waitingReason: reason }
  }

  /** Starts an evaluation in this process after the response (as for a pasted link); failures are logged by name only. */
  private startEvaluation(id: string, evaluate: boolean): void {
    if (!evaluate) return
    const task = this.evaluator
      .evaluate(id)
      .catch((error: unknown) => {
        this.logger.error(`Pasted posting evaluation failed: ${error instanceof Error ? error.name : "unknown"}`)
      })
      .finally(() => this.inFlight.delete(task))
    this.inFlight.add(task)
  }

  /**
   * AC 3.3: validated, stored once, then evaluated on demand. The evaluation
   * runs after the response, so the dashboard shows "Checking" at once. A
   * Candidate who may not have postings evaluated yet (EPIC-0002 D13) gets the
   * row stored and returned as "waiting_to_be_checked", with no evaluation.
   */
  async pasteLink(rawUrl: string): Promise<Readonly<{ created: boolean; posting: JobPostingSummary }>> {
    const check = checkPastedLink(rawUrl)
    if (!check.ok) throw new ApiException(check.code)
    const stored = await this.pipeline.ingestPastedLink(check.url)
    if (stored.evaluate) {
      const task = this.evaluator
        .evaluate(stored.id)
        .catch((error: unknown) => {
          this.logger.error(`Pasted link evaluation failed: ${error instanceof Error ? error.name : "unknown"}`)
        })
        .finally(() => this.inFlight.delete(task))
      this.inFlight.add(task)
    }
    const row = await this.repository.findPosting(stored.id)
    if (!row) throw new ApiException("internal_error")
    // EPIC-0006 (AC-5.7): the posting's first hidden reason, if any.
    const [summary] = await this.summaries([row], await this.repository.readCriteria())
    return { created: stored.created, posting: summary as JobPostingSummary }
  }

  /** EPIC-0006 Check again for the session Candidate (AC-7.3 to 7.5). Spends nothing itself. */
  async checkAgain(): Promise<CheckAgainResponse> {
    const result = await this.repository.checkAgain(this.clock.now(), (trx, candidateId, ids) => this.queue.enqueue(trx, candidateId, ids))
    this.logger.log(JSON.stringify({ event: "job_postings.check_again", queued: result.queued, movedTo: result.movedTo }))
    return result
  }

  /** Waits for evaluations started by this process. Used by tests. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }

  async eligibilitySettings(): Promise<EligibilitySettings> {
    const settings = await this.repository.readSettings()
    return { hoursCutoff: settings.hoursCutoff, hoursTimeZone: settings.hoursTimeZone }
  }

  /** Summaries of single postings (detail, pasted link); the rank comes from the same SQL order as the list. */
  private async summaries(rows: readonly DetailRow[], criteria: StoredJobCriteria): Promise<JobPostingSummary[]> {
    const ids = rows.map((row) => row.id)
    const now = this.clock.now()
    const ctx = await this.repository.visibilityContext(now)
    const reasons = new Map(rows.map((row) => [row.id, hiddenReason(visibilityFactsOf(row), ctx)]))
    const [counts, ranks] = await Promise.all([
      this.repository.findMatchCounts(ids),
      this.repository.ranksOf(ctx, rows.filter((row) => row.status === "ranked" && reasons.get(row.id) === null).map((row) => row.id)),
    ])
    const countBy = new Map(
      counts.map((row) => [
        row.job_posting_id,
        { coveredCount: row.covered_count, totalCount: row.total_count, thresholdPercent: thresholdPercent(row.threshold), atsFit: row.ats_fit },
      ])
    )
    return this.toSummaries(rows, criteria, now, (row) => countBy.get(row.id) ?? null, (row) => ranks.get(row.id) ?? null, (row) => reasons.get(row.id) ?? null)
  }

  private pageSummaries(rows: readonly PageRow[], criteria: StoredJobCriteria, now: Date): Promise<JobPostingSummary[]> {
    return this.toSummaries(
      rows,
      criteria,
      now,
      (row) =>
        row.covered_count === null || row.total_count === null || row.threshold === null
          ? null
          : { coveredCount: row.covered_count, totalCount: row.total_count, thresholdPercent: thresholdPercent(row.threshold), atsFit: atsFitOfRow(row) },
      (row) => row.rank,
      () => null
    )
  }

  private async toSummaries<Row extends PostingRow>(
    rows: readonly Row[],
    criteria: StoredJobCriteria,
    now: Date,
    matchOf: (row: Row) => MatchCounts | null,
    rankOf: (row: Row) => number | null,
    hiddenOf: (row: Row) => HiddenReason | null
  ): Promise<JobPostingSummary[]> {
    const technologyCriterionOn = criteria.frameworks.length + criteria.technologies.length > 0
    const labels = await this.repository.findUnverifiedLabels(rows.map((row) => row.id))
    const labelsBy = new Map(
      labels.map((row) => [
        row.job_posting_id,
        row.rules.filter((rule) => rule.result === "unverified").map((rule) => rule.rule as "location"),
      ])
    )
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      company: row.company,
      // v1.27.0: the synthetic URN of a description-only posting never leaves the API.
      applicationUrl: publicLink(row.application_url),
      requisitionId: row.requisition_id,
      applicationSystem: row.application_system,
      applyUrl: publicLink(row.apply_url),
      applyMode: row.apply_mode,
      origin: row.origin,
      attribution: row.attribution_name !== null && row.attribution_url !== null ? { name: row.attribution_name, url: row.attribution_url } : null,
      status: row.status,
      skipReason: row.skip_reason as JobPostingSummary["skipReason"],
      skipDetail: row.skip_detail,
      // v1.18.0: a queued (checking) row keeps its stored kind server-side but sends null.
      evaluationFailure: row.status === "evaluation_failed" ? (row.evaluation_failure as JobPostingSummary["evaluationFailure"]) : null,
      roleFamily: row.role_family as JobPostingSummary["roleFamily"],
      rank: row.status === "ranked" && hiddenOf(row) === null ? rankOf(row) : null,
      unverifiedLabels: labelsBy.get(row.id) ?? [],
      match: matchOf(row),
      // AC 4.5, 3.6: criterion on now, Match evidence exists, no technology data.
      technologiesNotChecked: technologyCriterionOn && matchOf(row) !== null && row.technologies_missing,
      discoveredAt: row.discovered_at.toISOString(),
      ...postedDateFields(row, now),
      hiddenReason: hiddenOf(row),
    }))
  }
}

/** v1.18.0 (AC-5.1, AC-6.1): all four null when undated; the same shared values for every holder, age per read. */
function postedDateFields(row: Readonly<{ posted_at: Date | null; posted_date_kind: "published" | "updated" | null }>, now: Date) {
  if (row.posted_at === null || row.posted_date_kind === null) return { postedAt: null, postedOn: null, postedDateKind: null, ageDays: null }
  return { postedAt: row.posted_at.toISOString(), postedOn: watDate(row.posted_at), postedDateKind: row.posted_date_kind, ageDays: ageDays(row.posted_at, now) }
}

/** v1.18.0 (r1): null when nothing waits; the Operator's rows wait for the cost pause, everyone else's for checks to be enabled (EPIC-0002 slice D). */
function waitingReason(waiting: number, operator: boolean): WaitingReason | null {
  if (waiting === 0) return null
  return operator ? "cost_pause" : "checks_not_enabled"
}

function thresholdPercent(threshold: string): number {
  return Math.round(Number(threshold) * 100)
}

function dateOnly(value: Date | string | null): string | null {
  if (value === null) return null
  if (typeof value === "string") return value.slice(0, 10)
  return value.toISOString().slice(0, 10)
}

/** AC 6.3: "differ from the defaults (70%, empty lists)". */
function isDefaultCriteria(criteria: StoredJobCriteria): boolean {
  return (
    criteria.minCoreMatchPercent === DEFAULT_JOB_CRITERIA.minCoreMatchPercent && criteria.frameworks.length === 0 && criteria.technologies.length === 0
  )
}

/** A page row's ATS fit: the Ranked tab sorts a missing one as -1, which the response sends as null. */
function atsFitOfRow(row: PageRow): number | null {
  const value = row.ats_fit ?? row.posting_ats_fit ?? null
  return value === null || value < 0 ? null : value
}
