import type { AddedFact, AddedFactRoleOption, AddedFactsView } from "@eve/contracts"
import { ADDED_FACT_LIMITS } from "@eve/contracts"
import type { Selectable } from "kysely"

import type { ApplicationAddedFactTable, ApplicationTable, StoredAddedFactUsed, StoredSection } from "../db/schema.js"
import type { CandidateTx } from "../db/tenant-database.js"
import { containsKeyword, normaliseForAts } from "../ats/ats-score.js"
import type { ContactHeader } from "../documents/document-model.js"
import { addedFactsState } from "./added-facts-rules.js"
import { citedAddedFacts, recordedDocuments, type RecordedDocument } from "./document-records.js"
import { gapTermAllowed } from "./gap-terms.js"
import { readApplicationMatch } from "./match-read.js"
import { documentsStale } from "./added-facts-gate.js"

/**
 * FEAT-0017: the Added facts view (api-contract v1.32.0 `AddedFactsView`), built
 * from one consistent read inside the caller's transaction. It is served by
 * `GET /v1/applications/{id}/added-facts` and embedded as
 * `ApplicationDetail.addedFacts`, so the page needs one fetch and the two can
 * never disagree.
 */

/** A resume's stored gaps, when it has an ATS result with keywords: only terms a tick could store (SEC-R01). */
function resumeGaps(documents: readonly RecordedDocument[], contents: ReadonlyMap<"resume" | "cover_letter", unknown>, contact: ContactHeader | null): { available: boolean; gaps: string[] } {
  if (!documents.some((document) => document.kind === "resume")) return { available: false, gaps: [] }
  const resume = contents.get("resume") as { ats?: { gaps?: unknown; total?: unknown } } | undefined
  const gaps = resume?.ats?.gaps
  const total = resume?.ats?.total
  if (!Array.isArray(gaps) || typeof total !== "number" || total === 0) return { available: false, gaps: [] }
  return { available: true, gaps: gaps.filter((gap): gap is string => typeof gap === "string" && gapTermAllowed(gap, contact)) }
}

/** A skill-only or one-liner text closes a gap term: equality for a tick, the ATS matcher for a sentence. */
function closes(fact: Pick<Selectable<ApplicationAddedFactTable>, "kind" | "text">, term: string): boolean {
  if (fact.kind === "skill_only") return fact.text.trim().toLowerCase() === term.trim().toLowerCase()
  return containsKeyword(normaliseForAts(fact.text), term)
}

function roleOf(fact: Selectable<ApplicationAddedFactTable>, experience: ReadonlySet<string>): NonNullable<AddedFact["role"]> | null {
  if (fact.kind === "skill_only" || fact.role_snapshot === null || fact.role_section_id === null) return null
  return {
    sectionId: fact.role_section_id,
    title: fact.role_snapshot.title,
    employer: fact.role_snapshot.employer,
    period: fact.role_snapshot.period,
    inProfileVersion: experience.has(fact.role_section_id),
  }
}

export async function addedFactsView(
  trx: CandidateTx,
  candidateId: string,
  application: Selectable<ApplicationTable>,
  now: Date,
  flagOn: boolean
): Promise<AddedFactsView> {
  const [factRows, documents, contactRow, profile] = await Promise.all([
    trx
      .selectFrom("application_added_fact")
      .selectAll()
      .where("candidate_id", "=", candidateId)
      .where("application_id", "=", application.id)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute(),
    recordedDocuments(trx, candidateId, application.id),
    trx.selectFrom("candidate_contact").select(["full_name", "lines"]).where("candidate_id", "=", candidateId).executeTakeFirst(),
    trx.selectFrom("career_profile_version").select(["version", "sections"]).where("candidate_id", "=", candidateId).where("status", "=", "approved").executeTakeFirst(),
  ])
  const contact: ContactHeader = { name: contactRow?.full_name ?? "", lines: contactRow?.lines ?? [] }
  const profileVersion = documents[0]?.careerProfileVersion ?? profile?.version ?? null
  const profileRow =
    profileVersion === null
      ? undefined
      : profileVersion === profile?.version
        ? profile
        : await trx.selectFrom("career_profile_version").select(["version", "sections"]).where("candidate_id", "=", candidateId).where("version", "=", profileVersion).executeTakeFirst()
  const sections = (profileRow?.sections ?? []) as StoredSection[]
  const experience = new Set(sections.filter((section) => section.kind === "experience").map((section) => section.id))
  const roles: AddedFactRoleOption[] = sections
    .filter((section) => section.kind === "experience")
    .map((section) => ({ sectionId: section.id, title: section.title, employer: section.organization, period: section.period }))
  const contents = new Map<"resume" | "cover_letter", unknown>()
  for (const document of await trx
    .selectFrom("tailored_document")
    .select(["kind", "content"])
    .where("candidate_id", "=", candidateId)
    .where("application_id", "=", application.id)
    .execute()) {
    contents.set(document.kind, document.content)
  }
  const gaps = resumeGaps(documents, contents, contact)
  const state = addedFactsState(application)
  const current = new Map<string, StoredAddedFactUsed>(
    factRows.map((fact) => [
      fact.id,
      { id: fact.id, kind: fact.kind, text: fact.text, role: fact.kind === "skill_only" || fact.role_snapshot === null ? null : { title: fact.role_snapshot.title, employer: fact.role_snapshot.employer, period: fact.role_snapshot.period } },
    ])
  )
  const stale = documentsStale({ flagOn, applicationVersion: application.added_facts_version, documents: documents.map((document) => ({ version: document.version, cited: document.cited })) })
  const facts: AddedFact[] = factRows.map((fact) => ({
    id: fact.id,
    kind: fact.kind,
    text: fact.text,
    term: fact.term,
    role: roleOf(fact, experience),
    saveToProfile: fact.save_to_profile,
    profile: null,
    usedInDocuments: documents.some((document) => document.cited.includes(fact.id)),
    affirmedAt: fact.affirmed_at.toISOString(),
    createdAt: fact.created_at.toISOString(),
    updatedAt: fact.updated_at.toISOString(),
  }))
  // `profile` is derived at read from `profile_draft_version`: the draft while it is the draft, approved once it was approved.
  const draftVersions = [...new Set(factRows.map((fact) => fact.profile_draft_version).filter((version): version is number => version !== null))]
  const profileStatuses = new Map<number, "draft" | "approved">()
  if (draftVersions.length > 0) {
    const rows = await trx
      .selectFrom("career_profile_version")
      .select(["version", "status", "approved_at"])
      .where("candidate_id", "=", candidateId)
      .where("version", "in", draftVersions)
      .execute()
    for (const row of rows) {
      if (row.status === "draft") profileStatuses.set(row.version, "draft")
      else if (row.approved_at !== null) profileStatuses.set(row.version, "approved")
    }
  }
  for (const fact of facts) {
    const row = factRows.find((candidate) => candidate.id === fact.id)
    const version = row?.profile_draft_version ?? null
    const status = version === null ? undefined : profileStatuses.get(version)
    if (version !== null && status !== undefined) fact.profile = { status, version }
  }
  const match = flagOn && application.details_deleted_at === null ? await readApplicationMatch(trx, candidateId, application, now) : null
  const lifted = match?.lifted === true
  const confirmed = application.added_facts_confirmed_version === application.added_facts_version
  const documentsReady = application.state === "documents_ready" && documents.length > 0
  const queuedOrLater = application.submission_state !== null && application.submission_state !== "not_submitted"
  const voided = application.added_facts_confirmed_version !== null && !confirmed
  // A stale document set is the first thing the Candidate must fix; an earlier confirmation keeps the "voided" panel
  // (C-AF-68) even when the change also lost the lift. With no live lift and no earlier confirmation, the panel is absent.
  const confirmationState: AddedFactsView["confirmation"]["state"] = !documentsReady
    ? lifted
      ? "needs_documents"
      : "not_required"
    : stale
      ? lifted || voided
        ? "stale"
        : "not_required"
      : !lifted
        ? "not_required"
        : confirmed && queuedOrLater
          ? "confirmed"
          : "required"
  return {
    version: application.added_facts_version,
    editable: state.frozenReason === null && state.busyReason === null,
    frozenReason: state.frozenReason,
    busyReason: state.busyReason,
    profileVersion: profileRow?.version ?? null,
    roles,
    facts,
    counts: { oneLiner: factRows.filter((fact) => fact.kind === "one_liner").length, skillOnly: factRows.filter((fact) => fact.kind === "skill_only").length },
    limits: { oneLiner: ADDED_FACT_LIMITS.oneLiner, skillOnly: ADDED_FACT_LIMITS.skillOnly, textMax: ADDED_FACT_LIMITS.textMax },
    postingGaps: {
      available: application.details_deleted_at === null && gaps.available,
      terms: application.details_deleted_at === null ? gaps.gaps.filter((term) => !factRows.some((fact) => closes(fact, term))) : [],
    },
    documentsStale: application.details_deleted_at === null ? stale : false,
    addedFactsCited: application.details_deleted_at === null ? citedAddedFacts(documents, current) : [],
    match:
      match === null
        ? null
        : {
            careerProfileVersion: match.careerProfileVersion,
            thresholdPercent: match.thresholdPercent,
            posting: match.posting,
            withAdded: match.withAdded,
            lifted: match.lifted,
            covers: match.covers,
          },
    confirmation: { state: confirmationState, voided, confirmedAt: confirmationState === "confirmed" ? application.added_facts_confirmed_at?.toISOString() ?? null : null },
  }
}
