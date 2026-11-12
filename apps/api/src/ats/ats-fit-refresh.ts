import type { CandidateTx } from "../db/tenant-database.js"
import type { StoredSection } from "../db/schema.js"
import { atsFit, atsKeywords } from "./ats-score.js"

/**
 * ATS fit depends on the Career Profile: a new approved version (a fact about Docker, say) changes how
 * many of each posting's ATS requirements the Candidate meets, and so the Ranked order. This recomputes
 * `match_evidence.ats_fit` for every evaluated posting of the transaction's Candidate from the posting's
 * stored keywords and the given profile. Code only: no model call, no spend. `onlyMissing` limits it to
 * rows without a fit (the startup sweep after 0029).
 */
export async function refreshAtsFit(trx: CandidateTx, candidateId: string, sections: readonly StoredSection[], options: Readonly<{ onlyMissing?: boolean }> = {}): Promise<number> {
  let query = trx
    .selectFrom("match_evidence as m")
    .innerJoin("job_posting as p", "p.id", "m.job_posting_id")
    .select(["m.job_posting_id", "m.ats_fit", "p.technologies", "p.ats_skills", "p.company"])
    .where("m.candidate_id", "=", candidateId)
  if (options.onlyMissing) query = query.where("m.ats_fit", "is", null)
  const rows = await query.execute()
  const profileText = sections.flatMap((section) => [section.title, ...section.facts.map((fact) => fact.text)]).join("\n")
  let changed = 0
  for (const row of rows) {
    const keywords = atsKeywords(row.technologies, row.ats_skills, row.company)
    const fit = keywords.length === 0 ? null : atsFit(keywords, profileText)
    if (fit === row.ats_fit) continue
    await trx.updateTable("match_evidence").set({ ats_fit: fit }).where("candidate_id", "=", candidateId).where("job_posting_id", "=", row.job_posting_id).execute()
    changed += 1
  }
  return changed
}
