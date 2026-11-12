import type { INestApplication } from "@nestjs/common"
import { approvedAnswersResponseSchema, salaryResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { SalaryService } from "../src/answers/salary.service.js"
import { MissingCandidateScopeError } from "../src/db/candidate-scope.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 A1 unit 2 (answers group): repositories scope every statement to
 * the session's Candidate through `TenantDatabase`, before RLS is on. A second
 * synthetic Candidate's rows are invisible and unchangeable through the owner's
 * session, and a call outside any Candidate scope throws before reading.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let browser: Browser
let owner: SignedInCandidate
let otherId: string
const OTHER_ANSWER_ID = "00000000-0000-4000-8000-0000000000b1"
const clock = new TestClock("2026-10-16T10:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
  owner = await signInCandidate(browser)
  otherId = (
    await database.db
      .insertInto("candidate")
      .values({ email: "kenya.invitee@example.test", google_sub: "synthetic-other-sub", role: "candidate" } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id
})

beforeEach(async () => {
  const now = new Date("2026-10-15T09:00:00.000Z")
  for (const table of ["approved_answer", "gross_salary_answer", "preferred_net_pay"] as const) await database.db.deleteFrom(table).execute()
  await database.db.deleteFrom("candidate_setting").where("candidate_id", "=", otherId).execute()
  await database.db.updateTable("candidate_setting").set({ work_authorization: "none outside Nigeria" }).execute()
  await database.db
    .insertInto("approved_answer")
    .values({ candidate_id: otherId, id: OTHER_ANSWER_ID, answer_group: "standard", topic: "notice_period", skill: null, question: null, answer_key: "standard:notice_period", value: "OTHER-SECRET", created_at: now, updated_at: now })
    .execute()
  await database.db.insertInto("gross_salary_answer").values({ candidate_id: otherId, kind: "gross_salary_policy", amount: "99999.00", currency: "KES", period: "year", updated_at: now }).execute()
  await database.db.insertInto("preferred_net_pay").values({ candidate_id: otherId, amount: "77777.00", currency: "KES", updated_at: now }).execute()
  await database.db.insertInto("candidate_setting").values({ candidate_id: otherId, work_authorization: "Kenya" }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const otherAnswer = () => database.db.selectFrom("approved_answer").select(["value"]).where("id", "=", OTHER_ANSWER_ID).executeTakeFirst()

describe("answers group is scoped to the session's Candidate", () => {
  it("lists none of the other Candidate's Approved Answers", async () => {
    const answers = approvedAnswersResponseSchema.parse((await owner.get("/v1/approved-answers").expect(200)).body).answers
    expect(answers).toEqual([])
  })

  it("creates the owner's answer even when the other Candidate holds the same answer key", async () => {
    const created = await owner.post("/v1/approved-answers").send({ group: "standard", topic: "notice_period", value: "4 weeks" }).expect(201)
    const row = await database.db.selectFrom("approved_answer").select("candidate_id").where("id", "=", created.body.id).executeTakeFirstOrThrow()
    expect(row.candidate_id).not.toBe(otherId)
  })

  it("answers 404 to edit and delete of the other Candidate's answer, and leaves it unchanged", async () => {
    await owner.patch(`/v1/approved-answers/${OTHER_ANSWER_ID}`).send({ value: "hijacked" }).expect(404)
    await owner.delete(`/v1/approved-answers/${OTHER_ANSWER_ID}`).expect(404)
    expect(await otherAnswer()).toEqual({ value: "OTHER-SECRET" })
  })

  it("shows none of the other Candidate's salary figures and never deletes them", async () => {
    const salary = salaryResponseSchema.parse((await owner.get("/v1/salary").expect(200)).body)
    expect(JSON.stringify(salary)).not.toMatch(/99999|77777|KES/)
    await owner.delete("/v1/salary/preferred-net-pay").expect((res) => expect([200, 204]).toContain(res.status))
    const others = await database.db.selectFrom("preferred_net_pay").select("amount").where("candidate_id", "=", otherId).execute()
    expect(others).toEqual([{ amount: "77777.00" }])
  })

  it("reads and writes only the owner's work-authorization setting", async () => {
    expect((await owner.get("/v1/candidate-settings").expect(200)).body).toEqual({ workAuthorization: "none outside Nigeria" })
    await owner.put("/v1/candidate-settings/work-authorization").send({ workAuthorization: "Nigeria only" }).expect(200)
    const other = await database.db.selectFrom("candidate_setting").select("work_authorization").where("candidate_id", "=", otherId).executeTakeFirstOrThrow()
    expect(other.work_authorization).toBe("Kenya")
  })

  it("refuses a repository call outside any Candidate scope", async () => {
    await expect(app.get(SalaryService).grossSalaryPolicyForForms()).rejects.toBeInstanceOf(MissingCandidateScopeError)
  })
})
