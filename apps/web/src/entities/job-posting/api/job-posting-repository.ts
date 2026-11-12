import {
  checkAgainResponseSchema,
  JOB_POSTINGS_CHECK_AGAIN_PATH,
  jobPostingsPath,
  JOB_POSTING_LINKS_PATH,
  JOB_POSTINGS_PATH,
  jobPostingDetailSchema,
  jobPostingsResponseSchema,
  pasteJobLinkResponseSchema,
  type JobPostingDetail as JobPostingDetailBody,
  type JobPostingSummary,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { CheckAgainResult, JobPosting, JobPostingDetail, JobPostingPage, PasteRequest, PasteResult, PostingFilter, PostingsTab } from "../model/job-posting"

export interface JobPostingsPageRequest {
  readonly tab: PostingsTab
  readonly filter?: PostingFilter
  readonly cursor?: string | null
  readonly limit?: number
}

/** One page of a tab under the Posting filter (v1.12.0). The cursor must come from the same tab and filter. */
export async function fetchJobPostingsPage({ tab, filter, cursor, limit }: JobPostingsPageRequest): Promise<JobPostingPage> {
  const path = jobPostingsPath({ tab, families: filter?.families, keyword: filter?.keyword, limit, cursor })
  const response = await apiRequest(path)
  const body = jobPostingsResponseSchema.parse(await response.json())
  return {
    postings: body.postings.map(toJobPosting),
    waitingToBeCheckedCount: body.waitingToBeCheckedCount,
    nextCursor: body.nextCursor,
    totalCount: body.totalCount,
    criteriaEmptyState: body.criteriaEmptyState,
    hiddenCounts: { ...body.hiddenCounts },
    recheckableCount: body.recheckableCount,
    targetRoleFamilies: [...body.targetRoleFamilies],
    waitingReason: body.waitingReason,
  }
}

/**
 * v1.18.0: re-queues the session Candidate's visible failed and not-checked
 * postings. No body: the server decides which rows. A 200 the schema refuses
 * throws, so the caller shows the network error and never a toast without its number.
 */
export async function checkAgain(csrfToken: string): Promise<CheckAgainResult> {
  const response = await apiRequest(JOB_POSTINGS_CHECK_AGAIN_PATH, { method: "POST", csrfToken, json: {} })
  const body = checkAgainResponseSchema.parse(await response.json())
  return { queued: body.queued, movedTo: body.movedTo }
}

export async function fetchJobPosting(id: string): Promise<JobPostingDetail> {
  const response = await apiRequest(`${JOB_POSTINGS_PATH}/${encodeURIComponent(id)}`)
  return toJobPostingDetail(jobPostingDetailSchema.parse(await response.json()))
}

/**
 * `created: false` means the link resolved to a stored Job Posting (C-LINK-2).
 * v1.27.0: a link-only paste sends exactly `{ url }`; a paste with a description
 * sends the keys it was given. `descriptionOutcome` is null exactly for link-only.
 */
export async function pasteJobLink(request: PasteRequest, csrfToken: string): Promise<PasteResult> {
  const response = await apiRequest(JOB_POSTING_LINKS_PATH, { method: "POST", csrfToken, json: request })
  const body = pasteJobLinkResponseSchema.parse(await response.json())
  return {
    created: body.created,
    posting: toJobPosting(body.posting),
    descriptionOutcome: body.descriptionOutcome,
    applicationId: body.applicationId,
    waitingReason: body.waitingReason,
  }
}

function toJobPosting(body: JobPostingSummary): JobPosting {
  return {
    id: body.id,
    title: body.title,
    company: body.company,
    applicationUrl: body.applicationUrl,
    requisitionId: body.requisitionId,
    applicationSystem: body.applicationSystem,
    applyUrl: body.applyUrl,
    isManual: body.applyMode === "manual",
    pastedDescription: body.origin === "pasted_description",
    attribution: body.attribution && { name: body.attribution.name, url: body.attribution.url },
    status: body.status,
    skipReason: body.skipReason,
    skipDetail: body.skipDetail,
    evaluationFailure: body.evaluationFailure,
    roleFamily: body.roleFamily,
    rank: body.rank,
    unverifiedLabels: [...body.unverifiedLabels],
    coverage: body.match && {
      covered: body.match.coveredCount,
      total: body.match.totalCount,
      thresholdPercent: body.match.thresholdPercent,
      atsFit: body.match.atsFit ?? null,
    },
    technologiesNotChecked: body.technologiesNotChecked,
    discoveredAt: body.discoveredAt,
    postedDate: toPostedDate(body),
    hiddenReason: body.hiddenReason,
  }
}

/** The four date fields are all null or all set (v1.18.0); anything else counts as undated. */
function toPostedDate(body: JobPostingSummary): JobPosting["postedDate"] {
  const { postedOn, postedDateKind, ageDays } = body
  if (postedOn === null || postedDateKind === null || ageDays === null) return null
  return { on: postedOn, kind: postedDateKind, ageDays }
}

function toJobPostingDetail(body: JobPostingDetailBody): JobPostingDetail {
  const { eligibility, match } = body
  return {
    ...toJobPosting(body),
    postingText: body.postingText,
    technologies: body.technologies && body.technologies.map((t) => ({ name: t.name, quote: t.quote, inCriteria: t.inCriteria })),
    employmentType: body.employmentType,
    applyAnyway: body.applyAnyway && {
      decision: {
        status: body.applyAnyway.decision.status,
        skipReason: body.applyAnyway.decision.skipReason,
        skipDetail: body.applyAnyway.decision.skipDetail,
        violatedRules: [...body.applyAnyway.decision.violatedRules],
      },
    },
    applicationId: body.applicationId,
    pastedPrepareOffered: body.pastedPrepareOffered,
    eligibility: eligibility && {
      arrangement: eligibility.arrangement,
      relocationCountry: eligibility.relocationCountry,
      rules: eligibility.rules.map((r) => ({ rule: r.rule, result: r.result, quote: r.quote })),
      normalizedMonthlyMaxUsd: eligibility.normalizedMonthlyMaxUsd,
      fxRateDate: eligibility.fxRateDate,
      evaluatedAt: eligibility.evaluatedAt,
    },
    match: match && {
      verdict: match.verdict,
      weakReason: match.weakReason,
      covered: match.coveredCount,
      total: match.totalCount,
      thresholdPercent: match.thresholdPercent,
      atsFit: match.atsFit ?? null,
      careerProfileVersion: match.careerProfileVersion,
      coreResponsibilities: match.coreResponsibilities.map(toItem),
      mandatoryPrerequisites: match.mandatoryPrerequisites.map(toItem),
      niceToHave: match.niceToHave.map(toItem),
    },
  }
}

function toItem(item: { text: string; factId: string | null; factText: string | null }) {
  return { text: item.text, factId: item.factId, factText: item.factText }
}
