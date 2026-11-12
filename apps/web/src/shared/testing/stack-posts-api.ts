import {
  ALERT_FEED_LABEL_MAX,
  ALERT_FEED_LIMIT,
  ALERT_FEED_VERIFICATION_PATH,
  ALERT_FEEDS_PATH,
  alertFeedsResponseSchema,
  apiErrorResponseSchema,
  codePointLength,
  CSRF_HEADER,
  hasDisallowedControlCharacters,
  isAlertFeedUrl,
  isCalendarDate,
  maskAlertFeedUrl,
  registerAlertFeedResponseSchema,
  STACK_POSTS_PAGE_PATTERN,
  STACK_POSTS_PAGE_SIZE,
  STACK_POSTS_PATH,
  stackPostsResponseSchema,
  VERIFICATION_BASIS_MAX,
  type AlertFeedFailureReason,
  type AlertFeedsResponse,
  type ApiErrorResponse,
  type StackPost,
  type StackPostsFieldError,
} from "@eve/contracts"
import { http, HttpResponse, type JsonBodyType } from "msw"

import {
  apiErrorResponseSchema as phase3ErrorSchema,
  HIRING_ALERT_FEED_LIMIT,
  HIRING_ALERT_FEEDS_PATH,
  HIRING_FEED_VERIFICATION_PATH,
  HIRING_POSTS_PATH,
  hiringAlertFeedsResponseSchema,
  hiringPostsResponseSchema,
  type HiringAlertFeedsResponse,
  type StackPostsFieldError as Phase3FieldError,
} from "@/shared/lib/hiring-contracts"
import { apiErrorResponse, TEST_CSRF_TOKEN } from "./contract-handlers"

/** FEED_A from `alert-feeds.feature`; mask "…654321". */
export const FEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321"
/** FEED_B; mask "…222333". */
export const FEED_B = "https://www.google.com/alerts/feeds/01234567890123456789/1111111111111222333"
/** HFEED_A from EPIC-0007 `hiring-alert-feeds.feature`; mask "…123456". */
export const HFEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555123456"
/** HFEED_B; mask "…777888". */
export const HFEED_B = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555777888"
/** SFEED_A: a Stack posts Alert feed in the EPIC-0007 scenarios. */
export const SFEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321"

const NOW = "2026-10-21T13:00:00.000Z"
/** Today in WAT (UTC+1) at request time, for the future-date rule. */
const todayWat = () => new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10)

export interface StoredFeed {
  id: string
  url: string
  label: string | null
  createdAt: string
  lastReadAt: string | null
  failure: { reason: AlertFeedFailureReason; at: string } | null
}

export interface StoredPost extends Omit<StackPost, "source"> {
  /** Null: from a removed feed. */
  feedId: string | null
}

export interface StackPostsApiState {
  /**
   * EPIC-0008 (contract v1.22.0, D15): the session Candidate's own Stack posts permitted-use record.
   * Every Candidate, Operator or invitee, may PUT it; there is no role check and no 404. `feeds` can be
   * non-empty while this is null (feeds registered before EPIC-0008, OD-7).
   */
  verification: AlertFeedsResponse["verification"]
  feeds: StoredFeed[]
  posts: StoredPost[]
  /** What the one registration fetch finds: a reason refuses it, a number stores that many posts. */
  registrationFetch: AlertFeedFailureReason | { storedPosts: number }
  /**
   * v1.15.2 (SEC-E5F-04): how many of the next registrations that pass every check find the
   * storing transaction's lock wait timed out: 503 `service_unavailable`, `Retry-After: 5`, nothing stored.
   */
  registrationBusy: number
  /** EPIC-0007 Phase 3: the session Candidate's own permitted-use record for Hiring Alert feeds (D14). */
  hiringVerification: HiringAlertFeedsResponse["verification"]
  hiringFeeds: StoredFeed[]
  hiringPosts: StoredPost[]
  /** What the Hiring registration fetch finds. */
  hiringRegistrationFetch: AlertFeedFailureReason | { storedPosts: number }
  /**
   * v1.22.0 (OWN-1): the global pause flag both feeds responses (GET and the verification PUT) carry,
   * for every Candidate. Test helpers keep it equal to the controls fake's `globalPaused`.
   */
  globalPaused: boolean
}

let counter = 0
const uuid = (prefix: string) => `${prefix}-0000-4000-8000-${String(++counter).padStart(12, "0")}`

/** A stored feed row. */
export function storedFeed(overrides: Partial<StoredFeed> = {}): StoredFeed {
  return { id: uuid("a0000000"), url: FEED_A, label: "React posts", createdAt: NOW, lastReadAt: NOW, failure: null, ...overrides }
}

/** A stored Stack post (posts-list.feature "A row shows…"). */
export function storedPost(overrides: Partial<StoredPost> = {}): StoredPost {
  return {
    id: uuid("b0000000"),
    canonicalUrl: "https://www.linkedin.com/posts/ada-obi_react-activity-1-abcd",
    kind: "post",
    title: "Hooks in practice",
    snippet: "What we learned moving a large app to React hooks and TypeScript.",
    date: "2026-10-20T23:30:00.000Z",
    dateKind: "posted",
    matchedTechnologies: ["React", "TypeScript"],
    feedId: null,
    firstSeenAt: "2026-10-21T07:00:00.000Z",
    ...overrides,
  }
}

/** "bola@example.com"'s own permitted-use record from `hiring-alert-feeds.feature` (HAF:341). */
export const ownRecord21Oct = {
  verifiedOn: "2026-10-21",
  verificationBasis: "Read Google's terms for Alerts RSS on 21 Oct.",
  updatedAt: "2026-10-21T10:15:00.000Z",
}

/** The recorded verification from the Gherkin backgrounds. */
export const verifiedOn20Oct = {
  verifiedOn: "2026-10-20",
  verificationBasis: "Reviewed Google Alerts terms.",
  updatedAt: "2026-10-20T09:00:00.000Z",
}

function badRequest(fieldErrors?: StackPostsFieldError[]) {
  const body: ApiErrorResponse = {
    error: { code: "bad_request", message: "The request is not valid.", ...(fieldErrors?.length && { fieldErrors }) },
  }
  return HttpResponse.json(body, { status: 400 })
}

/** v1.15.2: a lock wait in the storing transaction timed out. `Retry-After` is a header only, never in the body. */
function busy() {
  const body = apiErrorResponseSchema.parse({ error: { code: "service_unavailable", message: SERVICE_UNAVAILABLE_MESSAGE } })
  return HttpResponse.json(body, { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } })
}

const SERVICE_UNAVAILABLE_MESSAGE = "The service is unavailable. Try again shortly."

const fe = (field: StackPostsFieldError["field"], problem: StackPostsFieldError["problem"]): StackPostsFieldError => ({
  field,
  position: null,
  problem,
})

/** EPIC-0007 Phase 3: `url / in_other_list`, parsed with the Phase 3 envelope before it is sent. */
function inOtherList() {
  const fieldError: Phase3FieldError = { field: "url", position: null, problem: "in_other_list" }
  const body = phase3ErrorSchema.parse({ error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [fieldError] } })
  return HttpResponse.json(body as JsonBodyType, { status: 400 })
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * An in-memory Stack posts API (contract v1.15.2): every JSON body is parsed
 * with the contract schema before it is sent, writes check the CSRF header,
 * and the registration check order is the contract's. Text rules come from the
 * shared `hasDisallowedControlCharacters` (v1.15.2: C1, bidi, U+200B, U+2060
 * and U+FEFF refused; ZWNJ, ZWJ and U+00A0 allowed). `registrationBusy` makes
 * the next registrations answer the v1.15.2 lock-timeout 503. Ordering of posts is
 * the contract's (date, first seen, id; all descending).
 *
 * EPIC-0008 (api-contract v1.22.0): the state is one session Candidate's. The
 * Stack posts PUT saves her own record with no role check (no 404), the
 * registration 409 reads only that record, and removal needs no record.
 *
 * EPIC-0007 Phase 3 (api-contract.r1.md): the Hiring routes keep their own
 * record, feeds and posts in the same state, so the cross-list check works both
 * ways: Hiring order is body → 409 (no own record) → limit → duplicate →
 * `in_other_list` → fetch; Stack posts gains `in_other_list` after duplicate.
 *
 * `options.globalPaused` reads the pause flag from elsewhere (the controls fake),
 * as the API reads one control state: a pause or resume through
 * `PUT /v1/controls/global-pause` then shows in the next feeds responses.
 * Without it, `state.globalPaused` answers.
 */
export function createStackPostsApi(initial: Partial<StackPostsApiState> = {}, options: { globalPaused?: () => boolean } = {}) {
  const state: StackPostsApiState = {
    verification: null,
    feeds: [],
    posts: [],
    registrationFetch: { storedPosts: 0 },
    registrationBusy: 0,
    hiringVerification: null,
    hiringFeeds: [],
    hiringPosts: [],
    hiringRegistrationFetch: { storedPosts: 0 },
    globalPaused: false,
    ...initial,
  }
  const pauseFlag = options.globalPaused ?? (() => state.globalPaused)
  const requests: { method: string; path: string; body: unknown }[] = []
  const respond = <T,>(schema: { parse: (input: unknown) => T }, body: T, status = 200) =>
    HttpResponse.json(schema.parse(body) as JsonBodyType, { status, headers: { "cache-control": "no-store" } })
  const csrfRefused = (request: Request) => request.headers.get(CSRF_HEADER) !== TEST_CSRF_TOKEN
  const record = async (request: Request) => {
    const body: unknown = request.method === "DELETE" ? null : await request.json().catch(() => undefined)
    const url = new URL(request.url)
    requests.push({ method: request.method, path: `${url.pathname}${url.search}`, body })
    return body
  }
  const toFeed = (feed: StoredFeed) => ({
    id: feed.id,
    label: feed.label,
    maskedUrl: maskAlertFeedUrl(feed.url),
    createdAt: feed.createdAt,
    lastReadAt: feed.lastReadAt,
    failure: feed.failure,
  })
  const feedsBody = (): AlertFeedsResponse => ({
    verification: state.verification,
    feeds: state.feeds.map(toFeed),
    limit: ALERT_FEED_LIMIT,
    globalPaused: pauseFlag(),
  })
  const hiringFeedsBody = (): HiringAlertFeedsResponse => ({
    verification: state.hiringVerification,
    feeds: state.hiringFeeds.map(toFeed),
    limit: HIRING_ALERT_FEED_LIMIT,
    globalPaused: pauseFlag(),
  })

  /** PUT body checks shared by both verification routes: every field error at once (api-contract.r1, PUT table). */
  const verificationErrors = (body: Record<string, unknown>): StackPostsFieldError[] => {
    const errors: StackPostsFieldError[] = []
    const { verifiedOn, verificationBasis } = body
    if (verifiedOn === undefined || verifiedOn === null || verifiedOn === "") errors.push(fe("verifiedOn", "missing"))
    else if (typeof verifiedOn !== "string" || !isCalendarDate(verifiedOn)) errors.push(fe("verifiedOn", "invalid"))
    else if (verifiedOn > todayWat()) errors.push(fe("verifiedOn", "future_date"))
    if (typeof verificationBasis !== "string" && verificationBasis !== undefined && verificationBasis !== null)
      errors.push(fe("verificationBasis", "invalid"))
    else if (typeof verificationBasis !== "string" || verificationBasis.trim() === "") errors.push(fe("verificationBasis", "missing"))
    else if (hasDisallowedControlCharacters(verificationBasis.trim(), { allowLineBreaks: true }))
      errors.push(fe("verificationBasis", "invalid_characters"))
    else if (codePointLength(verificationBasis.trim()) > VERIFICATION_BASIS_MAX) errors.push(fe("verificationBasis", "too_long"))
    return errors
  }

  /** Registration body checks shared by both lists (step 3): the URL, then the label, all at once. */
  const registrationErrors = (body: Record<string, unknown>): { errors: StackPostsFieldError[]; url: string; label: string | null } => {
    const errors: StackPostsFieldError[] = []
    const url = typeof body.url === "string" ? body.url.trim() : null
    if (url === null || !isAlertFeedUrl(url)) errors.push(fe("url", "invalid_format"))
    const rawLabel = body.label
    if (rawLabel !== undefined && rawLabel !== null && typeof rawLabel !== "string") errors.push(fe("label", "invalid"))
    else if (typeof rawLabel === "string" && hasDisallowedControlCharacters(rawLabel.trim(), { allowLineBreaks: false }))
      errors.push(fe("label", "invalid_characters"))
    else if (typeof rawLabel === "string" && codePointLength(rawLabel.trim()) > ALERT_FEED_LABEL_MAX) errors.push(fe("label", "too_long"))
    const label = typeof rawLabel === "string" && rawLabel.trim() !== "" ? rawLabel.trim() : null
    return { errors, url: url ?? "", label }
  }

  const page = <T,>(posts: StoredPost[], feeds: StoredFeed[], raw: string | null, schema: { parse: (input: unknown) => T }) => {
    if (raw !== null && !STACK_POSTS_PAGE_PATTERN.test(raw)) return badRequest([fe("page", "invalid")])
    const n = raw === null ? 1 : Number(raw)
    const sorted = [...posts].sort(
      (a, b) => b.date.localeCompare(a.date) || b.firstSeenAt.localeCompare(a.firstSeenAt) || b.id.localeCompare(a.id)
    )
    const items = sorted.slice((n - 1) * STACK_POSTS_PAGE_SIZE, n * STACK_POSTS_PAGE_SIZE).map(({ feedId, ...post }) => {
      const feed = feeds.find((f) => f.id === feedId)
      return { ...post, source: feed ? { label: feed.label, maskedUrl: maskAlertFeedUrl(feed.url) } : null }
    })
    const body: unknown = {
      items,
      page: n,
      pageSize: STACK_POSTS_PAGE_SIZE,
      totalCount: sorted.length,
      totalPages: Math.ceil(sorted.length / STACK_POSTS_PAGE_SIZE),
    }
    return respond(schema, schema.parse(body))
  }

  const handlers = [
    http.get(ALERT_FEEDS_PATH, async ({ request }) => {
      await record(request)
      return respond(alertFeedsResponseSchema, feedsBody())
    }),

    http.put(ALERT_FEED_VERIFICATION_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await record(request)
      if (!isObject(body) || Object.keys(body).some((k) => k !== "verifiedOn" && k !== "verificationBasis")) return badRequest()
      const errors = verificationErrors(body)
      if (errors.length > 0) return badRequest(errors)
      state.verification = {
        verifiedOn: String(body.verifiedOn),
        verificationBasis: String(body.verificationBasis).trim(),
        updatedAt: NOW,
      }
      return respond(alertFeedsResponseSchema, feedsBody())
    }),

    http.post(ALERT_FEEDS_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await record(request)
      if (!isObject(body) || Object.keys(body).some((k) => k !== "url" && k !== "label")) return badRequest()
      const { errors, url, label } = registrationErrors(body)
      if (errors.length > 0) return badRequest(errors)
      if (!state.verification) return apiErrorResponse("alert_feeds_not_verified")
      if (state.feeds.length >= ALERT_FEED_LIMIT) return badRequest([fe("url", "limit_reached")])
      if (state.feeds.some((f) => f.url === url)) return badRequest([fe("url", "duplicate")])
      // EPIC-0007 Phase 3 (api-contract.r1): after duplicate, before the fetch.
      if (state.hiringFeeds.some((f) => f.url === url)) return inOtherList()
      if (typeof state.registrationFetch === "string") return badRequest([fe("url", state.registrationFetch)])
      if (state.registrationBusy > 0) {
        state.registrationBusy -= 1
        return busy()
      }
      const feed = storedFeed({ url, label, createdAt: NOW, lastReadAt: NOW })
      state.feeds.push(feed)
      const stored = Array.from({ length: state.registrationFetch.storedPosts }, (_, i) =>
        storedPost({ feedId: feed.id, title: `Registration post ${i + 1}`, canonicalUrl: `https://www.linkedin.com/posts/reg-${feed.id}-${i}` })
      )
      state.posts.push(...stored)
      return respond(registerAlertFeedResponseSchema, { feed: { ...toFeed(feed), url: feed.url }, storedPosts: stored.length }, 201)
    }),

    http.delete(`${ALERT_FEEDS_PATH}/:id`, async ({ request, params }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      await record(request)
      state.feeds = state.feeds.filter((f) => f.id !== params.id)
      state.posts = state.posts.map((p) => (p.feedId === params.id ? { ...p, feedId: null } : p))
      return new HttpResponse(null, { status: 204, headers: { "cache-control": "no-store" } })
    }),

    http.get(STACK_POSTS_PATH, async ({ request }) => {
      await record(request)
      return page(state.posts, state.feeds, new URL(request.url).searchParams.get("page"), stackPostsResponseSchema)
    }),

    // ── EPIC-0007 Phase 3 (api-contract.r1.md): the session Candidate's own record, feeds and posts ──

    http.get(HIRING_ALERT_FEEDS_PATH, async ({ request }) => {
      await record(request)
      return respond(hiringAlertFeedsResponseSchema, hiringFeedsBody())
    }),

    http.put(HIRING_FEED_VERIFICATION_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await record(request)
      if (!isObject(body) || Object.keys(body).some((k) => k !== "verifiedOn" && k !== "verificationBasis")) return badRequest()
      const errors = verificationErrors(body)
      if (errors.length > 0) return badRequest(errors)
      state.hiringVerification = {
        verifiedOn: String(body.verifiedOn),
        verificationBasis: String(body.verificationBasis).trim(),
        updatedAt: NOW,
      }
      return respond(hiringAlertFeedsResponseSchema, hiringFeedsBody())
    }),

    http.post(HIRING_ALERT_FEEDS_PATH, async ({ request }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      const body = await record(request)
      if (!isObject(body) || Object.keys(body).some((k) => k !== "url" && k !== "label")) return badRequest()
      const { errors, url, label } = registrationErrors(body)
      if (errors.length > 0) return badRequest(errors)
      if (!state.hiringVerification) return apiErrorResponse("alert_feeds_not_verified")
      if (state.hiringFeeds.length >= HIRING_ALERT_FEED_LIMIT) return badRequest([fe("url", "limit_reached")])
      if (state.hiringFeeds.some((f) => f.url === url)) return badRequest([fe("url", "duplicate")])
      if (state.feeds.some((f) => f.url === url)) return inOtherList()
      if (typeof state.hiringRegistrationFetch === "string") return badRequest([fe("url", state.hiringRegistrationFetch)])
      if (state.registrationBusy > 0) {
        state.registrationBusy -= 1
        return busy()
      }
      const feed = storedFeed({ url, label, createdAt: NOW, lastReadAt: NOW })
      state.hiringFeeds.push(feed)
      const stored = Array.from({ length: state.hiringRegistrationFetch.storedPosts }, (_, i) =>
        storedPost({ feedId: feed.id, title: `Hiring post ${i + 1}`, canonicalUrl: `https://www.linkedin.com/posts/hiring-${feed.id}-${i}` })
      )
      state.hiringPosts.push(...stored)
      return respond(registerAlertFeedResponseSchema, { feed: { ...toFeed(feed), url: feed.url }, storedPosts: stored.length }, 201)
    }),

    http.delete(`${HIRING_ALERT_FEEDS_PATH}/:id`, async ({ request, params }) => {
      if (csrfRefused(request)) return apiErrorResponse("csrf_invalid")
      await record(request)
      state.hiringFeeds = state.hiringFeeds.filter((f) => f.id !== params.id)
      state.hiringPosts = state.hiringPosts.map((p) => (p.feedId === params.id ? { ...p, feedId: null } : p))
      return new HttpResponse(null, { status: 204, headers: { "cache-control": "no-store" } })
    }),

    http.get(HIRING_POSTS_PATH, async ({ request }) => {
      await record(request)
      return page(state.hiringPosts, state.hiringFeeds, new URL(request.url).searchParams.get("page"), hiringPostsResponseSchema)
    }),
  ]

  const requestsTo = (method: string, path: string) => requests.filter((r) => r.method === method && r.path.startsWith(path))
  return { state, handlers, requests, requestsTo }
}

export type StackPostsApi = ReturnType<typeof createStackPostsApi>
