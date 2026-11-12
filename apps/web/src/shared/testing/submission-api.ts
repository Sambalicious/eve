import {
  AUTOMATIC_SUBMISSION_PATH,
  createExistingApplicationRequestSchema,
  createExistingApplicationResponseSchema,
  CSRF_HEADER,
  EXISTING_APPLICATIONS_COMPLETE_PATH,
  EXISTING_APPLICATIONS_PATH,
  existingApplicationsResponseSchema,
  formAnswersResponseSchema,
  prepareSamplesResultSchema,
  SAMPLES_PATH,
  SAMPLES_PREPARE_PATH,
  sampleStateSchema,
  samplesResponseSchema,
  SUBMISSIONS_SUMMARY_PATH,
  submissionSummarySchema,
  REASON_MAX,
  reasonRequestSchema,
  sampleResultSchema,
  setAutomaticRequestSchema,
  SUBMISSION_STATUS_PATH,
  SUBMISSIONS_PATH,
  submissionListResponseSchema,
  submissionListViewSchema,
  submissionSchema,
  submissionStatusSchema,
  type ApplicationDetail,
  type ExistingApplication,
  type ExistingApplicationsResponse,
  type FormAnswersResponse,
  type PrepareSamplesResult,
  type SampleResult,
  type SampleRow,
  type Submission,
  type SubmissionStatus,
} from "@eve/contracts"
import { http, HttpResponse, type JsonBodyType } from "msw"

import { apiErrorResponse, TEST_CSRF_TOKEN } from "./contract-handlers"
import type { DocumentsApi } from "./documents-api"
import type { MeApi } from "./me-api"

/**
 * An in-memory stand-in for the slice 5 API (api-contract.md v1.7.0), layered
 * on the slice 4 fake so Applications and their Submissions share one store.
 * Every JSON body is parsed with the contract schema before it is sent. The
 * fake decides nothing the backend decides: a sample approval ends as
 * `nextSampleResult`, which a test sets. As in v1.8.0, an approval answers
 * `pending` (apart from `excluded` and paused `not_submitted`) and the worker's
 * outcome shows on the Submission: at once when `workerFinishesAtOnce`, or
 * when the test calls `finishSample` or `returnSampleToReview`.
 */
export interface SubmissionApiState {
  status: SubmissionStatus
  /** Submission per Application ID; missing means "not in submission". */
  submissions: Record<string, Submission>
  /** What the next sample approval ends as; updates the Submission and count. */
  nextSampleResult: (id: string) => { result: Exclude<SampleResult["result"], "pending">; submission: Partial<Submission> }
  /** The worker finishes an approved sample before the page's first poll (default true). */
  workerFinishesAtOnce: boolean
  /** Form answers per Application ID; missing means the form hasn't been read (`available: false`). */
  formAnswers: Record<string, FormAnswersResponse>
  /** Extra sample-row fields per Application ID (defaults: Greenhouse, no Match, no Unverified labels). */
  sampleRows: Record<string, Partial<Pick<SampleRow, "applicationSystem" | "match" | "unverifiedLabels">>>
  /** What the next `POST /v1/samples/prepare` answers; it makes `sampleIds` awaiting samples. */
  nextPrepare: () => { result: PrepareSamplesResult; sampleIds: string[] }
  /**
   * Existing applications, oldest first. `completedAt` follows
   * `status.existingApplicationsCompletedAt` until the step is completed here.
   */
  existing: ExistingApplication[]
  /** The time `POST /v1/existing-applications/complete` records, when the step isn't complete yet. */
  existingCompletesAt: string
}

const NOW = "2026-10-20T09:15:00.000Z"

let existingSeq = 0
/** A stored existing application for `state.existing`. */
export function existingApplication(overrides: Partial<ExistingApplication> = {}): ExistingApplication {
  existingSeq += 1
  return {
    id: `00000000-0000-4000-8000-${String(existingSeq).padStart(12, "0")}`,
    company: "Globex",
    roleTitle: "Frontend Lead",
    applicationUrl: "https://jobs.lever.co/globex/abc-123",
    requisitionId: "L-77",
    appliedOn: "2026-09-30",
    createdAt: NOW,
    ...overrides,
  }
}

export function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    state: null,
    kind: null,
    attemptNumber: 0,
    submittedAt: null,
    submittedWatDay: null,
    evidence: null,
    captchaAfterSubmit: false,
    blockedReason: null,
    blockedSubReason: null,
    blockedDetail: null,
    blockedQuestion: null,
    blockedAt: null,
    queuedForWatDay: null,
    sample: null,
    declinedReason: null,
    declinedAt: null,
    markedNotSubmittedAt: null,
    manualCompletedAt: null,
    override: null,
    ...overrides,
  }
}

export const awaitingSample = (o: Partial<Submission> = {}) =>
  submission({ kind: "sample", sample: { state: "awaiting_review", rejectReason: null, counts: false }, ...o })

export const uncertain = (o: Partial<Submission> = {}) =>
  submission({ state: "uncertain", kind: "automatic", attemptNumber: 1, submittedAt: NOW, submittedWatDay: "2026-10-20", ...o })

export const blocked = (reason: NonNullable<Submission["blockedReason"]>, detail: string | null, o: Partial<Submission> = {}) =>
  submission({ state: "blocked", kind: "automatic", blockedReason: reason, blockedDetail: detail, blockedAt: NOW, ...o })

/** A planned form answer for `state.formAnswers` (C-SAMPLE-14 to 17). */
export const formAnswer = (o: Partial<FormAnswersResponse["answers"][number]> = {}): FormAnswersResponse["answers"][number] => ({
  question: "Email",
  source: "settings_contact",
  value: "ada@example.test",
  redacted: false,
  blockedReason: null,
  ...o,
})

export function submissionStatus(overrides: Partial<SubmissionStatus> = {}): SubmissionStatus {
  return {
    automaticEnabled: false,
    gatePassedAt: null,
    careerProfileApproved: true,
    existingApplicationsCompletedAt: "2026-10-17T09:00:00.000Z",
    countingSamples: 2,
    requiredSamples: 5,
    todayWatDay: "2026-10-20",
    todayCount: 0,
    cap: 5,
    queuedForTomorrow: 0,
    globalPaused: false,
    ...overrides,
  }
}

/** Options linking this fake to another fake's state; both are optional so existing tests stay unchanged. */
export interface SubmissionApiOptions {
  /**
   * The `/v1/me` fixture state. Contract v1.28.0 MSW section: the server sets
   * `advancedEnabled` and `advancedLocked` in the same `enabled: true` write, so a
   * viewer refetch must see them (CR-01).
   */
  viewer?: MeApi["state"]
}

export function createSubmissionApi(documents: DocumentsApi, initial: Partial<SubmissionApiState> = {}, options: SubmissionApiOptions = {}) {
  const state: SubmissionApiState = {
    status: submissionStatus(),
    submissions: {},
    nextSampleResult: () => ({
      result: "confirmed",
      submission: { state: "confirmed", submittedAt: NOW, submittedWatDay: "2026-10-20", evidence: { kind: "confirmation_page", text: "Thanks for applying", observedAt: NOW } },
    }),
    workerFinishesAtOnce: true,
    formAnswers: {},
    sampleRows: {},
    nextPrepare: () => ({ result: { created: 0, stoppedBy: "no_candidates" }, sampleIds: [] }),
    existing: [],
    existingCompletesAt: NOW,
    ...initial,
  }
  const requests = documents.requests
  const respond = <T,>(schema: { parse: (input: unknown) => T }, body: T, status = 200) =>
    HttpResponse.json(schema.parse(body) as JsonBodyType, { status, headers: { "cache-control": "no-store" } })
  const csrfRefused = (request: Request) => request.headers.get(CSRF_HEADER) !== TEST_CSRF_TOKEN
  const app = (id: unknown): ApplicationDetail | undefined => documents.state.applications.find((a) => a.id === id)
  /** The Submission carries the same `override` object as its Application (v1.24.0). */
  const sub = (id: string) => {
    const s = (state.submissions[id] ??= submission())
    s.override = app(id)?.override ?? null
    return s
  }
  documents.state.submissionOf = (id) => {
    const s = state.submissions[id]
    return { state: s?.state ?? null, isSample: s?.sample != null }
  }
  const record = (request: Request, body: unknown) => requests.push({ method: request.method, path: new URL(request.url).pathname, body })
  const summary = (a: ApplicationDetail) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { documents: _documents, posting: _posting, latestDrop: _latestDrop, ...rest } = a
    return rest
  }

  /** The worker's outcome per approved sample it hasn't finished. */
  const waiting: Record<string, ReturnType<SubmissionApiState["nextSampleResult"]>> = {}
  /** The worker finishes an approved sample with its `nextSampleResult`. */
  const finishSample = (id: string) => {
    const next = waiting[id]
    if (!next) return
    delete waiting[id]
    const s = sub(id)
    const counts = next.result === "confirmed" || next.result === "uncertain"
    Object.assign(s, next.submission, { sample: { state: "approved", rejectReason: null, counts } })
    if (counts) state.status = { ...state.status, countingSamples: state.status.countingSamples + 1 }
  }
  /** The worker found automation paused or no browser: the sample is back in awaiting review. */
  const returnSampleToReview = (id: string) => {
    delete waiting[id]
    Object.assign(sub(id), { state: null, sample: { state: "awaiting_review", rejectReason: null, counts: false } })
  }

  /** Runs `change` for an existing Application and answers with its Submission. */
  const action = (path: string, change: (s: Submission, id: string, body: unknown) => Response | void, withBody = false) =>
    http.post(path, async ({ request, params }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = withBody ? await request.json().catch(() => undefined) : null
      record(request, body)
      const id = String(params.id)
      if (!app(id)) return apiErrorResponse("not_found")
      const refused = change(sub(id), id, body)
      if (refused) return refused
      return respond(submissionSchema, sub(id))
    })

  const readReason = (body: unknown): string | Response => {
    const parsed = reasonRequestSchema.safeParse(body)
    if (!parsed.success || parsed.data.reason.length > REASON_MAX) return apiErrorResponse("bad_request")
    if (parsed.data.reason.trim() === "") return apiErrorResponse("reason_empty")
    return parsed.data.reason.trim()
  }

  const existingList = (): ExistingApplicationsResponse => ({ applications: state.existing, completedAt: state.status.existingApplicationsCompletedAt })

  const handlers = [
    http.get(EXISTING_APPLICATIONS_PATH, () => respond(existingApplicationsResponseSchema, existingList())),
    http.post(EXISTING_APPLICATIONS_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await request.json().catch(() => undefined)
      record(request, body)
      const parsed = createExistingApplicationRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      const { company, roleTitle, applicationUrl, appliedOn } = parsed.data
      // The contract's checks, in order; the backend's own matching (URL normalisation) is not modelled.
      if (company.trim() === "") return apiErrorResponse("existing_application_company_empty")
      if (roleTitle.trim() === "") return apiErrorResponse("existing_application_role_empty")
      if (applicationUrl.trim() === "") return apiErrorResponse("existing_application_url_empty")
      if (appliedOn.trim() === "") return apiErrorResponse("existing_application_date_empty")
      if (!/^\d{4}-\d{2}-\d{2}$/.test(appliedOn.trim()) || !/^https?:\/\//i.test(applicationUrl.trim())) return apiErrorResponse("bad_request")
      const requisitionId = parsed.data.requisitionId?.trim() || null
      const stored = state.existing.find((e) => e.applicationUrl === applicationUrl.trim() && e.requisitionId === requisitionId)
      if (stored) return respond(createExistingApplicationResponseSchema, { created: false, application: stored })
      const added = existingApplication({ company: company.trim(), roleTitle: roleTitle.trim(), applicationUrl: applicationUrl.trim(), requisitionId, appliedOn: appliedOn.trim() })
      state.existing = [...state.existing, added]
      return respond(createExistingApplicationResponseSchema, { created: true, application: added }, 201)
    }),
    http.post(EXISTING_APPLICATIONS_COMPLETE_PATH, ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      record(request, null)
      // The backend keeps the first time.
      if (state.status.existingApplicationsCompletedAt === null) state.status = { ...state.status, existingApplicationsCompletedAt: state.existingCompletesAt }
      return respond(existingApplicationsResponseSchema, existingList())
    }),
    http.get(SUBMISSION_STATUS_PATH, () => respond(submissionStatusSchema, state.status)),
    http.put(AUTOMATIC_SUBMISSION_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await request.json().catch(() => undefined)
      record(request, body)
      const parsed = setAutomaticRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      if (parsed.data.enabled && state.status.gatePassedAt === null) return apiErrorResponse("gate_requirements_unmet")
      state.status = { ...state.status, automaticEnabled: parsed.data.enabled }
      // Contract v1.28.0: the same transaction sets Advanced on and locks it.
      if (parsed.data.enabled && options.viewer) {
        options.viewer.me = { ...options.viewer.me, advancedEnabled: true, advancedLocked: true }
      }
      return respond(submissionStatusSchema, state.status)
    }),
    http.get(SUBMISSIONS_PATH, ({ request }) => {
      const view = submissionListViewSchema.safeParse(new URL(request.url).searchParams.get("view"))
      if (!view.success) return apiErrorResponse("bad_request")
      const wants = (s: Submission) => {
        const held = s.state === "blocked" && s.blockedReason === "same_company_review"
        if (view.data === "held") return held
        if (view.data === "blocked") return s.state === "blocked" && !held
        if (view.data === "uncertain") return s.state === "uncertain"
        return s.state === "blocked" || s.state === "uncertain"
      }
      const rows = documents.state.applications
        .filter((a) => state.submissions[a.id] && wants(state.submissions[a.id]))
        .map((a) => ({ application: summary(a), submission: sub(a.id) }))
      return respond(submissionListResponseSchema, { rows })
    }),
    http.get(SUBMISSIONS_SUMMARY_PATH, () => {
      const all = Object.values(state.submissions)
      const sample = (st: string) => all.filter((s) => s.sample?.state === st).length
      const held = all.filter((s) => s.state === "blocked" && s.blockedReason === "same_company_review").length
      return respond(submissionSummarySchema, {
        samples: { awaitingReview: sample("awaiting_review"), approved: sample("approved"), rejected: sample("rejected") },
        blocked: all.filter((s) => s.state === "blocked").length - held,
        held,
        uncertain: all.filter((s) => s.state === "uncertain").length,
      })
    }),
    http.get(SAMPLES_PATH, ({ request }) => {
      const wanted = sampleStateSchema.safeParse(new URL(request.url).searchParams.get("state"))
      if (!wanted.success) return apiErrorResponse("bad_request")
      const rows = documents.state.applications
        .filter((a) => state.submissions[a.id]?.sample?.state === wanted.data)
        .map((a) => ({
          application: summary(a),
          submission: sub(a.id),
          applicationSystem: "Greenhouse",
          match: null,
          unverifiedLabels: [],
          ...state.sampleRows[a.id],
        }))
      return respond(samplesResponseSchema, { rows })
    }),
    http.post(SAMPLES_PREPARE_PATH, ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      record(request, null)
      const next = state.nextPrepare()
      for (const id of next.sampleIds) Object.assign(sub(id), { kind: "sample", sample: { state: "awaiting_review", rejectReason: null, counts: false } })
      return respond(prepareSamplesResultSchema, next.result)
    }),
    http.get("/v1/applications/:id/form-answers", ({ params }) => {
      const id = String(params.id)
      if (!app(id)) return apiErrorResponse("not_found")
      return respond(formAnswersResponseSchema, state.formAnswers[id] ?? { available: false, readAt: null, answers: [] })
    }),
    http.get("/v1/applications/:id/submission", ({ params }) => {
      const id = String(params.id)
      if (!app(id)) return apiErrorResponse("not_found")
      return respond(submissionSchema, sub(id))
    }),
    http.post("/v1/applications/:id/sample/approve", ({ request, params }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      record(request, null)
      const id = String(params.id)
      if (!app(id)) return apiErrorResponse("not_found")
      // v1.27.0 (PD-4.1): after not_found, before not_a_sample and any write.
      if (app(id)?.manualOnly) return apiErrorResponse("manual_application_only")
      const s = sub(id)
      const result = (r: SampleResult["result"], alreadyDone: boolean) =>
        respond(sampleResultSchema, { result: r, alreadyDone, countingSamples: state.status.countingSamples, gatePassedAt: state.status.gatePassedAt })
      if (s.sample?.state === "approved") return result(resultOf(s), true)
      if (s.sample?.state !== "awaiting_review") return apiErrorResponse("not_a_sample")
      const next = state.nextSampleResult(id)
      // Paused at approval: nothing recorded (C-SAMPLE-13).
      if (next.result === "not_submitted") return result("not_submitted", false)
      // v1.24.0 (AA-3.2): excluded, not_ranked and not_allowed record the approval and end not submitted, uncounted.
      if (next.result === "excluded" || next.result === "not_ranked" || next.result === "not_allowed") {
        Object.assign(s, { state: "not_submitted" }, next.submission, { kind: "sample", sample: { state: "approved", rejectReason: null, counts: false } })
        return result(next.result, false)
      }
      Object.assign(s, { kind: "sample", sample: { state: "approved", rejectReason: null, counts: false } })
      waiting[id] = next
      if (state.workerFinishesAtOnce) finishSample(id)
      return result("pending", false)
    }),
    action("/v1/applications/:id/sample/reject", (s, _id, body) => {
      if (s.sample?.state === "rejected") return
      if (s.sample?.state !== "awaiting_review") return apiErrorResponse("not_a_sample")
      const reason = readReason(body)
      if (typeof reason !== "string") return reason
      s.sample = { state: "rejected", rejectReason: reason, counts: false }
    }, true),
    // v1.24.0 (AA-5): remove table rows 2 to 5. Row 1 (404) is `action`'s.
    action("/v1/applications/:id/remove-from-queue", (s, id) => {
      if (app(id)?.detailsDeletedAt) return apiErrorResponse("application_state_conflict")
      if (s.state === null) return
      if (s.state !== "queued") return apiErrorResponse("application_state_conflict")
      Object.assign(s, { state: null, kind: null, queuedForWatDay: null })
    }),
    action("/v1/applications/:id/queue", (s, id) => {
      // v1.27.0 (PD-4.1): after not_found, before every state check.
      if (app(id)?.manualOnly) return apiErrorResponse("manual_application_only")
      if (s.state === "queued") return
      if (s.state === "blocked" && s.blockedReason === "automation_incomplete") return apiErrorResponse("automation_incomplete_not_requeueable")
      Object.assign(s, { state: "queued", kind: "automatic", blockedReason: null, blockedSubReason: null, blockedDetail: null, blockedQuestion: null, blockedAt: null })
    }),
    action("/v1/applications/:id/mark-confirmed", (s) => {
      if (s.state === "confirmed") return
      if (s.state !== "uncertain") return apiErrorResponse("application_state_conflict")
      Object.assign(s, { state: "confirmed", evidence: { kind: "marked_confirmed", text: null, observedAt: NOW } })
    }),
    action("/v1/applications/:id/mark-not-submitted", (s) => {
      if (s.state === "confirmed" || s.state === "queued" || s.state === "not_submitted") return
      if (s.state !== "uncertain") return apiErrorResponse("application_state_conflict")
      const fresh = s.kind === "automatic" && s.attemptNumber < 2
      if (s.sample?.counts) {
        s.sample = { ...s.sample, counts: false }
        state.status = { ...state.status, countingSamples: state.status.countingSamples - 1 }
      }
      Object.assign(s, { state: fresh ? "queued" : "not_submitted", markedNotSubmittedAt: NOW })
    }),
    // v1.28.0 C3: no submission state is the Draft path (any Candidate); blocked is the Operator path; the rest conflict.
    action("/v1/applications/:id/manual-complete", (s, id) => {
      if (s.state === "manual") return
      if (s.state === null) {
        if (s.sample !== null || app(id)?.detailsDeletedAt) return apiErrorResponse("application_state_conflict")
        Object.assign(s, { state: "manual", manualCompletedAt: NOW })
        return
      }
      if (s.state !== "blocked") return apiErrorResponse("application_state_conflict")
      Object.assign(s, { state: "manual", manualCompletedAt: NOW })
    }),
    action("/v1/applications/:id/same-company/approve", (s) => {
      if (s.state === "declined") return apiErrorResponse("posting_declined")
      if (s.state === "queued") return
      if (s.state !== "blocked" || s.blockedReason !== "same_company_review") return apiErrorResponse("application_state_conflict")
      Object.assign(s, { state: "queued", blockedReason: null, blockedDetail: null, blockedQuestion: null, blockedAt: null })
    }),
    action("/v1/applications/:id/same-company/decline", (s, _id, body) => {
      if (s.state === "declined") return
      if (s.state !== "blocked" || s.blockedReason !== "same_company_review") return apiErrorResponse("application_state_conflict")
      const reason = readReason(body)
      if (typeof reason !== "string") return reason
      Object.assign(s, { state: "declined", declinedReason: reason, declinedAt: NOW, blockedReason: null, blockedDetail: null, blockedQuestion: null })
    }, true),
  ]
  return { state, requests, handlers, finishSample, returnSampleToReview }
}

/** The result a repeat approval of an approved sample answers (v1.8.0). */
function resultOf(s: Submission): SampleResult["result"] {
  if (s.state === null || s.state === "submit_claimed" || s.state === "submitting") return "pending"
  if (s.state === "blocked") return s.blockedReason === "same_company_review" ? "held" : "blocked"
  if (s.state === "confirmed" || s.state === "uncertain") return s.state
  return "duplicate"
}

export type SubmissionApi = ReturnType<typeof createSubmissionApi>

/** `GET /v1/existing-applications` answering `body` (read-only; for pages that only read the step). */
export function existingApplicationsHandler(body: Partial<ExistingApplicationsResponse> = {}) {
  return http.get(EXISTING_APPLICATIONS_PATH, () =>
    HttpResponse.json(existingApplicationsResponseSchema.parse({ applications: [], completedAt: null, ...body }))
  )
}

/** Read-only defaults: a fresh installation (gate pending, nothing in submission). */
export const freshSubmissionHandlers = [
  http.get(EXISTING_APPLICATIONS_PATH, () => HttpResponse.json(existingApplicationsResponseSchema.parse({ applications: [], completedAt: null }))),
  http.get(SUBMISSION_STATUS_PATH, () =>
    HttpResponse.json(submissionStatusSchema.parse(submissionStatus({ countingSamples: 0, careerProfileApproved: false, existingApplicationsCompletedAt: null })))
  ),
  http.get(SUBMISSIONS_PATH, () => HttpResponse.json(submissionListResponseSchema.parse({ rows: [] }))),
  http.get(SUBMISSIONS_SUMMARY_PATH, () =>
    HttpResponse.json(submissionSummarySchema.parse({ samples: { awaitingReview: 0, approved: 0, rejected: 0 }, blocked: 0, held: 0, uncertain: 0 }))
  ),
  http.get(SAMPLES_PATH, () => HttpResponse.json(samplesResponseSchema.parse({ rows: [] }))),
  // Slice 4 tests' Applications have not entered submission.
  http.get("/v1/applications/:id/submission", () => HttpResponse.json(submissionSchema.parse(submission()))),
  // Slice 7: the Application page's Answers table; nothing read yet.
  http.get("/v1/applications/:id/form-answers", () => HttpResponse.json(formAnswersResponseSchema.parse({ available: false, readAt: null, answers: [] }))),
]
