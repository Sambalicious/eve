import { randomUUID } from "node:crypto"

import type { Kysely } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { CandidateJobRunner } from "../src/worker/candidate-job-runner.js"
import { EVALUATE_POSTING } from "../src/worker/discovery-jobs.js"
import { type CandidateQueue, JobQueue, candidateQueue } from "../src/worker/job-queue.js"
import { SAMPLE_SUBMISSION } from "../src/worker/submission-jobs.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"

/**
 * EPIC-0002 A2: CandidateJobRunner on the real runtime role, so RLS applies.
 * data-isolation.feature :391 (no Candidate ID refused), :399 (another
 * Candidate's record loads nothing), :612 (no sample for a non-Operator before
 * slice E), :361 (the job loads only its Candidate's rows).
 */
let database: TestDatabase
let runtime: Kysely<Database>
let tenant: TenantDatabase
let runner: CandidateJobRunner
let otherId: string
const ADA_APPLICATION = "00000000-0000-4000-8000-00000000b001"

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  tenant = new TenantDatabase(runtime)
  runner = new CandidateJobRunner(new JobQueue({ databaseUrl: database.url }), tenant)
  otherId = await insertSecondCandidate(database.db)
  const postingId = randomUUID()
  const url = "https://boards.greenhouse.io/runner/jobs/1"
  await insertPostingFor(database.db, database.operatorId, { id: postingId, application_url: url, requisition_id: "1", apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Role", company: "Co", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date(), evaluated_at: new Date() })
  await database.db.insertInto("application").values({ id: ADA_APPLICATION, candidate_id: database.operatorId, job_posting_id: postingId, application_url: url, requisition_id: "1", company: "Co", role_title: "Role", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date() }).execute()
})

afterAll(async () => {
  await runtime?.destroy()
  await database?.stop()
})

const readApplication = (id: string) => tenant.run((tx, candidateId) => tx.selectFrom("application").select("id").where("candidate_id", "=", candidateId).where("id", "=", id).executeTakeFirst())
const readAnyApplication = (id: string) => tenant.run((tx) => tx.selectFrom("application").select("id").where("id", "=", id).executeTakeFirst())

describe("CandidateJobRunner with the runtime role", () => {
  it("a job with no Candidate ID on a strict queue is refused and runs nothing (:391)", async () => {
    // evaluate.posting accepts pre-A2 payloads as the Operator's; a strict queue does not.
    expect(await runner.run(EVALUATE_POSTING, {}, async () => undefined)).toEqual({ result: "ran", candidateId: database.operatorId })
    let ran = false
    const strict = candidateQueue<{ postingId: string }>("test.runner.strict")
    expect(await runner.run(strict, { postingId: "p" }, async () => void (ran = true))).toEqual({ result: "refused", reason: "missing_candidate_id" })
    // F-SEC-08: a copy of evaluate.posting with other options is not the declared queue.
    const copy = { ...EVALUATE_POSTING, options: {} } as CandidateQueue<{ postingId: string }>
    await expect(runner.run(copy, { postingId: "p" }, async () => void (ran = true))).rejects.toThrow(/not a declared Candidate queue/)
    expect(ran).toBe(false)
  })

  it("a job carrying B's ID that names A's Application loads nothing, even without app scoping (:399)", async () => {
    const seen: unknown[] = []
    expect(await runner.run(EVALUATE_POSTING, { candidateId: otherId, postingId: "x" }, async () => {
      seen.push(await readApplication(ADA_APPLICATION), await readAnyApplication(ADA_APPLICATION))
    })).toEqual({ result: "ran", candidateId: otherId })
    expect(seen).toEqual([undefined, undefined])
  })

  it("the Operator's job sees the Operator's Application (:361)", async () => {
    const seen: unknown[] = []
    await runner.run(EVALUATE_POSTING, { candidateId: database.operatorId, postingId: "x" }, async () => void seen.push(await readApplication(ADA_APPLICATION)))
    expect(seen).toEqual([{ id: ADA_APPLICATION }])
  })

  it("a sample job for a non-Operator is refused before slice E; a pre-A2 sample job is the Operator's (:612)", async () => {
    const ran: string[] = []
    expect(await runner.run(SAMPLE_SUBMISSION, { candidateId: otherId, applicationId: ADA_APPLICATION }, async (id) => void ran.push(id))).toEqual({ result: "refused", reason: "feature_not_yet_available" })
    expect(await runner.run(SAMPLE_SUBMISSION, { applicationId: ADA_APPLICATION }, async (id) => void ran.push(id))).toEqual({ result: "ran", candidateId: database.operatorId })
    expect(ran).toEqual([database.operatorId])
  })
})
