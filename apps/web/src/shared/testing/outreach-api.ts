import { delay, http, HttpResponse, type JsonBodyType } from "msw"

import {
  composeOutreachText,
  OUTREACH_KINDS,
  OUTREACH_KIND_SLUGS,
  outreachItemSchema,
  outreachResponseSchema,
  readerNameRequestSchema,
  validateReaderName,
  type OutreachItem,
  type OutreachKind,
  type OutreachResponse,
} from "@eve/contracts"

import { apiErrorResponse, TEST_CSRF_TOKEN } from "./contract-handlers"

/**
 * A stateful stand-in for the three EPIC-0014 outreach routes
 * (`api-contract.md` v1.31.0, section 11). Every JSON body is parsed with the
 * contract's own strict schemas before it is sent, so a fixture that drifts
 * from the contract fails the test.
 */

/** A Run stored as `running` for longer than this reads back as `interrupted` (4.1). */
export const STALE_RUN_MS = 10 * 60_000
const NOW = "2026-11-09T15:02:41.000Z"
/** A later Run writes at a later date, so 6.2 can tell Ready from stopped-without-cause. */
export const RUN_WRITTEN_AT = "2026-11-10T09:30:00.000Z"

/** The contract's example bodies (5.5). */
export const OUTREACH_BODIES: Record<OutreachKind, string> = {
  referral_request:
    "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd. Would you be open to referring me for the Senior Frontend Engineer role at Northwind Labs, with no pressure at all if the answer is no?",
  introduction:
    "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd. I cut the release cycle from 2 weeks to 3 days. Would you be open to a short conversation about the Senior Frontend Engineer role at Northwind Labs?",
  application_note:
    "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd. I mentored 6 junior developers.",
}

export function notWritten(kind: OutreachKind): OutreachItem {
  return {
    kind,
    status: "idle",
    readerName: null,
    text: null,
    profileVersion: null,
    writtenAt: null,
    lastFailure: null,
    firstFailedSentence: null,
  }
}

/** A Ready item: the server composes `text` from the name and the body (7.4). */
export function readyItem(
  kind: OutreachKind,
  options: {
    readerName?: string | null
    body?: string
    profileVersion?: number | null
    writtenAt?: string | null
  } = {}
): OutreachItem {
  const readerName = options.readerName ?? null
  const body = options.body ?? OUTREACH_BODIES[kind]
  return {
    ...notWritten(kind),
    readerName,
    text: composeOutreachText({ kind, readerName, body }),
    profileVersion: options.profileVersion ?? 1,
    writtenAt: options.writtenAt ?? NOW,
  }
}

/** A Ready item that keeps its text plus a last-Run cause. */
export function readyWithCause(kind: OutreachKind, cause: string, extra: Partial<OutreachItem> = {}): OutreachItem {
  return { ...readyItem(kind, extra), ...extra, kind, lastFailure: cause }
}

/** A blocked Run, with or without a stored sentence and with or without an earlier text. */
export function blockedItem(kind: OutreachKind, sentence: string | null, extra: Partial<OutreachItem> = {}): OutreachItem {
  return { ...notWritten(kind), ...extra, kind, lastFailure: "blocked", firstFailedSentence: sentence }
}

export type OutreachOutcome =
  /** A successful Run: a new text, version and date, and no cause. */
  | { status: "ready"; body?: string; profileVersion?: number; writtenAt?: string }
  /** A Run that dropped sentences but still wrote a text: no trace (invariant I5). */
  | { status: "ready-after-drop"; body?: string }
  /** `blocked`, with or without a stored first failed sentence. */
  | { status: "blocked"; sentence?: string | null }
  /** Any other cause; a sentence is ignored unless the cause is `blocked`. */
  | { status: "cause"; cause: string; sentence?: string | null }
  /** Stopped by a pause: nothing changes and no cause is stored. */
  | { status: "paused" }
  | { status: "cost-paused" }

export interface OutreachScriptEntry {
  outcome: OutreachOutcome
  /** GETs after the 202 before the outcome lands. Default 1. */
  pollsUntilDone?: number
}

export type OutreachApiFailure =
  /** `GET` answers 401 `unauthenticated`. */
  | { kind: "signed-out" }
  /** `GET` answers 500 `internal_error` every time (the first read fails). */
  | { kind: "load-error" }
  /** The `after`th GET fails with 500, then reads recover (a failed background poll). */
  | { kind: "poll-error"; after?: number }
  /** `POST` fails at the network layer (`HttpResponse.error()`). */
  | { kind: "write-network-error" }
  /** `POST` answers 500 `internal_error`. */
  | { kind: "write-server-error" }
  /** `PUT` fails at the network layer. */
  | { kind: "name-network-error" }
  /** `PUT` answers 500 `internal_error`. */
  | { kind: "name-server-error" }
  /** Every route answers 403 `csrf_invalid`. */
  | { kind: "csrf" }
  /** Every route answers 404 `not_found`: another Candidate's Application, a missing id, or deleted details. */
  | { kind: "not-found" }

export interface OutreachApiOptions {
  /** Items not given read as Not written. A body composes the text with the item's name. */
  items?: Partial<Record<OutreachKind, Partial<OutreachItem> & { body?: string }>>
  approvedProfileVersion?: number | null
  /** The queue of outcomes the next `POST` for that kind produces. */
  script?: Partial<Record<OutreachKind, OutreachScriptEntry[]>>
  failure?: OutreachApiFailure
  /** How long the first read is held back, so a test can see the loading state. */
  getDelayMs?: number
  /** How long ago a `running` item started, in ms (default 0). */
  runningFor?: Partial<Record<OutreachKind, number>>
  now?: () => number
}

interface PendingRun {
  outcome: OutreachOutcome
  pollsUntilDone: number
  seen: number
}

export function createOutreachApi(options: OutreachApiOptions = {}) {
  const now = options.now ?? (() => Date.now())
  const state: {
    items: Record<OutreachKind, OutreachItem>
    bodies: Partial<Record<OutreachKind, string>>
    approvedProfileVersion: number | null
    script: Partial<Record<OutreachKind, OutreachScriptEntry[]>>
    failure: OutreachApiFailure | null
    runningSince: Partial<Record<OutreachKind, number>>
    pending: Partial<Record<OutreachKind, PendingRun>>
    gets: number
  } = {
    items: {} as Record<OutreachKind, OutreachItem>,
    bodies: {},
    approvedProfileVersion: options.approvedProfileVersion === undefined ? 1 : options.approvedProfileVersion,
    script: options.script ?? {},
    failure: options.failure ?? null,
    runningSince: {},
    pending: {},
    gets: 0,
  }
  for (const kind of OUTREACH_KINDS) {
    const given = options.items?.[kind]
    if (given?.body !== undefined && given.text === undefined) {
      const readerName = given.readerName === undefined ? null : given.readerName
      state.bodies[kind] = given.body
      state.items[kind] = readyItem(kind, { ...given, readerName, body: given.body })
      continue
    }
    if (given?.text !== undefined && given.text !== null) state.bodies[kind] = undefined
    state.items[kind] = { ...notWritten(kind), ...given }
    if (state.items[kind].text !== null) {
      state.bodies[kind] = bodyOf(kind, state.items[kind].text, state.items[kind].readerName)
    }
    if (state.items[kind].status === "running") {
      state.runningSince[kind] = now() - (options.runningFor?.[kind] ?? 0)
    }
  }

  const requests: { method: string; path: string; body: unknown }[] = []

  const record = (request: Request, body: unknown = null) =>
    requests.push({ method: request.method, path: new URL(request.url).pathname, body })

  const respond = <T,>(parse: (body: unknown) => T, body: unknown, status = 200) =>
    HttpResponse.json(parse(body) as JsonBodyType, { status, headers: { "cache-control": "no-store" } })

  const respondItem = (item: OutreachItem, status = 200) => respond((body) => outreachItemSchema.parse(body), item, status)
  const respondResponse = (body: OutreachResponse) => respond((value) => outreachResponseSchema.parse(value), body)

  /** 2: every response, success or error, sends `cache-control: no-store`. */
  const fail = (code: Parameters<typeof apiErrorResponse>[0]) => {
    const response = apiErrorResponse(code)
    response.headers.set("cache-control", "no-store")
    return response
  }

  const csrfRefused = (request: Request) => request.headers.get("x-csrf-token") !== TEST_CSRF_TOKEN

  /** v1.31.0: 422 with the contract's own code and message (`outreach_reader_name_invalid`). */
  const readerNameInvalid = () => fail("outreach_reader_name_invalid")

  const kindOf = (slug: string | readonly string[] | undefined): OutreachKind | null =>
    OUTREACH_KINDS.find((kind) => OUTREACH_KIND_SLUGS[kind] === slug) ?? null

  const isStale = (kind: OutreachKind) => {
    const since = state.runningSince[kind]
    return state.items[kind].status === "running" && since !== undefined && now() - since > STALE_RUN_MS
  }

  /** 4.1: a stale `running` row reads as `idle` with `interrupted`, text fields as stored. */
  const readItem = (kind: OutreachKind): OutreachItem =>
    isStale(kind)
      ? { ...state.items[kind], status: "idle", lastFailure: "interrupted", firstFailedSentence: null }
      : state.items[kind]

  const applyOutcome = (kind: OutreachKind, outcome: OutreachOutcome) => {
    const item = state.items[kind]
    const done = (next: Partial<OutreachItem>) => {
      state.items[kind] = { ...item, ...next, kind, status: "idle" }
      delete state.runningSince[kind]
    }
    switch (outcome.status) {
      case "ready":
      case "ready-after-drop": {
        const body = outcome.body ?? OUTREACH_BODIES[kind]
        state.bodies[kind] = body
        done({
          text: composeOutreachText({ kind, readerName: item.readerName, body }),
          profileVersion: outcome.status === "ready" ? (outcome.profileVersion ?? 1) : (item.profileVersion ?? 1),
          writtenAt: outcome.status === "ready" ? (outcome.writtenAt ?? RUN_WRITTEN_AT) : RUN_WRITTEN_AT,
          lastFailure: null,
          firstFailedSentence: null,
        })
        return
      }
      case "blocked":
        done({ lastFailure: "blocked", firstFailedSentence: outcome.sentence ?? null })
        return
      case "cause":
        done({ lastFailure: outcome.cause, firstFailedSentence: outcome.cause === "blocked" ? (outcome.sentence ?? null) : null })
        return
      case "paused":
      case "cost-paused":
        done({ lastFailure: null, firstFailedSentence: null })
        return
    }
  }

  /** Each GET after a `202` counts down its Run, so the poll cadence is what a test drives. */
  const advanceRuns = () => {
    for (const kind of OUTREACH_KINDS) {
      const pending = state.pending[kind]
      if (pending === undefined) continue
      pending.seen += 1
      if (pending.seen < pending.pollsUntilDone) continue
      delete state.pending[kind]
      applyOutcome(kind, pending.outcome)
    }
  }

  const handlers = [
    http.get("/v1/applications/:id/outreach", async ({ request }) => {
      record(request)
      state.gets += 1
      const failure = state.failure
      if (failure?.kind === "signed-out") return fail("unauthenticated")
      if (failure?.kind === "not-found") return fail("not_found")
      if (failure?.kind === "load-error") return fail("internal_error")
      if (failure?.kind === "poll-error" && state.gets === (failure.after ?? 1) + 1) {
        return fail("internal_error")
      }
      advanceRuns()
      const body = { items: OUTREACH_KINDS.map(readItem), approvedProfileVersion: state.approvedProfileVersion }
      if (options.getDelayMs !== undefined) await delay(options.getDelayMs)
      return respondResponse(body)
    }),

    http.post("/v1/applications/:id/outreach/:kind/write", async ({ request, params }) => {
      const body = await request.json().catch(() => undefined)
      record(request, body)
      const failure = state.failure
      if (failure?.kind === "csrf" || csrfRefused(request)) return fail("csrf_invalid")
      if (failure?.kind === "not-found") return fail("not_found")
      if (failure?.kind === "write-network-error") return HttpResponse.error()
      if (failure?.kind === "write-server-error") return fail("internal_error")
      const kind = kindOf(params.kind)
      if (kind === null) return fail("not_found")
      // A second request while a Run is in flight starts nothing and consumes no script (4.2).
      if (state.items[kind].status === "running" && !isStale(kind)) return respondItem(readItem(kind), 202)
      const claimed: OutreachItem = {
        ...state.items[kind],
        status: "running",
        lastFailure: null,
        firstFailedSentence: null,
      }
      state.items[kind] = claimed
      state.runningSince[kind] = now()
      delete state.pending[kind]
      const next = state.script[kind]?.shift()
      if (next !== undefined) {
        state.pending[kind] = { outcome: next.outcome, pollsUntilDone: next.pollsUntilDone ?? 1, seen: 0 }
      }
      return respondItem(claimed, 202)
    }),

    http.put("/v1/applications/:id/outreach/:kind/reader-name", async ({ request, params }) => {
      const raw = await request.json().catch(() => undefined)
      record(request, raw)
      const failure = state.failure
      if (failure?.kind === "csrf" || csrfRefused(request)) return fail("csrf_invalid")
      if (failure?.kind === "not-found") return fail("not_found")
      if (failure?.kind === "name-network-error") return HttpResponse.error()
      if (failure?.kind === "name-server-error") return fail("internal_error")
      const kind = kindOf(params.kind)
      if (kind === null) return fail("not_found")
      let readerName: string | null
      try {
        readerName = readerNameRequestSchema.parse(raw).readerName
      } catch {
        return fail("bad_request")
      }
      const validated = validateReaderName(readerName)
      if (!validated.ok) return readerNameInvalid()
      const item = state.items[kind]
      const body = state.bodies[kind]
      const text =
        item.text === null
          ? null
          : body !== undefined
            ? composeOutreachText({ kind, readerName: validated.value, body })
            : item.text
      // The stored sentence is nulled when the new name occurs in it (whole word, case-folded).
      const sentence = item.firstFailedSentence
      const newName = validated.value
      const clears = sentence !== null && newName !== null && wholeWordOccurs(sentence, newName)
      const next: OutreachItem = {
        ...item,
        readerName: validated.value,
        text,
        firstFailedSentence: clears ? null : sentence,
      }
      state.items[kind] = next
      return respondItem(next)
    }),
  ]

  /** Backdate a `running` item past the 10-minute rule, as a failed recovery would leave it. */
  const expireRun = (kind: OutreachKind) => {
    state.runningSince[kind] = now() - STALE_RUN_MS - 1
  }

  /** Make a Run finish at the next GET, so a test can measure the 2,000 ms poll. */
  const finishOnNextPoll = (kind: OutreachKind, outcome: OutreachOutcome) => {
    state.pending[kind] = { outcome, pollsUntilDone: 1, seen: 0 }
  }

  return { state, requests, handlers, expireRun, finishOnNextPoll }
}

export type OutreachApi = ReturnType<typeof createOutreachApi>

function wholeWordOccurs(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^\\p{L}])${escaped}([^\\p{L}]|$)`, "iu").test(haystack)
}

/** The body under the stored greeting, so a `PUT` can recompose the text (7.4). */
function bodyOf(kind: OutreachKind, text: string, readerName: string | null): string {
  if (readerName !== null) {
    const greeting = `Hi ${readerName},\n\n`
    if (text.startsWith(greeting)) return text.slice(greeting.length)
  }
  if (kind !== "application_note" && text.startsWith("Hello,\n\n")) return text.slice("Hello,\n\n".length)
  return text
}

/** Read-only defaults: three Not written items and an approved version of 1. */
export const freshOutreachHandlers = createOutreachApi().handlers
