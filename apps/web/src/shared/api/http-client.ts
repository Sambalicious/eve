import {
  CSRF_HEADER,
  type AccessRequestFieldCode,
  type ApiErrorCode,
  type ResumeRefusalReason,
} from "@eve/contracts"

// EPIC-0007 Phase 3: the envelope accepts the `in_other_list` field problem (contract shim until v1.20.0).
import { apiErrorResponseSchema, type ApiFieldError } from "@/shared/lib/hiring-contracts"

/**
 * An error response from the API. `code` is null when the body is not the
 * contract envelope. `reason` is the contract's refusal reason, sent only with
 * `resume_unreadable` (v1.3.0); null otherwise. `fields` lists the field codes
 * sent with `access_request_invalid` (v1.16.0); empty otherwise.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode | null
  readonly reason: ResumeRefusalReason | null
  readonly fields: readonly AccessRequestFieldCode[]
  /** v1.13.0/v1.14.0: field-level problems on `bad_request` from the Job criteria PUT or a Stack posts route; empty otherwise. */
  readonly fieldErrors: readonly ApiFieldError[]

  constructor(
    status: number,
    code: ApiErrorCode | null,
    message: string,
    reason: ResumeRefusalReason | null = null,
    fields: readonly AccessRequestFieldCode[] = [],
    fieldErrors: readonly ApiFieldError[] = []
  ) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.reason = reason
    this.fields = fields
    this.fieldErrors = fieldErrors
  }
}

/**
 * A state-changing request. It carries the CSRF token and at most one body:
 * `json` is sent as `application/json`; `formData` as multipart, with the
 * boundary chosen by the browser.
 */
type MutationRequest = {
  method: "POST" | "PUT" | "PATCH" | "DELETE"
  csrfToken: string
} & ({ json?: never; formData?: never } | { json: unknown } | { formData: FormData })

type ApiRequest = { method?: "GET" } | MutationRequest

/**
 * Sends a request to the API on the dashboard's own origin, with the session
 * cookie, and returns the response when it is a success. Any other status
 * becomes an `ApiError`. State-changing methods carry the CSRF token.
 */
export async function apiRequest(
  path: string,
  request: ApiRequest = {}
): Promise<Response> {
  const response = await fetch(new URL(path, window.location.origin), {
    method: request.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: buildHeaders(request),
    body: buildBody(request),
  })
  if (!response.ok) throw await toApiError(response)
  return response
}

const PUBLIC_TIMEOUT_MS = 15_000

/**
 * A request to a public endpoint (v1.16.0, `/v1/public/*`): no session cookie,
 * so a stored request is never linked to an account, and no CSRF header. The
 * browser adds `Origin` itself. Gives up after `timeoutMs` (a `TimeoutError`).
 */
export async function publicRequest(
  path: string,
  request: { method?: "GET" | "POST"; json?: unknown; timeoutMs?: number } = {}
): Promise<Response> {
  const headers = new Headers({ accept: "application/json" })
  if (request.json !== undefined) headers.set("content-type", "application/json")
  const response = await fetch(new URL(path, window.location.origin), {
    method: request.method ?? "GET",
    credentials: "omit",
    cache: "no-store",
    headers,
    body: request.json === undefined ? undefined : JSON.stringify(request.json),
    signal: AbortSignal.timeout(request.timeoutMs ?? PUBLIC_TIMEOUT_MS),
  })
  if (!response.ok) throw await toApiError(response)
  return response
}

/** True for the 401 the API returns when there is no valid session. */
export function isUnauthorizedError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401
}

/** True when the API refused the request with this contract error code. */
export function hasErrorCode(error: unknown, code: ApiErrorCode): error is ApiError {
  return error instanceof ApiError && error.code === code
}

function buildHeaders(request: ApiRequest): Headers {
  const headers = new Headers({ accept: "application/json" })
  if ("csrfToken" in request) headers.set(CSRF_HEADER, request.csrfToken)
  if ("json" in request && request.json !== undefined) {
    headers.set("content-type", "application/json")
  }
  return headers
}

function buildBody(request: ApiRequest): BodyInit | undefined {
  if ("formData" in request && request.formData) return request.formData
  if ("json" in request && request.json !== undefined) return JSON.stringify(request.json)
  return undefined
}

async function toApiError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null)
  const envelope = apiErrorResponseSchema.safeParse(body)
  if (!envelope.success) {
    return new ApiError(response.status, null, `HTTP ${response.status}`)
  }
  const { code, message, reason, fields, fieldErrors } = envelope.data.error
  return new ApiError(response.status, code, message, reason ?? null, fields ?? [], fieldErrors ?? [])
}
