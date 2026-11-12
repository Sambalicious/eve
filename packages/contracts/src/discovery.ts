import { z } from "zod"

import { keywordFoldsToEmpty } from "./keyword-fold.js"

/** v1.4.0 (slice 3): Job Sources, the employer list, Job Postings, Eligibility and Match. */
export const JOB_SOURCES_PATH = "/v1/job-sources"
export const EMPLOYER_LIST_APPROVE_PATH = "/v1/job-sources/employer-list/approve"
export const JOB_POSTINGS_PATH = "/v1/job-postings"
export const JOB_POSTING_LINKS_PATH = "/v1/job-postings/links"
/** v1.18.0 (EPIC-0006): re-queue the session Candidate's visible failed and not-checked postings. */
export const JOB_POSTINGS_CHECK_AGAIN_PATH = "/v1/job-postings/check-again"
/** `GET` only from v1.25.0 (EPIC-0002 B1): the `PUT` is removed; its fields live in `PUT /v1/me/preferences`. */
export const ELIGIBILITY_SETTINGS_PATH = "/v1/eligibility-settings"

export const applicationSystemSchema = z.enum(["greenhouse", "lever", "ashby"])
export type ApplicationSystem = z.infer<typeof applicationSystemSchema>

export const remoteBoardKeySchema = z.enum(["himalayas", "remoteok", "remotive", "weworkremotely"])
export type RemoteBoardKey = z.infer<typeof remoteBoardKeySchema>

export const employerListCompanySchema = z
  .object({
    id: z.uuid(),
    position: z.int().positive(),
    company: z.string(),
    applicationSystem: applicationSystemSchema,
    boardToken: z.string(),
    boardUrl: z.url(),
    /** Set for companies the Candidate must decide on at approval (crypto). */
    flag: z.enum(["crypto"]).nullable(),
    note: z.string().nullable(),
  })
  .strict()

export const employerListSchema = z
  .object({
    status: z.enum(["draft", "approved"]),
    approvedAt: z.iso.datetime({ offset: true }).nullable(),
    companies: z.array(employerListCompanySchema),
  })
  .strict()

export const remoteBoardSchema = z
  .object({
    key: remoteBoardKeySchema,
    name: z.string(),
    /** Fixed verification order (AC 1.9): Himalayas 1, Remote OK 2, Remotive 3, We Work Remotely 4. */
    order: z.int().positive(),
    verifiedOn: z.iso.date().nullable(),
    verificationBasis: z.string().nullable(),
    enabled: z.boolean(),
    /** False while the board needs something only the Candidate can obtain (Remotive: written permission). */
    available: z.boolean(),
    unavailableReason: z.string().nullable(),
    attributionName: z.string(),
    attributionUrl: z.url(),
  })
  .strict()

export const jobSourcesResponseSchema = z
  .object({
    employerList: employerListSchema,
    remoteBoards: z.array(remoteBoardSchema),
    /** True once the employer list is approved: the 08:00 Africa/Lagos run is on (C-SRC-8 otherwise). */
    scheduledDiscoveryOn: z.boolean(),
  })
  .strict()
export type JobSourcesResponse = z.infer<typeof jobSourcesResponseSchema>

export const verifyJobSourceRequestSchema = z
  .object({ verifiedOn: z.iso.date(), basis: z.string().trim().min(1).max(2000) })
  .strict()
export type VerifyJobSourceRequest = z.infer<typeof verifyJobSourceRequestSchema>

export const setJobSourceEnabledRequestSchema = z.object({ enabled: z.boolean() }).strict()
export type SetJobSourceEnabledRequest = z.infer<typeof setJobSourceEnabledRequestSchema>

export const ruleResultSchema = z.enum(["met", "unverified", "violated", "not_applicable"])
/** v1.25.0 (EPIC-0002 B1, D44): `seniority` and `employment_type` follow `industry`. Results stored before B1 have the first five only. */
export const ruleNameSchema = z.enum(["location", "sponsorship", "pay", "hours", "industry", "seniority", "employment_type"])
export type RuleNameValue = z.infer<typeof ruleNameSchema>

export const jobPostingStatusSchema = z.enum([
  /** Stored; evaluation is queued or running ("Checking"). */
  "checking",
  /** Saved during the cost pause, not evaluated yet ("Waiting to be checked"). */
  "waiting_to_be_checked",
  /** v1.18.0: hidden when stored for this Candidate, or a queued check found it hidden; never evaluated for them. "Not checked yet". */
  "not_checked",
  /** Eligible with a strong core Match; on the Ranked tab. */
  "ranked",
  /** Not eligible: a rule is violated (C-SKIP-1). */
  "excluded",
  /** Skipped by a pre-filter or the Match (C-SKIP-2, 3, 4, 4a). */
  "skipped",
  /** The evaluation could not run or finish (see `evaluationFailure`). */
  "evaluation_failed",
])
export type JobPostingStatus = z.infer<typeof jobPostingStatusSchema>

export const skipReasonSchema = z.enum([
  "unsupported_application_system",
  "not_software_role",
  "violated_rule",
  "uncovered_mandatory_prerequisite",
  "weak_core_match",
  "no_core_responsibilities",
  /** v1.13.0 (EPIC-0004 AC 5.1 step 5): the technology criterion is on and the posting mentions no listed entry. */
  "technology_mismatch",
  /** v1.25.0 (EPIC-0002 B1, R6-2 step 2): the posting's role family is `excluded` in the Candidate's tiers. Excluded families tab only. */
  "excluded_role_family",
  /** v1.25.0 (EPIC-0002 B1, R6-2 step 3): a saved title keyword is set and the stored folded title is null or lacks it. */
  "keyword_mismatch",
])
export type SkipReason = z.infer<typeof skipReasonSchema>

export const evaluationFailureSchema = z.enum([
  "not_approved",
  "not_configured",
  "provider_error",
  "invalid_output",
  "timed_out",
  "no_career_profile",
  "posting_unavailable",
])

/**
 * Role families in display order (AC-1.2). v1.12.0 added `backend`, `mobile`
 * and `devops_platform`. v1.18.0 (EPIC-0006) adds `software_engineering`,
 * `platform_engineering`, `data_ml` and `solutions_customer`, which rank in the
 * last tier, and narrows `devops_platform` (no platform engineering titles).
 */
export const roleFamilySchema = z.enum([
  "senior_frontend",
  "technical_lead",
  "fullstack",
  "product_engineering",
  "software_engineering",
  "backend",
  "mobile",
  "platform_engineering",
  "devops_platform",
  "people_management",
  "data_ml",
  "solutions_customer",
  "other",
])
export type RoleFamilyValue = z.infer<typeof roleFamilySchema>

/** v1.18.0 (AC-1.6): the default and migrated target families, catalog order. */
export const DEFAULT_TARGET_ROLE_FAMILIES = Object.freeze([
  "senior_frontend",
  "technical_lead",
  "fullstack",
  "product_engineering",
  "software_engineering",
  "backend",
  "mobile",
  "platform_engineering",
  "people_management",
] as const)

/** v1.18.0: first reason in AC-3.4 order. */
export const hiddenReasonSchema = z.enum(["off_target", "below_seniority_floor", "undated", "older_than_60_days"])
export type HiddenReason = z.infer<typeof hiddenReasonSchema>

/** v1.18.0: which source field gave the posted date (AC-5.1, AC-5.3). */
export const postedDateKindSchema = z.enum(["published", "updated"])
export type PostedDateKind = z.infer<typeof postedDateKindSchema>

/** v1.18.0 (AC-2.1). */
export const seniorityFloorSchema = z.enum(["all_levels", "hide_entry_level"])
export type SeniorityFloor = z.infer<typeof seniorityFloorSchema>
export const DEFAULT_SENIORITY_FLOOR = "hide_entry_level" satisfies SeniorityFloor

/** v1.18.0 (AC-3.4): over all of the session Candidate's postings; ignores tab, filter and cursor. */
export const hiddenCountsSchema = z
  .object({
    offTarget: z.int().nonnegative(),
    belowSeniorityFloor: z.int().nonnegative(),
    undated: z.int().nonnegative(),
    olderThan60Days: z.int().nonnegative(),
    /** offTarget + belowSeniorityFloor + undated + olderThan60Days. */
    total: z.int().nonnegative(),
  })
  .strict()
export type HiddenCounts = z.infer<typeof hiddenCountsSchema>

/** v1.18.0 (r1): why the session Candidate's visible waiting postings wait. */
export const waitingReasonSchema = z.enum(["cost_pause", "checks_not_enabled"])
export type WaitingReason = z.infer<typeof waitingReasonSchema>

export const employmentTypeSchema = z.enum(["direct", "employer_of_record", "contract"])

/**
 * Where a Job Posting came from. v1.27.0 (EPIC-0010 PD-2.1): `pasted_description`, a
 * Candidate-private posting whose text the Candidate pasted. Always `applyMode: "manual"`.
 */
export const jobPostingOriginSchema = z.enum(["employer_board", "remote_board", "pasted_link", "pasted_description"])
export type JobPostingOrigin = z.infer<typeof jobPostingOriginSchema>

export const jobPostingSummarySchema = z
  .object({
    id: z.uuid(),
    title: z.string().nullable(),
    company: z.string().nullable(),
    /** v1.27.0: null exactly for a description-only `pasted_description` posting (no link). */
    applicationUrl: z.url().nullable(),
    /** v1.27.0: `pasted:<posting id>` for a `pasted_description` posting; synthetic, never shown (hide the Requisition ID fact). */
    requisitionId: z.string(),
    /**
     * "Greenhouse", "Lever", "Ashby", or the detected name of another system (C-SKIP-3 `{system}`).
     * v1.27.0: `"none"` for a description-only posting (hide the Application system fact when `applyUrl` is null).
     */
    applicationSystem: z.string(),
    /** Where the Apply action starts. For Himalayas this is the API's applicationLink, never an ATS link. v1.27.0: null exactly when `applicationUrl` is null. */
    applyUrl: z.url().nullable(),
    /** `manual`: never submitted automatically (unsupported system, a board whose terms require it, or v1.27.0 any `pasted_description` posting). */
    applyMode: z.enum(["automatic", "manual"]),
    origin: jobPostingOriginSchema,
    /** Board credit the dashboard must show with a followed link, e.g. "via Himalayas". */
    attribution: z.object({ name: z.string(), url: z.url() }).strict().nullable(),
    status: jobPostingStatusSchema,
    skipReason: skipReasonSchema.nullable(),
    /** For `violated_rule`: the first violated rule in AC order. For `uncovered_mandatory_prerequisite`: the requirement text. */
    skipDetail: z.string().nullable(),
    /** v1.18.0: non-null only when status is "evaluation_failed". */
    evaluationFailure: evaluationFailureSchema.nullable(),
    roleFamily: roleFamilySchema.nullable(),
    /** 1-based Role Preference rank among the Candidate's visible `ranked` postings; null when hidden or not ranked (v1.18.0). */
    rank: z.int().positive().nullable(),
    unverifiedLabels: z.array(ruleNameSchema),
    match: z
      .object({
        coveredCount: z.int().nonnegative(),
        totalCount: z.int().nonnegative(),
        /**
         * v1.13.0: the minimum core Match the stored decision used, as a whole percent.
         * The `weak_core_match` line is "core Match {⌊covered·100/total⌋}% is below your {thresholdPercent}%".
         */
        thresholdPercent: z.int().min(1).max(100),
        /** ATS fit 0 to 100: the share of the posting's ATS requirements the Career Profile meets. Null before ATS scoring. */
        atsFit: z.int().min(0).max(100).nullable().optional(),
      })
      .strict()
      .nullable(),
    /**
     * v1.13.0 (AC 4.5, 3.6): true only when the technology criterion is on now, the posting has
     * Match evidence, and it has no technology data (evaluated before EPIC-0004 or with a malformed field).
     */
    technologiesNotChecked: z.boolean(),
    discoveredAt: z.iso.datetime({ offset: true }),
    /** v1.18.0: the posted date instant (UTC, offset "Z"); null when undated. */
    postedAt: z.iso.datetime({ offset: true }).nullable(),
    /** v1.18.0: postedAt's WAT calendar date, "YYYY-MM-DD"; null when undated. */
    postedOn: z.iso.date().nullable(),
    /** v1.18.0: basis of postedAt; null when undated. */
    postedDateKind: postedDateKindSchema.nullable(),
    /** v1.18.0: whole WAT days since postedOn; null when undated. */
    ageDays: z.int().nonnegative().nullable(),
    /** v1.18.0: first hidden reason for the session Candidate. Always null in GET /v1/job-postings rows (they are visible). */
    hiddenReason: hiddenReasonSchema.nullable(),
  })
  .strict()
export type JobPostingSummary = z.infer<typeof jobPostingSummarySchema>

export const jobPostingsResponseSchema = z
  .object({
    /** v1.18.0: visible postings only. */
    postings: z.array(jobPostingSummarySchema),
    /** Every visible `waiting_to_be_checked` posting (v1.18.0: visible only); ignores the tab, the Posting filter and the cursor (8P.11). */
    waitingToBeCheckedCount: z.int().nonnegative(),
    /** v1.12.0: opaque; pass it back as `cursor` with the same tab and filter. Null on the last page. */
    nextCursor: z.string().min(1).nullable(),
    /** v1.12.0: exact number of postings matching the tab and the Posting filter when this page was served. */
    totalCount: z.int().nonnegative(),
    /**
     * v1.13.0 (EPIC-0004 AC 6.3): true only when no posting is ranked, at least one is skipped as
     * `weak_core_match` or `technology_mismatch`, and the criteria differ from 70 with empty lists.
     * Computed from counts over all postings, ignoring the tab, the Posting filter and the cursor
     * (decision D1). Same value on every tab and page.
     */
    criteriaEmptyState: z.boolean(),
    /** v1.18.0 (AC-3.4). */
    hiddenCounts: hiddenCountsSchema,
    /** v1.18.0 (AC-7.3, AC-7.10): visible evaluation_failed + visible not_checked. Ignores tab, filter, cursor. */
    recheckableCount: z.int().nonnegative(),
    /** v1.18.0: the session Candidate's target families, in catalog order (AC-3.7). */
    targetRoleFamilies: z.array(roleFamilySchema).min(1).max(13),
    /** v1.18.0 (r1): null exactly when waitingToBeCheckedCount === 0. */
    waitingReason: waitingReasonSchema.nullable(),
  })
  .strict()
export type JobPostingsResponse = z.infer<typeof jobPostingsResponseSchema>

/** v1.12.0 (slice 8): page size bounds and the longest cursor or keyword the API accepts. */
export const JOB_POSTINGS_DEFAULT_LIMIT = 25
export const JOB_POSTINGS_MAX_LIMIT = 100
export const JOB_POSTINGS_CURSOR_MAX_LENGTH = 1024
export const POSTING_KEYWORD_MAX_LENGTH = 100

/**
 * v1.25.0 (EPIC-0002 B1, D17): four tabs. `skipped` (Skipped by rules) = status
 * `excluded` or `skipped` with any reason except `excluded_role_family` (a null
 * reason included); `excluded_family` = `skipped` with `excluded_role_family`;
 * `all` = everything except `excluded_role_family`.
 */
export const postingsTabSchema = z.enum(["ranked", "manual", "skipped", "excluded_family", "all"])
export type PostingsTabValue = z.infer<typeof postingsTabSchema>

/** Canonical positive integer text only: "25" yes; "025", "25.0", "1e2", "+5" no (8P.1). */
const limitSchema = z
  .string()
  .regex(/^[1-9]\d{0,2}$/)
  .transform(Number)
  .pipe(z.int().min(1).max(JOB_POSTINGS_MAX_LIMIT))

/**
 * Comma-separated role family keys, sent once (`families=backend,mobile`).
 * Exact keys only; an empty item is refused; a repeated key counts once. The
 * parsed value is deduplicated and in display order, so `mobile,backend` and
 * `backend,mobile,backend` are the same filter. Empty means no family filter.
 */
const familiesSchema = z.string().transform((value, ctx) => {
  if (value === "") return []
  const keys = value.split(",")
  const families = new Set<RoleFamilyValue>()
  for (const key of keys) {
    const parsed = roleFamilySchema.safeParse(key)
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: "unknown role family" })
      return z.NEVER
    }
    families.add(parsed.data)
  }
  return roleFamilySchema.options.filter((family) => families.has(family))
})

/**
 * v1.12.1 (F-QA8-01): C0 control characters other than whitespace (U+0000 to
 * U+0008, U+000E to U+001F) and DEL (U+007F). Tab, line feed, vertical tab,
 * form feed and carriage return are whitespace: trimmed at the ends and folded
 * to one space inside, like any other whitespace.
 */
function hasNonWhitespaceControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x08 || (code >= 0x0e && code <= 0x1f) || code === 0x7f) return true
  }
  return false
}

/**
 * A title keyword (8F.4): trimmed; at most 100 UTF-16 code units after
 * trimming; no non-whitespace control character (v1.12.1). Parses to the
 * trimmed string, which may be empty (no keyword).
 */
export const postingKeywordSchema = z
  .string()
  .refine((value) => !hasNonWhitespaceControl(value))
  .transform((value) => value.trim())
  // `.length` (UTF-16 code units), the unit the browser's maxlength counts; zod's max counts differently.
  .refine((value) => value.length <= POSTING_KEYWORD_MAX_LENGTH)

/** Blank means no keyword; so does a keyword that folds to empty (v1.13.1, 8d.13: zero-width, format or combining characters only). */
const keywordSchema = postingKeywordSchema.transform((value) => (keywordFoldsToEmpty(value) ? null : value))

/**
 * Query of `GET /v1/job-postings`. Strict: unknown parameters are refused,
 * and every parameter is sent at most once (a repeated parameter is a 400).
 */
export const jobPostingsQuerySchema = z
  .object({
    tab: postingsTabSchema.default("all"),
    limit: limitSchema.default(JOB_POSTINGS_DEFAULT_LIMIT),
    families: familiesSchema.default([]),
    keyword: keywordSchema.default(null),
    cursor: z.string().min(1).max(JOB_POSTINGS_CURSOR_MAX_LENGTH).nullable().default(null),
  })
  .strict()
export type JobPostingsQuery = z.infer<typeof jobPostingsQuerySchema>

/**
 * Builds a list URL in the order tab, families, keyword, limit, cursor. Leaves
 * out an empty family list, a blank keyword, the default limit and a null cursor.
 */
export function jobPostingsPath(query: {
  tab: PostingsTabValue
  families?: readonly RoleFamilyValue[]
  keyword?: string | null
  limit?: number
  cursor?: string | null
}): string {
  const params = new URLSearchParams({ tab: query.tab })
  if (query.families && query.families.length > 0) params.set("families", query.families.join(","))
  const keyword = query.keyword?.trim() ?? ""
  if (!keywordFoldsToEmpty(keyword)) params.set("keyword", keyword)
  if (query.limit !== undefined && query.limit !== JOB_POSTINGS_DEFAULT_LIMIT) params.set("limit", String(query.limit))
  if (query.cursor) params.set("cursor", query.cursor)
  return `${JOB_POSTINGS_PATH}?${params.toString()}`
}

export const eligibilityRuleSchema = z
  .object({
    rule: ruleNameSchema,
    result: ruleResultSchema,
    /** Verbatim posting text (or the structured field shown as text); null means "The posting doesn't say." */
    quote: z.string().nullable(),
  })
  .strict()

const matchItemSchema = z
  .object({
    text: z.string(),
    /** Approved Career Profile fact ID, or null for "Not covered". */
    factId: z.string().nullable(),
    factText: z.string().nullable(),
  })
  .strict()

export const matchResultSchema = z
  .object({
    verdict: z.enum(["strong", "weak"]),
    weakReason: z.enum(["unmet_mandatory", "coverage_below_threshold", "no_core_responsibilities"]).nullable(),
    coveredCount: z.int().nonnegative(),
    totalCount: z.int().nonnegative(),
    /** The minimum core Match this decision used, as a whole percent (v1.13.0: the Candidate's Job criteria). */
    thresholdPercent: z.int().min(1).max(100),
    /** ATS fit 0 to 100 (see the summary); null before ATS scoring. */
    atsFit: z.int().min(0).max(100).nullable().optional(),
    careerProfileVersion: z.int().positive(),
    coreResponsibilities: z.array(matchItemSchema),
    mandatoryPrerequisites: z.array(matchItemSchema),
    niceToHave: z.array(matchItemSchema),
  })
  .strict()

/**
 * v1.24.0 apply anyway (AA-1, AA-2.1): a posting's decision for the session
 * Candidate. Defined here, next to the enums it uses, so the posting detail can
 * carry it; the helpers live in `override.ts`.
 */
/** A stored Eligibility rule name. A string, not `ruleNameSchema`, so a rule the override check doesn't know is echoed and refused as not overridable, never a 400. */
export const violatedRuleNameSchema = z.string().regex(/^[a-z][a-z_]{0,39}$/)

export const violatedRulesSchema = z
  .array(violatedRuleNameSchema)
  .max(20)
  .refine((rules) => new Set(rules).size === rules.length, { message: "duplicate rule" })

export const overrideDecisionSchema = z
  .object({
    status: jobPostingStatusSchema,
    skipReason: skipReasonSchema.nullable(),
    /** `violated_rule`: the first violated rule only. `uncovered_mandatory_prerequisite`: the first unmet prerequisite. */
    skipDetail: z.string().min(1).max(500).nullable(),
    /** Every rule whose result is `violated`. Unverified, met and not applicable are not violations. Compared as a set. */
    violatedRules: violatedRulesSchema,
  })
  .strict()
export type OverrideDecision = z.infer<typeof overrideDecisionSchema>

/** `JobPostingDetail.applyAnyway`: non-null exactly when "Prepare documents anyway" is offered (design B1). */
export const applyAnywaySchema = z
  .object({
    offered: z.literal(true),
    decision: overrideDecisionSchema,
  })
  .strict()
export type ApplyAnyway = z.infer<typeof applyAnywaySchema>

/** v1.13.0 (AC 4.4): one verified technology the posting mentions, with its verbatim quote. */
export const postingTechnologySchema = z
  .object({
    name: z.string(),
    quote: z.string(),
    /** True when it matches an entry in the Candidate's lists. Always false when both lists are empty. */
    inCriteria: z.boolean(),
  })
  .strict()
export type PostingTechnology = z.infer<typeof postingTechnologySchema>

export const jobPostingDetailSchema = jobPostingSummarySchema
  .extend({
    /**
     * v1.13.0: verified technologies in model order (at most 40). `null` = no technology data
     * ("not checked"); `[]` = checked and none found. Shown whether or not the criterion is on.
     */
    technologies: z.array(postingTechnologySchema).nullable(),
    postingText: z.string(),
    employmentType: employmentTypeSchema.nullable(),
    eligibility: z
      .object({
        arrangement: z.enum(["remote", "relocation", "onsite"]),
        relocationCountry: z.string().nullable(),
        rules: z.array(eligibilityRuleSchema),
        /** Monthly gross maximum in USD with 2 decimals, e.g. "2000.27"; null when pay is undisclosed or unconvertible. */
        normalizedMonthlyMaxUsd: z.string().nullable(),
        /** Publication date of the rate used for non-USD pay. */
        fxRateDate: z.iso.date().nullable(),
        evaluatedAt: z.iso.datetime({ offset: true }),
      })
      .strict()
      .nullable(),
    match: matchResultSchema.nullable(),
    /** v1.24.0 (AA-1.1, AA-6): non-null exactly when "Prepare documents anyway" is offered; echo `decision` in the create's acknowledgement. */
    applyAnyway: applyAnywaySchema.nullable(),
    /** v1.24.0 (AA-6.4): the session Candidate's Application for this requisition, if any (including a minimal record). */
    applicationId: z.uuid().nullable(),
    /**
     * v1.27.0 (EPIC-0010 PD-3.1, design dependency 5): true exactly when the posting is a
     * `pasted_description` posting, its status is `ranked`, `skipped` or `excluded`, and
     * `applicationId` is null. Then "Prepare documents" is offered with no dialog and the create
     * sends no `acknowledgement`. Always false for every other origin (they keep `applyAnyway`).
     */
    pastedPrepareOffered: z.boolean(),
  })
  .strict()
export type JobPostingDetail = z.infer<typeof jobPostingDetailSchema>

/** v1.27.0 (EPIC-0010, OQ-2): bounds of a pasted description after `normalisePastedDescription`, in UTF-16 code units (`.length`). */
export const PASTED_DESCRIPTION_MIN_LENGTH = 200
export const PASTED_DESCRIPTION_MAX_LENGTH = 30_000
/** v1.27.0: the raw `description` the body schema accepts before normalising; longer is a plain `400 bad_request`. */
export const PASTED_DESCRIPTION_RAW_MAX_LENGTH = 65_536
/** v1.27.0 (OQ-1, I-2): longest Job title or Company after cleaning; longer is refused, never cut. Equals the api's STORED_NAME_MAX_LENGTH. */
export const PASTED_NAME_MAX_LENGTH = 200
/** v1.27.0: the raw `title` or `company` the body schema accepts before cleaning; longer is a plain `400 bad_request`. */
export const PASTED_NAME_RAW_MAX_LENGTH = 1_000
export const PASTED_LINK_MAX_LENGTH = 2048

/**
 * `POST /v1/job-postings/links`. v1.4.0 body `{ url }`; v1.27.0 (EPIC-0010) adds optional
 * `description`, `title` and `company`. Strict. At least one of `url` and `description` must be
 * present as a key, so `{}` stays the `400 bad_request` it was. A link-only paste is still exactly `{ url }`.
 */
export const pasteJobLinkRequestSchema = z
  .object({
    url: z.string().max(PASTED_LINK_MAX_LENGTH).optional(),
    description: z.string().max(PASTED_DESCRIPTION_RAW_MAX_LENGTH).optional(),
    title: z.string().max(PASTED_NAME_RAW_MAX_LENGTH).optional(),
    company: z.string().max(PASTED_NAME_RAW_MAX_LENGTH).optional(),
  })
  .strict()
  .refine((body) => body.url !== undefined || body.description !== undefined, { message: "url or description is required" })
export type PasteJobLinkRequest = z.infer<typeof pasteJobLinkRequestSchema>

// C0 and C1 controls except tab (U+0009) and line feed (U+000A), and the bidi embedding,
// override and isolate controls (U+202A to U+202E, U+2066 to U+2069).
// eslint-disable-next-line no-control-regex
const DESCRIPTION_STRIPPED = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g

/**
 * v1.27.0 (architecture "Validate"): the stored form of a pasted description. Line endings
 * become `\n`, controls other than `\n` and `\t` and bidi controls are removed, then the text
 * is trimmed. The length bounds apply to this result. The web counter and the MSW handlers use it too.
 */
export function normalisePastedDescription(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(DESCRIPTION_STRIPPED, "").trim()
}

// The api's cleanPostingName set: control, format and line/paragraph separator characters, and every default-ignorable code point.
const NAME_NON_PRINTING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\p{Default_Ignorable_Code_Point}/gu

/**
 * v1.27.0 (PD-1.4, I-2): a typed Job title or Company cleaned as `cleanPostingName` cleans
 * (non-printing characters become spaces, whitespace runs collapse, trimmed) but never cut.
 * Empty means missing; longer than PASTED_NAME_MAX_LENGTH is refused.
 */
export function cleanPastedName(raw: string): string {
  return raw.replace(NAME_NON_PRINTING, " ").replace(/\s+/gu, " ").trim()
}

/** v1.27.0: the fields a paste refusal can point at. `title` and `company` are the request keys. */
export const pasteFieldSchema = z.enum(["description", "title", "company"])
export type PasteField = z.infer<typeof pasteFieldSchema>
export const pasteFieldProblemSchema = z.enum(["too_short", "too_long", "required"])
export type PasteFieldProblem = z.infer<typeof pasteFieldProblemSchema>

/** v1.27.0: one entry of `fieldErrors` on a paste refusal. Never echoes a value. */
export const pasteFieldErrorSchema = z.object({ field: pasteFieldSchema, position: z.null(), problem: pasteFieldProblemSchema }).strict()
export type PasteFieldError = z.infer<typeof pasteFieldErrorSchema>

/** v1.27.0: the error code a single paste field problem is refused with. */
export const PASTE_FIELD_ERROR_CODES = {
  description: { too_short: "job_description_too_short", too_long: "job_description_too_long" },
  title: { required: "job_title_required", too_long: "job_title_too_long" },
  company: { required: "company_required", too_long: "company_too_long" },
} as const

export type PasteFieldErrorCode =
  | "job_description_too_short"
  | "job_description_too_long"
  | "job_title_required"
  | "job_title_too_long"
  | "company_required"
  | "company_too_long"

/** The top-level code of a refusal: the first field error, in the order description, title, company. */
export function pasteFieldErrorCode(error: PasteFieldError): PasteFieldErrorCode {
  const byProblem: Partial<Record<PasteFieldProblem, PasteFieldErrorCode>> = PASTE_FIELD_ERROR_CODES[error.field]
  const code = byProblem[error.problem]
  if (code === undefined) throw new Error(`no code for ${error.field} ${error.problem}`)
  return code
}

/**
 * v1.27.0: the field checks of a paste that carries a description, in the order description,
 * title, company, at most one problem per field. `namesRequired` is true with no link or a link
 * that is not a Greenhouse, Lever or Ashby job URL (the server decides; the web passes true only
 * with no link). A too-long name is refused whether or not names are required.
 */
export function pasteFieldErrors(input: {
  description: string
  title: string | undefined
  company: string | undefined
  namesRequired: boolean
}): PasteFieldError[] {
  const errors: PasteFieldError[] = []
  const text = normalisePastedDescription(input.description)
  if (text.length < PASTED_DESCRIPTION_MIN_LENGTH) errors.push({ field: "description", position: null, problem: "too_short" })
  else if (text.length > PASTED_DESCRIPTION_MAX_LENGTH) errors.push({ field: "description", position: null, problem: "too_long" })
  for (const field of ["title", "company"] as const) {
    const name = cleanPastedName(input[field] ?? "")
    if (name.length > PASTED_NAME_MAX_LENGTH) errors.push({ field, position: null, problem: "too_long" })
    else if (name === "" && input.namesRequired) errors.push({ field, position: null, problem: "required" })
  }
  return errors
}

/**
 * v1.27.0 (EPIC-0010): what a paste that carried a description did. Null for a link-only paste.
 * One value per result line (copy deck):
 * - `stored`: a new pasted-description posting (no link, or a link that is not Greenhouse, Lever or Ashby). C-PD-30.
 * - `stored_lookup_failed`: a Greenhouse, Lever or Ashby link whose lookup failed; a new pasted-description posting from the text. C-PD-38.
 * - `attached` (OQ-4 a): the Candidate held this link with no text; the description became a new pasted-description posting that replaces it (new posting id). C-PD-32.
 * - `replaced` (OQ-4 b): the Candidate's pasted-description posting for this link got the new text and is checked again (same id). C-PD-32.
 * - `already_pasted` (OQ-4 d): an identical description-only paste; nothing changed. C-PD-33.
 * - `employer_page_used` (OQ-3): the employer's text from Greenhouse, Lever or Ashby was used, or was already held; the description was not stored. C-PD-31.
 * - `unchanged_has_application` (OQ-4 c, PD-5.3): the posting for this link has an Application; nothing changed; see `applicationId`. C-PD-34 + C-PD-35.
 */
export const pasteDescriptionOutcomeSchema = z.enum([
  "stored",
  "stored_lookup_failed",
  "attached",
  "replaced",
  "already_pasted",
  "employer_page_used",
  "unchanged_has_application",
])
export type PasteDescriptionOutcome = z.infer<typeof pasteDescriptionOutcomeSchema>

export const pasteJobLinkResponseSchema = z
  .object({
    /** True only when this request inserted the posting it returns (HTTP 201). False when the link resolved to an already stored Job Posting (C-LINK-2), and for `attached`, `replaced`, `already_pasted`, `unchanged_has_application` and a held `employer_page_used` (HTTP 200). */
    created: z.boolean(),
    posting: jobPostingSummarySchema,
    /** v1.27.0: null exactly for a link-only paste (no description, or a blank one, sent with a link). */
    descriptionOutcome: pasteDescriptionOutcomeSchema.nullable(),
    /** v1.27.0 (PD-5.3): the existing Application; non-null exactly when `descriptionOutcome` is `unchanged_has_application`. */
    applicationId: z.uuid().nullable(),
    /** v1.27.0: why the posting waits (C-PD-36 / C-PD-37); non-null exactly when `posting.status` is `waiting_to_be_checked`. */
    waitingReason: waitingReasonSchema.nullable(),
  })
  .strict()
  .refine((r) => (r.applicationId !== null) === (r.descriptionOutcome === "unchanged_has_application"), {
    message: "applicationId is set exactly with unchanged_has_application",
  })
  .refine((r) => (r.waitingReason !== null) === (r.posting.status === "waiting_to_be_checked"), {
    message: "waitingReason is set exactly when the posting is waiting_to_be_checked",
  })
export type PasteJobLinkResponse = z.infer<typeof pasteJobLinkResponseSchema>

/** v1.18.0: absent body or exactly `{}`; any key is a 400. */
export const checkAgainRequestSchema = z.object({}).strict()
export const checkAgainResponseSchema = z
  .object({
    /** Rows newly claimed for the session Candidate by this request. */
    queued: z.int().nonnegative(),
    /** "checking": jobs queued (the Operator). "waiting_to_be_checked": no job, no model call (every other Candidate until EPIC-0002 slice D). */
    movedTo: z.enum(["checking", "waiting_to_be_checked"]),
  })
  .strict()
export type CheckAgainResponse = z.infer<typeof checkAgainResponseSchema>

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const eligibilitySettingsSchema = z
  .object({ hoursCutoff: hhmm, hoursTimeZone: z.string().min(1).max(64) })
  .strict()
export type EligibilitySettings = z.infer<typeof eligibilitySettingsSchema>

