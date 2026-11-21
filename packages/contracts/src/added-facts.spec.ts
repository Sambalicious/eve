import { describe, expect, it } from "vitest"

import {
  ADDED_FACT_LIMITS,
  ADDED_FACT_TERM_WIRE_MAX,
  ADDED_FACT_TEXT_WIRE_MAX,
  ADDED_FACTS_ERROR_MESSAGES,
  addAddedFactsRequestSchema,
  addedFactSchema,
  addedFactsViewSchema,
  applicationAddedFactPath,
  applicationAddedFactsConfirmPath,
  applicationAddedFactsPath,
  apiErrorCodeSchema,
  apiErrorResponseSchema,
  applicationDetailSchema,
  confirmAddedFactsRequestSchema,
  editAddedFactRequestSchema,
  latestDropReasonOf,
  queuedPostingDroppedDetailSchema,
  removeAddedFactQuerySchema,
  tailoredDocumentSchema,
} from "./index.js"

/**
 * FEAT-0017 contract tests, api-contract.md v1.32.0 "Contract tests" 1 to 6 and 8.
 * Item 7 edits `blocked-claim.spec.ts` test 1 (nine causes).
 * Fixtures are E1, E2, E4, E5, E6, E7, E8, E9 and E10 from the contract, byte for byte.
 */

const APPLICATION = "a1b2c3d4-0000-4000-8000-000000000001"
const FIGMA = "f0000000-0000-4000-8000-000000000001"
const CICD = "f0000000-0000-4000-8000-000000000002"

const figmaUsed = { id: FIGMA, kind: "skill_only", text: "Figma", role: null } as const

/** E1: Editable, two facts, documents stale, lifted, confirmation required. */
const E1 = {
  version: 2,
  editable: true,
  frozenReason: null,
  busyReason: null,
  profileVersion: 4,
  roles: [
    { sectionId: "sec-exp-1", title: "Frontend Engineer", employer: "Acme Ltd", period: "2021 to 2023" },
    { sectionId: "sec-exp-2", title: "Senior Engineer", employer: "Brightwave Ltd", period: "2023 to present" },
  ],
  facts: [
    {
      id: CICD,
      kind: "one_liner",
      text: "Set up GitHub Actions CI/CD pipelines at Acme",
      term: "CI/CD pipelines",
      role: { sectionId: "sec-exp-1", title: "Frontend Engineer", employer: "Acme Ltd", period: "2021 to 2023", inProfileVersion: true },
      saveToProfile: true,
      profile: { status: "draft", version: 5 },
      usedInDocuments: false,
      affirmedAt: "2026-11-21T09:00:00.000Z",
      createdAt: "2026-11-21T09:00:00.000Z",
      updatedAt: "2026-11-21T09:05:00.000Z",
    },
    {
      id: FIGMA,
      kind: "skill_only",
      text: "Figma",
      term: "Figma",
      role: null,
      saveToProfile: false,
      profile: null,
      usedInDocuments: true,
      affirmedAt: "2026-11-21T08:58:00.000Z",
      createdAt: "2026-11-21T08:58:00.000Z",
      updatedAt: "2026-11-21T08:58:00.000Z",
    },
  ],
  counts: { oneLiner: 1, skillOnly: 1 },
  limits: { oneLiner: 10, skillOnly: 40, textMax: 300 },
  postingGaps: { available: true, terms: ["design systems", "component library", "error boundaries"] },
  documentsStale: true,
  addedFactsCited: [figmaUsed],
  match: {
    careerProfileVersion: 4,
    thresholdPercent: 70,
    posting: { covered: 5, total: 9, unmetMandatory: 0, verdict: "weak" },
    withAdded: { covered: 7, total: 9, unmetMandatory: 0, verdict: "strong" },
    lifted: true,
    covers: [
      { group: "core", requirement: "Build and maintain our Figma-based design handoff", factId: FIGMA, kind: "skill_only" },
      { group: "core", requirement: "Own CI/CD pipelines for the web app", factId: CICD, kind: "one_liner" },
    ],
  },
  confirmation: { state: "stale", voided: true, confirmedAt: null },
} as const

/** E2: same Application after Generate again (fresh documents, ready to confirm). */
const E2 = {
  ...E1,
  facts: [
    { ...E1.facts[0]!, usedInDocuments: true },
    { ...E1.facts[1]!, usedInDocuments: true },
  ],
  documentsStale: false,
  addedFactsCited: [
    figmaUsed,
    { id: CICD, kind: "one_liner", text: "Set up GitHub Actions CI/CD pipelines at Acme", role: { title: "Frontend Engineer", employer: "Acme Ltd", period: "2021 to 2023" } },
  ],
  confirmation: { state: "required", voided: true, confirmedAt: null },
} as const

/** E8: Frozen view (Confirmed Submission). */
const E8 = {
  ...E1,
  version: 3,
  editable: false,
  frozenReason: "submitted",
  roles: [{ sectionId: "sec-exp-1", title: "Frontend Engineer", employer: "Acme Ltd", period: "2021 to 2023" }],
  postingGaps: { available: true, terms: ["design systems"] },
  documentsStale: false,
  match: null,
  confirmation: { state: "not_required", voided: false, confirmedAt: null },
} as const

/** E9: busy, no ATS result, no role. */
const E9 = {
  version: 0,
  editable: false,
  frozenReason: null,
  busyReason: "generating",
  profileVersion: 4,
  roles: [],
  facts: [],
  counts: { oneLiner: 0, skillOnly: 0 },
  limits: { oneLiner: 10, skillOnly: 40, textMax: 300 },
  postingGaps: { available: false, terms: [] },
  documentsStale: false,
  addedFactsCited: [],
  match: null,
  confirmation: { state: "not_required", voided: false, confirmedAt: null },
} as const

/** A v1.31.0 ApplicationDetail: no `addedFacts` key anywhere. */
const DETAIL_V131 = {
  id: "90090000-0000-4000-8000-000000000001",
  jobPostingId: "10000000-0000-4000-8000-000000000901",
  company: "Reddit",
  roleTitle: "Frontend Engineer, Ads",
  requisitionId: "R-9001",
  applicationUrl: "https://boards.greenhouse.io/reddit/jobs/9001",
  pastedDescription: false,
  manualOnly: false,
  state: "documents_ready",
  careerProfileVersion: 4,
  blockedDocument: null,
  blockedClaim: null,
  failure: null,
  coverLetterStatus: "not_submitted",
  createdAt: "2026-11-10T09:00:00.000Z",
  updatedAt: "2026-11-10T09:04:12.000Z",
  detailsDeletedAt: null,
  expiresOn: "2027-11-10",
  override: null,
  documents: [],
  posting: { status: "ranked", hidden: false },
  latestDrop: null,
} as const

/** E10: a resume entry inside ApplicationDetail.documents. */
const E10 = {
  kind: "resume",
  careerProfileVersion: 4,
  createdAt: "2026-11-21T09:30:00.000Z",
  pdfUrl: `/v1/applications/${APPLICATION}/documents/resume.pdf`,
  docxUrl: `/v1/applications/${APPLICATION}/documents/resume.docx`,
  previewText: ["Senior Frontend Engineer"],
  ats: { score: 72, total: 29, matched: ["React", "Figma"], missing: [], gaps: ["design systems"] },
  addedFactsUsed: [figmaUsed],
} as const
const E10_BEFORE: Record<string, unknown> = { ...E10 }
delete E10_BEFORE.addedFactsUsed

describe("contract test 1: addedFactsViewSchema (E1, E2, E8, E9; @ac-1.1, @ac-4.2, @ac-5.6, @ac-7.6)", () => {
  it.each([
    ["E1: Editable, two facts, documents stale, lifted, confirmation required", E1],
    ["E2: fresh documents, ready to confirm", E2],
    ["E8: Frozen view of a Confirmed Submission", E8],
    ["E9: busy, no ATS result, no role", E9],
  ])("accepts %s", (_name, view) => {
    expect(addedFactsViewSchema.safeParse(view).success).toBe(true)
  })

  it.each([
    ["editable true with a frozenReason", { ...E1, frozenReason: "submitted" }],
    ["editable true with a busyReason", { ...E1, busyReason: "generating" }],
    ["editable false with no reason", { ...E1, editable: false }],
    ["a skill-only fact with a role", { ...E1, facts: [{ ...E1.facts[1], role: E1.facts[0]!.role }] }],
    ["a one-liner fact with role null", { ...E1, facts: [{ ...E1.facts[0], role: null }] }],
    ["an unknown key on the view", { ...E1, addedFacts: [] }],
    ["an unknown key on a fact", { ...E1, facts: [{ ...E1.facts[1], hidden: true }] }],
    ["version -1", { ...E1, version: -1 }],
    ["frozenReason this build does not know", { ...E8, frozenReason: "some_future_reason" }],
    ["confirmation state this build does not know", { ...E1, confirmation: { state: "pending", voided: false, confirmedAt: null } }],
    ["counts that exceed the limits (no cross-check refine)", { ...E1, counts: { oneLiner: 11, skillOnly: 0 } }],
    ["a match verdict this build does not know", { ...E1, match: { ...E1.match!, withAdded: { ...E1.match!.withAdded, verdict: "medium" } } }],
    ["a cover kind this build does not know", { ...E1, match: { ...E1.match!, covers: [{ ...E1.match!.covers[0]!, kind: "profile" }] } }],
  ])("rejects %s", (_name, view) => {
    expect(addedFactsViewSchema.safeParse(view).success).toBe(false)
  })

  it("accepts a frozen application whose match is still non-null (E8 note)", () => {
    expect(addedFactsViewSchema.safeParse({ ...E8, match: E1.match }).success).toBe(true)
  })

  it("accepts an agreed confirmation with confirmedAt set", () => {
    expect(addedFactsViewSchema.safeParse({ ...E2, confirmation: { state: "confirmed", voided: false, confirmedAt: "2026-11-21T10:00:00.000Z" } }).success).toBe(true)
  })

  it("accepts a fact whose role section is gone from the version in use", () => {
    const orphan = { ...E1.facts[0]!, role: { ...E1.facts[0]!.role!, inProfileVersion: false } }
    expect(addedFactSchema.safeParse(orphan).success).toBe(true)
  })

  it("accepts a document long enough to be refused as too_long rather than 400 (600 units)", () => {
    expect(addedFactSchema.safeParse({ ...E1.facts[0]!, text: "x".repeat(ADDED_FACT_LIMITS.textMax * 2) }).success).toBe(true)
    expect(addedFactSchema.safeParse({ ...E1.facts[0]!, text: "x".repeat(ADDED_FACT_LIMITS.textMax * 2 + 1) }).success).toBe(false)
  })
})

describe("contract test 2: addAddedFactsRequestSchema (E4; @ac-1.2, @ac-1.7, @ac-2.1, @ac-3.2, @ac-9.4)", () => {
  it("accepts E4: two ticks, one with the profile checkbox", () => {
    expect(
      addAddedFactsRequestSchema.safeParse({
        expectedVersion: 0,
        items: [
          { kind: "skill_only", term: "figma", affirmed: true, saveToProfile: false },
          { kind: "skill_only", term: "CI/CD pipelines", affirmed: true, saveToProfile: true },
        ],
      }).success
    ).toBe(true)
  })

  it("accepts a one-liner without affirmed: 422 is the server's job, not 400 (@ac-3.2)", () => {
    expect(
      addAddedFactsRequestSchema.safeParse({
        expectedVersion: 1,
        items: [{ kind: "one_liner", text: "Set up GitHub Actions CI/CD at Acme", roleSectionId: "sec-exp-1" }],
      }).success
    ).toBe(true)
  })

  it("accepts a free-entry one-liner with no term key", () => {
    expect(
      addAddedFactsRequestSchema.safeParse({
        expectedVersion: 0,
        items: [{ kind: "one_liner", text: "Mentored 3 interns on code review at Acme", roleSectionId: "sec-exp-1", affirmed: true }],
      }).success
    ).toBe(true)
  })

  it("defaults saveToProfile to false when it is absent", () => {
    const parsed = addAddedFactsRequestSchema.parse({ expectedVersion: 0, items: [{ kind: "skill_only", term: "Figma", affirmed: true }] })
    expect(parsed.items[0]).toMatchObject({ saveToProfile: false })
  })

  it("accepts the 40-item per-request maximum and the wire caps", () => {
    const items = Array.from({ length: ADDED_FACT_LIMITS.perRequest }, (_, i) => ({ kind: "skill_only", term: `term ${i}`, affirmed: true }))
    expect(addAddedFactsRequestSchema.safeParse({ expectedVersion: 0, items }).success).toBe(true)
    expect(
      addAddedFactsRequestSchema.safeParse({ expectedVersion: 0, items: [{ kind: "one_liner", text: "x".repeat(ADDED_FACT_TEXT_WIRE_MAX), roleSectionId: "s", affirmed: true }] }).success
    ).toBe(true)
    expect(
      addAddedFactsRequestSchema.safeParse({ expectedVersion: 0, items: [{ kind: "skill_only", term: "x".repeat(ADDED_FACT_TERM_WIRE_MAX), affirmed: true }] }).success
    ).toBe(true)
  })

  it.each([
    ["a skill-only item with text (the wire never splits the kind)", { expectedVersion: 0, items: [{ kind: "skill_only", term: "Figma", text: "Figma", affirmed: true }] }],
    ["a skill-only item with a role", { expectedVersion: 0, items: [{ kind: "skill_only", term: "Figma", roleSectionId: "sec-exp-1", affirmed: true }] }],
    ["an empty items list", { expectedVersion: 0, items: [] }],
    ["41 items", { expectedVersion: 0, items: Array.from({ length: 41 }, (_, i) => ({ kind: "skill_only", term: `term ${i}`, affirmed: true })) }],
    ["an unknown kind", { expectedVersion: 0, items: [{ kind: "sentence", text: "Figma", affirmed: true }] }],
    ["a missing expectedVersion", { items: [{ kind: "skill_only", term: "Figma", affirmed: true }] }],
    ["a negative expectedVersion", { expectedVersion: -1, items: [{ kind: "skill_only", term: "Figma", affirmed: true }] }],
    ["a one-liner over the 5000-unit wire cap", { expectedVersion: 0, items: [{ kind: "one_liner", text: "x".repeat(ADDED_FACT_TEXT_WIRE_MAX + 1), roleSectionId: "s", affirmed: true }] }],
    ["a term over the 200-unit wire cap", { expectedVersion: 0, items: [{ kind: "skill_only", term: "x".repeat(ADDED_FACT_TERM_WIRE_MAX + 1), affirmed: true }] }],
    ["an unknown key on the request", { expectedVersion: 0, items: [{ kind: "skill_only", term: "Figma", affirmed: true }], confirmed: true }],
    ["an unknown key on an item", { expectedVersion: 0, items: [{ kind: "skill_only", term: "Figma", affirmed: true, alsoProfile: true }] }],
  ])("rejects %s", (_name, body) => {
    expect(addAddedFactsRequestSchema.safeParse(body).success).toBe(false)
  })

  it("keeps affirmed as a plain optional boolean so false reaches the server as a field error", () => {
    const parsed = addAddedFactsRequestSchema.safeParse({ expectedVersion: 0, items: [{ kind: "one_liner", text: "Built a design system at Acme", roleSectionId: "sec-exp-1", affirmed: false }] })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.items[0]).toMatchObject({ affirmed: false })
  })
})

describe("contract test 3: editAddedFactRequestSchema (@ac-4.1)", () => {
  it("accepts an edit of text and role, and a null role", () => {
    expect(editAddedFactRequestSchema.safeParse({ expectedVersion: 3, text: "Set up GitHub Actions CI/CD pipelines at Acme", roleSectionId: "sec-exp-1" }).success).toBe(true)
    expect(editAddedFactRequestSchema.safeParse({ expectedVersion: 3, text: "Set up the release workflow at Acme", roleSectionId: null }).success).toBe(true)
  })

  it.each([
    ["saveToProfile (not a PATCH field)", { expectedVersion: 3, text: "Set up CI/CD at Acme", roleSectionId: "sec-exp-1", saveToProfile: true }],
    ["kind (a one-liner can never become skill-only)", { expectedVersion: 3, kind: "skill_only", text: "Figma", roleSectionId: "sec-exp-1" }],
    ["term (the stored term is kept, never sent)", { expectedVersion: 3, term: "CI/CD pipelines", text: "Set up CI/CD at Acme", roleSectionId: "sec-exp-1" }],
    ["a missing roleSectionId (the key is required, null allowed)", { expectedVersion: 3, text: "Set up CI/CD at Acme" }],
    ["a negative expectedVersion", { expectedVersion: -1, text: "Set up CI/CD at Acme", roleSectionId: "sec-exp-1" }],
    ["text over the wire cap", { expectedVersion: 3, text: "x".repeat(ADDED_FACT_TEXT_WIRE_MAX + 1), roleSectionId: "sec-exp-1" }],
  ])("rejects %s", (_name, body) => {
    expect(editAddedFactRequestSchema.safeParse(body).success).toBe(false)
  })

  it("DELETE accepts digits only, so an empty, 1e1, padded or -0 value is 400 (@ac-4.1, order of checks 6)", () => {
    expect(removeAddedFactQuerySchema.parse({ expectedVersion: "0" }).expectedVersion).toBe(0)
    expect(removeAddedFactQuerySchema.parse({ expectedVersion: "12" }).expectedVersion).toBe(12)
    expect(removeAddedFactQuerySchema.safeParse({ expectedVersion: "007" }).success).toBe(false)
    for (const value of ["", "1e1", " 3 ", "-0", "-1", "1.0", "abc"]) {
      expect(removeAddedFactQuerySchema.safeParse({ expectedVersion: value }).success).toBe(false)
    }
    expect(removeAddedFactQuerySchema.safeParse({}).success).toBe(false)
    expect(removeAddedFactQuerySchema.safeParse({ expectedVersion: "1", extra: "x" }).success).toBe(false)
  })

  it("confirm carries only expectedVersion", () => {
    expect(confirmAddedFactsRequestSchema.safeParse({ expectedVersion: 2 }).success).toBe(true)
    expect(confirmAddedFactsRequestSchema.safeParse({ expectedVersion: 2, confirmedAt: "2026-11-21T10:00:00.000Z" }).success).toBe(false)
    expect(confirmAddedFactsRequestSchema.safeParse({}).success).toBe(false)
  })

  it("names the five routes as the contract does (@ac-1.1)", () => {
    expect(applicationAddedFactsPath(APPLICATION)).toBe(`/v1/applications/${APPLICATION}/added-facts`)
    expect(applicationAddedFactPath(APPLICATION, FIGMA)).toBe(`/v1/applications/${APPLICATION}/added-facts/${FIGMA}`)
    expect(applicationAddedFactsConfirmPath(APPLICATION)).toBe(`/v1/applications/${APPLICATION}/added-facts/confirm`)
  })
})

describe("contract test 4: apiErrorResponseSchema with the added-facts field errors (E5, E6, E7; @ac-1.2, @ac-1.7, @ac-3.3, @ac-4.5)", () => {
  const E5 = {
    error: {
      code: "added_facts_invalid",
      message: "Check the highlighted fields. Nothing was saved.",
      fieldErrors: [
        { source: "added_facts", field: "text", position: 1, problem: "aspiration_text" },
        { source: "added_facts", field: "roleSectionId", position: 1, problem: "role_required" },
      ],
    },
  }
  const E6 = {
    error: {
      code: "added_facts_limit",
      message: "That would pass the limit of added facts for this Application. Nothing was saved.",
      fieldErrors: [{ source: "added_facts", field: "items", position: null, problem: "one_liner_limit" }],
    },
  }
  const E7 = [
    "added_facts_conflict",
    "added_facts_busy",
    "added_facts_frozen",
    "documents_stale",
    "added_facts_not_lifted",
    "added_facts_confirmation_required",
  ].map((code) => ({ error: { code, message: ADDED_FACTS_ERROR_MESSAGES[code as keyof typeof ADDED_FACTS_ERROR_MESSAGES] } }))

  it("accepts E5, E6 and every E7 body, with the exact messages", () => {
    expect(apiErrorResponseSchema.safeParse(E5).success).toBe(true)
    expect(apiErrorResponseSchema.safeParse(E6).success).toBe(true)
    for (const body of E7) expect(apiErrorResponseSchema.safeParse(body).success).toBe(true)
  })

  it("accepts each field and each problem the contract defines", () => {
    for (const field of ["term", "text", "roleSectionId", "affirmed", "items"]) {
      const body = { error: { code: "added_facts_invalid", message: "Check the highlighted fields. Nothing was saved.", fieldErrors: [{ source: "added_facts", field, position: null, problem: "duplicate" }] } }
      expect(apiErrorResponseSchema.safeParse(body).success).toBe(true)
    }
    for (const problem of [
      "affirmation_required",
      "empty",
      "too_long",
      "invalid_characters",
      "contact_detail",
      "aspiration_text",
      "term_not_named",
      "term_not_a_gap",
      "duplicate",
      "role_required",
      "role_unknown",
      "no_experience_role",
      "one_liner_limit",
      "skill_only_limit",
    ]) {
      const body = { error: { code: "added_facts_invalid", message: "Check the highlighted fields. Nothing was saved.", fieldErrors: [{ source: "added_facts", field: "text", position: 2, problem }] } }
      expect(apiErrorResponseSchema.safeParse(body).success).toBe(true)
    }
  })

  it.each([
    ["a field error with no source (indistinguishable from the four existing members)", { source: undefined, field: "text", position: 1, problem: "empty" }],
    ["a source other than added_facts", { source: "added_fact", field: "text", position: 1, problem: "empty" }],
    ["an unknown field", { source: "added_facts", field: "termText", position: 1, problem: "empty" }],
    ["an unknown problem", { source: "added_facts", field: "text", position: 1, problem: "too_short" }],
    ["position 0", { source: "added_facts", field: "text", position: 0, problem: "empty" }],
    ["an unknown key", { source: "added_facts", field: "text", position: 1, problem: "empty", term: "Figma" }],
  ])("rejects %s", (_name, fieldError) => {
    const body = { error: { code: "added_facts_invalid", message: "Check the highlighted fields. Nothing was saved.", fieldErrors: [fieldError] } }
    expect(apiErrorResponseSchema.safeParse(body).success).toBe(false)
  })

  it("still accepts a v1.31.0 fieldErrors fixture of each existing strict member", () => {
    const fixtures = [
      { error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "minCoreMatchPercent", position: null, problem: "invalid" }] } },
      { error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "url", position: null, problem: "invalid_format" }] } },
      { error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "homeCountry", position: null, problem: "invalid" }] } },
      { error: { code: "job_description_too_short", message: "Too short to check. Paste the full description, at least 200 characters.", fieldErrors: [{ field: "description", position: null, problem: "too_short" }] } },
    ]
    for (const body of fixtures) expect(apiErrorResponseSchema.safeParse(body).success).toBe(true)
  })

  it("accepts the two new blocked causes as bounded cause strings on a summary (@ac-5.3, @ac-3.4, A-8)", () => {
    for (const cause of ["skill_only_in_bullet", "added_fact_hedge"]) {
      const body = { ...DETAIL_V131, state: "documents_blocked", blockedDocument: "resume", blockedClaim: "Worked with Figma at Brightwave Ltd", blockedClaimCause: cause }
      expect(applicationDetailSchema.safeParse(body).success).toBe(true)
    }
  })
})

describe("contract test 5: ApplicationDetail and TailoredDocument (E1, E10; @ac-5.10)", () => {
  it("accepts a v1.31.0 detail with no addedFacts key", () => {
    expect(applicationDetailSchema.safeParse(DETAIL_V131).success).toBe(true)
    expect("addedFacts" in DETAIL_V131).toBe(false)
  })

  it("accepts a detail carrying E1 as addedFacts", () => {
    expect(applicationDetailSchema.safeParse({ ...DETAIL_V131, addedFacts: E1 }).success).toBe(true)
  })

  it("accepts E10 and an entry without addedFactsUsed", () => {
    expect(tailoredDocumentSchema.safeParse(E10).success).toBe(true)
    expect(tailoredDocumentSchema.safeParse(E10_BEFORE).success).toBe(true)
    expect("addedFactsUsed" in E10_BEFORE).toBe(false)
  })

  it("accepts a document whose addedFactsUsed is empty (flag on, nothing cited)", () => {
    expect(tailoredDocumentSchema.safeParse({ ...E10, addedFactsUsed: [] }).success).toBe(true)
  })

  it("rejects an addedFactsUsed entry with an unknown key or a non-UUID id", () => {
    expect(tailoredDocumentSchema.safeParse({ ...E10, addedFactsUsed: [{ ...figmaUsed, term: "Figma" }] }).success).toBe(false)
    expect(tailoredDocumentSchema.safeParse({ ...E10, addedFactsUsed: [{ ...figmaUsed, id: "added:s:1" }] }).success).toBe(false)
  })
})

describe("contract test 6: queue drop details (@ac-5.6, @ac-7.7)", () => {
  it("accepts the two new details beside the four existing ones", () => {
    for (const detail of ["closed", "hidden", "override_mismatch", "not_ranked", "documents_stale", "added_facts_unconfirmed"]) {
      expect(queuedPostingDroppedDetailSchema.safeParse(detail).success).toBe(true)
    }
    expect(queuedPostingDroppedDetailSchema.safeParse("stale").success).toBe(false)
  })

  it("maps both new details to not_submittable, and closed to closed", () => {
    expect(latestDropReasonOf("documents_stale")).toBe("not_submittable")
    expect(latestDropReasonOf("added_facts_unconfirmed")).toBe("not_submittable")
    expect(latestDropReasonOf("closed")).toBe("closed")
    expect(latestDropReasonOf(null)).toBe("not_submittable")
  })
})

describe("contract test 8: ADDED_FACTS_ERROR_MESSAGES (error table)", () => {
  const CODES = [
    "added_facts_frozen",
    "added_facts_busy",
    "added_facts_conflict",
    "added_facts_invalid",
    "added_facts_limit",
    "added_facts_not_lifted",
    "added_facts_confirmation_required",
    "documents_stale",
  ] as const

  it("has exactly the eight new codes, and every key is an apiErrorCode", () => {
    expect(Object.keys(ADDED_FACTS_ERROR_MESSAGES).sort()).toEqual([...CODES].sort())
    for (const code of Object.keys(ADDED_FACTS_ERROR_MESSAGES)) {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true)
    }
  })

  it("carries the contract's messages byte for byte", () => {
    expect(ADDED_FACTS_ERROR_MESSAGES).toEqual({
      added_facts_frozen: "This Application was sent or closed, so its added facts can't change. Nothing changed.",
      added_facts_busy: "Eve is writing or submitting this Application's documents. Wait until that finishes, then try again. Nothing changed.",
      added_facts_conflict: "The added facts changed in another tab or request. Reload the list and try again. Nothing changed.",
      added_facts_invalid: "Check the highlighted fields. Nothing was saved.",
      added_facts_limit: "That would pass the limit of added facts for this Application. Nothing was saved.",
      added_facts_not_lifted: "This Application's Match isn't strong with your added facts, so there's nothing to confirm. Nothing changed.",
      added_facts_confirmation_required: 'Confirm "Submit with your added skills" on the Application page first. Nothing changed.',
      documents_stale: "Your added facts changed after these documents were written. Generate them again first. Nothing changed.",
    })
  })

  it("adds every new code to apiErrorCodeSchema", () => {
    for (const code of CODES) expect(apiErrorCodeSchema.safeParse(code).success).toBe(true)
  })
})
