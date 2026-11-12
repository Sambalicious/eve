import { createHash, randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { storedFileRows } from "../src/files/storage-migrate-rows.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"

/**
 * QA gap test (run epic-0002-a2, F-QA-01). `pnpm storage:migrate` runs with the
 * migration owner's DATABASE_URL (storage-migrate.cli.ts, docker-compose
 * `storage-migrate`, docs/ops/deploy.md), not the bootstrap superuser the other
 * storage specs use. Under the forced RLS of migration 0017 the owner role must
 * still see every Candidate's stored-file rows, or the move copies nothing and
 * writes the completion marker anyway (migration-and-operator-bootstrap.feature:701, :709).
 */
let database: TestDatabase
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

beforeAll(async () => {
  database = await startMigratedDatabase()
})

afterAll(async () => {
  await database?.stop()
})

describe("storage:migrate reads every stored-file row with the role it is deployed with", () => {
  it("the migration owner role sees the Operator's and an invitee's resume rows", async () => {
    const other = await insertSecondCandidate(database.db)
    for (const candidateId of [database.operatorId, other]) {
      const id = randomUUID()
      await database.db.insertInto("resume_upload").values({ candidate_id: candidateId, id, original_filename: "r.pdf", media_type: "application/pdf", byte_size: 1, sha256: sha(id), storage_name: `${id}.pdf`, status: "drafted", failure_reason: null, started_at: new Date(), finished_at: new Date() }).execute()
    }
    expect(await storedFileRows(database.db)).toHaveLength(2)

    const owner = createDatabase(database.ownerUrl, { statementTimeoutMs: 0 })
    try {
      const rows = await storedFileRows(owner)
      expect(rows.map((row) => row.candidateId).sort()).toEqual([database.operatorId, other].sort())
    } finally {
      await owner.destroy()
    }
  })
})
