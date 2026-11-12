import { type Kysely } from "kysely"
import { sql } from "../db/sql.js"

import type { Database } from "../db/schema.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import type { StoredFileRow } from "./storage-migrate.js"

/**
 * Every stored file the database names, with its owner and recorded SHA-256.
 * storage:migrate runs as the migration owner role, which obeys the forced RLS
 * of migration 0017 like every application role (F-QA-01). So it reads the
 * Candidate IDs from the identity table and each Candidate's rows in that
 * Candidate's own `forCandidate` transaction (architecture r4 Tenancy
 * mechanism 5), never through an RLS exception. A failed upload may never have
 * written its file, so only its absence is tolerated.
 */
export async function storedFileRows(db: Kysely<Database>): Promise<StoredFileRow[]> {
  const tenant = new TenantDatabase(db)
  const rows: StoredFileRow[] = []
  for (const candidateId of await tenant.candidateIds()) rows.push(...(await tenant.forCandidate(candidateId, (tx) => candidateRows(tx, candidateId))))
  return rows
}

/**
 * The number of stored files the rows name, counted per Candidate with
 * `count(*)` in a separate statement from the row read. storage:migrate refuses
 * to write its marker when the rows it moved differ from this number.
 */
export async function countStoredFileRows(db: Kysely<Database>): Promise<number> {
  const tenant = new TenantDatabase(db)
  let total = 0
  for (const candidateId of await tenant.candidateIds()) {
    total += await tenant.forCandidate(candidateId, async (tx) => {
      const counted = await sql<{ n: string }>`select (select count(*) from resume_upload where candidate_id = ${candidateId}) + 2 * (select count(*) from tailored_document where candidate_id = ${candidateId}) as n`.execute(tx)
      return Number(counted.rows[0]?.n ?? 0)
    })
  }
  return total
}

async function candidateRows(tx: CandidateTx, candidateId: string): Promise<StoredFileRow[]> {
  const resumes = await tx.selectFrom("resume_upload").select(["candidate_id", "storage_name", "sha256", "status"]).where("candidate_id", "=", candidateId).execute()
  const documents = await tx.selectFrom("tailored_document").select(["candidate_id", "pdf_storage_name", "docx_storage_name", "pdf_sha256", "docx_sha256"]).where("candidate_id", "=", candidateId).execute()
  return [
    ...resumes.map((row): StoredFileRow => ({ candidateId: row.candidate_id, area: "resumes", storageName: row.storage_name, sha256: row.sha256, required: row.status !== "failed" })),
    ...documents.flatMap((row): StoredFileRow[] => [
      { candidateId: row.candidate_id, area: "documents", storageName: row.pdf_storage_name, sha256: row.pdf_sha256, required: true },
      { candidateId: row.candidate_id, area: "documents", storageName: row.docx_storage_name, sha256: row.docx_sha256, required: true },
    ]),
  ]
}
