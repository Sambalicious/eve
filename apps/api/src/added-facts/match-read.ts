import type { Selectable } from "kysely"

import type { ApplicationTable, StoredSection } from "../db/schema.js"
import type { CandidateTx } from "../db/tenant-database.js"
import { tenureMonths } from "../discovery/rules/tenure.js"
import { decisionCriteria } from "../discovery/rules/job-criteria.js"
import { applicationMatch, type AddedFactForMatch, type ApplicationMatchResult } from "./application-match.js"

export type { ApplicationMatchResult }

/** The posting's stored technology entries, as `job_posting.technologies` holds them. */
type StoredTechnology = Readonly<{ name: string; quote?: string }>

/**
 * FEAT-0017: the live Application Match for one Application, read in the caller's
 * transaction (the added-facts write, the view, the queue gate and the submit-time
 * check all call this, so they cannot disagree). Null when there is nothing to
 * compute: details deleted, no approved Career Profile, or no stored posting Match.
 *
 * The Job criteria row is read with the caller's locks; a caller that must not race
 * a criteria save reads it FOR SHARE first, as the submission claim does.
 */
export async function readApplicationMatch(
  trx: CandidateTx,
  candidateId: string,
  application: Pick<Selectable<ApplicationTable>, "id" | "job_posting_id" | "requisition_id" | "details_deleted_at" | "added_facts_version">,
  now: Date
): Promise<ApplicationMatchResult | null> {
  if (application.details_deleted_at !== null) return null
  const profile = await trx.selectFrom("career_profile_version").select(["version", "sections"]).where("candidate_id", "=", candidateId).where("status", "=", "approved").executeTakeFirst()
  if (!profile) return null
  const evidence = await trx.selectFrom("match_evidence").select(["items"]).where("candidate_id", "=", candidateId).where("job_posting_id", "=", application.job_posting_id).executeTakeFirst()
  if (!evidence) return null
  const criteriaRow = await trx.selectFrom("job_criteria").select(["min_core_match_percent", "frameworks", "technologies", "version"]).where("candidate_id", "=", candidateId).executeTakeFirst()
  const criteria = decisionCriteria({
    minCoreMatchPercent: criteriaRow?.min_core_match_percent ?? 70,
    frameworks: criteriaRow?.frameworks ?? [],
    technologies: criteriaRow?.technologies ?? [],
  })
  const posting = await trx
    .selectFrom("job_posting as p")
    .leftJoin("candidate_posting as cp", (join) => join.onRef("cp.job_posting_id", "=", "p.id").on("cp.candidate_id", "=", candidateId))
    .leftJoin("eligibility_result as e", (join) => join.onRef("e.job_posting_id", "=", "p.id").on("e.candidate_id", "=", candidateId))
    .select(["p.technologies", "p.apply_mode", "cp.status", "cp.skip_reason", "e.rules"])
    .where("p.id", "=", application.job_posting_id)
    .executeTakeFirst()
  if (!posting) return null
  const sections = profile.sections as StoredSection[]
  const experience = new Set(sections.filter((section) => section.kind === "experience").map((section) => section.id))
  const facts = await trx
    .selectFrom("application_added_fact")
    .select(["id", "kind", "text", "term", "role_section_id"])
    .where("candidate_id", "=", candidateId)
    .where("application_id", "=", application.id)
    .orderBy("created_at")
    .orderBy("id")
    .execute()
  const addedFacts: AddedFactForMatch[] = facts.map((fact) => ({
    id: fact.id,
    kind: fact.kind,
    text: fact.text,
    term: fact.term,
    roleInProfile: fact.kind === "skill_only" || (fact.role_section_id !== null && experience.has(fact.role_section_id)),
  }))
  const technologies = posting.technologies as StoredTechnology[] | null
  return applicationMatch({
    profileVersion: profile.version,
    addedFactsVersion: application.added_facts_version,
    criteriaVersion: criteriaRow?.version ?? 0,
    items: evidence.items,
    approvedFactIds: new Set(sections.flatMap((section) => section.facts.map((fact) => fact.id))),
    tenureMonths: tenureMonths(sections, now),
    criteria,
    technologyNames: technologies === null ? null : technologies.map((entry) => entry.name),
    postingStatus: posting.status ?? "checking",
    skipReason: posting.skip_reason,
    violatedRules: [...new Set((posting.rules ?? []).filter((rule) => rule.result === "violated").map((rule) => rule.rule))],
    manualOnly: application.requisition_id.startsWith("pasted:") || posting.apply_mode === "manual",
    addedFacts,
  })
}
