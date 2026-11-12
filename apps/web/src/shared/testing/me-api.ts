import {
  ME_ADVANCED_PATH,
  ME_PATH,
  meNoteSchema,
  meResponseSchema,
  setAdvancedRequestSchema,
  type MeResponse,
} from "@eve/contracts"
import { delay, http, HttpResponse } from "msw"

import { apiErrorResponse, TEST_CSRF_TOKEN } from "./contract-handlers"

const CANDIDATE_ID = "5f1e7c2a-1111-4a2b-8c3d-000000000002"

/** `GET /v1/me` fixtures (contract v1.28.0 MSW handlers). The default is the Operator with Advanced on, so existing automation screens keep rendering. */
export function meBody(overrides: Partial<MeResponse> = {}): MeResponse {
  const operator = overrides.isOperator ?? true
  const available = operator ? "available" : "not_yet"
  return meResponseSchema.parse({
    candidateId: CANDIDATE_ID,
    email: operator ? "tolu@example.com" : "bisi@example.com",
    isOperator: operator,
    capabilities: { submission: available, notifications: available, spend: available },
    advancedEnabled: operator,
    advancedLocked: false,
    simplerNoteDue: false,
    improveListDismissed: false,
    ...overrides,
  })
}

export const operatorMe = (overrides: Partial<MeResponse> = {}) => meBody({ isOperator: true, advancedEnabled: true, ...overrides })
/** An existing invitee at upgrade: Advanced off, the simpler note due. */
export const inviteeMe = (overrides: Partial<MeResponse> = {}) =>
  meBody({ isOperator: false, advancedEnabled: false, simplerNoteDue: true, ...overrides })
/** A new invitee: all four flags false. */
export const newInviteeMe = (overrides: Partial<MeResponse> = {}) =>
  meBody({ isOperator: false, advancedEnabled: false, simplerNoteDue: false, ...overrides })

export interface MeApi {
  state: { me: MeResponse; failWrites: boolean }
  /** Request log: `PUT` and `POST` calls, in order. */
  writes: string[]
  handlers: ReturnType<typeof http.get>[]
}

/** A stateful stand-in for `GET /v1/me`, `PUT /v1/me/advanced` and the note dismissals. */
export function createMeApi(initial: MeResponse = operatorMe(), options: { delayMs?: number; failRead?: boolean } = {}): MeApi {
  const state = { me: initial, failWrites: false }
  const writes: string[] = []
  const csrfOk = (request: Request) => request.headers.get("x-csrf-token") === TEST_CSRF_TOKEN
  const handlers = [
    http.get(ME_PATH, async () => {
      if (options.delayMs) await delay(options.delayMs)
      if (options.failRead) return apiErrorResponse("internal_error")
      return HttpResponse.json(state.me, { headers: { "cache-control": "no-store" } })
    }),
    http.put(ME_ADVANCED_PATH, async ({ request }) => {
      if (!csrfOk(request)) return apiErrorResponse("csrf_invalid")
      const parsed = setAdvancedRequestSchema.safeParse(await request.json().catch(() => null))
      if (!parsed.success) return apiErrorResponse("bad_request")
      if (state.failWrites) return apiErrorResponse("internal_error")
      if (!parsed.data.enabled && state.me.advancedLocked) return apiErrorResponse("advanced_locked")
      writes.push(`advanced:${parsed.data.enabled}`)
      state.me = { ...state.me, advancedEnabled: parsed.data.enabled }
      return HttpResponse.json(state.me)
    }),
    http.post("/v1/me/notes/:note/dismiss", ({ request, params }) => {
      if (!csrfOk(request)) return apiErrorResponse("csrf_invalid")
      const note = meNoteSchema.safeParse(params.note)
      if (!note.success) return apiErrorResponse("not_found")
      writes.push(`dismiss:${note.data}`)
      state.me =
        note.data === "simpler_now" ? { ...state.me, simplerNoteDue: false } : { ...state.me, improveListDismissed: true }
      return HttpResponse.json(state.me)
    }),
  ]
  return { state, writes, handlers } as unknown as MeApi
}

/** Default for every test: the Operator with Advanced on. */
export const freshMeHandlers = createMeApi().handlers
