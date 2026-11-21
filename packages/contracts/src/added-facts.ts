import { z } from "zod"

/**
 * v1.32.0 (FEAT-0017): Application-scoped added facts. All routes answer 404
 * unless `ADDED_FACTS_ENABLED=1`; the new response keys are absent while it is off.
 */
export const applicationAddedFactsPath = (id: string) => `/v1/applications/${id}/added-facts`
export const applicationAddedFactPath = (id: string, factId: string) => `/v1/applications/${id}/added-facts/${factId}`
export const applicationAddedFactsConfirmPath = (id: string) => `/v1/applications/${id}/added-facts/confirm`

/** At most 10 one-liners and 40 skill-only facts per Application (counted separately), 300 characters per one-liner. */
export const ADDED_FACT_LIMITS = { oneLiner: 10, skillOnly: 40, textMax: 300, perRequest: 40 } as const
/** Accepted on the wire so a long paste is refused as `too_long` (422) with the form kept, not as a 400. */
export const ADDED_FACT_TEXT_WIRE_MAX = 5000
export const ADDED_FACT_TERM_WIRE_MAX = 200

export const addedFactKindSchema = z.enum(["skill_only", "one_liner"])
export type AddedFactKind = z.infer<typeof addedFactKindSchema>

/** A role as the Candidate sees it: an `experience` section of a Career Profile version. */
export const addedFactRoleSchema = z.object({ title: z.string(), employer: z.string().nullable(), period: z.string().nullable() }).strict()
export type AddedFactRole = z.infer<typeof addedFactRoleSchema>

/** One dropdown option: an experience section of the Career Profile version in use, in profile order. */
export const addedFactRoleOptionSchema = addedFactRoleSchema.extend({ sectionId: z.string().min(1) }).strict()
export type AddedFactRoleOption = z.infer<typeof addedFactRoleOptionSchema>

/** A fact as the detail page lists it. `text` keeps a refused long paste non-400 (`ADDED_FACT_LIMITS.textMax * 2`). */
export const addedFactSchema = z
  .object({
    /** The row UUID. Stable across a skill-only to one-liner upgrade. Never an `added:s:`/`added:o:` string. */
    id: z.uuid(),
    kind: addedFactKindSchema,
    /** Skill-only: the gap term as the posting words it. One-liner: the sentence, trimmed. Plain text; render escaped. */
    text: z.string().min(1).max(ADDED_FACT_LIMITS.textMax * 2),
    /** The gap term this fact answers; null for free entry. Kept when a skill-only fact is upgraded. */
    term: z.string().min(1).nullable(),
    /** Null for skill-only. For a one-liner: the role snapshot taken when it was picked. */
    role: addedFactRoleSchema
      .extend({
        sectionId: z.string().min(1),
        /** False when that section is not an experience section of the version in use: not citable, "pick another role". */
        inProfileVersion: z.boolean(),
      })
      .strict()
      .nullable(),
    saveToProfile: z.boolean(),
    /**
     * Where the draft copy is now, derived at read from `profile_draft_version`:
     * `draft` while that version is the draft; `approved` once it was approved (also when later replaced).
     * Null: not saved to the profile (box not ticked, or the save outcome was not `saved_to_draft`, or the draft was discarded).
     */
    profile: z.object({ status: z.enum(["draft", "approved"]), version: z.int().positive() }).strict().nullable(),
    /** True when the current resume or cover letter cites this fact (current documents only). */
    usedInDocuments: z.boolean(),
    affirmedAt: z.iso.datetime({ offset: true }),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((f) => (f.kind === "skill_only" ? f.role === null && f.term !== null : f.role !== null), {
    message: "skill_only has a term and no role; one_liner has a role",
  })
export type AddedFact = z.infer<typeof addedFactSchema>

/** An added fact as a document cited it, frozen at generation (PRD 5.10). Text is as it was then. */
export const addedFactUsedSchema = z
  .object({
    id: z.uuid(),
    kind: addedFactKindSchema,
    text: z.string().min(1),
    role: addedFactRoleSchema.nullable(),
  })
  .strict()
export type AddedFactUsed = z.infer<typeof addedFactUsedSchema>

const matchNumbersSchema = z
  .object({
    covered: z.int().nonnegative(),
    total: z.int().nonnegative(),
    unmetMandatory: z.int().nonnegative(),
    verdict: z.enum(["strong", "weak"]),
  })
  .strict()

/** The live Application Match: the posting's numbers, the numbers with the added facts, and what lifted it. */
export const applicationMatchSchema = z
  .object({
    careerProfileVersion: z.int().positive(),
    /** The Candidate's current minimum core Match, whole percent. */
    thresholdPercent: z.int().min(1).max(100),
    /** "Match with your Career Profile: {covered}/{total}". Same function as `withAdded`, with no added facts. */
    posting: matchNumbersSchema,
    /** "With the facts you added: {covered}/{total}". Equals `posting` when no fact covers anything. */
    withAdded: matchNumbersSchema,
    /**
     * True only when: the posting is skipped for `weak_core_match` or `uncovered_mandatory_prerequisite`
     * with no violated rule, `withAdded.verdict` is strong, the technology criterion still ranks it, and the
     * Application is not manual-only. Never true for a ranked posting.
     */
    lifted: z.boolean(),
    /** Requirements covered by an added fact and not by the profile, in posting order. */
    covers: z.array(
      z
        .object({
          group: z.enum(["core", "mandatory"]),
          requirement: z.string(),
          factId: z.uuid(),
          /** `skill_only` shows the `C-AF-82` marker. */
          kind: addedFactKindSchema,
        })
        .strict(),
    ),
  })
  .strict()
export type ApplicationMatch = z.infer<typeof applicationMatchSchema>

export const addedFactsFrozenReasonSchema = z.enum([
  "submitted", // submission confirmed, or blocked after the submit click
  "uncertain", // Uncertain Submission (re-opens on "not submitted")
  "manual", // marked manually completed
  "sample_approved", // Activation Gate sample approved, before or after its job ran
  "declined", // same-company review declined
  "details_deleted", // minimal record
])
export type AddedFactsFrozenReason = z.infer<typeof addedFactsFrozenReasonSchema>

export const addedFactsBusyReasonSchema = z.enum(["generating", "submitting"])
export type AddedFactsBusyReason = z.infer<typeof addedFactsBusyReasonSchema>

/**
 * `addedFactsViewSchema.confirmation`.
 *
 * - `not_required`: `match.lifted` is false (or no match).
 * - `needs_documents`: lifted, but there are no current documents (state not `documents_ready`).
 * - `stale`: lifted, documents exist, `documentsStale` is true. Button aria-disabled, `C-AF-67`.
 * - `required`: lifted, documents fresh, not confirmed for this set (or confirmed but taken out of the queue).
 * - `confirmed`: lifted, confirmed for the current counter, and `submission.state` is `queued` or later.
 */
export const addedFactsConfirmationSchema = z
  .object({
    state: z.enum(["not_required", "needs_documents", "stale", "required", "confirmed"]),
    /** True when an earlier confirmation exists for an older counter and state is not `confirmed` (`C-AF-68`). */
    voided: z.boolean(),
    /** Set only with state `confirmed`. */
    confirmedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
export type AddedFactsConfirmation = z.infer<typeof addedFactsConfirmationSchema>

/** `GET /v1/applications/{id}/added-facts` and `ApplicationDetail.addedFacts`. */
export const addedFactsViewSchema = z
  .object({
    /** The Application's added-facts counter. Send it back as `expectedVersion`. Starts at 0. */
    version: z.int().nonnegative(),
    /** Exactly `frozenReason === null && busyReason === null`. The web never derives it. */
    editable: z.boolean(),
    frozenReason: addedFactsFrozenReasonSchema.nullable(),
    busyReason: addedFactsBusyReasonSchema.nullable(),
    /** The Career Profile version whose roles are offered: the documents' version if any, else the approved one. Null: none approved. */
    profileVersion: z.int().positive().nullable(),
    /** Experience sections of `profileVersion`, in profile order. Empty: one-liners unavailable (`C-AF-43`). */
    roles: z.array(addedFactRoleOptionSchema),
    /** Newest first by `createdAt`. */
    facts: z.array(addedFactSchema).max(ADDED_FACT_LIMITS.oneLiner + ADDED_FACT_LIMITS.skillOnly),
    counts: z
      .object({
        // Also capped at the limits, as the authored contract test requires (`counts` over a limit is not a real state).
        oneLiner: z.int().nonnegative().max(ADDED_FACT_LIMITS.oneLiner),
        skillOnly: z.int().nonnegative().max(ADDED_FACT_LIMITS.skillOnly),
      })
      .strict(),
    limits: z
      .object({
        oneLiner: z.literal(ADDED_FACT_LIMITS.oneLiner),
        skillOnly: z.literal(ADDED_FACT_LIMITS.skillOnly),
        textMax: z.literal(ADDED_FACT_LIMITS.textMax),
      })
      .strict(),
    /**
     * Tickable terms: the current resume's stored `ats.gaps`, minus terms an added fact already closes, in stored order.
     * `available` false: no current resume ATS result (no documents, or a posting with no keywords). `C-AF-21`.
     */
    postingGaps: z.object({ available: z.boolean(), terms: z.array(z.string().min(1)) }).strict(),
    /** Current documents exist and were generated against a different counter. Always false with no documents. */
    documentsStale: z.boolean(),
    /** Union of the added facts the current resume and cover letter cite, as at generation, de-duplicated by id. Drives "Added skills used" (`C-AF-85`) and `C-AF-89`. */
    addedFactsCited: z.array(addedFactUsedSchema),
    /** Null: no approved Career Profile, no stored posting Match, or details deleted. */
    match: applicationMatchSchema.nullable(),
    confirmation: addedFactsConfirmationSchema,
  })
  .strict()
  .refine((v) => v.editable === (v.frozenReason === null && v.busyReason === null), { message: "editable mirrors the reasons" })
export type AddedFactsView = z.infer<typeof addedFactsViewSchema>

// ---- Requests ----

/** Missing or false is 422 `affirmation_required`, never 400. */
const affirmed = z.boolean().optional()

export const addSkillOnlyItemSchema = z
  .object({
    kind: z.literal("skill_only"),
    /** Matched case-insensitively after trim against `postingGaps.terms`; stored as the posting words it. */
    term: z.string().max(ADDED_FACT_TERM_WIRE_MAX),
    affirmed,
    saveToProfile: z.boolean().optional().default(false),
  })
  .strict()
export type AddSkillOnlyItem = z.infer<typeof addSkillOnlyItemSchema>

export const addOneLinerItemSchema = z
  .object({
    kind: z.literal("one_liner"),
    text: z.string().max(ADDED_FACT_TEXT_WIRE_MAX),
    roleSectionId: z.string().max(200).nullable().optional(),
    /** A live gap term this sentence answers; absent or null for free entry (also from the blocked alert). */
    term: z.string().max(ADDED_FACT_TERM_WIRE_MAX).nullable().optional(),
    affirmed,
    saveToProfile: z.boolean().optional().default(false),
  })
  .strict()
export type AddOneLinerItem = z.infer<typeof addOneLinerItemSchema>

export const addAddedFactsItemSchema = z.discriminatedUnion("kind", [addSkillOnlyItemSchema, addOneLinerItemSchema])
export type AddAddedFactsItem = z.infer<typeof addAddedFactsItemSchema>

/** `POST /v1/applications/{id}/added-facts`: a batch of 1 to 40 ticks and one-liners, all or nothing. */
export const addAddedFactsRequestSchema = z
  .object({
    expectedVersion: z.int().nonnegative(),
    items: z.array(addAddedFactsItemSchema).min(1).max(ADDED_FACT_LIMITS.perRequest),
  })
  .strict()
export type AddAddedFactsRequest = z.input<typeof addAddedFactsRequestSchema>

/** Edit a one-liner, or upgrade a skill-only fact to a one-liner. Both fields always sent. */
export const editAddedFactRequestSchema = z
  .object({
    expectedVersion: z.int().nonnegative(),
    text: z.string().max(ADDED_FACT_TEXT_WIRE_MAX),
    roleSectionId: z.string().max(200).nullable(),
  })
  .strict()
export type EditAddedFactRequest = z.infer<typeof editAddedFactRequestSchema>

/** `DELETE …/added-facts/{factId}` query. Strict digits only: empty, `1e1`, `" 3 "` or `-0` are 400, never a coerced 0. */
export const removeAddedFactQuerySchema = z
  .object({ expectedVersion: z.string().regex(/^(0|[1-9]\d{0,9})$/).transform(Number) })
  .strict()
export type RemoveAddedFactQuery = z.infer<typeof removeAddedFactQuerySchema>

export const confirmAddedFactsRequestSchema = z.object({ expectedVersion: z.int().nonnegative() }).strict()
export type ConfirmAddedFactsRequest = z.infer<typeof confirmAddedFactsRequestSchema>

// ---- Responses ----

export const profileSaveOutcomeSchema = z.enum([
  "not_requested", // saveToProfile false
  "saved_to_draft", // appended; draftVersion set
  "already_there", // same text (case-insensitive, trimmed) already in the draft or approved version (C-AF-30)
  "draft_full", // a CAREER_PROFILE_LIMITS limit; Application fact kept (C-AF-29)
  "draft_unavailable", // a resume is being drafted; Application fact kept (C-AF-29 wording "this job only")
  "failed", // unexpected error writing the draft; draft unchanged, Application fact kept (C-AF-58 on the row)
])
export type ProfileSaveOutcome = z.infer<typeof profileSaveOutcomeSchema>

/** `POST …/added-facts` 200: the view after the write and one profile-save outcome per request item, same order. */
export const addAddedFactsResponseSchema = z
  .object({
    view: addedFactsViewSchema,
    profileSave: z.array(
      z
        .object({
          position: z.int().positive(),
          factId: z.uuid(),
          outcome: profileSaveOutcomeSchema,
          draftVersion: z.int().positive().nullable(),
        })
        .strict(),
    ),
  })
  .strict()
export type AddAddedFactsResponse = z.infer<typeof addAddedFactsResponseSchema>

// ---- Field errors (`added_facts_invalid`, `added_facts_limit`) ----

export const addedFactFieldSchema = z.enum(["term", "text", "roleSectionId", "affirmed", "items"])
export type AddedFactField = z.infer<typeof addedFactFieldSchema>

export const addedFactProblemSchema = z.enum([
  "affirmation_required", // affirmed missing or false (AC 3.2)
  "empty", // text empty after trim
  "too_long", // text over 300 code points after trim
  "invalid_characters", // control, bidi-control or default-ignorable code point
  "contact_detail", // email, phone or URL (containsContactDetail, with the Candidate's header)
  "aspiration_text", // ASPIRATION_PHRASES hit (AC 3.3)
  "term_not_named", // one-liner tied to a term does not name it (AC 2.3, OD-13)
  "term_not_a_gap", // term not in the live gap list, or no ATS result (AC 1.2, 1.5)
  "duplicate", // text equals an existing added fact or another item in this request, case-insensitive after trim (AC 1.9, 2.5)
  "role_required", // one-liner without roleSectionId
  "role_unknown", // roleSectionId is not an experience section of the version in use
  "no_experience_role", // the version in use has no experience section, or there is no approved version (AC 2.4, 6.8)
  "one_liner_limit", // more than 10 one-liners after the request (added_facts_limit only)
  "skill_only_limit", // more than 40 skill-only facts after the request (added_facts_limit only)
])
export type AddedFactProblem = z.infer<typeof addedFactProblemSchema>

/**
 * One field-level error on `422 added_facts_invalid` or `422 added_facts_limit`.
 * The required `source` literal tells it from the four older strict members of
 * the envelope's `fieldErrors` union; no value is ever echoed.
 */
export const addedFactFieldErrorSchema = z
  .object({
    source: z.literal("added_facts"),
    field: addedFactFieldSchema,
    /** 1-based position in `items` (POST); null for PATCH and for the limit problems. */
    position: z.int().positive().nullable(),
    problem: addedFactProblemSchema,
  })
  .strict()
export type AddedFactFieldError = z.infer<typeof addedFactFieldErrorSchema>
