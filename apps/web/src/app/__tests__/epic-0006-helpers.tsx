import userEvent from "@testing-library/user-event"
import { HttpResponse, http, type JsonBodyType } from "msw"
import {
  CSRF_HEADER,
  JOB_CRITERIA_PATH,
  JOB_POSTINGS_CHECK_AGAIN_PATH,
  JOB_POSTINGS_PATH,
  JOB_POSTING_LINKS_PATH,
  checkAgainResponseSchema,
  jobCriteriaRequestSchema,
  jobCriteriaResponseSchema,
  jobPostingDetailSchema,
  jobPostingsResponseSchema,
  pasteJobLinkResponseSchema,
  type CheckAgainResponse,
  type JobCriteriaResponse,
  type JobPostingDetail,
  type JobPostingSummary,
  type JobPostingsResponse,
} from "@eve/contracts"

import { apiErrorResponse, createCareerSetupApi, createDiscoveryApi, server, signedInSession, TEST_CSRF_TOKEN } from "@/shared/testing"
import { renderApp } from "./test-app"

/**
 * EPIC-0006 QA test authoring (step [5e]): a self-contained fake of the
 * v1.18.0 endpoints the board and Settings use, parsed with the contract
 * schemas. It does not reuse the shared discovery fake, so these tests stay
 * independent of how the frontend session updates it. Visibility is decided
 * here the way the contract defines it: the fake returns what the API would.
 */

export const DEFAULT_TARGETS = [
  "senior_frontend",
  "technical_lead",
  "fullstack",
  "product_engineering",
  "software_engineering",
  "backend",
  "mobile",
  "platform_engineering",
  "people_management",
] as const

export const FAMILY_LABELS: readonly (readonly [string, string])[] = [
  ["senior_frontend", "Frontend"],
  ["technical_lead", "Hands-on technical lead"],
  ["fullstack", "Fullstack"],
  ["product_engineering", "Product engineering"],
  ["software_engineering", "Software engineering"],
  ["backend", "Backend"],
  ["mobile", "Mobile"],
  ["platform_engineering", "Platform engineering"],
  ["devops_platform", "DevOps and SRE"],
  ["people_management", "Engineering management"],
  ["data_ml", "Data and ML"],
  ["solutions_customer", "Solutions and customer engineering"],
  ["other", "Other"],
]

let counter = 0
const NOW = "2026-10-24T08:00:00.000Z"

/** A visible, dated (2026-10-20, age 4), ranked posting with every v1.18.0 field. */
export function posting(over: Partial<JobPostingDetail> = {}): JobPostingDetail {
  const n = ++counter
  const id = `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  return jobPostingDetailSchema.parse({
    id,
    title: "Senior Frontend Engineer",
    company: `Acme ${n}`,
    applicationUrl: `https://boards.greenhouse.io/acme/jobs/${n}`,
    requisitionId: `R-${n}`,
    applicationSystem: "Greenhouse",
    applyUrl: `https://boards.greenhouse.io/acme/jobs/${n}`,
    applyMode: "automatic",
    origin: "employer_board",
    attribution: null,
    status: "ranked",
    skipReason: null,
    skipDetail: null,
    evaluationFailure: null,
    roleFamily: "senior_frontend",
    rank: 1,
    unverifiedLabels: [],
    match: null,
    technologiesNotChecked: false,
    discoveredAt: NOW,
    postedAt: "2026-10-19T23:00:00.000Z",
    postedOn: "2026-10-20",
    postedDateKind: "published",
    ageDays: 4,
    hiddenReason: null,
    // v1.24.0: no Application and no override offer in these EPIC-0006 fixtures.
    applyAnyway: null,
    applicationId: null,
    // v1.27.0: not a pasted-description posting.
    pastedPrepareOffered: false,
    technologies: null,
    postingText: "Acme builds payment APIs for merchants.\nRemote, open to candidates in Nigeria.",
    employmentType: "direct",
    eligibility: null,
    ...over,
  })
}

/** A dated posting aged `days` (whole WAT days at 2026-10-24). */
export function aged(days: number, kind: "published" | "updated" = "published", over: Partial<JobPostingDetail> = {}) {
  const on = new Date(Date.UTC(2026, 9, 24) - days * 86_400_000).toISOString().slice(0, 10)
  return posting({ postedOn: on, postedAt: `${on}T00:00:00.000Z`, postedDateKind: kind, ageDays: days, ...over })
}

export type HiddenCounts = JobPostingsResponse["hiddenCounts"]

export function counts(c: Partial<Omit<HiddenCounts, "total">> = {}): HiddenCounts {
  const full = { offTarget: 0, belowSeniorityFloor: 0, undated: 0, olderThan60Days: 0, ...c }
  return { ...full, total: full.offTarget + full.belowSeniorityFloor + full.undated + full.olderThan60Days }
}

export type BoardState = {
  /** Visible postings (the fake never lists a hidden one). */
  postings: JobPostingDetail[]
  /** Hidden postings, reachable by detail URL only. */
  hidden: JobPostingDetail[]
  hiddenCounts: HiddenCounts
  waitingToBeCheckedCount: number
  waitingReason: JobPostingsResponse["waitingReason"]
  targetRoleFamilies: string[]
  criteriaEmptyState: boolean
  criteria: JobCriteriaResponse
  /** Next Check again answer; default claims every visible failed/not_checked posting. */
  checkAgain: ((state: BoardState) => Response | CheckAgainResponse) | null
  /** Next paste response. */
  paste: { status: 200 | 201; created: boolean; posting: JobPostingDetail } | null
}

function summary(detail: JobPostingDetail): JobPostingSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { postingText, employmentType, eligibility, match, technologies, applyAnyway, applicationId, pastedPrepareOffered, ...rest } = detail
  return { ...rest, match: match && { coveredCount: match.coveredCount, totalCount: match.totalCount, thresholdPercent: match.thresholdPercent } }
}

const recheckable = (p: JobPostingDetail) => p.status === "evaluation_failed" || p.status === "not_checked"

export function openBoard(path: string, initial: Partial<BoardState> = {}) {
  const state: BoardState = {
    postings: [],
    hidden: [],
    hiddenCounts: counts(),
    waitingToBeCheckedCount: 0,
    waitingReason: null,
    targetRoleFamilies: [...DEFAULT_TARGETS],
    criteriaEmptyState: false,
    criteria: { minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: [...DEFAULT_TARGETS], seniorityFloor: "hide_entry_level", version: 1 },
    checkAgain: null,
    paste: null,
    ...initial,
  }
  const requests: { method: string; path: string; search: string; body: unknown }[] = []
  const json = <T,>(schema: { parse: (v: unknown) => T }, body: unknown, status = 200) => HttpResponse.json(schema.parse(body) as JsonBodyType, { status })
  const csrfOk = (request: Request) => request.headers.get(CSRF_HEADER) === TEST_CSRF_TOKEN

  const handlers = [
    http.get(JOB_POSTINGS_PATH, ({ request }) => {
      const url = new URL(request.url)
      requests.push({ method: "GET", path: url.pathname, search: url.search, body: null })
      const tab = url.searchParams.get("tab") ?? "ranked"
      const families = (url.searchParams.get("families") ?? "").split(",").filter(Boolean)
      const keyword = (url.searchParams.get("keyword") ?? "").trim().toLowerCase()
      const onTab = state.postings.filter((p) =>
        tab === "ranked" ? p.status === "ranked" : tab === "skipped" ? p.status === "skipped" || p.status === "excluded" : true
      )
      const matching = onTab.filter(
        (p) => (families.length === 0 || (p.roleFamily !== null && families.includes(p.roleFamily))) && (keyword === "" || (p.title ?? "").toLowerCase().includes(keyword))
      )
      return json(jobPostingsResponseSchema, {
        postings: matching.map(summary),
        waitingToBeCheckedCount: state.waitingToBeCheckedCount,
        nextCursor: null,
        totalCount: matching.length,
        criteriaEmptyState: state.criteriaEmptyState,
        hiddenCounts: state.hiddenCounts,
        recheckableCount: state.postings.filter(recheckable).length,
        targetRoleFamilies: state.targetRoleFamilies,
        waitingReason: state.waitingToBeCheckedCount > 0 ? (state.waitingReason ?? "cost_pause") : null,
      })
    }),
    http.post(JOB_POSTINGS_CHECK_AGAIN_PATH, async ({ request }) => {
      const body = await request.text()
      requests.push({ method: "POST", path: JOB_POSTINGS_CHECK_AGAIN_PATH, search: "", body: body === "" ? null : JSON.parse(body) })
      if (!csrfOk(request)) return apiErrorResponse("csrf_invalid")
      if (state.checkAgain) {
        const answer = state.checkAgain(state)
        state.checkAgain = null
        return answer instanceof Response ? answer : json(checkAgainResponseSchema, answer)
      }
      const claimed = state.postings.filter(recheckable)
      for (const p of claimed) Object.assign(p, { status: "checking", rank: null })
      return json(checkAgainResponseSchema, { queued: claimed.length, movedTo: "checking" })
    }),
    http.get(`${JOB_POSTINGS_PATH}/:id`, ({ params }) => {
      const found = [...state.postings, ...state.hidden].find((p) => p.id === params.id)
      return found ? json(jobPostingDetailSchema, found) : apiErrorResponse("not_found")
    }),
    http.post(JOB_POSTING_LINKS_PATH, async ({ request }) => {
      requests.push({ method: "POST", path: JOB_POSTING_LINKS_PATH, search: "", body: await request.json().catch(() => null) })
      if (!csrfOk(request)) return apiErrorResponse("csrf_invalid")
      if (!state.paste) return apiErrorResponse("internal_error")
      const { status, created, posting: p } = state.paste
      if (created) state.hidden.push(p)
      // v1.27.0: a link-only paste answers with `descriptionOutcome: null`.
      const waitingReason = p.status === "waiting_to_be_checked" ? ("cost_pause" as const) : null
      return json(pasteJobLinkResponseSchema, { created, posting: summary(p), descriptionOutcome: null, applicationId: null, waitingReason }, status)
    }),
    http.get(JOB_CRITERIA_PATH, () => json(jobCriteriaResponseSchema, state.criteria)),
    http.put(JOB_CRITERIA_PATH, async ({ request }) => {
      const body = await request.json().catch(() => null)
      requests.push({ method: "PUT", path: JOB_CRITERIA_PATH, search: "", body })
      if (!csrfOk(request)) return apiErrorResponse("csrf_invalid")
      const parsed = jobCriteriaRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      state.criteria = { ...parsed.data, version: state.criteria.version + 1 }
      state.targetRoleFamilies = [...parsed.data.targetRoleFamilies]
      return json(jobCriteriaResponseSchema, state.criteria)
    }),
  ]

  // Ours first: MSW uses the first matching handler. The career-setup and discovery fakes serve the rest of the app.
  server.use(signedInSession, ...handlers, ...createCareerSetupApi().handlers, ...createDiscoveryApi().handlers)
  const user = userEvent.setup({ delay: null })
  return { ...renderApp(path), state, requests, user }
}
