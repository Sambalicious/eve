/**
 * EPIC-0007 contract exports, the one place the web reads them from.
 * Phase 1 (contract v1.19.0) and Phase 3 (v1.20.0) both come from `@eve/contracts`.
 */
export {
  buildHiringSearchGroups,
  HIRING_SEARCH_INPUTS_PATH,
  hiringFamilies,
  hiringHintTerms,
  hiringSearchInputsResponseSchema,
  resolveHiringFamily,
  ROLE_FAMILY_HIRING_PHRASES,
  type HiringHintPreferences,
  type HiringHintTerm,
  type HiringSearchGroup,
  type HiringSearchInputsResponse,
} from "@eve/contracts"

export {
  apiErrorResponseSchema,
  HIRING_ALERT_FEED_LIMIT,
  HIRING_ALERT_FEEDS_PATH,
  HIRING_FEED_VERIFICATION_PATH,
  HIRING_POSTS_PATH,
  hiringAlertFeedsResponseSchema,
  hiringPostsResponseSchema,
  stackPostsFieldErrorSchema,
  type ApiErrorResponse,
  type ApiFieldError,
  type HiringAlertFeedsResponse,
  type HiringPostsResponse,
  type StackPostsFieldError,
} from "@eve/contracts"
