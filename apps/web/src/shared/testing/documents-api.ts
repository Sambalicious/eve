import {
  APPLICATIONS_PATH,
  applicationDetailSchema,
  applicationsResponseSchema,
  applicationSummarySchema,
  ATS_MINIMUM_PATH,
  CANDIDATE_CONTACT_PATH,
  atsMinimumSchema,
  candidateContactSchema,
  createApplicationRequestSchema,
  createApplicationResponseSchema,
  CSRF_HEADER,
  DOCUMENTS_PATH,
  documentDownloadPath,
  documentsListResponseSchema,
  type ApplicationDetail,
  type ApplicationListItem,
  type JobPostingDetail,
  type ApplicationSummary,
  type CandidateContact,
  type TailoredDocument,
} from "@eve/contracts"
import { http, HttpResponse, type JsonBodyType } from "msw"

import { appliedOverride, decideCreate, type ExistingApplication } from "./apply-anyway-fake"
import { apiErrorResponse, TEST_CSRF_TOKEN } from "./contract-handlers"

/**
 * An in-memory stand-in for the slice 4 API (api-contract.md v1.5.0):
 * contact details, Applications, document generation, downloads and the
 * Documents list. Every JSON body is parsed with the contract schema before
 * it is sent. Downloads answer with the contract's headers and a tiny PDF.
 */
export interface DocumentsState {
  contact: CandidateContact | { fullName: ""; lines: [] }
  /** ATS minimum for automatic submission (v1.26.0), default 40. */
  atsMinimum: number
  applications: ApplicationDetail[]
  /**
   * v1.24.0 (CR-AA-06): the stored posting a create is decided from. `linkFakes`
   * points it at the discovery fake; unlinked, every posting is unknown (404).
   */
  postingOf: (jobPostingId: string) => JobPostingDetail | undefined
  /** The Application's submission state and sample flag; `linkFakes` points it at the submission fake. */
  submissionOf: (applicationId: string) => { state: string | null; isSample: boolean }
  /**
   * v1.28.0 (C4): the board fields `GET /v1/applications` adds to each row, by Application id. Anything not set reads from
   * `submissionOf` (state and kind) or is null/false.
   */
  board: Record<string, Partial<BoardFields>>
  /** The Application's Outcomes, oldest first (v1.28.0 C4 derives `latestOutcome` and `requestForAction`); `linkOutcomes` points it at the controls fake. */
  outcomesOf: (applicationId: string) => readonly { id: string; type: string; createdAt: string }[]
  /** What a generation turns the Application into once it runs. */
  nextGeneration: (app: ApplicationDetail) => ApplicationDetail
  /**
   * `GET /v1/applications?retention=due|waiting` (v1.17.0, E5.7). `today` is the
   * WAT date; `waiting` lists Applications waiting on a decision. `due`: live,
   * not waiting, `expiresOn` from today to today + 30. `waiting`: live, waiting,
   * 30 or more days past `expiresOn`. Earliest `expiresOn` first.
   */
  retention: { today: string; waiting: string[] }
}

/** `YYYY-MM-DD` plus `days`, as calendar dates. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

function retentionMatches(state: DocumentsState, filter: string | null): ApplicationDetail[] | null {
  if (filter !== "due" && filter !== "waiting") return null
  const { today, waiting } = state.retention
  return state.applications
    .filter((a) => !a.detailsDeletedAt && typeof a.expiresOn === "string")
    .filter((a) =>
      filter === "due"
        ? !waiting.includes(a.id) && a.expiresOn! >= today && a.expiresOn! <= addDays(today, 30)
        : waiting.includes(a.id) && a.expiresOn! <= addDays(today, -30)
    )
    .sort((a, b) => a.expiresOn!.localeCompare(b.expiresOn!) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

const NOW = "2026-10-19T10:00:00.000Z"
let counter = 0
export const applicationId = () => `30000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`

/** A minimal valid PDF, so a preview has real bytes. */
export const TINY_PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"

export function tailoredDocument(id: string, kind: TailoredDocument["kind"], version = 1): TailoredDocument {
  return {
    kind,
    careerProfileVersion: version,
    createdAt: NOW,
    pdfUrl: documentDownloadPath(id, kind, "pdf"),
    docxUrl: documentDownloadPath(id, kind, "docx"),
    previewText:
      kind === "resume"
        ? ["Ada Okafor", "Lagos, Nigeria · ada@example.com", "Summary", "Senior frontend engineer who builds products from scratch to production.", "Experience", "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd"]
        : ["Ada Okafor", "Dear Acme Payments hiring team,", "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", "Kind regards,", "Ada Okafor"],
    ats: null,
  }
}

/**
 * An Application with both documents ready, generated from Career Profile version 1.
 * Blocked fixtures add `blockedClaimCause`, `blockedClaimTerms` and `blockedClaimMoreTerms` via overrides (see blocked-claim-fixtures.ts).
 */
export function readyApplication(overrides: Partial<ApplicationDetail> = {}): ApplicationDetail {
  const id = overrides.id ?? applicationId()
  return {
    id,
    jobPostingId: "10000000-0000-4000-8000-000000000001",
    company: "Acme Payments",
    roleTitle: "Senior Frontend Engineer",
    requisitionId: "R-1042",
    applicationUrl: "https://boards.greenhouse.io/acme/jobs/1042",
    pastedDescription: false,
    manualOnly: false,
    state: "documents_ready",
    careerProfileVersion: 1,
    blockedDocument: null,
    blockedClaim: null,
    failure: null,
    coverLetterStatus: "not_submitted",
    createdAt: NOW,
    updatedAt: NOW,
    documents: [tailoredDocument(id, "resume"), tailoredDocument(id, "cover_letter")],
    override: null,
    posting: null,
    latestDrop: null,
    ...overrides,
  }
}

function summaryOf(app: ApplicationDetail): ApplicationSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { documents, posting, latestDrop, ...summary } = app
  return summary
}

/** The five C4 keys on a list row (contract v1.28.0). */
export interface BoardFields {
  submissionState: ApplicationListItem["submissionState"]
  submissionKind: ApplicationListItem["submissionKind"]
  sampleState: ApplicationListItem["sampleState"]
  latestOutcome: ApplicationListItem["latestOutcome"]
  requestForAction: boolean
}

function listItemOf(app: ApplicationDetail, state: DocumentsState): ApplicationListItem {
  const sub = state.submissionOf(app.id)
  const base: BoardFields = {
    submissionState: (sub.state as BoardFields["submissionState"]) ?? null,
    submissionKind: sub.isSample ? "sample" : sub.state === "queued" || sub.state === "confirmed" ? "automatic" : null,
    sampleState: null,
    latestOutcome: null,
    requestForAction: false,
  }
  const outcomes = state.outcomesOf(app.id)
  const placing = outcomes.filter((o) => o.type !== "request_for_action").at(-1)
  if (placing) base.latestOutcome = { id: placing.id, type: placing.type as NonNullable<BoardFields["latestOutcome"]>["type"], createdAt: placing.createdAt }
  base.requestForAction = outcomes.at(-1)?.type === "request_for_action"
  return { ...summaryOf(app), ...base, ...state.board[app.id] }
}

export function createDocumentsApi(initial: Partial<DocumentsState> = {}) {
  const state: DocumentsState = {
    contact: { fullName: "Ada Okafor", lines: ["Lagos, Nigeria", "ada@example.com"] },
    atsMinimum: 40,
    applications: [],
    postingOf: () => undefined,
    submissionOf: () => ({ state: null, isSample: false }),
    board: {},
    outcomesOf: () => [],
    nextGeneration: (app) => readyApplication({ ...app, state: "documents_ready", careerProfileVersion: 1, documents: [tailoredDocument(app.id, "resume"), tailoredDocument(app.id, "cover_letter")] }),
    retention: { today: "2026-10-20", waiting: [] },
    ...initial,
  }
  const requests: { method: string; path: string; body: unknown }[] = []
  const respond = <T,>(schema: { parse: (input: unknown) => T }, body: T, status = 200) =>
    HttpResponse.json(schema.parse(body) as JsonBodyType, { status, headers: { "cache-control": "no-store" } })
  const csrfRefused = (request: Request) => request.headers.get(CSRF_HEADER) !== TEST_CSRF_TOKEN
  const readJson = async (request: Request): Promise<unknown> => request.json().catch(() => undefined)
  const record = (request: Request, body: unknown) =>
    requests.push({ method: request.method, path: new URL(request.url).pathname, body })
  const find = (id: unknown) => state.applications.find((a) => a.id === id)
  const existingOf = (a: ApplicationDetail): ExistingApplication => {
    const s = state.submissionOf(a.id)
    return { id: a.id, submissionState: s.state, isSample: s.isSample, detailsDeleted: Boolean(a.detailsDeletedAt) }
  }
  /** v1.24.0: the posting-detail fake asks this for `applicationId` and `applyAnyway`. */
  const existingFor = (jobPostingId: string): ExistingApplication | null => {
    const a = state.applications.find((x) => x.jobPostingId === jobPostingId)
    return a ? existingOf(a) : null
  }
  /**
   * Generation finishes on the second detail read after it starts: the first
   * read (the refetch right after POST) still sees `generating`, as it would
   * while a background job runs; the next poll sees the result.
   */
  const pending = new Map<string, number>()

  const handlers = [
    http.get(ATS_MINIMUM_PATH, () => respond(atsMinimumSchema, { minAtsPercent: state.atsMinimum })),
    http.put(ATS_MINIMUM_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      record(request, body)
      const parsed = atsMinimumSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      state.atsMinimum = parsed.data.minAtsPercent
      return respond(atsMinimumSchema, parsed.data)
    }),
    http.get(CANDIDATE_CONTACT_PATH, () =>
      HttpResponse.json(state.contact.fullName === "" ? { fullName: "", lines: [] } : candidateContactSchema.parse(state.contact))
    ),
    http.put(CANDIDATE_CONTACT_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      record(request, body)
      const parsed = candidateContactSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      state.contact = parsed.data
      return respond(candidateContactSchema, parsed.data)
    }),
    http.get(APPLICATIONS_PATH, ({ request }) => {
      const values = new URL(request.url).searchParams.getAll("retention")
      const filtered = values.length === 1 ? retentionMatches(state, values[0]) : null
      return respond(applicationsResponseSchema, { applications: (filtered ?? state.applications).map((a) => listItemOf(a, state)) })
    }),
    http.post(APPLICATIONS_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await readJson(request)
      record(request, body)
      const parsed = createApplicationRequestSchema.safeParse(body)
      if (!parsed.success) return apiErrorResponse("bad_request")
      const posting = state.postingOf(parsed.data.jobPostingId)
      const existing = state.applications.find((a) => a.jobPostingId === parsed.data.jobPostingId)
      const decision = decideCreate(posting, parsed.data.acknowledgement, existing ? existingOf(existing) : null)
      if (decision.kind === "refuse") return apiErrorResponse(decision.code)
      if (existing) {
        // Step 10: mark the existing Application; an identical stored decision is a no-op (first time kept).
        if (decision.kind === "override") {
          const same = existing.override?.status === decision.decision.status && existing.override.skipReason === decision.decision.skipReason && existing.override.skipDetail === decision.decision.skipDetail
          if (!same) existing.override = appliedOverride(decision.decision, new Date().toISOString())
          existing.latestDrop = null
        }
        return respond(createApplicationResponseSchema, { created: false, application: summaryOf(existing) })
      }
      const id = applicationId()
      const created = readyApplication({
        id,
        jobPostingId: parsed.data.jobPostingId,
        state: "prepared",
        careerProfileVersion: null,
        documents: [],
        override: decision.kind === "override" ? appliedOverride(decision.decision, new Date().toISOString()) : null,
        posting: posting ? { status: posting.status, hidden: posting.hiddenReason !== null } : null,
        // v1.27.0: a pasted-description Application carries its posting's names, link and marks.
        ...(posting?.origin === "pasted_description" && {
          company: posting.company,
          roleTitle: posting.title,
          requisitionId: posting.requisitionId,
          applicationUrl: posting.applicationUrl,
          pastedDescription: true,
        }),
        manualOnly: posting?.applyMode === "manual",
      })
      state.applications.unshift(created)
      return respond(createApplicationResponseSchema, { created: true, application: summaryOf(created) }, 201)
    }),
    http.get(`${APPLICATIONS_PATH}/:id`, ({ params }) => {
      const app = find(params.id)
      if (!app) return apiErrorResponse("not_found")
      const reads = pending.get(app.id)
      if (reads !== undefined) {
        if (reads >= 1) {
          pending.delete(app.id)
          Object.assign(app, state.nextGeneration(app))
        } else pending.set(app.id, reads + 1)
      }
      return respond(applicationDetailSchema, app)
    }),
    http.post(`${APPLICATIONS_PATH}/:id/documents/generate`, ({ request, params }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      record(request, null)
      const app = find(params.id)
      if (!app) return apiErrorResponse("not_found")
      if (state.contact.fullName === "") return apiErrorResponse("contact_details_missing")
      if (app.state !== "generating") {
        Object.assign(app, {
          state: "generating",
          documents: [],
          blockedDocument: null,
          blockedClaim: null,
          // undefined, not null: the api leaves these keys out once a block is cleared (contract, fixtures).
          blockedClaimCause: undefined,
          blockedClaimTerms: undefined,
          blockedClaimMoreTerms: undefined,
          failure: null,
        })
        pending.set(app.id, 0)
      }
      return respond(applicationSummarySchema, summaryOf(app), 202)
    }),
    http.get(`${APPLICATIONS_PATH}/:id/documents/:file`, ({ params }) => {
      const app = find(params.id)
      const match = /^(resume|cover-letter)\.(pdf|docx)$/.exec(String(params.file))
      if (!app || !match) return apiErrorResponse("not_found")
      const kind = match[1] === "resume" ? "resume" : "cover_letter"
      if (app.state !== "documents_ready" || !app.documents.some((d) => d.kind === kind)) return apiErrorResponse("document_not_available")
      const pdf = match[2] === "pdf"
      return new HttpResponse(pdf ? TINY_PDF : "PK-docx", {
        headers: {
          "content-type": pdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "content-disposition": `attachment; filename="${kind === "resume" ? "Resume" : "Cover letter"} - ${app.company ?? ""} - ${app.requisitionId}.${match[2]}"`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
          "content-security-policy": "sandbox; default-src 'none'",
        },
      })
    }),
    http.get(DOCUMENTS_PATH, () =>
      respond(documentsListResponseSchema, {
        rows: state.applications
          .filter((a) => a.documents.length > 0)
          .map((a) => {
            const strip = (kind: TailoredDocument["kind"]) => {
              const doc = a.documents.find((d) => d.kind === kind)
              if (!doc) return null
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { previewText, ...rest } = doc
              return rest
            }
            return {
              applicationId: a.id,
              company: a.company,
              roleTitle: a.roleTitle,
              requisitionId: a.requisitionId,
              pastedDescription: a.pastedDescription,
              coverLetterStatus: a.coverLetterStatus,
              resume: strip("resume"),
              coverLetter: strip("cover_letter"),
            }
          }),
      })
    ),
  ]

  return { state, requests, handlers, existingFor }
}

export type DocumentsApi = ReturnType<typeof createDocumentsApi>

/** Read-only defaults: a contact with a name, no Applications. */
export const freshDocumentsHandlers = createDocumentsApi().handlers.filter((_, i) => i === 0 || i === 2 || i === 7)

/** Points the Applications list's `latestOutcome` and `requestForAction` at the Outcomes the controls fake holds. */
export function linkOutcomes(documents: { state: DocumentsState }, controls: { state: { outcomes: readonly { id: string; applicationId: string; type: string; createdAt: string }[] } }) {
  documents.state.outcomesOf = (id) => controls.state.outcomes.filter((o) => o.applicationId === id)
}
