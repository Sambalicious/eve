import type { Logger } from "@nestjs/common"

/**
 * The `.catch` handler for a fire-and-forget call that must never throw: the
 * call still swallows its failure, but the failure is no longer silent.
 *
 * The line names the label and the error's class only. A message, a stack, a
 * payload or a driver's SQL text can quote a value, a parameter, a token or
 * PII, so none of them are logged (the same care `describeServerError` takes
 * for a 500 in `api-exception.filter.ts`).
 */
export function swallowAndLog(logger: Pick<Logger, "warn">, label: string): (error: unknown) => undefined {
  return (error: unknown) => {
    logger.warn(`${label} failed: ${errorName(error)}`)
    return undefined
  }
}

/** The error's class name, or "non-error" for anything thrown that is not an Error. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "non-error"
}
