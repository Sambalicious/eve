import {
  AI_PROVIDER_APPROVAL_PATH,
  AI_PROVIDER_PATH,
  aiProviderResponseSchema,
  ANTHROPIC_TERMS,
  approveAiProviderRequestSchema,
  approveCareerProfileDraftRequestSchema,
  APPROVED_ANSWERS_PATH,
  approvedAnswerSchema,
  approvedAnswersResponseSchema,
  CANDIDATE_SETTINGS_PATH,
  candidateSettingsResponseSchema,
  CAREER_PROFILE_DRAFT_APPROVE_PATH,
  CAREER_PROFILE_DRAFT_PATH,
  CAREER_PROFILE_PATH,
  CAREER_PROFILE_RESUME_PATH,
  careerProfileResponseSchema,
  careerProfileVersionSchema,
  createApprovedAnswerRequestSchema,
  CSRF_HEADER,
  CURRENT_SALARY_PATH,
  DEFAULT_WORK_AUTHORIZATION,
  DEFAULT_JOB_CRITERIA,
  JOB_CRITERIA_PATH,
  jobCriteriaFieldErrors,
  jobCriteriaRequestSchema,
  jobCriteriaResponseSchema,
  type ApiErrorResponse,
  type FieldError,
  type JobCriteriaResponse,
  GROSS_SALARY_POLICY_PATH,
  PREFERRED_NET_PAY_PATH,
  RESUME_FILE_FIELD,
  RESUME_MAX_BYTES,
  SALARY_PATH,
  salaryResponseSchema,
  saveCareerProfileDraftRequestSchema,
  setGrossSalaryRequestSchema,
  setPreferredNetPayRequestSchema,
  setWorkAuthorizationRequestSchema,
  updateApprovedAnswerRequestSchema,
  WORK_AUTHORIZATION_PATH,
  type AiProviderResponse,
  type ApprovedAnswer,
  type CareerProfileResponse,
  type CareerProfileSection,
  type CareerProfileVersion,
  type GrossSalary,
  type PreferredNetPay,
  type ResumeDrafting,
  type SalaryResponse,
  type ResumeRefusalReason,
  type SaveCareerProfileDraftRequest,
} from "@eve/contracts"
import { http, HttpResponse, type JsonBodyType } from "msw"

import { apiErrorResponse, TEST_CSRF_TOKEN } from "./contract-handlers"

/**
 * An in-memory stand-in for the slice 2 API (api-contract.md v1.2.0): AI
 * provider approval, Career Profile, Approved Answers, salary, and candidate
 * settings. It follows the contract's status codes, error codes, CSRF rule and
 * version rules, and parses every response body with the contract schema
 * before sending it, so a test can't pass against a shape the API doesn't send.
 *
 * Tests read `state` to assert what the backend recorded, and `requests` to
 * assert what the dashboard sent.
 */
type ResumeDraftingFailure = NonNullable<ResumeDrafting["failureReason"]>

export interface CareerSetupState {
  approval: AiProviderResponse["approval"]
  versions: CareerProfileVersion[]
  drafting: ResumeDrafting | null
  answers: ApprovedAnswer[]
  salary: SalaryResponse
  workAuthorization: string
  /** v1.13.0 (EPIC-0004). A migrated installation that never saved: 70, empty lists, version 1. */
  jobCriteria: JobCriteriaResponse
}

export interface RecordedRequest {
  method: string
  path: string
  body: unknown
}

const NOW = "2026-10-18T09:15:00.000Z"

export const BRIGHTWAVE_FACT = "Led a team of 4 frontend engineers at Brightwave Ltd, 2021–2024"

/** A drafted section with a quoted fact, as the backend returns it after quote verification. */
export function brightwaveSection(): CareerProfileSection {
  return {
    id: "sec-brightwave",
    kind: "experience",
    title: "Senior Frontend Engineer",
    organization: "Brightwave Ltd",
    period: "2021–2024",
    sourceQuote: "Brightwave Ltd, Senior Frontend Engineer, 2021–2024",
    facts: [
      { id: "fact-team", text: BRIGHTWAVE_FACT, sourceQuote: BRIGHTWAVE_FACT },
      {
        id: "fact-checkout",
        text: "Cut checkout page load time by 38%",
        sourceQuote: "cut checkout page load time by 38%",
      },
    ],
  }
}

export function version(
  n: number,
  status: CareerProfileVersion["status"],
  sections: CareerProfileSection[] = [brightwaveSection()]
): CareerProfileVersion {
  return {
    version: n,
    status,
    source: n === 1 ? "resume" : "edit",
    createdAt: `2026-10-1${Math.min(n, 9)}T08:00:00.000Z`,
    approvedAt: status === "draft" ? null : `2026-10-1${Math.min(n, 9)}T10:00:00.000Z`,
    droppedFactCount: 0,
    sections,
  }
}

export function approvedState(): Partial<CareerSetupState> {
  return {
    approval: {
      approvedAt: "2026-10-16T09:00:00.000Z",
      termsCheckedOn: ANTHROPIC_TERMS.checkedOn,
      trainingLine: ANTHROPIC_TERMS.trainingLine,
      retentionLine: ANTHROPIC_TERMS.retentionLine,
      whatsSentLine: ANTHROPIC_TERMS.whatsSentLine,
    },
  }
}

/** The migrated and default Job criteria (v1.18.0: plus the nine default families and the entry-level floor). */
export function defaultJobCriteria(): Omit<JobCriteriaResponse, "version"> {
  return {
    minCoreMatchPercent: DEFAULT_JOB_CRITERIA.minCoreMatchPercent,
    frameworks: [],
    technologies: [],
    targetRoleFamilies: [...DEFAULT_JOB_CRITERIA.targetRoleFamilies],
    seniorityFloor: DEFAULT_JOB_CRITERIA.seniorityFloor,
  }
}

export function createCareerSetupApi(initial: Partial<CareerSetupState> = {}) {
  const state: CareerSetupState = {
    approval: null,
    versions: [],
    drafting: null,
    answers: [],
    salary: { grossSalaryPolicy: null, currentSalary: null, preferredNetPay: null },
    workAuthorization: DEFAULT_WORK_AUTHORIZATION,
    jobCriteria: { ...defaultJobCriteria(), version: 1 },
    ...initial,
  }
  const requests: RecordedRequest[] = []
  /** What the next resume upload turns into once its background drafting finishes. */
  let nextDraft:
    | { kind: "draft"; sections: CareerProfileSection[]; droppedFactCount: number }
    | { kind: "fails"; reason: ResumeDraftingFailure } = { kind: "draft", sections: [brightwaveSection()], droppedFactCount: 0 }
  /** v1.3.0: the next upload is refused as `resume_unreadable`, with this reason (or none, as an older API sends). */
  let nextUploadUnreadable: { reason: ResumeRefusalReason | undefined } | null = null
  /** v1.2.0: the next upload can't be stored; the backend records storage_error and answers 503. */
  let nextUploadStorageFails = false
  /** The next valid Job criteria save fails with 500 internal_error and stores nothing (AC 1.3). */
  let nextJobCriteriaSaveFails = false
  /** Runs after a stored save, where a test applies the server's re-decision to its postings fake. */
  let onJobCriteriaSaved: ((criteria: JobCriteriaResponse) => void) | undefined
  let idCounter = 0
  const newId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`

  const draft = () => state.versions.find((v) => v.status === "draft") ?? null
  const inUse = () => state.versions.find((v) => v.status === "approved") ?? null
  const profileBody = (): CareerProfileResponse => ({
    inUse: inUse(),
    draft: draft(),
    drafting: state.drafting,
    history: [...state.versions]
      .sort((a, b) => b.version - a.version)
      .map(({ version: n, status, source, createdAt, approvedAt }) => ({ version: n, status, source, createdAt, approvedAt })),
  })
  const providerBody = (): AiProviderResponse => ({
    provider: "anthropic",
    name: "Anthropic",
    terms: { ...ANTHROPIC_TERMS },
    approval: state.approval,
  })

  /** Parses with the contract schema, so a body the API couldn't send fails the test. */
  const respond = <T,>(schema: { parse: (input: unknown) => T }, body: T, status = 200) =>
    HttpResponse.json(schema.parse(body) as JsonBodyType, { status })

  const record = async (request: Request, body?: unknown) => {
    requests.push({ method: request.method, path: new URL(request.url).pathname, body })
  }
  const csrfRefused = (request: Request) => request.headers.get(CSRF_HEADER) !== TEST_CSRF_TOKEN
  const readJson = async (request: Request): Promise<unknown> => request.json().catch(() => undefined)

  /** Ends background drafting the way the backend does when the model call returns. */
  const finishDrafting = () => {
    if (state.drafting?.status !== "drafting") return
    if (nextDraft.kind === "fails") {
      state.drafting = { ...state.drafting, status: "failed", failureReason: nextDraft.reason }
      return
    }
    state.versions.push({
      ...version(1 + state.versions.length, "draft", nextDraft.sections),
      droppedFactCount: nextDraft.droppedFactCount,
    })
    state.drafting = null
  }

  const handlers = [
    http.get(AI_PROVIDER_PATH, () => respond(aiProviderResponseSchema, providerBody())),

    http.post(AI_PROVIDER_APPROVAL_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      await record(request, body)
      if (!approveAiProviderRequestSchema.safeParse(body).success) return apiErrorResponse("bad_request")
      state.approval ??= {
        approvedAt: NOW,
        termsCheckedOn: ANTHROPIC_TERMS.checkedOn,
        trainingLine: ANTHROPIC_TERMS.trainingLine,
        retentionLine: ANTHROPIC_TERMS.retentionLine,
        whatsSentLine: ANTHROPIC_TERMS.whatsSentLine,
      }
      return respond(aiProviderResponseSchema, providerBody())
    }),

    http.get(CAREER_PROFILE_PATH, () => respond(careerProfileResponseSchema, profileBody())),

    http.get(`${CAREER_PROFILE_PATH}/versions/:version`, ({ params }) => {
      const found = state.versions.find((v) => String(v.version) === params.version)
      return found ? respond(careerProfileVersionSchema, found) : apiErrorResponse("not_found")
    }),

    http.post(CAREER_PROFILE_RESUME_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      if (!state.approval) return apiErrorResponse("ai_provider_not_approved")
      if (state.drafting?.status === "drafting") return apiErrorResponse("resume_drafting_in_progress")
      if (draft()) return apiErrorResponse("career_profile_draft_exists")
      if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) {
        return apiErrorResponse("unsupported_media_type")
      }
      const parts = await readMultipartParts(request)
      const file = parts.find((part) => part.name === RESUME_FILE_FIELD && part.filename !== null)
      await record(request, { file: file?.filename ?? null, fields: parts.map((part) => part.name) })
      if (!file?.filename || file.size === 0 || file.size > RESUME_MAX_BYTES || !looksLikeResume(file.filename)) {
        return apiErrorResponse("resume_file_invalid")
      }
      if (nextUploadUnreadable) {
        const { reason } = nextUploadUnreadable
        nextUploadUnreadable = null
        return apiErrorResponse("resume_unreadable", reason)
      }
      if (nextUploadStorageFails) {
        nextUploadStorageFails = false
        const startedAt = new Date().toISOString()
        state.drafting = { status: "failed", filename: file.filename, startedAt, failureReason: "storage_error" }
        return apiErrorResponse("resume_storage_unavailable")
      }
      state.drafting = { status: "drafting", filename: file.filename, startedAt: new Date().toISOString(), failureReason: null }
      return respond(careerProfileResponseSchema, profileBody(), 202)
    }),

    http.put(CAREER_PROFILE_DRAFT_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      await record(request, body)
      const parsed = saveCareerProfileDraftRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      if (state.drafting?.status === "drafting") return apiErrorResponse("resume_drafting_in_progress")
      const base = draft() ?? inUse()
      const sections = applyEdits(base?.sections ?? [], parsed.data.sections, newId)
      const current = draft()
      if (current) {
        current.sections = sections
        return respond(careerProfileVersionSchema, current)
      }
      const created = { ...version(state.versions.length + 1, "draft", sections), source: "edit" as const }
      state.versions.push(created)
      return respond(careerProfileVersionSchema, created)
    }),

    http.post(CAREER_PROFILE_DRAFT_APPROVE_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      await record(request, body)
      const parsed = approveCareerProfileDraftRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      const current = draft()
      if (!current || current.version !== parsed.data.version) return apiErrorResponse("not_found")
      if (current.sections.some((s) => s.facts.some((f) => f.text.trim() === ""))) {
        return apiErrorResponse("career_profile_fact_empty")
      }
      const previous = inUse()
      if (previous) previous.status = "replaced"
      current.status = "approved"
      current.approvedAt = NOW
      return respond(careerProfileResponseSchema, profileBody())
    }),

    http.delete(CAREER_PROFILE_DRAFT_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      await record(request)
      const current = draft()
      const requested = new URL(request.url).searchParams.get("version")
      if (!current || (requested !== null && requested !== String(current.version))) {
        return apiErrorResponse("not_found")
      }
      state.versions = state.versions.filter((v) => v !== current)
      return new HttpResponse(null, { status: 204 })
    }),

    http.get(APPROVED_ANSWERS_PATH, () => respond(approvedAnswersResponseSchema, { answers: state.answers })),

    http.post(APPROVED_ANSWERS_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      await record(request, body)
      const parsed = createApprovedAnswerRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      const input = parsed.data
      if (input.group === "custom" && input.question.trim() === "") return apiErrorResponse("approved_answer_question_empty")
      if (input.value.trim() === "") return apiErrorResponse("approved_answer_value_empty")
      if (input.group === "standard" && (input.topic === "skill_years") !== (input.skill !== undefined)) {
        return apiErrorResponse("bad_request")
      }
      const answer: ApprovedAnswer =
        input.group === "standard"
          ? { id: newId(), group: "standard", topic: input.topic, skill: input.skill ?? null, value: input.value.trim(), updatedAt: NOW }
          : input.group === "sensitive"
            ? { id: newId(), group: "sensitive", topic: input.topic, value: input.value.trim(), updatedAt: NOW }
            : { id: newId(), group: "custom", question: input.question.trim(), value: input.value.trim(), updatedAt: NOW }
      if (state.answers.some((existing) => sameQuestion(existing, answer))) return apiErrorResponse("approved_answer_exists")
      state.answers.push(answer)
      return respond(approvedAnswerSchema, answer, 201)
    }),

    http.patch(`${APPROVED_ANSWERS_PATH}/:id`, async ({ request, params }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      await record(request, body)
      const parsed = updateApprovedAnswerRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      const answer = state.answers.find((a) => a.id === params.id)
      if (!answer) return apiErrorResponse("not_found")
      if (parsed.data.value.trim() === "") return apiErrorResponse("approved_answer_value_empty")
      answer.value = parsed.data.value.trim()
      return respond(approvedAnswerSchema, answer)
    }),

    http.delete(`${APPROVED_ANSWERS_PATH}/:id`, async ({ request, params }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      await record(request)
      if (!state.answers.some((a) => a.id === params.id)) return apiErrorResponse("not_found")
      state.answers = state.answers.filter((a) => a.id !== params.id)
      return new HttpResponse(null, { status: 204 })
    }),

    http.get(SALARY_PATH, () => respond(salaryResponseSchema, state.salary)),
    ...grossSalaryHandlers(GROSS_SALARY_POLICY_PATH, "grossSalaryPolicy"),
    ...grossSalaryHandlers(CURRENT_SALARY_PATH, "currentSalary"),

    http.put(PREFERRED_NET_PAY_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      await record(request, body)
      const parsed = setPreferredNetPayRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      const net: PreferredNetPay = {
        ...parsed.data,
        period: "month_net",
        display: `${parsed.data.currency} ${formatAmount(parsed.data.amount)} per month net`,
      }
      state.salary = { ...state.salary, preferredNetPay: net }
      return respond(salaryResponseSchema, state.salary)
    }),
    http.delete(PREFERRED_NET_PAY_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      await record(request)
      state.salary = { ...state.salary, preferredNetPay: null }
      return respond(salaryResponseSchema, state.salary)
    }),

    http.get(CANDIDATE_SETTINGS_PATH, () =>
      respond(candidateSettingsResponseSchema, { workAuthorization: state.workAuthorization })
    ),
    http.put(WORK_AUTHORIZATION_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      await record(request, body)
      const parsed = setWorkAuthorizationRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      state.workAuthorization = parsed.data.workAuthorization
      return respond(candidateSettingsResponseSchema, { workAuthorization: state.workAuthorization })
    }),

    http.get(JOB_CRITERIA_PATH, () => respond(jobCriteriaResponseSchema, state.jobCriteria)),
    http.put(JOB_CRITERIA_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      await record(request, body)
      const parsed = jobCriteriaRequestSchema.safeParse(body)
      if (!parsed.success) return badRequestWithFieldErrors(jobCriteriaFieldErrors(body, parsed.error.issues))
      if (nextJobCriteriaSaveFails) {
        nextJobCriteriaSaveFails = false
        return apiErrorResponse("internal_error")
      }
      state.jobCriteria = { ...parsed.data, version: state.jobCriteria.version + 1 }
      onJobCriteriaSaved?.(state.jobCriteria)
      return respond(jobCriteriaResponseSchema, state.jobCriteria)
    }),
  ]

  function grossSalaryHandlers(path: string, card: "grossSalaryPolicy" | "currentSalary") {
    return [
      http.put(path, async ({ request }) => {
        if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
        const body = await readJson(request)
        await record(request, body)
        const parsed = setGrossSalaryRequestSchema.safeParse(body)
        if (!parsed.success) return apiErrorResponse("bad_request")
        const { amount, currency, period } = parsed.data
        const figure: GrossSalary = {
          amount,
          currency,
          period,
          display: `${currency} ${formatAmount(amount)} per ${period}`,
        }
        state.salary = { ...state.salary, [card]: figure }
        return respond(salaryResponseSchema, state.salary)
      }),
      http.delete(path, async ({ request }) => {
        if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
        await record(request)
        state.salary = { ...state.salary, [card]: null }
        return respond(salaryResponseSchema, state.salary)
      }),
    ]
  }

  return {
    state,
    requests,
    handlers,
    finishDrafting,
    /** Makes the next upload's background drafting fail with `reason` (default `invalid_output`). */
    failNextDraft: (reason: ResumeDraftingFailure = "invalid_output") => {
      nextDraft = { kind: "fails", reason }
    },
    /** The next drafting succeeds with these sections, recording `droppedFactCount` left out. */
    draftNextWith: (sections: CareerProfileSection[], droppedFactCount = 0) => {
      nextDraft = { kind: "draft", sections, droppedFactCount }
    },
    /** The next upload is refused with 422 `resume_unreadable` and `reason` (omit it to send none). */
    refuseNextUpload: (reason?: ResumeRefusalReason) => {
      nextUploadUnreadable = { reason }
    },
    /** Makes the next upload fail to be stored: 503 resume_storage_unavailable, failureReason storage_error (QA-F2). */
    failNextUploadStorage: () => {
      nextUploadStorageFails = true
    },
    failNextJobCriteriaSave: () => {
      nextJobCriteriaSaveFails = true
    },
    onJobCriteriaSaved: (callback: (criteria: JobCriteriaResponse) => void) => {
      onJobCriteriaSaved = callback
    },
    requestsTo: (method: string, path: string) => requests.filter((r) => r.method === method && r.path === path),
  }
}

export type CareerSetupApi = ReturnType<typeof createCareerSetupApi>

/** `400 bad_request` with `fieldErrors` when there are any (contract v1.13.0). */
function badRequestWithFieldErrors(fieldErrors: FieldError[]) {
  const body: ApiErrorResponse = {
    error: { code: "bad_request", message: "The request is not valid.", ...(fieldErrors.length > 0 && { fieldErrors }) },
  }
  return HttpResponse.json(body, { status: 400 })
}

/** The backend decides by content; this fake decides by the extensions the tests use. */
function looksLikeResume(filename: string): boolean {
  return /\.(pdf|docx)$/i.test(filename)
}

interface MultipartPart {
  name: string
  filename: string | null
  size: number
}

/**
 * Reads the parts of a multipart body: field name, file name, byte size.
 * `request.formData()` can't be used here: under jsdom, undici's parser
 * rejects the File class it is handed.
 */
async function readMultipartParts(request: Request): Promise<MultipartPart[]> {
  const boundary = /boundary=([^;]+)/.exec(request.headers.get("content-type") ?? "")?.[1]
  if (!boundary) return []
  const body = new Uint8Array(await request.arrayBuffer())
  const text = new TextDecoder("latin1").decode(body)
  return text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((chunk) => {
      const headerEnd = chunk.indexOf("\r\n\r\n")
      const headers = chunk.slice(0, headerEnd)
      const content = chunk.slice(headerEnd + 4, chunk.length - 2)
      return {
        name: /name="([^"]*)"/.exec(headers)?.[1] ?? "",
        filename: /filename="([^"]*)"/.exec(headers)?.[1] ?? null,
        size: content.length,
      }
    })
}

function sameQuestion(a: ApprovedAnswer, b: ApprovedAnswer): boolean {
  if (a.group !== b.group) return false
  if (a.group === "custom" && b.group === "custom") {
    const norm = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim()
    return norm(a.question) === norm(b.question)
  }
  if (a.group === "standard" && b.group === "standard") {
    return a.topic === b.topic && (a.topic !== "skill_years" || a.skill?.toLowerCase() === b.skill?.toLowerCase())
  }
  return a.group === "sensitive" && b.group === "sensitive" && a.topic === b.topic
}

/** Mirrors the backend's draft edit rules: an edited fact loses its quote; unknown ids get new ids. */
function applyEdits(
  base: CareerProfileSection[],
  sections: SaveCareerProfileDraftRequest["sections"],
  newId: () => string
): CareerProfileSection[] {
  return sections.map((section) => {
    const previous = base.find((s) => s.id === section.id)
    return {
      id: previous?.id ?? newId(),
      kind: section.kind,
      title: section.title,
      organization: section.organization,
      period: section.period,
      sourceQuote: previous?.sourceQuote ?? null,
      facts: section.facts.map((fact) => {
        const old = previous?.facts.find((f) => f.id === fact.id)
        return {
          id: old?.id ?? newId(),
          text: fact.text,
          sourceQuote: old && old.text === fact.text ? old.sourceQuote : null,
        }
      }),
    }
  })
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(amount)
}

/**
 * Read-only handlers for a new installation: Anthropic not approved, no Career
 * Profile, no answers, default work authorization. The default for tests that
 * don't care about slice 2 data, such as the slice 1 session tests.
 */
export const freshInstallationHandlers = [
  http.get(AI_PROVIDER_PATH, () =>
    HttpResponse.json(
      aiProviderResponseSchema.parse({
        provider: "anthropic",
        name: "Anthropic",
        terms: { ...ANTHROPIC_TERMS },
        approval: null,
      }) as JsonBodyType
    )
  ),
  http.get(CAREER_PROFILE_PATH, () =>
    HttpResponse.json(
      careerProfileResponseSchema.parse({ inUse: null, draft: null, drafting: null, history: [] }) as JsonBodyType
    )
  ),
  http.get(APPROVED_ANSWERS_PATH, () => HttpResponse.json({ answers: [] })),
  http.get(SALARY_PATH, () =>
    HttpResponse.json({ grossSalaryPolicy: null, currentSalary: null, preferredNetPay: null })
  ),
  http.get(CANDIDATE_SETTINGS_PATH, () => HttpResponse.json({ workAuthorization: DEFAULT_WORK_AUTHORIZATION })),
  http.get(JOB_CRITERIA_PATH, () => HttpResponse.json({ ...defaultJobCriteria(), version: 1 })),
]
