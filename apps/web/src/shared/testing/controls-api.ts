import {
  applicationDetailSchema,
  CONTROLS_PATH,
  controlsSchema,
  CSRF_HEADER,
  DELETE_DETAILS_PATH,
  deleteDetailsRequestSchema,
  deleteDetailsResponseSchema,
  GLOBAL_PAUSE_PATH,
  MINIMAL_RECORDS_PATH,
  minimalRecordsResponseSchema,
  MONTHLY_CEILING_PATH,
  outcomeRequestSchema,
  outcomeSchema,
  outcomesResponseSchema,
  raiseCeilingRequestSchema,
  raiseCeilingResponseSchema,
  RETENTION_PATH,
  retentionResponseSchema,
  setGlobalPauseRequestSchema,
  type ApplicationDetail,
  type Controls,
  type MinimalRecord,
  type Outcome,
  type RaiseCeilingResponse,
  type RetentionResponse,
} from "@eve/contracts"
import { http, HttpResponse, type JsonBodyType } from "msw"

import { apiErrorResponse, TEST_CSRF_TOKEN } from "./contract-handlers"

const NOW = "2026-10-20T10:00:00.000Z"

/** `GET /v1/controls` (v1.11.0): October 2026, USD 23.40 of USD 50.00, no pause. */
export function controls(overrides: Partial<Omit<Controls, "spend">> & { spend?: Partial<Controls["spend"]> } = {}): Controls {
  const { spend, ...rest } = overrides
  return {
    globalPaused: false,
    globalPausedAt: null,
    costPause: null,
    ...rest,
    spend: {
      month: "2026-10-01",
      spent: "23.40",
      ceiling: "50.00",
      defaultCeiling: "50.00",
      raised: false,
      maxCeiling: "100.00",
      canRaise: true,
      percentUsed: 46,
      byCategory: { hosting: "24.00", ai: "0.00", browser: "0.00", discovery: "0.00", email: "0.00" },
      ...spend,
    },
  }
}

/** A cost pause from 25 Oct 2026, resuming 00:00 WAT on 1 Nov 2026. */
export const costPause = (o: Partial<NonNullable<Controls["costPause"]>> = {}): NonNullable<Controls["costPause"]> => ({
  pausedAt: "2026-10-25T09:00:00.000Z",
  month: "2026-10-01",
  resumesAt: "2026-10-31T23:00:00.000Z",
  nextAction: "form filling",
  nextActionEstimate: "0.30",
  ...o,
})

/** `GET /v1/retention` (v1.17.0): the handoff's "before the first run" fixture, then overrides. */
export function retention(overrides: Partial<RetentionResponse> = {}): RetentionResponse {
  return {
    rule: { months: 12 },
    dueNext30Days: { count: 0, earliestOn: null },
    overdueDue: { count: 0 },
    waitingForDecision: { count: 0 },
    graceEndsOn: null,
    lastRun: null,
    lastFailure: null,
    ...overrides,
  }
}

export interface ControlsApiState {
  controls: Controls
  /** What `PUT /v1/controls/ceiling` answers; defaults to raising to the typed value and clearing the cost pause. */
  raise: (ceiling: string, state: Controls) => RaiseCeilingResponse
  outcomes: Outcome[]
  records: MinimalRecord[]
  /** Applications that `delete-details` turns into minimal records (the documents fake's array, shared). */
  applications: ApplicationDetail[]
  /** `GET /v1/retention`. */
  retention: RetentionResponse
}

let counter = 0
const outcomeId = () => `40000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`

/**
 * An in-memory stand-in for the slice 7 API (api-contract v1.11.0): controls,
 * the global pause, raising the ceiling, manual Outcomes, deleting detailed
 * records and minimal records. Every JSON body is parsed with the contract
 * schema before it is sent. State-changing routes check the CSRF header.
 */
export function createControlsApi(initial: Partial<ControlsApiState> = {}) {
  const state: ControlsApiState = {
    controls: controls(),
    raise: (ceiling, current) => ({
      result: "raised",
      costPauseCleared: current.costPause !== null,
      controls: { ...current, costPause: null, spend: { ...current.spend, ceiling: Number(ceiling).toFixed(2), raised: true } },
    }),
    outcomes: [],
    records: [],
    applications: [],
    retention: retention(),
    ...initial,
  }
  const requests: { method: string; path: string; body: unknown }[] = []
  const respond = <T,>(schema: { parse: (input: unknown) => T }, body: T, status = 200) =>
    HttpResponse.json(schema.parse(body) as JsonBodyType, { status, headers: { "cache-control": "no-store" } })
  const csrfRefused = (request: Request) => request.headers.get(CSRF_HEADER) !== TEST_CSRF_TOKEN
  const read = async (request: Request) => {
    const body: unknown = await request.json().catch(() => undefined)
    requests.push({ method: request.method, path: new URL(request.url).pathname, body })
    return body
  }
  const findApp = (id: unknown) => state.applications.find((a) => a.id === id)

  const handlers = [
    http.get(CONTROLS_PATH, () => respond(controlsSchema, state.controls)),
    http.put(GLOBAL_PAUSE_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const parsed = setGlobalPauseRequestSchema.safeParse(await read(request))
      if (!parsed.success) return apiErrorResponse("bad_request")
      const c = state.controls
      state.controls = { ...c, globalPaused: parsed.data.paused, globalPausedAt: parsed.data.paused ? (c.globalPausedAt ?? NOW) : null }
      return respond(controlsSchema, state.controls)
    }),
    http.put(MONTHLY_CEILING_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const parsed = raiseCeilingRequestSchema.safeParse(await read(request))
      if (!parsed.success || parsed.data.month !== state.controls.spend.month) return apiErrorResponse("bad_request")
      const body = state.raise(parsed.data.ceiling, state.controls)
      if (body.result === "raised") state.controls = body.controls
      return respond(raiseCeilingResponseSchema, body)
    }),
    http.get("/v1/applications/:id/outcomes", ({ params }) =>
      respond(outcomesResponseSchema, { outcomes: state.outcomes.filter((o) => o.applicationId === params.id) })
    ),
    http.post("/v1/applications/:id/outcomes", async ({ request, params }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const parsed = outcomeRequestSchema.safeParse(await read(request))
      if (!parsed.success) return apiErrorResponse("bad_request")
      const app = findApp(params.id)
      if (app?.detailsDeletedAt) return apiErrorResponse("application_state_conflict")
      const outcome: Outcome = { id: outcomeId(), applicationId: String(params.id), type: parsed.data.type, source: "candidate", excerpt: null, createdAt: NOW, updatedAt: NOW }
      state.outcomes.push(outcome)
      return respond(outcomeSchema, outcome, 201)
    }),
    http.patch("/v1/outcomes/:id", async ({ request, params }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const parsed = outcomeRequestSchema.safeParse(await read(request))
      if (!parsed.success) return apiErrorResponse("bad_request")
      const outcome = state.outcomes.find((o) => o.id === params.id)
      if (!outcome) return apiErrorResponse("not_found")
      Object.assign(outcome, { type: parsed.data.type, updatedAt: NOW })
      return respond(outcomeSchema, outcome)
    }),
    http.post(DELETE_DETAILS_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const parsed = deleteDetailsRequestSchema.safeParse(await read(request))
      if (!parsed.success) return apiErrorResponse("bad_request")
      const apps = parsed.data.applicationIds.map(findApp)
      if (apps.some((a) => !a)) return apiErrorResponse("not_found")
      let deletedCount = 0
      for (const app of apps as ApplicationDetail[]) {
        if (app.detailsDeletedAt) continue
        deletedCount++
        const latest = state.outcomes.filter((o) => o.applicationId === app.id).at(-1)
        state.outcomes = state.outcomes.filter((o) => o.applicationId !== app.id)
        state.records.push({
          applicationId: app.id,
          company: app.company,
          applicationUrl: app.applicationUrl,
          requisitionId: app.requisitionId,
          createdAt: app.createdAt,
          detailsDeletedAt: NOW,
          finalStatus: latest?.type ?? app.state,
          deletedBy: "candidate",
        })
        // The api's deleteDetailsLocked clears the block fields; the keys are left out, not null (AC 8.4).
        Object.assign(
          app,
          applicationDetailSchema.parse({ ...app, roleTitle: null, documents: [], detailsDeletedAt: NOW, expiresOn: null, blockedClaim: null, blockedClaimCause: undefined, blockedClaimTerms: undefined, blockedClaimMoreTerms: undefined }),
        )
      }
      return respond(deleteDetailsResponseSchema, { deletedCount })
    }),
    http.get(MINIMAL_RECORDS_PATH, () => respond(minimalRecordsResponseSchema, { records: state.records })),
    http.get(RETENTION_PATH, () => respond(retentionResponseSchema, state.retention)),
    http.delete("/v1/minimal-records/:id", ({ request, params }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      requests.push({ method: "DELETE", path: new URL(request.url).pathname, body: null })
      const record = state.records.find((r) => r.applicationId === params.id)
      if (!record) return apiErrorResponse("not_found")
      state.records = state.records.filter((r) => r !== record)
      const index = state.applications.findIndex((a) => a.id === params.id)
      if (index >= 0) state.applications.splice(index, 1)
      return new HttpResponse(null, { status: 204 })
    }),
  ]
  return { state, requests, handlers }
}

export type ControlsApi = ReturnType<typeof createControlsApi>

/** Read-only defaults: no pause, nothing spent beyond hosting's share, no Outcomes or minimal records, nothing due for retention. */
export const freshControlsHandlers = createControlsApi().handlers.filter((_, i) => i === 0 || i === 3 || i === 7 || i === 8)
