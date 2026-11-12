import { hasErrorCode } from "@/shared/api"

/** A 409 `feature_not_yet_available`: the API says this account can't use the feature yet. Not a failure to retry. */
export function isNotYetAvailable(error: unknown): boolean {
  return hasErrorCode(error, "feature_not_yet_available")
}
