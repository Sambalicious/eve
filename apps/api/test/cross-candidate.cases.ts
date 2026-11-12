/**
 * EPIC-0002 cross-Candidate 404 registry (architecture r4, "Endpoint 404
 * registry"; r5-addendum "Routes added to the 404 registry"). One entry per
 * authenticated route: the case that proves Candidate B cannot read or change
 * Candidate A's data through it.
 *
 * Slice A2 covers every authenticated route. `cross-candidate.int-spec.ts`
 * enumerates Nest's route table at boot and fails when an authenticated route
 * has no entry here, an entry names a route that does not exist, or a route is
 * in neither this registry nor PUBLIC_ROUTES. A route carrying
 * `@ConvertedFeature` needs `guarded` set here and an entry in
 * `converted-feature.cases.ts` (its second case, 409 before conversion).
 *
 * `kind` picks the generic check `cross-candidate-registry.int-spec.ts` runs:
 * - `foreign-id`: B sends A's resource ID (`:id` or in the body). The status and
 *   body equal those for an ID that never existed (404, or 204 for R5-2), and
 *   A's rows are byte-equal afterwards.
 * - `own-scope`: no ID. B's response holds none of A's sentinel strings, and A's
 *   rows are byte-equal afterwards.
 * - `operator-only`: B gets 404 and A's rows are byte-equal.
 * - `session`: acts only on the caller's own session (`/v1/session`, logout, `/v1/me`).
 * `named` entries have a dedicated case in `cross-candidate.int-spec.ts` instead
 * of (or in addition to) the generic one.
 */
import { ANTHROPIC_TERMS, DEFAULT_ROLE_FAMILY_TIERS } from "@eve/contracts"

export type Method = "GET" | "PUT" | "POST" | "DELETE" | "PATCH"
export type RegistryKind = "foreign-id" | "own-scope" | "operator-only" | "session"
export type ForeignResource = "application" | "outcome" | "minimal-record" | "approved-answer" | "posting" | "alert-feed" | "hiring-feed" | "career-profile-version"

export type RegistryCase = Readonly<{
  method: Method
  path: string
  kind: RegistryKind
  proof: string
  /** foreign-id: which of A's resources B names. */
  resource?: ForeignResource
  /** foreign-id with the ID in the body: builds the body from A's ID. */
  body?: (foreignId: string) => unknown
  /** Body for own-scope writes: valid enough to reach the handler. */
  send?: unknown
  /** Expected status for B's foreign call when it is not 404 (R5-2: 204). */
  status?: number
  /** Behind ConvertedFeatureGuard: the second case is the 409 in converted-feature.cases.ts. */
  guarded?: true
  /** Proved by a dedicated case in cross-candidate.int-spec.ts. */
  named?: true
}>

/** EPIC-0003 (public-routes.int-spec.ts): unauthenticated routes, outside sign-in and this registry. */
export const PUBLIC_ROUTES: readonly string[] = [
  "GET /v1/auth/google/callback",
  "GET /v1/auth/google/start",
  "GET /v1/health",
  "GET /v1/public/access-requests/proof",
  "POST /v1/public/access-requests",
]

const VALID_OUTCOME = { type: "confirmation" }
/** A valid `PUT /v1/me/preferences` values object for B (Kenya), holding none of A's values. */
const B_PREFERENCES = {
  homeCountry: "KE",
  timeZone: "Africa/Nairobi",
  latestWorkHour: "23:00",
  workAuthorizedCountries: ["KE"],
  remoteAccepted: true,
  relocationAccepted: true,
  sponsorshipNeededForRelocation: true,
  excludedRelocationCountries: [],
  excludedIndustries: [],
  payFloor: { amount: "4000.00", currency: "EUR", period: "month", basis: "gross" },
  preferredPay: { amount: "5500.00", currency: "EUR", period: "month", basis: "net" },
  roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS },
  titleKeyword: null,
  seniorityLevels: ["junior", "mid", "senior", "staff", "principal"],
  employmentTypes: ["direct", "employer_of_record", "contract"],
  dailyCap: 3,
  emphasisThemes: [],
}
const SUBMISSION_ACTIONS = ["sample", "sample/approve", "sample/reject", "queue", "mark-confirmed", "mark-not-submitted", "same-company/approve", "same-company/decline"] as const
const REASON_ACTIONS = new Set<string>(["sample/reject", "same-company/decline"])

export const CROSS_CANDIDATE_CASES: readonly RegistryCase[] = [
  // ── Session and identity ────────────────────────────────────────────
  { method: "GET", path: "/v1/session", kind: "session", proof: "returns the caller's own CSRF token only" },
  { method: "POST", path: "/v1/auth/logout", kind: "session", proof: "ends the caller's own session; A's session still works" },
  { method: "GET", path: "/v1/me", kind: "session", proof: "B's ID, email and capabilities; none of A's" },

  // ── r5 routes and Job Postings (A1) ─────────────────────────────────
  { method: "GET", path: "/v1/candidate-settings/job-criteria", kind: "own-scope", proof: "B's body holds B's values, none of A's", named: true },
  { method: "PUT", path: "/v1/candidate-settings/job-criteria", kind: "own-scope", proof: "B's save changes B's row only; A's row and version are byte-equal", named: true },
  { method: "GET", path: "/v1/stack-posts", kind: "own-scope", proof: "B's page and totalCount count B's posts only", named: true },
  // EPIC-0008 (owner decisions D12, D15; supersede r5 K6 and D24): each Candidate has their own Stack posts
  // verification. The PUT has no role check and writes only the caller's row, so it runs the generic own-scope
  // check (A's sentinel-marked row stays byte-equal) as well as its dedicated case, like the Hiring PUT.
  { method: "GET", path: "/v1/stack-posts/alert-feeds", kind: "own-scope", proof: "B sees B's feeds only; B's verification is null while A has a record", named: true },
  { method: "PUT", path: "/v1/stack-posts/alert-feeds/verification", kind: "own-scope", proof: "writes only the caller's row; another Candidate's row, their registration gate and their reads are unchanged", send: { verifiedOn: "2026-10-01", verificationBasis: "B basis." } },
  { method: "POST", path: "/v1/stack-posts/alert-feeds", kind: "own-scope", proof: "A's record never lifts B's 409; a URL A registered is accepted for B once B has their own record; B's limit counts B's feeds", named: true },
  { method: "DELETE", path: "/v1/stack-posts/alert-feeds/:id", kind: "foreign-id", resource: "alert-feed", status: 204, proof: "A's feed ID sent by B gets the same 204 as an unknown ID and A's feed stays (R5-2)", named: true },
  // ── EPIC-0007 (merged first): Hiring search inputs (P1), Hiring feeds and posts (P3) ──
  // F-SEC-40: these run the generic HTTP check with B's session as well as their dedicated
  // cases in cross-candidate.int-spec.ts. POST stays `named` only: its proof is about A's
  // record and URL lists never changing B's 409 or refusal codes, which a sentinel and
  // byte-equality check cannot express, and a valid body makes the route fetch the feed.
  { method: "GET", path: "/v1/stack-posts/hiring-search-inputs", kind: "own-scope", proof: "reflects only the caller's own preferences: A has hints, B has none, so B gets []" },
  { method: "GET", path: "/v1/stack-posts/hiring-feeds", kind: "own-scope", proof: "lists only own feeds and own verification: B gets null and [] while A has both" },
  { method: "PUT", path: "/v1/stack-posts/hiring-feeds/verification", kind: "own-scope", proof: "writes only the caller's row; A's row, A's registration gate and A's reads are unchanged", send: { verifiedOn: "2026-10-01", verificationBasis: "B basis." } },
  { method: "POST", path: "/v1/stack-posts/hiring-feeds", kind: "own-scope", proof: "A's record never lifts B's 409; A's URLs in either list never refuse B", named: true },
  { method: "DELETE", path: "/v1/stack-posts/hiring-feeds/:id", kind: "foreign-id", resource: "hiring-feed", status: 204, proof: "A's Hiring feed ID sent by B gets the same 204 as an unknown ID and A's feed stays" },
  { method: "GET", path: "/v1/stack-posts/hiring-posts", kind: "own-scope", proof: "B's page and totalCount count B's Hiring posts only" },
  { method: "GET", path: "/v1/job-postings", kind: "own-scope", proof: "B's list holds B's postings only; A's nextCursor presented by B is 400", named: true },
  { method: "GET", path: "/v1/job-postings/:id", kind: "foreign-id", resource: "posting", proof: "A's posting ID that B does not hold is 404 for B", named: true },
  { method: "POST", path: "/v1/job-postings/links", kind: "own-scope", proof: "a link A holds, pasted by B, gives B their own row; A's row is unchanged", named: true },
  { method: "POST", path: "/v1/job-postings/check-again", kind: "own-scope", proof: "B's press claims B's rows only (to waiting, no job); A's rows and A's jobs are unchanged", named: true },

  // ── Slice 1-2: AI provider, Career Profile, answers, settings ───────
  { method: "GET", path: "/v1/ai-provider", kind: "own-scope", proof: "B's approval state; none of A's approval time" },
  { method: "POST", path: "/v1/ai-provider/approval", kind: "operator-only", proof: "a non-Operator gets 404; the installation-wide ai_provider_approval stays as it was, even when empty (F-SEC-01; per-Candidate ai_terms_approval arrives in slice C)", send: { termsCheckedOn: ANTHROPIC_TERMS.checkedOn } },
  { method: "GET", path: "/v1/career-profile", kind: "own-scope", proof: "B's profile; none of A's facts" },
  { method: "GET", path: "/v1/career-profile/versions/:version", kind: "foreign-id", resource: "career-profile-version", proof: "a version only A holds is 404 for B" },
  { method: "POST", path: "/v1/career-profile/resume", kind: "own-scope", proof: "B's upload is refused or stored for B; A's rows are unchanged", send: {} },
  { method: "PUT", path: "/v1/career-profile/draft", kind: "own-scope", proof: "creates or edits B's draft only; A's versions are unchanged", send: { sections: [] } },
  { method: "POST", path: "/v1/career-profile/draft/approve", kind: "foreign-id", resource: "career-profile-version", body: () => ({ version: 7 }), proof: "approving a version number only A holds is 404 for B; A's draft stays a draft" },
  { method: "DELETE", path: "/v1/career-profile/draft", kind: "own-scope", proof: "discards B's draft only; A's draft stays" },
  { method: "GET", path: "/v1/approved-answers", kind: "own-scope", proof: "B's answers; none of A's values" },
  { method: "POST", path: "/v1/approved-answers", kind: "own-scope", proof: "creates B's answer even when A holds the same key; A's answer is unchanged", send: { group: "standard", topic: "notice_period", value: "B-VALUE" } },
  { method: "PATCH", path: "/v1/approved-answers/:id", kind: "foreign-id", resource: "approved-answer", body: () => ({ value: "B-EDIT" }), proof: "A's answer ID is 404 for B and A's value is unchanged" },
  { method: "DELETE", path: "/v1/approved-answers/:id", kind: "foreign-id", resource: "approved-answer", proof: "A's answer ID is 404 for B and A's answer stays" },
  { method: "GET", path: "/v1/salary", kind: "own-scope", proof: "B's salary cards; none of A's amounts" },
  { method: "PUT", path: "/v1/salary/gross-salary-policy", kind: "own-scope", proof: "writes B's row only", send: { amount: 1234, currency: "USD", period: "year" } },
  { method: "DELETE", path: "/v1/salary/gross-salary-policy", kind: "own-scope", proof: "clears B's row only; A's stays" },
  { method: "PUT", path: "/v1/salary/current-salary", kind: "own-scope", proof: "writes B's row only", send: { amount: 1234, currency: "USD", period: "year" } },
  { method: "DELETE", path: "/v1/salary/current-salary", kind: "own-scope", proof: "clears B's row only; A's stays" },
  { method: "PUT", path: "/v1/salary/preferred-net-pay", kind: "own-scope", proof: "writes B's row only", send: { amount: 1234, currency: "USD" } },
  { method: "DELETE", path: "/v1/salary/preferred-net-pay", kind: "own-scope", proof: "clears B's row only; A's stays" },
  { method: "GET", path: "/v1/candidate-settings", kind: "own-scope", proof: "B's work authorization; not A's" },
  { method: "PUT", path: "/v1/candidate-settings/work-authorization", kind: "own-scope", proof: "writes B's row only", send: { workAuthorization: "B-WORK-AUTH" } },
  { method: "GET", path: "/v1/candidate-settings/contact", kind: "own-scope", proof: "B's contact; none of A's name or lines" },
  { method: "PUT", path: "/v1/candidate-settings/contact", kind: "own-scope", proof: "writes B's row only", send: { fullName: "B Name", lines: [] } },
  // ATS (v1.26.0): the session Candidate's minimum ATS match; B's save upserts B's settings row only.
  { method: "GET", path: "/v1/candidate-settings/ats", kind: "own-scope", proof: "B's minimum or the default 40; never A's" },
  { method: "PUT", path: "/v1/candidate-settings/ats", kind: "own-scope", proof: "writes B's row only; A's minimum is unchanged", send: { minAtsPercent: 55 } },

  // ── EPIC-0002 B1: the session Candidate's Job Preferences (contract v1.25.0, D40) ──
  // No route takes a Candidate ID. B's first save (baseVersion null) creates B's version 1; A's record and history stay byte-equal.
  // v1.28.0 (EPIC-0011 C2)
  { method: "PUT", path: "/v1/me/advanced", kind: "own-scope", proof: "writes the caller's own candidate_view_setting row only; A's row is unchanged", send: { enabled: true } },
  { method: "POST", path: "/v1/me/notes/:note/dismiss", kind: "own-scope", proof: "writes the caller's own row only; A's row is unchanged" },
  { method: "GET", path: "/v1/me/preferences", kind: "own-scope", proof: "B's record or STEP3_DEFAULTS; none of A's values" },
  { method: "PUT", path: "/v1/me/preferences", kind: "own-scope", proof: "B's save writes B's rows only; A's record and versions are byte-equal", send: { baseVersion: null, values: B_PREFERENCES } },
  { method: "GET", path: "/v1/me/preferences/versions", kind: "own-scope", proof: "B's own versions only, newest first" },

  // ── Slice 3: Job Sources and eligibility settings (shared catalog) ──
  { method: "GET", path: "/v1/job-sources", kind: "own-scope", proof: "the installation catalog; no Candidate rows" },
  { method: "POST", path: "/v1/job-sources/employer-list/approve", kind: "operator-only", proof: "a non-Operator gets 404; the installation approval is unchanged" },
  { method: "PUT", path: "/v1/job-sources/remote-boards/:key/verification", kind: "operator-only", proof: "a non-Operator gets 404; the board's verification is unchanged", send: { verifiedOn: "2026-10-01", basis: "B" } },
  { method: "PUT", path: "/v1/job-sources/remote-boards/:key/enabled", kind: "operator-only", proof: "a non-Operator gets 404; the board stays as the Operator set it", send: { enabled: false } },
  // v1.25.0 (EPIC-0002 B1): the PUT is removed (404 for everyone, cross-candidate-registry.int-spec.ts); the GET stays, read by no rule.
  { method: "GET", path: "/v1/eligibility-settings", kind: "own-scope", proof: "the installation singleton; no Candidate rows" },

  // ── Slice 4: Applications and Tailored Documents ────────────────────
  { method: "GET", path: "/v1/applications", kind: "own-scope", proof: "B's Applications; none of A's" },
  { method: "POST", path: "/v1/applications", kind: "foreign-id", resource: "posting", body: (id) => ({ jobPostingId: id }), proof: "A's posting ID that B does not hold is 404; no Application is created" },
  { method: "GET", path: "/v1/applications/:id", kind: "foreign-id", resource: "application", proof: "A's Application ID is 404 for B" },
  { method: "POST", path: "/v1/applications/:id/documents/generate", kind: "foreign-id", resource: "application", proof: "A's Application ID is 404 for B; nothing is generated" },
  { method: "GET", path: "/v1/applications/:id/documents/:file", kind: "foreign-id", resource: "application", proof: "A's Application ID is 404 for B; no file content is returned" },
  { method: "GET", path: "/v1/documents", kind: "own-scope", proof: "B's documents; none of A's" },
  // v1.31.0 (EPIC-0014 D4): three private Outreach routes, no feature guard, ownership answers first.
  { method: "GET", path: "/v1/applications/:id/outreach", kind: "foreign-id", resource: "application", proof: "A's Application ID is 404 for B; no Outreach item is read" },
  { method: "POST", path: "/v1/applications/:id/outreach/:kind/write", kind: "foreign-id", resource: "application", proof: "A's Application ID is 404 for B; no Run starts" },
  { method: "PUT", path: "/v1/applications/:id/outreach/:kind/reader-name", kind: "foreign-id", resource: "application", body: () => ({ readerName: "B" }), proof: "A's Application ID is 404 for B; no Reader name is saved" },

  // v1.29.0 lead pipeline: the Candidate's own stages; a posting B does not hold answers as one that never existed.
  { method: "GET", path: "/v1/leads", kind: "own-scope", proof: "B's leads; none of A's" },
  { method: "PUT", path: "/v1/leads/:jobPostingId", kind: "foreign-id", resource: "posting", body: () => ({ stage: "saved" }), proof: "A's posting ID that B does not hold is 404; no lead is created" },
  { method: "DELETE", path: "/v1/leads/:jobPostingId", kind: "foreign-id", resource: "posting", status: 204, proof: "A's posting ID sent by B gets the same 204 as an unknown ID; A's rows are unchanged" },

  // ── Slice 5: submission and samples (guarded before slice E) ────────
  { method: "GET", path: "/v1/submission/status", kind: "own-scope", guarded: true, proof: "Operator only before E (409 for B); B never reads A's gate state" },
  { method: "PUT", path: "/v1/submission/automatic", kind: "own-scope", guarded: true, proof: "409 for B; A's switch is unchanged", send: { enabled: false } },
  { method: "GET", path: "/v1/submissions", kind: "own-scope", guarded: true, proof: "409 for B; none of A's submissions" },
  { method: "GET", path: "/v1/submissions/summary", kind: "own-scope", guarded: true, proof: "409 for B; none of A's counts" },
  { method: "GET", path: "/v1/samples", kind: "own-scope", guarded: true, proof: "409 for B; none of A's samples" },
  { method: "POST", path: "/v1/samples/prepare", kind: "own-scope", guarded: true, proof: "409 for B; no sample is prepared" },
  { method: "GET", path: "/v1/applications/:id/submission", kind: "foreign-id", resource: "application", guarded: true, proof: "409 for B before E; A's Application is never read" },
  { method: "GET", path: "/v1/applications/:id/form-answers", kind: "foreign-id", resource: "application", guarded: true, proof: "409 for B before E; A's answers are never read" },
  ...SUBMISSION_ACTIONS.map(
    (action): RegistryCase => ({
      method: "POST",
      path: `/v1/applications/:id/${action}`,
      kind: "foreign-id",
      resource: "application",
      guarded: true,
      ...(REASON_ACTIONS.has(action) ? { body: () => ({ reason: "B" }) } : {}),
      proof: "409 for B before E; A's Application is unchanged",
    })
  ),
  // v1.28.0 (EPIC-0011 C3, BRD:124): the route lost its guard; ownership answers first, so A's ID is 404 for every caller.
  { method: "POST", path: "/v1/applications/:id/manual-complete", kind: "foreign-id", resource: "application", proof: "A's Application ID is 404 for B; A's Application is unchanged" },
  // v1.24.0 (AA-5, Gherkin apply-anyway.feature:1202): not guarded, so ownership answers first.
  { method: "POST", path: "/v1/applications/:id/remove-from-queue", kind: "foreign-id", resource: "application", proof: "A's Application ID is 404 for B; A's Application stays queued" },
  { method: "GET", path: "/v1/existing-applications", kind: "own-scope", proof: "B's existing applications; none of A's" },
  { method: "POST", path: "/v1/existing-applications", kind: "own-scope", proof: "creates B's row only", send: { company: "B Co", roleTitle: "B Role", applicationUrl: "https://example.test/b", appliedOn: "2026-10-01" } },
  { method: "POST", path: "/v1/existing-applications/complete", kind: "own-scope", proof: "completes B's step only; A's activation row is unchanged" },

  // ── Slice 6: notifications (guarded before slice F) ─────────────────
  { method: "GET", path: "/v1/notifications/status", kind: "own-scope", guarded: true, proof: "409 for B before F; none of A's send counts" },

  // ── Slice 7: controls (guarded before slice D) and records ──────────
  { method: "GET", path: "/v1/controls", kind: "own-scope", guarded: true, proof: "409 for B before D; no spend figure" },
  { method: "PUT", path: "/v1/controls/global-pause", kind: "own-scope", guarded: true, proof: "409 for B before D; the pause is unchanged", send: { paused: true } },
  { method: "PUT", path: "/v1/controls/ceiling", kind: "own-scope", guarded: true, proof: "409 for B before D; the ceiling is unchanged", send: { month: "2026-10", ceiling: "60.00" } },
  { method: "GET", path: "/v1/applications/:id/outcomes", kind: "foreign-id", resource: "application", proof: "A's Application ID is 404 for B" },
  { method: "POST", path: "/v1/applications/:id/outcomes", kind: "foreign-id", resource: "application", body: () => VALID_OUTCOME, proof: "A's Application ID is 404 for B; no Outcome is recorded" },
  { method: "PATCH", path: "/v1/outcomes/:id", kind: "foreign-id", resource: "outcome", body: () => VALID_OUTCOME, proof: "A's Outcome ID (not under an Application path) is 404 for B; A's Outcome is unchanged" },
  { method: "POST", path: "/v1/applications/delete-details", kind: "foreign-id", resource: "application", body: (id) => ({ applicationIds: [id] }), proof: "A's Application ID in the body is 404 for B; nothing is deleted" },
  { method: "GET", path: "/v1/minimal-records", kind: "own-scope", proof: "B's minimal records; none of A's" },
  { method: "DELETE", path: "/v1/minimal-records/:id", kind: "foreign-id", resource: "minimal-record", proof: "A's minimal record ID is 404 for B; A's record stays" },
  { method: "GET", path: "/v1/retention", kind: "own-scope", proof: "B's counts; none of A's" },
]

/** The 9 slice 7 routes architecture r3 names (gap G6): each must be in the registry. */
export const SLICE_7_ROUTES: readonly string[] = [
  "GET /v1/controls",
  "PUT /v1/controls/global-pause",
  "PUT /v1/controls/ceiling",
  "GET /v1/applications/:id/outcomes",
  "POST /v1/applications/:id/outcomes",
  "PATCH /v1/outcomes/:id",
  "POST /v1/applications/delete-details",
  "GET /v1/minimal-records",
  "DELETE /v1/minimal-records/:id",
]
