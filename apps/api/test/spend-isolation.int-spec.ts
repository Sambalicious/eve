import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { SpendLedger } from "../src/spend/spend-ledger.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 A1 unit 2 (spend group). The ledger stays one installation-wide
 * ledger until slice D adds a Candidate kind, so there is no per-Candidate
 * row to hide. What must hold now: ledger transactions carry no Candidate
 * setting, and the cost-pause email (E4) always belongs to the Operator, even
 * when a non-Operator Candidate's action trips the pause, so it can never be
 * sent to or shown to that Candidate.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let owner: SignedInCandidate
let otherId: string
let operatorId: string
const USD = 1_000_000
const clock = new TestClock("2026-10-20T09:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  owner = await signInCandidate(new Browser(app, google))
  otherId = await insertSecondCandidate(database.db)
  operatorId = (await database.db.selectFrom("candidate").select("id").where("role", "=", "operator").executeTakeFirstOrThrow()).id
})

beforeEach(async () => {
  for (const table of ["notification_outbox", "spend_entry", "spend_month"] as const) await database.db.deleteFrom(table).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false, cost_paused_at: null, cost_paused_month: null }).execute()
  await database.db.insertInto("spend_month").values({ month: "2026-10-01", ceiling_micros: 50 * USD, raised_at: null, created_at: clock.now() }).execute()
  await database.db
    .insertInto("spend_entry")
    .values({ id: randomUUID(), month: "2026-10-01", category: "ai", sub_budget: null, purpose: "seed", status: "settled", reserved_micros: 49.9 * USD, actual_micros: 49.9 * USD, application_id: null, attempt_id: null, created_at: clock.now(), settled_at: clock.now() })
    .execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("spend group stays shared until slice D", () => {
  it("a refused reservation in another Candidate's scope queues the cost-pause email for the Operator only", async () => {
    const reservation = await CandidateScope.run(otherId, () => app.get(SpendLedger).reserve({ category: "ai", purpose: "probe", estimateMicros: 1 * USD, action: "Eligibility and Match check" }))
    expect(reservation).toEqual({ ok: false, refusal: "cost_paused" })
    const emails = await database.db.selectFrom("notification_outbox").select(["candidate_id", "kind"]).execute()
    expect(emails).toEqual([{ candidate_id: operatorId, kind: "cost_pause" }])
  })

  it("the owner's controls read the one shared ledger", async () => {
    const body = (await owner.get("/v1/controls").expect(200)).body
    expect(body.spend).toMatchObject({ month: "2026-10-01", spent: "49.90" })
  })
})
