import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication, INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { createDatabase } from "../src/db/create-database.js"
import { CLOCK } from "../src/shared/clock.js"
import { BROWSER_MUTEX_KEY } from "../src/submission/browser-mutex.js"
import { FORM_SESSION_FACTORY } from "../src/submission/form-session.js"
import { SubmissionJobs } from "../src/worker/submission-jobs.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { QUESTION_SCHEMAS } from "../src/submission/question-schema.js"
import { FakeAtsForms, STANDARD_FORM } from "./support/fake-ats-form.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertEligibilityFor, insertPostingFor } from "./support/candidate-posting.js"

/**
 * SEC-508: ADR 0005 crash recovery runs only in the worker, and only for
 * attempts whose browser lease (the global browser advisory lock) is free.
 * Booting the api must never touch an in-flight claim or click.
 */
let database: TestDatabase
let storage: string
const clock = new TestClock("2026-10-20T09:00:00.000Z")
const forms = new FakeAtsForms()

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-recovery-int-"))
  markStorageMigratedSync(storage)
  database = await startMigratedDatabase()
})

beforeEach(async () => {
  for (const table of ["notification_outbox", "submission_event", "application", "candidate_posting", "job_posting"] as const) await database.db.deleteFrom(table).execute()
  forms.use({ host: "boards.greenhouse.io", controls: STANDARD_FORM })
})

afterAll(async () => {
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

async function inFlight(state: "submit_claimed" | "submitting"): Promise<string> {
  const postingId = randomUUID()
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/co/jobs/${id.slice(0, 6)}`
  await insertPostingFor(database.db, database.operatorId, { id: postingId, application_url: url, requisition_id: id.slice(0, 6), apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Frontend Engineer", company: `Co ${id.slice(0, 4)}`, posting_text: "Remote.", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date(), evaluated_at: new Date() })
  await insertEligibilityFor(database.db, database.operatorId, postingId)
  await database.db
    .insertInto("application")
    .values({ candidate_id: database.operatorId, id, job_posting_id: postingId, application_url: url, requisition_id: id.slice(0, 6), company: `Co ${id.slice(0, 4)}`, role_title: "Senior Frontend Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date(), submission_state: state, submission_kind: "automatic", attempt_id: randomUUID(), submit_clicked_at: state === "submitting" ? new Date() : null })
    .execute()
  return id
}

const states = async (ids: readonly string[]) =>
  (await database.db.selectFrom("application").select(["id", "submission_state"]).where("id", "in", ids).orderBy("id").execute()).map((row) => row.submission_state)

async function bootWorker(): Promise<INestApplicationContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [WorkerModule.forRoot({ databaseUrl: database.url, anthropic: anthropicConfig(undefined, "claude-haiku-5-5"), candidateStorageDir: storage })],
  })
    .overrideProvider(WorkerHeartbeat)
    .useValue({ onApplicationBootstrap: () => undefined, onApplicationShutdown: () => undefined })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(FORM_SESSION_FACTORY)
    .useValue(forms)
    .overrideProvider(QUESTION_SCHEMAS)
    .useValue(forms.questionSchemas)
    .compile()
  await moduleRef.init()
  return moduleRef
}

describe("crash recovery runs only in the worker (SEC-508, ADR 0005)", () => {
  it("booting the api leaves submit_claimed and submitting rows alone", async () => {
    const ids = [await inFlight("submit_claimed"), await inFlight("submitting")]
    let api: INestApplication | undefined
    try {
      api = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: storage } })
      expect(await states(ids)).toEqual(expectedStates(ids))
    } finally {
      await api?.close()
    }
    const outbox = await database.db.selectFrom("notification_outbox").select("kind").execute()
    expect(outbox).toEqual([])
  })

  it("booting the worker with no live browser lease turns them Uncertain, with an outbox row each", async () => {
    const ids = [await inFlight("submit_claimed"), await inFlight("submitting")]
    const worker = await bootWorker()
    try {
      expect(await states(ids)).toEqual(["uncertain", "uncertain"])
      expect(await database.db.selectFrom("notification_outbox").select("kind").execute()).toEqual([{ kind: "uncertain" }, { kind: "uncertain" }])
    } finally {
      await worker.close()
    }
  })

  it("a worker that boots while another process holds the browser lease leaves the live attempt alone", async () => {
    const ids = [await inFlight("submitting")]
    const other = createDatabase(database.url)
    try {
      await other.connection().execute(async (connection) => {
        await sql`select pg_advisory_lock(${BROWSER_MUTEX_KEY})`.execute(connection)
        try {
          const worker = await bootWorker()
          try {
            expect(await states(ids)).toEqual(["submitting"])
            expect(await worker.get(SubmissionJobs).recoverInterrupted()).toBe("lease_held")
          } finally {
            await worker.close()
          }
        } finally {
          await sql`select pg_advisory_unlock(${BROWSER_MUTEX_KEY})`.execute(connection)
        }
      })
    } finally {
      await other.destroy()
    }
  })
})

/** The rows in id order, as inserted: claimed then submitting. */
function expectedStates(ids: readonly string[]): Array<string | null> {
  const byId = new Map([
    [ids[0]!, "submit_claimed"],
    [ids[1]!, "submitting"],
  ])
  return [...ids].sort().map((id) => byId.get(id) ?? null)
}
