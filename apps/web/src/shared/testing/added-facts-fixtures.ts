import type { AddedFact, AddedFactUsed, AddedFactsView, ApplicationDetail } from "@eve/contracts"

import { readyApplication } from "./documents-api"

/**
 * FEAT-0017 MSW fixtures (api-contract.md v1.32.0, "Frontend MSW fixtures" and E1 to E10).
 * Builder overrides are partial; the named states are the contract's examples, kept in one place so a
 * component test asserts against the same shape the api sends.
 */

export const ADDED_APPLICATION_ID = "a1b2c3d4-0000-4000-8000-000000000001"
export const FIGMA_FACT_ID = "f0000000-0000-4000-8000-000000000001"
export const CICD_FACT_ID = "f0000000-0000-4000-8000-000000000002"
export const ROLE_ACME = { sectionId: "sec-exp-1", title: "Frontend Engineer", employer: "Acme Ltd", period: "2021 to 2023" } as const
export const ROLE_BRIGHTWAVE = { sectionId: "sec-exp-2", title: "Senior Engineer", employer: "Brightwave Ltd", period: "2023 to present" } as const
const AT = "2026-11-21T09:00:00.000Z"

/** The frozen shape a document cites (`addedFactUsedSchema`: id, kind, text, role as title, employer and period). */
function used(fact: AddedFact): AddedFactUsed {
  return { id: fact.id, kind: fact.kind, text: fact.text, role: fact.role === null ? null : { title: fact.role.title, employer: fact.role.employer, period: fact.role.period } }
}

const LIMITS = { oneLiner: 10, skillOnly: 40, textMax: 300 } as const

export function skillOnlyFact(overrides: Partial<AddedFact> = {}): AddedFact {
  return {
    id: FIGMA_FACT_ID,
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
    ...overrides,
  }
}

export function oneLinerFact(overrides: Partial<AddedFact> = {}): AddedFact {
  return {
    id: CICD_FACT_ID,
    kind: "one_liner",
    text: "Set up GitHub Actions CI/CD pipelines at Acme",
    term: "CI/CD pipelines",
    role: { ...ROLE_ACME, inProfileVersion: true },
    saveToProfile: true,
    profile: { status: "draft", version: 5 },
    usedInDocuments: false,
    affirmedAt: AT,
    createdAt: AT,
    updatedAt: "2026-11-21T09:05:00.000Z",
    ...overrides,
  }
}

export function addedFactsView(overrides: Partial<AddedFactsView> = {}): AddedFactsView {
  return {
    version: 0,
    editable: true,
    frozenReason: null,
    busyReason: null,
    profileVersion: 4,
    roles: [{ ...ROLE_ACME }, { ...ROLE_BRIGHTWAVE }],
    facts: [],
    counts: { oneLiner: 0, skillOnly: 0 },
    limits: { ...LIMITS },
    postingGaps: { available: true, terms: ["design systems", "component library", "error boundaries"] },
    documentsStale: false,
    addedFactsCited: [],
    match: null,
    confirmation: { state: "not_required", voided: false, confirmedAt: null },
    ...overrides,
  }
}

/** E1: Editable, two facts, documents stale, lifted, confirmation stale. */
export const editableWithFacts = (overrides: Partial<AddedFactsView> = {}): AddedFactsView =>
  addedFactsView({
    version: 2,
    facts: [oneLinerFact(), skillOnlyFact()],
    counts: { oneLiner: 1, skillOnly: 1 },
    documentsStale: true,
    addedFactsCited: [used(skillOnlyFact())],
    match: {
      careerProfileVersion: 4,
      thresholdPercent: 70,
      posting: { covered: 5, total: 9, unmetMandatory: 0, verdict: "weak" },
      withAdded: { covered: 7, total: 9, unmetMandatory: 0, verdict: "strong" },
      lifted: true,
      covers: [
        { group: "core", requirement: "Build and maintain our Figma-based design handoff", factId: FIGMA_FACT_ID, kind: "skill_only" },
        { group: "core", requirement: "Own CI/CD pipelines for the web app", factId: CICD_FACT_ID, kind: "one_liner" },
      ],
    },
    confirmation: { state: "stale", voided: true, confirmedAt: null },
    ...overrides,
  })

/** E2: the same Application after Generate again (fresh, ready to confirm). */
export const freshLifted = (overrides: Partial<AddedFactsView> = {}): AddedFactsView =>
  editableWithFacts({
    documentsStale: false,
    facts: [oneLinerFact({ usedInDocuments: true }), skillOnlyFact()],
    addedFactsCited: [used(skillOnlyFact()), used(oneLinerFact())],
    confirmation: { state: "required", voided: true, confirmedAt: null },
    ...overrides,
  })

/** E3: confirmed at the current counter. */
export const confirmed = (overrides: Partial<AddedFactsView> = {}): AddedFactsView =>
  freshLifted({ confirmation: { state: "confirmed", voided: false, confirmedAt: "2026-11-21T10:00:00.000Z" }, ...overrides })

/** A change after the confirmation: keep the old confirmation, add the void marker. */
export const voidedStale = (overrides: Partial<AddedFactsView> = {}): AddedFactsView =>
  editableWithFacts({ editable: true, frozenReason: null, documentsStale: true, confirmation: { state: "stale", voided: true, confirmedAt: null }, ...overrides })

/** E8: Frozen view of a Confirmed Submission. */
export const frozenSubmitted = (overrides: Partial<AddedFactsView> = {}): AddedFactsView =>
  addedFactsView({
    version: 3,
    editable: false,
    frozenReason: "submitted",
    roles: [{ ...ROLE_ACME }],
    facts: [oneLinerFact(), skillOnlyFact()],
    counts: { oneLiner: 1, skillOnly: 1 },
    postingGaps: { available: true, terms: ["design systems"] },
    documentsStale: false,
    addedFactsCited: [{ id: FIGMA_FACT_ID, kind: "skill_only", text: "Figma", role: null }],
    match: null,
    confirmation: { state: "not_required", voided: false, confirmedAt: null },
    ...overrides,
  })

/** E9: busy generating, no ATS result, no role. */
export const busyGenerating = (overrides: Partial<AddedFactsView> = {}): AddedFactsView =>
  addedFactsView({
    editable: false,
    busyReason: "generating",
    roles: [],
    postingGaps: { available: false, terms: [] },
    ...overrides,
  })

/** OD-14, AC 1.5: no documents yet, so no ATS result; free entry still works. */
export const noAtsResult = (overrides: Partial<AddedFactsView> = {}): AddedFactsView =>
  addedFactsView({ postingGaps: { available: false, terms: [] }, ...overrides })

/** AC 2.4, 6.8: an approved version with no experience role. */
export const noRole = (overrides: Partial<AddedFactsView> = {}): AddedFactsView => addedFactsView({ roles: [], ...overrides })

/** AC 1.7: ten one-liners (the limit). */
export const atLimit = (overrides: Partial<AddedFactsView> = {}): AddedFactsView => {
  const facts = Array.from({ length: 10 }, (_, index) =>
    oneLinerFact({ id: `f0000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`, text: `Built pipeline number ${index} at Acme`, term: null })
  )
  return addedFactsView({ version: 10, facts, counts: { oneLiner: 10, skillOnly: 0 }, ...overrides })
}

/** AC 1.7: forty skill-only facts (the safety ceiling). */
export const skillCeiling = (overrides: Partial<AddedFactsView> = {}): AddedFactsView => {
  const facts = Array.from({ length: 40 }, (_, index) =>
    skillOnlyFact({ id: `f0000000-0000-4000-8000-0000000002${String(index).padStart(2, "0")}`, text: `term ${index}`, term: `term ${index}` })
  )
  return addedFactsView({ version: 40, facts, counts: { oneLiner: 0, skillOnly: 40 }, postingGaps: { available: true, terms: ["term 40"] }, ...overrides })
}

/** The named states, in contract order; a handler or a story can loop over this. */
export const ADDED_FACTS_STATES = {
  editableEmpty: addedFactsView,
  editableWithFacts,
  freshLifted,
  confirmed,
  voidedStale,
  frozenSubmitted,
  busyGenerating,
  noAtsResult,
  noRole,
  atLimit,
  skillCeiling,
} as const

/** An ApplicationDetail that carries a view, as `GET /v1/applications/{id}` does with the flag on. */
export function applicationWithAddedFacts(view: AddedFactsView = editableWithFacts(), overrides: Partial<ApplicationDetail> = {}): ApplicationDetail {
  return readyApplication({ id: ADDED_APPLICATION_ID, addedFacts: view, ...overrides })
}
