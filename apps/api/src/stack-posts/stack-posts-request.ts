import { Inject, Injectable, type PipeTransform } from "@nestjs/common"
import { type AlertFeedVerificationRequest, alertFeedVerificationRequestSchema } from "@eve/contracts"

import { ApiException } from "../http/api-exception.js"
import type { RequestRefusal } from "../http/zod-request.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { watDay } from "../submission/wat-day.js"
import { parsePage, registrationFieldErrors, verificationFieldErrors } from "./field-errors.js"

/**
 * How the Stack posts and Hiring routes refuse their input. Each answers the `400 bad_request` the handlers
 * built by hand: with every bad field named when the body is an object with known keys, a plain 400 otherwise.
 */

/** `?page=`: omitted is page 1; anything else that is not a plain positive integer is a `page` field error. */
export function pageOrRefuse(raw: unknown): number {
  const page = parsePage(raw)
  if (page === null) throw ApiException.badRequestWithFieldErrors([{ field: "page", position: null, problem: "invalid" }])
  return page
}

/** A registration the schema refused: name each bad field of the raw body. */
export const refuseRegistration: RequestRefusal = (body) => ApiException.badRequestWithFieldErrors(registrationFieldErrors(body))

/**
 * The verification PUT body (CR-E5-01): the future-date rule sits with the other field rules, so one 400 lists every
 * bad field. The latest date is today in WAT, which needs the clock, so this pipe is injected rather than built from a schema alone.
 */
@Injectable()
export class VerificationBodyPipe implements PipeTransform<unknown, Promise<AlertFeedVerificationRequest>> {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async transform(body: unknown): Promise<AlertFeedVerificationRequest> {
    await Promise.resolve() // as ZodRequestPipe: a path-parameter pipe answers first
    const fieldErrors = verificationFieldErrors(body, watDay(this.clock.now()))
    const parsed = alertFeedVerificationRequestSchema.safeParse(body)
    if (!parsed.success || fieldErrors.length > 0) throw ApiException.badRequestWithFieldErrors(fieldErrors)
    return parsed.data
  }
}
