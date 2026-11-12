import type { ConvertedFeature } from "@eve/contracts"

/**
 * EPIC-0002 A2: the routes behind ConvertedFeatureGuard (architecture r3/r4
 * "Fail closed before conversion"). Each is also a second case in the 404
 * registry (`cross-candidate.cases.ts`): the registry test fails when a route
 * carrying `@ConvertedFeature` is missing here, or one here lacks the decorator.
 */
export type GuardedRoute = Readonly<{ method: "GET" | "PUT" | "POST"; path: string; feature: ConvertedFeature }>

const APPLICATION_SUBMISSION_ACTIONS = ["sample", "sample/approve", "sample/reject", "queue", "mark-confirmed", "mark-not-submitted", "same-company/approve", "same-company/decline"] as const

export const GUARDED_ROUTES: readonly GuardedRoute[] = [
  { method: "GET", path: "/v1/submission/status", feature: "submission" },
  { method: "PUT", path: "/v1/submission/automatic", feature: "submission" },
  { method: "GET", path: "/v1/submissions", feature: "submission" },
  { method: "GET", path: "/v1/submissions/summary", feature: "submission" },
  { method: "GET", path: "/v1/samples", feature: "submission" },
  { method: "POST", path: "/v1/samples/prepare", feature: "submission" },
  { method: "GET", path: "/v1/applications/:id/submission", feature: "submission" },
  { method: "GET", path: "/v1/applications/:id/form-answers", feature: "submission" },
  ...APPLICATION_SUBMISSION_ACTIONS.map((action) => ({ method: "POST" as const, path: `/v1/applications/:id/${action}`, feature: "submission" as const })),
  { method: "GET", path: "/v1/notifications/status", feature: "notifications" },
  { method: "GET", path: "/v1/controls", feature: "spend" },
  { method: "PUT", path: "/v1/controls/global-pause", feature: "spend" },
  { method: "PUT", path: "/v1/controls/ceiling", feature: "spend" },
]

/** Negative cases: records and existing applications serve invitees (architecture r3, not guarded). */
export const UNGUARDED_CANDIDATE_ROUTES: readonly Readonly<{ method: "GET" | "POST"; path: string }>[] = [
  { method: "GET", path: "/v1/existing-applications" },
  { method: "POST", path: "/v1/existing-applications" },
  { method: "POST", path: "/v1/existing-applications/complete" },
  { method: "GET", path: "/v1/applications/:id/outcomes" },
  { method: "GET", path: "/v1/minimal-records" },
  { method: "POST", path: "/v1/applications/delete-details" },
  // v1.24.0 (AA-5): remove from queue answers 404 / 200 / 409 application_state_conflict, never feature_not_yet_available.
  { method: "POST", path: "/v1/applications/:id/remove-from-queue" },
]
