import {
  checkAgainRequestSchema,
  checkAgainResponseSchema,
  CSRF_HEADER,
  DEFAULT_TARGET_ROLE_FAMILIES,
  JOB_POSTINGS_CHECK_AGAIN_PATH,
  EMPLOYER_LIST_APPROVE_PATH,
  JOB_POSTING_LINKS_PATH,
  JOB_POSTINGS_PATH,
  JOB_SOURCES_PATH,
  jobPostingDetailSchema,
  jobPostingsQuerySchema,
  jobPostingsResponseSchema,
  jobSourcesResponseSchema,
  cleanPastedName,
  normalisePastedDescription,
  pasteFieldErrorCode,
  pasteFieldErrors,
  pasteJobLinkRequestSchema,
  pasteJobLinkResponseSchema,
  setJobSourceEnabledRequestSchema,
  verifyJobSourceRequestSchema,
  type CheckAgainResponse,
  type HiddenCounts,
  type JobPostingDetail,
  type JobPostingSummary,
  type JobSourcesResponse,
  type PasteJobLinkResponse,
  type RoleFamilyValue,
  type WaitingReason,
} from "@eve/contracts"
import { http, HttpResponse, type JsonBodyType } from "msw"

import { applyAnywayFor, pastedPrepareOfferedFor, type ExistingApplication } from "./apply-anyway-fake"
import { apiErrorResponse, pasteErrorResponse, TEST_CSRF_TOKEN } from "./contract-handlers"

/**
 * An in-memory stand-in for the slice 3 API (api-contract.md v1.4.0): Job
 * Sources, the employer list, Job Postings and pasted links. Every body is
 * parsed with the contract schema before it is sent, so a test can't pass
 * against a shape the API doesn't send.
 */
export interface DiscoveryState {
  postings: JobPostingDetail[]
  waitingToBeCheckedCount: number
  /** v1.13.0 (AC 6.3): the server computes it from counts; tests set it directly. */
  criteriaEmptyState: boolean
  sources: JobSourcesResponse
  /** What the next pasted, new link becomes. */
  nextPasted: (url: string) => JobPostingDetail
  /**
   * v1.18.0: the session Candidate's targets. The fake does not classify: a
   * posting is hidden when its stored `hiddenReason` is set (tests set it).
   */
  targetRoleFamilies: RoleFamilyValue[]
  /** v1.18.0: the reason sent while `waitingToBeCheckedCount > 0` (`cost_pause` for the Operator). */
  waitingReason: WaitingReason
  /** v1.18.0: hidden counts added to the ones computed from hidden fixtures, for large-number cases. */
  extraHiddenCounts: Partial<Omit<HiddenCounts, "total">>
  /** v1.18.0: where Check again moves claimed rows ("checking" for the Operator). */
  checkAgainMovesTo: CheckAgainResponse["movedTo"]
  /** v1.18.0: the next Check again answers this way instead of claiming. */
  nextCheckAgain: "ok" | "nothing_left" | "internal_error" | "csrf_invalid" | "malformed" | "network"
  /** v1.24.0: the requisition's Application, for `applicationId` and `applyAnyway`. `linkFakes` points it at the documents fake. */
  existingApplication: (postingId: string) => ExistingApplication | null
  /**
   * v1.27.0: why a newly saved pasted description waits (cost pause, invitee), or null to check it.
   * The posting is stored `waiting_to_be_checked` and the response carries this `waitingReason`.
   */
  pasteWaitingReason: WaitingReason | null
}

const NOW = "2026-10-19T09:00:00.000Z"
let idCounter = 0
export const postingId = () => `10000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`

/** An evaluated, ranked posting with every rule met and a strong Match. */
export function rankedPosting(overrides: Partial<JobPostingDetail> = {}): JobPostingDetail {
  return {
    id: postingId(),
    title: "Senior Frontend Engineer",
    company: "Acme Payments",
    applicationUrl: "https://boards.greenhouse.io/acme/jobs/1042",
    requisitionId: "R-1042",
    applicationSystem: "Greenhouse",
    applyUrl: "https://boards.greenhouse.io/acme/jobs/1042",
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
    technologies: null,
    discoveredAt: NOW,
    postedAt: NOW,
    postedOn: "2026-10-19",
    postedDateKind: "published",
    ageDays: 5,
    hiddenReason: null,
    // v1.24.0: computed from the store when sent (see `asSent`); null in the stored fixture.
    applyAnyway: null,
    applicationId: null,
    pastedPrepareOffered: false,
    postingText: "Acme builds payment APIs for merchants.\nRemote, open to candidates in Nigeria.",
    employmentType: "direct",
    eligibility: {
      arrangement: "remote",
      relocationCountry: null,
      rules: [
        { rule: "location", result: "met", quote: "Remote, open to candidates in Nigeria" },
        { rule: "sponsorship", result: "not_applicable", quote: null },
        { rule: "pay", result: "met", quote: "Salary USD 60,000–80,000 per year" },
        { rule: "hours", result: "met", quote: "Core hours 10:00–18:00 WAT" },
        { rule: "industry", result: "met", quote: "Acme builds payment APIs for merchants" },
      ],
      normalizedMonthlyMaxUsd: "6666.67",
      fxRateDate: null,
      evaluatedAt: NOW,
    },
    ...overrides,
  }
}

/**
 * v1.27.0: a pasted-description posting (Candidate-private, manual only, synthetic
 * requisition, no link unless one is given), evaluated as ranked unless overridden.
 */
export function pastedPosting(overrides: Partial<JobPostingDetail> = {}): JobPostingDetail {
  const id = overrides.id ?? postingId()
  return rankedPosting({
    title: "Senior Frontend Engineer",
    company: "Paystack",
    applicationUrl: null,
    applyUrl: null,
    applicationSystem: "none",
    applyMode: "manual",
    origin: "pasted_description",
    postingText: "Senior Frontend Engineer\n\nAbout the role: build merchant dashboards in React and TypeScript.",
    ...overrides,
    id,
    requisitionId: `pasted:${id}`,
  })
}

/** A strong Match result with 2 of 2 core duties covered, for `match` on a detail. */
export function strongMatch(): NonNullable<JobPostingDetail["match"]> {
  return {
    verdict: "strong",
    weakReason: null,
    coveredCount: 2,
    totalCount: 2,
    thresholdPercent: 70,
    careerProfileVersion: 1,
    coreResponsibilities: [
      { text: "Build React features", factId: "F1", factText: "Built a React and TypeScript merchant dashboard" },
      { text: "Mentor engineers", factId: "F3", factText: "Mentored 6 junior developers" },
    ],
    mandatoryPrerequisites: [{ text: "5+ years TypeScript", factId: null, factText: null }],
    niceToHave: [{ text: "GraphQL", factId: null, factText: null }],
  }
}

export function draftSources(): JobSourcesResponse {
  return {
    employerList: {
      status: "draft",
      approvedAt: null,
      companies: [
        company(1, "Railway", "ashby", "railway"),
        company(2, "Phantom", "ashby", "phantom", "crypto", "Crypto wallet. Decide at approval."),
        company(3, "GitLab", "greenhouse", "gitlab"),
      ],
    },
    remoteBoards: [
      board("himalayas", "Himalayas", 1, "https://himalayas.app", { verifiedOn: "2026-10-19", verificationBasis: "Terms clauses 30A and 113 allow API use with credit." }),
      board("remoteok", "Remote OK", 2, "https://remoteok.com", { verifiedOn: "2026-10-19", verificationBasis: "API terms allow use with a link back." }),
      board("remotive", "Remotive", 3, "https://remotive.com", {
        available: false,
        unavailableReason: "Remotive's terms (section 8) require written permission for automated access. The Candidate must obtain it first.",
      }),
      board("weworkremotely", "We Work Remotely", 4, "https://weworkremotely.com"),
    ],
    scheduledDiscoveryOn: false,
  }
}

function company(
  position: number,
  name: string,
  applicationSystem: "greenhouse" | "lever" | "ashby",
  token: string,
  flag: "crypto" | null = null,
  note: string | null = null
) {
  const urls = {
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`,
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
    lever: `https://api.lever.co/v0/postings/${token}?mode=json`,
  }
  return {
    id: `20000000-0000-4000-8000-${String(position).padStart(12, "0")}`,
    position,
    company: name,
    applicationSystem,
    boardToken: token,
    boardUrl: urls[applicationSystem],
    flag,
    note,
  }
}

function board(
  key: JobSourcesResponse["remoteBoards"][number]["key"],
  name: string,
  order: number,
  url: string,
  overrides: Partial<JobSourcesResponse["remoteBoards"][number]> = {}
): JobSourcesResponse["remoteBoards"][number] {
  return {
    key,
    name,
    order,
    verifiedOn: null,
    verificationBasis: null,
    enabled: false,
    available: true,
    unavailableReason: null,
    attributionName: name,
    attributionUrl: url,
    ...overrides,
  }
}

/** A posting with a posted date `ageDays` WAT days before 2026-10-24 (posting-age.feature's "today"). */
export function dated(ageDays: number, kind: "published" | "updated" = "published"): Pick<JobPostingDetail, "postedAt" | "postedOn" | "postedDateKind" | "ageDays"> {
  const day = new Date(Date.UTC(2026, 9, 24) - ageDays * 86_400_000).toISOString().slice(0, 10)
  return { postedAt: `${day}T09:00:00.000Z`, postedOn: day, postedDateKind: kind, ageDays }
}

/** No posted date: always hidden as `undated` unless an earlier reason applies. */
export const UNDATED = { postedAt: null, postedOn: null, postedDateKind: null, ageDays: null } as const

/**
 * The API's v1.18.0 rules for what a stored row sends: no rank when hidden, a failure kind only while failed.
 * v1.24.0: `applicationId` and `applyAnyway` are computed from the store, as the API computes them.
 */
function asSent(detail: JobPostingDetail, existing: ExistingApplication | null = null): JobPostingDetail {
  return {
    ...detail,
    applicationId: existing?.id ?? null,
    applyAnyway: applyAnywayFor(detail, existing),
    pastedPrepareOffered: pastedPrepareOfferedFor(detail, existing),
    rank: detail.hiddenReason === null ? detail.rank : null,
    evaluationFailure: detail.status === "evaluation_failed" ? detail.evaluationFailure : null,
  }
}

function summaryOf(stored: JobPostingDetail): JobPostingSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { postingText, employmentType, eligibility, match, technologies, applyAnyway, applicationId, pastedPrepareOffered, ...summary } = asSent(stored)
  return {
    ...summary,
    match: match && { coveredCount: match.coveredCount, totalCount: match.totalCount, thresholdPercent: match.thresholdPercent, ...(match.atsFit !== undefined && { atsFit: match.atsFit }) },
  }
}

const HIDDEN_KEY = {
  off_target: "offTarget",
  below_seniority_floor: "belowSeniorityFloor",
  undated: "undated",
  older_than_60_days: "olderThan60Days",
} as const satisfies Record<NonNullable<JobPostingDetail["hiddenReason"]>, keyof HiddenCounts>

export function createDiscoveryApi(initial: Partial<DiscoveryState> = {}) {
  const state: DiscoveryState = {
    postings: [],
    waitingToBeCheckedCount: 0,
    criteriaEmptyState: false,
    sources: draftSources(),
    nextPasted: (url) =>
      rankedPosting({ applicationUrl: url, applyUrl: url, status: "checking", rank: null, eligibility: null, match: null, title: null, company: null }),
    targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES],
    waitingReason: "cost_pause",
    extraHiddenCounts: {},
    checkAgainMovesTo: "checking",
    nextCheckAgain: "ok",
    existingApplication: () => null,
    pasteWaitingReason: null,
    ...initial,
  }
  const requests: { method: string; path: string; body: unknown }[] = []
  /** Every `GET /v1/job-postings` query string, in order (`tab=all&cursor=…`). */
  const listRequests: URLSearchParams[] = []
  const respond = <T,>(schema: { parse: (input: unknown) => T }, body: T, status = 200) =>
    HttpResponse.json(schema.parse(body) as JsonBodyType, { status })
  const csrfRefused = (request: Request) => request.headers.get(CSRF_HEADER) !== TEST_CSRF_TOKEN
  const readJson = async (request: Request): Promise<unknown> => request.json().catch(() => undefined)
  const record = (request: Request, body: unknown) =>
    requests.push({ method: request.method, path: new URL(request.url).pathname, body })

  const visible = () => state.postings.filter((p) => p.hiddenReason === null)
  const byTab = (tab: string) => {
    if (tab === "ranked") return visible().filter((p) => p.status === "ranked").sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    // v1.23.0: Not a match's keyword section leaves out excluded_role_family; its excluded-family section holds only it; All hides it.
    const family = (p: JobPostingDetail) => p.status === "skipped" && p.skipReason === "excluded_role_family"
    // v1.28.0 manual lane: a job Eve cannot submit for has its own tab and is no longer a "Not a match".
    const manual = (p: JobPostingDetail) => p.status === "skipped" && p.skipReason === "unsupported_application_system"
    if (tab === "manual") return visible().filter(manual)
    if (tab === "skipped") return visible().filter((p) => (p.status === "skipped" || p.status === "excluded") && !family(p) && !manual(p))
    if (tab === "excluded_family") return visible().filter(family)
    return visible().filter((p) => !family(p))
  }
  const isRecheckable = (p: JobPostingDetail) => p.status === "evaluation_failed" || p.status === "not_checked"
  const hiddenCounts = (): HiddenCounts => {
    const counts = { offTarget: 0, belowSeniorityFloor: 0, undated: 0, olderThan60Days: 0, ...state.extraHiddenCounts }
    for (const p of state.postings) if (p.hiddenReason !== null) counts[HIDDEN_KEY[p.hiddenReason]] += 1
    return { ...counts, total: counts.offTarget + counts.belowSeniorityFloor + counts.undated + counts.olderThan60Days }
  }

  const pasted = (body: Omit<PasteJobLinkResponse, "posting"> & { posting: JobPostingDetail }, status = 200) =>
    respond(pasteJobLinkResponseSchema, { ...body, posting: summaryOf(body.posting) }, status)
  const linkInvalid = (url: string) => !/^https?:\/\/[^\s/@]+\.[^\s/@]+/i.test(url)

  const pasteLinkOnly = (url: string) => {
    if (url === "") return apiErrorResponse("job_link_empty")
    if (linkInvalid(url)) return apiErrorResponse("job_link_invalid")
    const none = { descriptionOutcome: null, applicationId: null }
    const existing = state.postings.find((p) => p.applicationUrl === url)
    if (existing) return pasted({ created: false, ...none, waitingReason: waitingOf(existing), posting: existing })
    const created = state.nextPasted(url)
    state.postings.unshift(created)
    return pasted({ created: true, ...none, waitingReason: waitingOf(created), posting: created }, 201)
  }
  const waitingOf = (p: JobPostingDetail) => (p.status === "waiting_to_be_checked" ? state.waitingReason : null)

  /**
   * v1.27.0 "MSW handlers (Frontend)": processing order steps 3 to 7. The ATS host test is
   * the mock's only (the web never decides it). A Greenhouse link containing `4019999` fails
   * its lookup; any other ATS link is read (`employer_page_used`).
   */
  const pasteDescription = (url: string, description: string, title: string | undefined, company: string | undefined) => {
    const text = normalisePastedDescription(description)
    if (url === "" && text === "") return pasteErrorResponse("job_description_too_short", [{ field: "description", position: null, problem: "too_short" }])
    if (url !== "" && linkInvalid(url)) return apiErrorResponse("job_link_invalid")
    const isAts = /(boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com)/.test(url)
    const fieldErrors = pasteFieldErrors({ description, title, company, namesRequired: url === "" || !isAts })
    if (fieldErrors.length > 0) return pasteErrorResponse(pasteFieldErrorCode(fieldErrors[0]), fieldErrors)
    const names = { title: cleanPastedName(title ?? ""), company: cleanPastedName(company ?? "") }
    const held = url === "" ? undefined : state.postings.find((p) => p.applicationUrl === url)
    /** I-6: an unreadable Greenhouse/Lever/Ashby page needs both typed names. */
    const missingNames = () => {
      const missing = (["title", "company"] as const).filter((f) => names[f] === "")
      return missing.length === 0 ? null : pasteErrorResponse("employer_page_unreadable", missing.map((field) => ({ field, position: null, problem: "required" as const })))
    }
    const none = { applicationId: null, waitingReason: null }
    if (isAts && !held) {
      if (!url.includes("4019999")) {
        const read = state.nextPasted(url)
        state.postings.unshift(read)
        return pasted({ created: true, descriptionOutcome: "employer_page_used", ...none, waitingReason: waitingOf(read), posting: read }, 201)
      }
      const refusal = missingNames()
      if (refusal) return refusal
    }
    if (held) {
      const app = state.existingApplication(held.id)
      if (app) return pasted({ created: false, descriptionOutcome: "unchanged_has_application", applicationId: app.id, waitingReason: null, posting: held })
      if (held.origin !== "pasted_description" && held.postingText !== "") return pasted({ created: false, descriptionOutcome: "employer_page_used", ...none, waitingReason: waitingOf(held), posting: held })
      if (held.status === "checking") return apiErrorResponse("posting_still_checking")
      if (isAts) {
        const refusal = missingNames()
        if (refusal) return refusal
      }
      const fresh = pastedPosting({ ...held, ...names, ...newCheck(), id: held.origin === "pasted_description" ? held.id : postingId(), postingText: text, applicationUrl: url, applyUrl: url })
      state.postings = [fresh, ...state.postings.filter((p) => p !== held)]
      return pasted({ created: false, descriptionOutcome: held.origin === "pasted_description" ? "replaced" : "attached", applicationId: null, waitingReason: state.pasteWaitingReason, posting: fresh })
    }
    if (url === "") {
      const fingerprint = (p: Pick<JobPostingDetail, "title" | "company" | "postingText">) => [p.title, p.company, p.postingText.replace(/\s+/g, " ")].join("\u0000")
      const same = state.postings.find((p) => p.origin === "pasted_description" && p.applicationUrl === null && fingerprint(p) === fingerprint({ ...names, postingText: text }))
      if (same) return pasted({ created: false, descriptionOutcome: "already_pasted", ...none, waitingReason: waitingOf(same), posting: same })
    }
    const link = url === "" ? { applicationUrl: null, applyUrl: null, applicationSystem: "none" } : { applicationUrl: url, applyUrl: url, applicationSystem: isAts ? "Greenhouse" : new URL(url).hostname.replace(/^www\./, "") }
    const created = pastedPosting({ ...names, ...link, ...newCheck(), postingText: text })
    state.postings.unshift(created)
    return pasted({ created: true, descriptionOutcome: isAts ? "stored_lookup_failed" : "stored", applicationId: null, waitingReason: state.pasteWaitingReason, posting: created }, 201)
  }
  /** A pasted description starts checking, or waits during a pause (`pasteWaitingReason`). */
  const newCheck = () => ({
    status: state.pasteWaitingReason ? ("waiting_to_be_checked" as const) : ("checking" as const),
    rank: null,
    eligibility: null,
    match: null,
    skipReason: null,
    skipDetail: null,
  })

  const handlers = [
    http.get(JOB_POSTINGS_PATH, ({ request }) => {
      const search = new URL(request.url).searchParams
      listRequests.push(search)
      const keys = [...search.keys()]
      if (new Set(keys).size !== keys.length) return apiErrorResponse("bad_request")
      const parsed = jobPostingsQuerySchema.safeParse(Object.fromEntries(search))
      if (!parsed.success) return apiErrorResponse("bad_request")
      const { tab, limit, families, keyword, cursor } = parsed.data
      // The view a cursor belongs to: tab and normalised filter, as the API binds it (v1.12.0).
      const view = JSON.stringify([tab, families, keyword === null ? "" : fold(keyword)])
      let offset = 0
      if (cursor !== null) {
        const decoded = readCursor(cursor)
        if (!decoded || decoded.view !== view) return apiErrorResponse("bad_request")
        offset = decoded.offset
      }
      const matching = byTab(tab).filter(
        (p) =>
          (families.length === 0 || (p.roleFamily !== null && families.includes(p.roleFamily))) &&
          (keyword === null || (p.title !== null && fold(p.title).includes(fold(keyword))))
      )
      const page = matching.slice(offset, offset + limit)
      const next = offset + limit < matching.length ? writeCursor({ view, offset: offset + limit }) : null
      return respond(jobPostingsResponseSchema, {
        postings: page.map(summaryOf),
        waitingToBeCheckedCount: state.waitingToBeCheckedCount,
        nextCursor: next,
        totalCount: matching.length,
        criteriaEmptyState: state.criteriaEmptyState,
        hiddenCounts: hiddenCounts(),
        recheckableCount: visible().filter(isRecheckable).length,
        targetRoleFamilies: state.targetRoleFamilies,
        waitingReason: state.waitingToBeCheckedCount > 0 ? state.waitingReason : null,
      })
    }),
    http.post(JOB_POSTINGS_CHECK_AGAIN_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const text = await request.text()
      const body: unknown = text === "" ? undefined : JSON.parse(text)
      record(request, body)
      if (body !== undefined && !checkAgainRequestSchema.safeParse(body).success) return apiErrorResponse("bad_request")
      const outcome = state.nextCheckAgain
      state.nextCheckAgain = "ok"
      if (outcome === "network") return HttpResponse.error()
      if (outcome === "internal_error" || outcome === "csrf_invalid") return apiErrorResponse(outcome)
      if (outcome === "malformed") return HttpResponse.json({ movedTo: state.checkAgainMovesTo })
      // Another tab claimed every row first.
      if (outcome === "nothing_left") return respond(checkAgainResponseSchema, { queued: 0, movedTo: state.checkAgainMovesTo })
      const claimed = visible().filter(isRecheckable)
      state.postings = state.postings.map((p) => (claimed.includes(p) ? { ...p, status: state.checkAgainMovesTo } : p))
      if (state.checkAgainMovesTo === "waiting_to_be_checked") state.waitingToBeCheckedCount += claimed.length
      return respond(checkAgainResponseSchema, { queued: claimed.length, movedTo: state.checkAgainMovesTo })
    }),
    http.get(`${JOB_POSTINGS_PATH}/:id`, ({ params }) => {
      const found = state.postings.find((p) => p.id === params.id)
      return found ? respond(jobPostingDetailSchema, asSent(found, state.existingApplication(found.id))) : apiErrorResponse("not_found")
    }),
    http.post(JOB_POSTING_LINKS_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      record(request, body)
      const parsed = pasteJobLinkRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      const url = parsed.data.url?.trim() ?? ""
      const description = parsed.data.description
      // Processing order step 2: link only (no description, or a blank one sent with a link).
      if (description === undefined || (normalisePastedDescription(description) === "" && url !== "")) {
        if (description === undefined && url === "") return apiErrorResponse("bad_request")
        return pasteLinkOnly(url)
      }
      return pasteDescription(url, description, parsed.data.title, parsed.data.company)
    }),
    http.get(JOB_SOURCES_PATH, () => respond(jobSourcesResponseSchema, state.sources)),
    http.post(EMPLOYER_LIST_APPROVE_PATH, ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      record(request, null)
      const list = state.sources.employerList
      state.sources = {
        ...state.sources,
        employerList: { ...list, status: "approved", approvedAt: list.approvedAt ?? NOW },
        scheduledDiscoveryOn: true,
      }
      return respond(jobSourcesResponseSchema, state.sources)
    }),
    http.put(`${JOB_SOURCES_PATH}/remote-boards/:key/verification`, async ({ request, params }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      record(request, body)
      const target = state.sources.remoteBoards.find((b) => b.key === params.key)
      if (!target) return apiErrorResponse("not_found")
      const parsed = verifyJobSourceRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      if (!target.available) return apiErrorResponse("job_source_unavailable")
      updateBoard(target.key, { verifiedOn: parsed.data.verifiedOn, verificationBasis: parsed.data.basis.trim() })
      return respond(jobSourcesResponseSchema, state.sources)
    }),
    http.put(`${JOB_SOURCES_PATH}/remote-boards/:key/enabled`, async ({ request, params }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      record(request, body)
      const target = state.sources.remoteBoards.find((b) => b.key === params.key)
      if (!target) return apiErrorResponse("not_found")
      const parsed = setJobSourceEnabledRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      if (parsed.data.enabled) {
        if (!target.available) return apiErrorResponse("job_source_unavailable")
        if (!target.verifiedOn) return apiErrorResponse("job_source_not_verified")
      }
      updateBoard(target.key, { enabled: parsed.data.enabled })
      return respond(jobSourcesResponseSchema, state.sources)
    }),
  ]

  function updateBoard(key: string, patch: Partial<JobSourcesResponse["remoteBoards"][number]>) {
    state.sources = {
      ...state.sources,
      remoteBoards: state.sources.remoteBoards.map((b) => (b.key === key ? { ...b, ...patch } : b)),
    }
  }

  return { state, requests, listRequests, handlers }
}

export type DiscoveryApi = ReturnType<typeof createDiscoveryApi>

/** Case-, accent- and whitespace-insensitive, like the API's title fold. */
function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").toLowerCase()
}

/** The fake's cursor: opaque to the client, an offset bound to one view. */
function writeCursor(value: { view: string; offset: number }): string {
  return btoa(JSON.stringify(value))
}

function readCursor(cursor: string): { view: string; offset: number } | null {
  try {
    const value: unknown = JSON.parse(atob(cursor))
    if (typeof value !== "object" || value === null) return null
    const { view, offset } = value as Record<string, unknown>
    return typeof view === "string" && typeof offset === "number" ? { view, offset } : null
  } catch {
    return null
  }
}

/** Read-only defaults: no postings, the draft list. Keeps unrelated tests off unhandled requests. */
export const freshDiscoveryHandlers = createDiscoveryApi().handlers.filter((_, i) => i === 0 || i === 4)
