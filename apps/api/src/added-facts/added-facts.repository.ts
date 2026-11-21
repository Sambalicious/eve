import { randomUUID } from "node:crypto"

import { Injectable } from "@nestjs/common"
import type { Selectable } from "kysely"

import type { ApplicationAddedFactTable, ApplicationTable, StoredSection } from "../db/schema.js"
import { sql } from "../db/sql.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { containsKeyword, normaliseForAts } from "../ats/ats-score.js"
import type { ContactHeader } from "../documents/document-model.js"
import type { RecordedDocument } from "./document-records.js"
import { gapTermAllowed } from "./gap-terms.js"

export type AddedFactRow = Selectable<ApplicationAddedFactTable>

/** A new fact as a write stores it. */
export type NewAddedFact = Readonly<{
  kind: "skill_only" | "one_liner"
  text: string
  term: string | null
  roleSectionId: string | null
  roleSnapshot: { title: string; employer: string | null; period: string | null } | null
  roleProfileVersion: number | null
  saveToProfile: boolean
  affirmedAt: Date
}>

/** The live gap list: the current resume's stored `ats.gaps` minus the terms an added fact closes, filtered to terms a tick could store. */
export function gapTermsOf(
  resume: { ats?: { gaps?: unknown; total?: unknown } } | null | undefined,
  facts: readonly Pick<AddedFactRow, "kind" | "text">[],
  contact: ContactHeader | null
): { available: boolean; terms: string[] } {
  const gaps = resume?.ats?.gaps
  const total = resume?.ats?.total
  if (!Array.isArray(gaps) || typeof total !== "number" || total === 0) return { available: false, terms: [] }
  const terms = gaps.filter((gap): gap is string => typeof gap === "string" && gapTermAllowed(gap, contact))
  return { available: true, terms: terms.filter((term) => !facts.some((fact) => closesGap(fact, term))) }
}

/** A skill-only fact closes its own term; a one-liner closes a term its text names by the ATS matcher. */
export function closesGap(fact: Pick<AddedFactRow, "kind" | "text">, term: string): boolean {
  if (fact.kind === "skill_only") return fact.text.trim().toLowerCase() === term.trim().toLowerCase()
  return containsKeyword(normaliseForAts(fact.text), term)
}

/** The experience sections of the Career Profile version the roles are offered from (the documents' version, else the approved one). */
export function experienceRoles(sections: readonly StoredSection[]): Array<{ sectionId: string; title: string; employer: string | null; period: string | null }> {
  return sections
    .filter((section) => section.kind === "experience")
    .map((section) => ({ sectionId: section.id, title: section.title, employer: section.organization, period: section.period }))
}

/**
 * FEAT-0017: the added facts of the scope's Candidate's Application. Every method
 * runs in the Candidate's `CandidateTx` and names its `candidate_id`; mutations
 * lock the Application row first, so the counter, the caps and the queue drop are
 * decided under one lock.
 */
@Injectable()
export class AddedFactsRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  transaction<T>(work: (trx: CandidateTx, candidateId: string) => Promise<T>): Promise<T> {
    return this.tenant.run(work)
  }

  /** The Application as this Candidate may see it, or undefined (404, no existence oracle). */
  findApplication(trx: CandidateTx, candidateId: string, id: string): Promise<Selectable<ApplicationTable> | undefined> {
    return trx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("id", "=", id).executeTakeFirst()
  }

  /** The Application FOR UPDATE: the lock every mutation, the confirmation and the queue drop share. */
  lockApplication(trx: CandidateTx, candidateId: string, id: string): Promise<Selectable<ApplicationTable> | undefined> {
    return trx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("id", "=", id).forUpdate().executeTakeFirst()
  }

  list(trx: CandidateTx, candidateId: string, applicationId: string): Promise<AddedFactRow[]> {
    return trx
      .selectFrom("application_added_fact")
      .selectAll()
      .where("candidate_id", "=", candidateId)
      .where("application_id", "=", applicationId)
      .orderBy("created_at")
      .orderBy("id")
      .execute()
  }

  findFact(trx: CandidateTx, candidateId: string, applicationId: string, factId: string): Promise<AddedFactRow | undefined> {
    return trx.selectFrom("application_added_fact").selectAll().where("candidate_id", "=", candidateId).where("application_id", "=", applicationId).where("id", "=", factId).executeTakeFirst()
  }

  insert(trx: CandidateTx, candidateId: string, applicationId: string, fact: NewAddedFact): Promise<AddedFactRow> {
    return trx
      .insertInto("application_added_fact")
      .values({
        id: randomUUID(),
        candidate_id: candidateId,
        application_id: applicationId,
        kind: fact.kind,
        text: fact.text,
        // Written by SQL so the stored key is exactly the lower(btrim(text)) the database checks.
        text_key: sql<string>`lower(btrim(${fact.text}))`,
        term: fact.term,
        role_section_id: fact.roleSectionId,
        role_snapshot: fact.roleSnapshot === null ? null : JSON.stringify(fact.roleSnapshot),
        role_profile_version: fact.roleProfileVersion,
        affirmed_at: fact.affirmedAt,
        save_to_profile: fact.saveToProfile,
        profile_draft_version: null,
        created_at: fact.affirmedAt,
        updated_at: fact.affirmedAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  /**
   * SEC-R06: the duplicate key of each text, as the database computes it
   * (`lower(btrim(text))`), with the ids of the facts that already hold it. No
   * JavaScript lower-case is involved: it disagrees with the database's for
   * `ΟΣ` (final sigma) and `İ`, and that disagreement was a 23505/23514 500.
   */
  async textKeys(
    trx: CandidateTx,
    candidateId: string,
    applicationId: string,
    texts: readonly string[]
  ): Promise<Map<string, { key: string; factIds: string[] }>> {
    if (texts.length === 0) return new Map()
    const rows = await sql<{ text: string; key: string; id: string | null }>`
      select t.text, lower(btrim(t.text)) as key, f.id
        from unnest(${[...texts]}::text[]) as t(text)
        left join application_added_fact f
          on f.candidate_id = ${candidateId}
         and f.application_id = ${applicationId}
         and f.text_key = lower(btrim(t.text))`.execute(trx)
    const keys = new Map<string, { key: string; factIds: string[] }>()
    for (const row of rows.rows) {
      const entry = keys.get(row.text) ?? { key: row.key, factIds: [] }
      if (row.id !== null) entry.factIds.push(row.id)
      keys.set(row.text, entry)
    }
    return keys
  }

  async update(trx: CandidateTx, candidateId: string, factId: string, values: { kind: "one_liner"; text: string; roleSectionId: string; roleSnapshot: { title: string; employer: string | null; period: string | null }; at: Date }): Promise<void> {
    await trx
      .updateTable("application_added_fact")
      // SEC-R06: same key function as `insert` and the CHECK: SQL computes it, never JavaScript.
      .set({ kind: values.kind, text: values.text, text_key: sql<string>`lower(btrim(${values.text}))`, role_section_id: values.roleSectionId, role_snapshot: JSON.stringify(values.roleSnapshot), updated_at: values.at })
      .where("candidate_id", "=", candidateId)
      .where("id", "=", factId)
      .execute()
  }

  async remove(trx: CandidateTx, candidateId: string, factId: string): Promise<void> {
    await trx.deleteFrom("application_added_fact").where("candidate_id", "=", candidateId).where("id", "=", factId).execute()
  }

  /** The document rows' recorded counter and snapshot, for the stale rule and the gaps. */
  async documents(trx: CandidateTx, candidateId: string, applicationId: string): Promise<RecordedDocument[]> {
    const rows = await trx
      .selectFrom("tailored_document")
      .select(["kind", "career_profile_version", "added_facts_version", "added_facts", "content"])
      .where("candidate_id", "=", candidateId)
      .where("application_id", "=", applicationId)
      .orderBy(sql`case when kind = 'resume' then 0 else 1 end`)
      .orderBy("kind")
      .execute()
    return rows.map((row) => {
      const snapshot = (row.added_facts ?? { available: [], cited: [] }) as RecordedDocument["available"] extends never ? never : { available?: RecordedDocument["available"]; cited?: string[] }
      return {
        kind: row.kind,
        careerProfileVersion: row.career_profile_version,
        version: row.added_facts_version,
        cited: Array.isArray(snapshot.cited) ? snapshot.cited : [],
        available: Array.isArray(snapshot.available) ? snapshot.available : [],
      }
    })
  }

  /** The resume's content, for its stored ATS gaps. */
  async resumeContent(trx: CandidateTx, candidateId: string, applicationId: string): Promise<{ ats?: { gaps?: unknown; total?: unknown } } | null> {
    const row = await trx.selectFrom("tailored_document").select("content").where("candidate_id", "=", candidateId).where("application_id", "=", applicationId).where("kind", "=", "resume").executeTakeFirst()
    return (row?.content as { ats?: { gaps?: unknown; total?: unknown } } | undefined) ?? null
  }

  /** The approved Career Profile version, for the default role list. */
  async approvedProfile(trx: CandidateTx, candidateId: string): Promise<{ version: number; sections: StoredSection[] } | undefined> {
    const row = await trx.selectFrom("career_profile_version").select(["version", "sections"]).where("candidate_id", "=", candidateId).where("status", "=", "approved").executeTakeFirst()
    return row === undefined ? undefined : { version: row.version, sections: row.sections as StoredSection[] }
  }

  async profileVersion(trx: CandidateTx, candidateId: string, version: number): Promise<{ version: number; sections: StoredSection[] } | undefined> {
    const row = await trx.selectFrom("career_profile_version").select(["version", "sections"]).where("candidate_id", "=", candidateId).where("version", "=", version).executeTakeFirst()
    return row === undefined ? undefined : { version: row.version, sections: row.sections as StoredSection[] }
  }

  async contact(trx: CandidateTx, candidateId: string): Promise<{ full_name: string; lines: string[] }> {
    const row = await trx.selectFrom("candidate_contact").select(["full_name", "lines"]).where("candidate_id", "=", candidateId).executeTakeFirst()
    return row ?? { full_name: "", lines: [] }
  }

  /** Sets `profile_draft_version` on facts whose draft copy landed; the audit line only. */
  async markSavedToProfile(trx: CandidateTx, candidateId: string, entries: readonly Readonly<{ factId: string; draftVersion: number }>[]): Promise<void> {
    for (const entry of entries) {
      await trx.updateTable("application_added_fact").set({ profile_draft_version: entry.draftVersion }).where("candidate_id", "=", candidateId).where("id", "=", entry.factId).execute()
    }
  }
}
