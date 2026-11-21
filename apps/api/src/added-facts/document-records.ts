import type { StoredAddedFactUsed, StoredAddedFactsSnapshot } from "../db/schema.js"
import type { CandidateTx } from "../db/tenant-database.js"
import type { RecordedAddedFacts } from "./added-facts-gate.js"

/**
 * FEAT-0017: what the current documents recorded about the added-fact set at
 * generation (PRD 5.10). One helper for every reader (the view, the queue gate,
 * the submit-time check, `requeueAtsHeld`, the Confirmed email), so they cannot
 * disagree about "the set these documents were written from".
 */
export type RecordedDocument = Readonly<{
  kind: "resume" | "cover_letter"
  /** The Career Profile version the document was written from. */
  careerProfileVersion: number
  version: number
  cited: readonly string[]
  available: readonly StoredAddedFactUsed[]
}>

const EMPTY: StoredAddedFactsSnapshot = { available: [], cited: [] }

/** Both current documents of one Application, resume first. Empty when it has none. */
export async function recordedDocuments(trx: CandidateTx, candidateId: string, applicationId: string): Promise<RecordedDocument[]> {
  const rows = await trx
    .selectFrom("tailored_document")
    .select(["kind", "career_profile_version", "added_facts_version", "added_facts"])
    .where("candidate_id", "=", candidateId)
    .where("application_id", "=", applicationId)
    .orderBy("kind")
    .execute()
  return rows.map((row) => {
    const snapshot = (row.added_facts ?? EMPTY) as StoredAddedFactsSnapshot
    return {
      kind: row.kind,
      careerProfileVersion: row.career_profile_version,
      version: row.added_facts_version,
      cited: Array.isArray(snapshot.cited) ? snapshot.cited : [],
      available: Array.isArray(snapshot.available) ? snapshot.available : [],
    }
  })
}

/** The stale rule's input: one entry per current document. */
export function toRecordedAddedFacts(documents: readonly RecordedDocument[]): RecordedAddedFacts[] {
  return documents.map((document) => ({ version: document.version, cited: document.cited }))
}

/** Every added-fact row id the current documents cite, resume then cover letter. */
export function citedFactIds(documents: readonly RecordedDocument[]): Set<string> {
  return new Set(documents.flatMap((document) => document.cited))
}

/**
 * The union of the current documents' cited facts as they read at generation,
 * de-duplicated by id, keeping only facts that still exist on the Application
 * (a removed fact is no longer "used"; its old documents are stale instead).
 */
export function citedAddedFacts(documents: readonly RecordedDocument[], current: ReadonlyMap<string, StoredAddedFactUsed>): StoredAddedFactUsed[] {
  const seen = new Set<string>()
  const out: StoredAddedFactUsed[] = []
  for (const document of documents) {
    for (const fact of document.available) {
      if (!document.cited.includes(fact.id) || seen.has(fact.id) || !current.has(fact.id)) continue
      seen.add(fact.id)
      out.push(fact)
    }
  }
  return out
}
