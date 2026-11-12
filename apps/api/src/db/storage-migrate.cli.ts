import { createDatabase } from "./create-database.js"
import { migrateStorage } from "../files/storage-migrate.js"
import { countStoredFileRows, storedFileRows } from "../files/storage-migrate-rows.js"

/**
 * `pnpm storage:migrate` (EPIC-0002 A2, architecture r4 Files). Runs once at
 * deploy, after `migrate` and before the api and worker start, with the
 * migration owner's DATABASE_URL and write access to the file volume.
 * OLD_RESUME_STORAGE_DIR / OLD_DOCUMENT_STORAGE_DIR are the pre-A2 flat
 * directories (default /data/resumes, /data/documents); CANDIDATE_STORAGE_DIR
 * is the new root (default /data/candidates). Output: counts and IDs only.
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is required\n")
  process.exit(1)
}
const db = createDatabase(databaseUrl, { statementTimeoutMs: 0 })
try {
  // Read as the owner role under forced RLS: one forCandidate scope per Candidate (F-QA-01).
  const rows = await storedFileRows(db)
  const expectedRows = await countStoredFileRows(db)
  const report = await migrateStorage(rows, {
    expectedRows,
    oldResumeDir: process.env.OLD_RESUME_STORAGE_DIR ?? "/data/resumes",
    oldDocumentDir: process.env.OLD_DOCUMENT_STORAGE_DIR ?? "/data/documents",
    candidateRoot: process.env.CANDIDATE_STORAGE_DIR ?? "/data/candidates",
  })
  process.stdout.write(`storage:migrate ${report.result}: copied ${report.copied}, already in place ${report.alreadyInPlace}, optional missing ${report.skippedOptional}, unreferenced left ${report.unreferenced}\n`)
  for (const problem of report.problems) process.stderr.write(`storage:migrate problem ${problem.kind}: Candidate ${problem.candidateId} ${problem.area}/${problem.storageName}\n`)
  if (report.result === "failed") process.exitCode = 1
} catch (error) {
  process.stderr.write(`storage:migrate failed: ${error instanceof Error ? error.name : "unknown"}\n`)
  process.exitCode = 1
} finally {
  await db.destroy()
}
