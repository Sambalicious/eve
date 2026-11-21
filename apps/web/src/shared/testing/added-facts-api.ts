import {
  ADDED_FACT_LIMITS,
  ADDED_FACTS_ERROR_MESSAGES,
  addedFactFieldErrorSchema,
  addedFactsViewSchema,
  addAddedFactsRequestSchema,
  apiErrorResponseSchema,
  applicationAddedFactPath,
  applicationAddedFactsConfirmPath,
  applicationAddedFactsPath,
  confirmAddedFactsRequestSchema,
  CSRF_HEADER,
  editAddedFactRequestSchema,
  removeAddedFactQuerySchema,
  type AddedFact,
  type AddedFactsView,
  type ApiErrorCode,
  type Submission,
} from "@eve/contracts"
import type { z } from "zod"
import { http, HttpResponse, type JsonBodyType } from "msw"

import { addedFactsView, oneLinerFact, skillOnlyFact } from "./added-facts-fixtures"
import { TEST_CSRF_TOKEN } from "./contract-handlers"

type AddedFactFieldError = z.infer<typeof addedFactFieldErrorSchema>

/**
 * FEAT-0017 in-memory stand-in for the five added-facts routes (api-contract.md v1.32.0).
 * One view per Application; `expectedVersion` and the two limits are enforced with the contract's own
 * constants, so a component test cannot pass against a fake the api would refuse.
 * Fresh by default: one Application with no facts, an approved profile and two roles.
 */
export type AddedFactsState = {
  views: Record<string, AddedFactsView>
  /** Default `saved_to_draft` for a save-to-profile item; a test can force `draft_full`, `already_there`, … */
  profileOutcome: "saved_to_draft" | "already_there" | "draft_full" | "draft_unavailable" | "failed"
  requests: Array<{ method: string; path: string; body: unknown }>
}

const INITIAL_APPLICATION = "a1b2c3d4-0000-4000-8000-000000000001"
const NOT_FOUND = () => apiError(404, "not_found")
const CONFLICT = () => apiError(409, "added_facts_conflict")
const FROZEN = () => apiError(409, "added_facts_frozen")
const BUSY = () => apiError(409, "added_facts_busy")
const STALE = () => apiError(409, "documents_stale")
const NOT_LIFTED = () => apiError(409, "added_facts_not_lifted")
const CONFIRMATION_REQUIRED = () => apiError(409, "added_facts_confirmation_required")

/** Codes this fake can answer that are not in the added-facts table. */
const OTHER_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  not_found: "Not found.",
  bad_request: "The request is not valid.",
  csrf_invalid: "The request is missing a valid CSRF token.",
}

function apiError(status: number, code: ApiErrorCode, fieldErrors?: readonly AddedFactFieldError[]) {
  const body = apiErrorResponseSchema.parse({
    error: {
      code,
      message: OTHER_MESSAGES[code] ?? ADDED_FACTS_ERROR_MESSAGES[code as keyof typeof ADDED_FACTS_ERROR_MESSAGES],
      ...(fieldErrors === undefined ? {} : { fieldErrors }),
    },
  })
  return HttpResponse.json(body as JsonBodyType, { status, headers: { "cache-control": "no-store" } })
}

function invalid(fieldErrors: readonly AddedFactFieldError[]) {
  return apiError(422, "added_facts_invalid", fieldErrors)
}

function limit(problem: "one_liner_limit" | "skill_only_limit") {
  return apiError(422, "added_facts_limit", [{ source: "added_facts", field: "items", position: null, problem }])
}

const countsOf = (facts: readonly AddedFact[]) => ({
  oneLiner: facts.filter((fact) => fact.kind === "one_liner").length,
  skillOnly: facts.filter((fact) => fact.kind === "skill_only").length,
})

const textKey = (text: string) => text.trim().toLowerCase()

/** The live gap list: the stored terms minus the ones an added fact closes. */
function gapsAfter(terms: readonly string[], facts: readonly AddedFact[]): string[] {
  return terms.filter((term) =>
    !facts.some((fact) => (fact.kind === "skill_only" ? textKey(fact.text) === textKey(term) : textKey(fact.text).includes(textKey(term))))
  )
}

export function createAddedFactsApi(initial: Partial<AddedFactsState> = {}) {
  const state: AddedFactsState = {
    views: { [INITIAL_APPLICATION]: addedFactsView() },
    profileOutcome: "saved_to_draft",
    requests: [],
    ...initial,
  }
  const respond = (view: AddedFactsView, status = 200) => HttpResponse.json(addedFactsViewSchema.parse(view) as JsonBodyType, { status, headers: { "cache-control": "no-store" } })
  const read = async (request: Request): Promise<unknown> => request.json().catch(() => undefined)
  const record = (request: Request, body: unknown) => state.requests.push({ method: request.method, path: new URL(request.url).pathname, body })
  const find = (id: unknown) => state.views[String(id)]
  const csrfRefused = (request: Request) => request.headers.get(CSRF_HEADER) !== TEST_CSRF_TOKEN

  const handlers = [
    http.get(applicationAddedFactsPath(":id"), ({ params }) => {
      const view = find(params.id)
      return view === undefined ? NOT_FOUND() : respond(view)
    }),

    http.post(applicationAddedFactsPath(":id"), async ({ params, request }) => {
      if (csrfRefused(request)) return apiError(403, "csrf_invalid")
      const view = find(params.id)
      if (view === undefined) return NOT_FOUND()
      if (view.frozenReason !== null) return FROZEN()
      if (view.busyReason !== null) return BUSY()
      const parsed = addAddedFactsRequestSchema.safeParse(await read(request))
      record(request, parsed.success ? parsed.data : undefined)
      if (!parsed.success) return apiError(400, "bad_request")
      const body = parsed.data
      if (body.expectedVersion !== view.version) return CONFLICT()

      const fieldErrors: AddedFactFieldError[] = []
      const known = new Set(view.postingGaps.available ? view.postingGaps.terms.map(textKey) : [])
      const existing = new Set(view.facts.map((fact) => textKey(fact.text)))
      const created: AddedFact[] = []
      body.items.forEach((item, index) => {
        const position = index + 1
        if (item.affirmed !== true) fieldErrors.push({ source: "added_facts", field: "affirmed", position, problem: "affirmation_required" })
        if (item.kind === "skill_only") {
          const term = item.term.trim()
          if (!known.has(textKey(term))) {
            fieldErrors.push({ source: "added_facts", field: "term", position, problem: "term_not_a_gap" })
            return
          }
          if (existing.has(textKey(term))) {
            fieldErrors.push({ source: "added_facts", field: "term", position, problem: "duplicate" })
            return
          }
          existing.add(textKey(term))
          created.push(skillOnlyFact({ id: crypto.randomUUID(), text: view.postingGaps.terms.find((candidate) => textKey(candidate) === textKey(term)) ?? term, term: view.postingGaps.terms.find((candidate) => textKey(candidate) === textKey(term)) ?? term, profile: null, saveToProfile: item.saveToProfile }))
          return
        }
        const text = item.text.trim()
        if (text === "") fieldErrors.push({ source: "added_facts", field: "text", position, problem: "empty" })
        else if ([...text].length > ADDED_FACT_LIMITS.textMax) fieldErrors.push({ source: "added_facts", field: "text", position, problem: "too_long" })
        else if (existing.has(textKey(text))) fieldErrors.push({ source: "added_facts", field: "text", position, problem: "duplicate" })
        if (view.roles.length === 0) fieldErrors.push({ source: "added_facts", field: "roleSectionId", position, problem: "no_experience_role" })
        else if (item.roleSectionId === undefined || item.roleSectionId === null) fieldErrors.push({ source: "added_facts", field: "roleSectionId", position, problem: "role_required" })
        else if (!view.roles.some((role) => role.sectionId === item.roleSectionId)) fieldErrors.push({ source: "added_facts", field: "roleSectionId", position, problem: "role_unknown" })
        if (fieldErrors.some((error) => error.position === position)) return
        existing.add(textKey(text))
        const role = view.roles.find((candidate) => candidate.sectionId === item.roleSectionId)
        created.push(oneLinerFact({ id: crypto.randomUUID(), text, term: item.term ?? null, role: role === undefined ? null : { ...role, inProfileVersion: true }, profile: null, saveToProfile: item.saveToProfile, usedInDocuments: false }))
      })
      if (fieldErrors.length > 0) return invalid(fieldErrors)

      const counts = countsOf([...view.facts, ...created])
      if (counts.oneLiner > ADDED_FACT_LIMITS.oneLiner) return limit("one_liner_limit")
      if (counts.skillOnly > ADDED_FACT_LIMITS.skillOnly) return limit("skill_only_limit")

      const facts = [...created].reverse().concat(view.facts)
      const next: AddedFactsView = {
        ...view,
        version: view.version + 1,
        facts,
        counts: countsOf(facts),
        postingGaps: { ...view.postingGaps, terms: gapsAfter(view.postingGaps.terms, facts) },
        documentsStale: true,
        confirmation: { state: "stale", voided: view.confirmation.confirmedAt !== null, confirmedAt: null },
      }
      state.views[String(params.id)] = next
      const profileSave = body.items.map((item, index) => ({
        position: index + 1,
        factId: created[index]!.id,
        outcome: item.saveToProfile ? state.profileOutcome : ("not_requested" as const),
        draftVersion: item.saveToProfile && state.profileOutcome === "saved_to_draft" ? (view.profileVersion ?? 1) + 1 : null,
      }))
      return HttpResponse.json({ view: addedFactsViewSchema.parse(next), profileSave }, { status: 200, headers: { "cache-control": "no-store" } })
    }),

    http.patch(applicationAddedFactPath(":id", ":factId"), async ({ params, request }) => {
      if (csrfRefused(request)) return apiError(403, "csrf_invalid")
      const view = find(params.id)
      if (view === undefined) return NOT_FOUND()
      if (view.frozenReason !== null) return FROZEN()
      if (view.busyReason !== null) return BUSY()
      const parsed = editAddedFactRequestSchema.safeParse(await read(request))
      record(request, parsed.success ? parsed.data : undefined)
      if (!parsed.success) return apiError(400, "bad_request")
      if (parsed.data.expectedVersion !== view.version) return CONFLICT()
      const fact = view.facts.find((candidate) => candidate.id === params.factId)
      if (fact === undefined) return NOT_FOUND()
      const text = parsed.data.text.trim()
      if (text === "") return invalid([{ source: "added_facts", field: "text", position: null, problem: "empty" }])
      if (textKey(text) === textKey(fact.text) && parsed.data.roleSectionId === (fact.role?.sectionId ?? null)) return respond(view)
      if (view.roles.length === 0) return invalid([{ source: "added_facts", field: "roleSectionId", position: null, problem: "no_experience_role" }])
      if (parsed.data.roleSectionId === null) return invalid([{ source: "added_facts", field: "roleSectionId", position: null, problem: "role_required" }])
      const role = view.roles.find((candidate) => candidate.sectionId === parsed.data.roleSectionId)
      if (role === undefined) return invalid([{ source: "added_facts", field: "roleSectionId", position: null, problem: "role_unknown" }])
      if (view.facts.some((candidate) => candidate.id !== fact.id && textKey(candidate.text) === textKey(text))) {
        return invalid([{ source: "added_facts", field: "text", position: null, problem: "duplicate" }])
      }
      if (fact.term !== null && !textKey(text).includes(textKey(fact.term))) return invalid([{ source: "added_facts", field: "text", position: null, problem: "term_not_named" }])
      if (fact.kind === "skill_only" && countsOf(view.facts).oneLiner + 1 > ADDED_FACT_LIMITS.oneLiner) return limit("one_liner_limit")
      const updated: AddedFact = { ...fact, kind: "one_liner", text, role: { ...role, inProfileVersion: true } }
      const facts = view.facts.map((candidate) => (candidate.id === fact.id ? updated : candidate))
      const next: AddedFactsView = { ...view, version: view.version + 1, facts, counts: countsOf(facts), documentsStale: true, confirmation: { ...view.confirmation, state: "stale", voided: view.confirmation.confirmedAt !== null } }
      state.views[String(params.id)] = next
      return respond(next)
    }),

    http.delete(applicationAddedFactPath(":id", ":factId"), ({ params, request }) => {
      if (csrfRefused(request)) return apiError(403, "csrf_invalid")
      const view = find(params.id)
      if (view === undefined) return NOT_FOUND()
      if (view.frozenReason !== null) return FROZEN()
      if (view.busyReason !== null) return BUSY()
      const query = removeAddedFactQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
      if (!query.success) return apiError(400, "bad_request")
      if (query.data.expectedVersion !== view.version) return CONFLICT()
      const fact = view.facts.find((candidate) => candidate.id === params.factId)
      if (fact === undefined) return apiError(404, "not_found")
      const facts = view.facts.filter((candidate) => candidate.id !== fact.id)
      const next: AddedFactsView = {
        ...view,
        version: view.version + 1,
        facts,
        counts: countsOf(facts),
        postingGaps: { ...view.postingGaps, terms: gapsAfter([...view.postingGaps.terms, ...(fact.term === null ? [] : [fact.term])], facts) },
        documentsStale: true,
        confirmation: { ...view.confirmation, state: "stale", voided: view.confirmation.confirmedAt !== null },
      }
      state.views[String(params.id)] = next
      return respond(next)
    }),

    http.post(applicationAddedFactsConfirmPath(":id"), async ({ params, request }) => {
      if (csrfRefused(request)) return apiError(403, "csrf_invalid")
      const view = find(params.id)
      if (view === undefined) return NOT_FOUND()
      if (view.frozenReason !== null) return FROZEN()
      if (view.busyReason !== null) return BUSY()
      const parsed = confirmAddedFactsRequestSchema.safeParse(await read(request))
      record(request, parsed.success ? parsed.data : undefined)
      if (!parsed.success) return apiError(400, "bad_request")
      if (parsed.data.expectedVersion !== view.version) return CONFLICT()
      if (view.match === null || !view.match.lifted) return NOT_LIFTED()
      if (view.documentsStale) return STALE()
      if (view.confirmation.state === "confirmed") return HttpResponse.json(submission(), { status: 200 })
      const next: AddedFactsView = { ...view, confirmation: { state: "confirmed", voided: false, confirmedAt: "2026-11-21T10:00:00.000Z" } }
      state.views[String(params.id)] = next
      return HttpResponse.json(submission() as JsonBodyType, { status: 200, headers: { "cache-control": "no-store" } })
    }),
  ]

  /** `POST .../queue` with the new refusal, for a component test that bypasses the page (C-AF-65). */
  const queueGuard = http.post("/v1/applications/:id/queue", ({ params }) => {
    const view = find(params.id)
    if (view === undefined) return NOT_FOUND()
    if (view.documentsStale) return STALE()
    if (view.match?.lifted && view.confirmation.state !== "confirmed") return CONFIRMATION_REQUIRED()
    return HttpResponse.json(submission() as JsonBodyType, { status: 200 })
  })

  return { state, handlers: [...handlers, queueGuard] }
}

export type AddedFactsApi = ReturnType<typeof createAddedFactsApi>

/** One Application with no added facts, for the default test server. */
export const freshAddedFactsHandlers = createAddedFactsApi().handlers

function submission(): Submission {
  return {
    state: "queued",
    kind: "automatic",
    attemptNumber: 1,
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
  }
}
