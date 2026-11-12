import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common"
import { ACCESS_REQUEST_PATH, type AccessRequestFieldCode, type ApiErrorCode, type ApiErrorResponse } from "@eve/contracts"
import type { FastifyReply, FastifyRequest } from "fastify"
import pg from "pg"

import { API_ERROR_MESSAGES, ApiException } from "./api-exception.js"

/** Client errors Fastify or Nest raise before a handler runs, mapped to contract codes (CR-05). */
const CLIENT_ERROR_CODES: ReadonlyMap<number, ApiErrorCode> = new Map([
  [HttpStatus.BAD_REQUEST, "bad_request"],
  [HttpStatus.NOT_FOUND, "not_found"],
  [HttpStatus.PAYLOAD_TOO_LARGE, "payload_too_large"],
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type"],
])
import { SESSION_COOKIE, clearCookieOptions } from "../auth/cookies.js"

/** Codes that carry a Retry-After header: the 429s (contract v1.15.0, v1.16.0) and the 503 lock timeout (v1.15.2). */
const RETRY_AFTER_CODES: ReadonlySet<ApiErrorCode> = new Set([
  "too_many_requests",
  "rate_limited_ip",
  "rate_limited_global",
  "service_unavailable",
])

/** Codes whose body may carry `fieldErrors`: `bad_request`, and v1.27.0 the paste field codes and `employer_page_unreadable`. */
const FIELD_ERROR_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  "bad_request",
  "job_description_too_short",
  "job_description_too_long",
  "job_title_required",
  "job_title_too_long",
  "company_required",
  "company_too_long",
  "employer_page_unreadable",
])

/** Renders every error as the contract envelope. Never echoes internal details. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>()
    const request = host.switchToHttp().getRequest<FastifyRequest>()
    const { status, code } = isInvalidJsonOnAccessRequest(exception, request)
      ? { status: HttpStatus.BAD_REQUEST, code: "access_request_invalid" as const }
      : this.classify(exception, request?.dashboardSession?.candidateId)
    if (code === "unauthenticated" || code === "session_expired") {
      reply.clearCookie(SESSION_COOKIE, clearCookieOptions)
    }
    if (exception instanceof ApiException && RETRY_AFTER_CODES.has(code) && exception.retryAfterSeconds !== undefined) {
      void reply.header("retry-after", String(exception.retryAfterSeconds))
    }
    const reason = exception instanceof ApiException && code === "resume_unreadable" ? exception.reason : undefined
    const fields = code === "access_request_invalid" ? accessRequestFields(exception) : undefined
    const fieldErrors = exception instanceof ApiException && FIELD_ERROR_CODES.has(code) && exception.fieldErrors?.length ? [...exception.fieldErrors] : undefined
    const feature = exception instanceof ApiException && code === "feature_not_yet_available" ? exception.feature : undefined
    const currentVersion = exception instanceof ApiException && code === "preferences_stale" && exception.currentVersion !== undefined ? { currentVersion: exception.currentVersion } : {}
    const lockedUntil = exception instanceof ApiException && code === "timezone_change_rate_limited" && exception.timeZoneLockedUntil ? { timeZoneLockedUntil: exception.timeZoneLockedUntil.toISOString() } : {}
    const body: ApiErrorResponse = {
      error: {
        code,
        message: API_ERROR_MESSAGES[code],
        ...(reason ? { reason } : {}),
        ...(fields ? { fields } : {}),
        ...(fieldErrors ? { fieldErrors } : {}),
        ...(feature ? { feature } : {}),
        ...currentVersion,
        ...lockedUntil,
      },
    }
    reply.status(status).send(body)
  }

  private classify(exception: unknown, candidateId: string | undefined): { status: number; code: ApiErrorCode } {
    if (exception instanceof ApiException) {
      return { status: exception.getStatus(), code: exception.code }
    }
    const clientStatus = clientErrorStatus(exception)
    const clientCode = clientStatus === undefined ? undefined : CLIENT_ERROR_CODES.get(clientStatus)
    if (clientStatus !== undefined && clientCode !== undefined) {
      this.logger.debug?.(`Client error ${clientStatus}: ${clientCode}`)
      return { status: clientStatus, code: clientCode }
    }
    this.logger.error(withCandidate(describeServerError(exception), candidateId))
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: "internal_error" }
  }
}

/**
 * The 4xx status of an error a client caused: Nest's HttpException, or a Fastify
 * error carrying `statusCode` (malformed JSON, unsupported media type, body limit).
 */
function clientErrorStatus(exception: unknown): number | undefined {
  const status =
    exception instanceof HttpException
      ? exception.getStatus()
      : exception instanceof Error && "statusCode" in exception && typeof exception.statusCode === "number"
        ? exception.statusCode
        : undefined
  return status !== undefined && status >= 400 && status < 500 ? status : undefined
}

/**
 * Malformed JSON on the public route is a field error the dialog can map
 * (architecture.r1 7.3); elsewhere it stays `bad_request`. Nest's Fastify adapter
 * rewraps FST_ERR_CTP_INVALID_JSON_BODY as a plain 400 HttpException without the
 * code, so this matches any non-contract 400 on that route. The only other 400
 * source there (size) is answered by the transport gate before parsing.
 */
function isInvalidJsonOnAccessRequest(exception: unknown, request: FastifyRequest | undefined): boolean {
  return (
    request?.routeOptions?.url === ACCESS_REQUEST_PATH &&
    !(exception instanceof ApiException) &&
    clientErrorStatus(exception) === HttpStatus.BAD_REQUEST
  )
}

function accessRequestFields(exception: unknown): AccessRequestFieldCode[] {
  return exception instanceof ApiException && exception.fields ? [...exception.fields] : ["body.invalid_json"]
}

/**
 * The log line for a 500. Slice 8d (8d.12, SEC-803): a Postgres error is logged
 * by its SQLSTATE only (for example `57014` when the statement timeout cancels a
 * query). Its message can quote parameter values, and the SQL text and
 * parameters are never logged.
 */
export function describeServerError(exception: unknown): string {
  if (exception instanceof pg.DatabaseError) return `Database error ${exception.code ?? "unknown"}`
  return exception instanceof Error ? `${exception.name}: ${exception.message}` : "Unknown error"
}

/**
 * EPIC-0002 A2 (architecture r4 line 338, SEC-803): a 500 on an authenticated
 * request names the session's Candidate ID, so a query the api statement
 * timeout stopped can be traced to its Candidate. The ID is the only addition;
 * no request data is logged.
 */
export function withCandidate(line: string, candidateId: string | undefined): string {
  return candidateId === undefined ? line : `${line} for Candidate ${candidateId}`
}
