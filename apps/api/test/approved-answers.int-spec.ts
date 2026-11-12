import type { INestApplication } from "@nestjs/common"
import { approvedAnswersResponseSchema, salaryResponseSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { SalaryService } from "../src/answers/salary.service.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
const clock = new TestClock("2026-10-16T10:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

beforeEach(async () => {
  await database.db.deleteFrom("approved_answer").execute()
  await database.db.deleteFrom("gross_salary_answer").execute()
  await database.db.deleteFrom("preferred_net_pay").execute()
  await database.db.updateTable("candidate_setting").set({ work_authorization: "none outside Nigeria" }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

async function listAnswers() {
  return approvedAnswersResponseSchema.parse((await candidate.get("/v1/approved-answers").expect(200)).body).answers
}

describe("Approved Answers (AC 1.3)", () => {
  it("a new installation has none, and work authorization reads none outside Nigeria", async () => {
    expect(await listAnswers()).toEqual([])
    const settings = await candidate.get("/v1/candidate-settings").expect(200)
    expect(settings.body).toEqual({ workAuthorization: "none outside Nigeria" })
  })

  it.each([
    [{ group: "standard", topic: "notice_period", value: "4 weeks" }],
    [{ group: "standard", topic: "start_date", value: "2026-12-01" }],
    [{ group: "standard", topic: "skill_years", skill: "React", value: "7" }],
    [{ group: "standard", topic: "profile_links", value: "https://github.com/ada-okafor" }],
    [{ group: "standard", topic: "relocation_willingness", value: "Yes, with employer visa sponsorship" }],
    [{ group: "sensitive", topic: "demographic", value: "Black or African" }],
    [{ group: "sensitive", topic: "disability", value: "I do not wish to answer" }],
    [{ group: "sensitive", topic: "veteran_status", value: "I am not a veteran" }],
    [{ group: "custom", question: "Why do you want to work here?", value: "Payments at scale." }],
  ])("stores %o exactly as entered", async (request) => {
    const created = await candidate.post("/v1/approved-answers").send(request).expect(201)
    expect(created.body).toMatchObject({ ...request, updatedAt: "2026-10-16T10:00:00.000Z" })
    expect(await listAnswers()).toEqual([created.body])
  })

  it("edits an answer's value", async () => {
    const created = await candidate.post("/v1/approved-answers").send({ group: "standard", topic: "notice_period", value: "4 weeks" }).expect(201)
    clock.set("2026-10-16T11:00:00.000Z")
    const edited = await candidate.patch(`/v1/approved-answers/${created.body.id}`).send({ value: "2 weeks" }).expect(200)
    clock.set("2026-10-16T10:00:00.000Z")
    expect(edited.body).toMatchObject({ value: "2 weeks", updatedAt: "2026-10-16T11:00:00.000Z" })
    expect((await listAnswers())[0]?.value).toBe("2 weeks")
  })

  it("deletes an answer", async () => {
    const created = await candidate.post("/v1/approved-answers").send({ group: "standard", topic: "start_date", value: "2026-12-01" }).expect(201)
    await candidate.delete(`/v1/approved-answers/${created.body.id}`).expect(204)
    expect(await listAnswers()).toEqual([])
    await candidate.delete(`/v1/approved-answers/${created.body.id}`).expect(404)
  })

  it.each([
    ["an empty value", { group: "standard", topic: "notice_period", value: "   " }, 422, "approved_answer_value_empty", "Enter an answer."],
    ["an empty custom question", { group: "custom", question: " ", value: "x" }, 422, "approved_answer_question_empty", "Enter the question as the form asks it."],
    ["skill years without a skill", { group: "standard", topic: "skill_years", value: "7" }, 400, "bad_request", "The request is not valid."],
    ["a skill on another topic", { group: "standard", topic: "notice_period", skill: "React", value: "x" }, 400, "bad_request", "The request is not valid."],
    ["an unknown topic", { group: "standard", topic: "salary", value: "x" }, 400, "bad_request", "The request is not valid."],
    ["an over-long value", { group: "standard", topic: "notice_period", value: "x".repeat(2001) }, 400, "bad_request", "The request is not valid."],
  ])("refuses %s", async (_label, request, status, code, message) => {
    const response = await candidate.post("/v1/approved-answers").send(request).expect(status)
    expect(response.body).toEqual({ error: { code, message } })
    expect(await listAnswers()).toEqual([])
  })

  it("refuses a second answer for the same question, custom questions compared loosely", async () => {
    await candidate.post("/v1/approved-answers").send({ group: "standard", topic: "notice_period", value: "4 weeks" }).expect(201)
    const again = await candidate.post("/v1/approved-answers").send({ group: "standard", topic: "notice_period", value: "2 weeks" }).expect(409)
    expect(again.body.error.code).toBe("approved_answer_exists")
    await candidate.post("/v1/approved-answers").send({ group: "custom", question: "Why us?", value: "a" }).expect(201)
    await candidate.post("/v1/approved-answers").send({ group: "custom", question: "  why US? ", value: "b" }).expect(409)
    expect(await listAnswers()).toHaveLength(2)
  })

  it("editing to an empty value is refused and keeps the old value", async () => {
    const created = await candidate.post("/v1/approved-answers").send({ group: "standard", topic: "notice_period", value: "4 weeks" }).expect(201)
    const response = await candidate.patch(`/v1/approved-answers/${created.body.id}`).send({ value: "" }).expect(422)
    expect(response.body.error.code).toBe("approved_answer_value_empty")
    expect((await listAnswers())[0]?.value).toBe("4 weeks")
  })

  it("an unknown or malformed id is 404", async () => {
    await candidate.patch("/v1/approved-answers/00000000-0000-4000-8000-000000000000").send({ value: "x" }).expect(404)
    await candidate.patch("/v1/approved-answers/not-a-uuid").send({ value: "x" }).expect(404)
  })

  it.each([
    ["GET", "/v1/approved-answers"],
    ["POST", "/v1/approved-answers"],
    ["PATCH", "/v1/approved-answers/00000000-0000-4000-8000-000000000000"],
    ["DELETE", "/v1/approved-answers/00000000-0000-4000-8000-000000000000"],
    ["GET", "/v1/salary"],
    ["PUT", "/v1/salary/gross-salary-policy"],
    ["PUT", "/v1/salary/preferred-net-pay"],
    ["GET", "/v1/candidate-settings"],
    ["PUT", "/v1/candidate-settings/work-authorization"],
  ])("refuses unauthenticated %s %s", async (method, path) => {
    const response = await browser.http()[method.toLowerCase() as "get"](path).send({}).expect(401)
    expect(response.body.error.code).toBe("unauthenticated")
  })

  it("refuses a signed-in write without the CSRF token", async () => {
    await browser
      .http()
      .post("/v1/approved-answers")
      .set("cookie", candidate.cookie)
      .send({ group: "standard", topic: "notice_period", value: "4 weeks" })
      .expect(403)
    expect(await listAnswers()).toEqual([])
  })
})

describe("salary answers (AC 1.4)", () => {
  it("stores the gross-salary policy as USD 48,000 per year", async () => {
    const response = await candidate.put("/v1/salary/gross-salary-policy").send({ amount: 48000, period: "year" }).expect(200)
    expect(salaryResponseSchema.parse(response.body).grossSalaryPolicy).toEqual({
      amount: 48000,
      currency: "USD",
      period: "year",
      display: "USD 48,000 per year",
    })
  })

  it("stores USD 5,000 per month net separately and leaves the gross policy unchanged", async () => {
    await candidate.put("/v1/salary/gross-salary-policy").send({ amount: 48000, period: "year" }).expect(200)
    const response = await candidate.put("/v1/salary/preferred-net-pay").send({ amount: 5000 }).expect(200)
    expect(response.body).toEqual({
      grossSalaryPolicy: { amount: 48000, currency: "USD", period: "year", display: "USD 48,000 per year" },
      currentSalary: null,
      preferredNetPay: { amount: 5000, currency: "USD", period: "month_net", display: "USD 5,000 per month net" },
    })
    const grossRows = await database.db.selectFrom("gross_salary_answer").selectAll().execute()
    expect(grossRows.map((row) => row.amount)).toEqual(["48000.00"])
  })

  it("the gross value used for forms never returns the net preference, even with no gross policy", async () => {
    await candidate.put("/v1/salary/preferred-net-pay").send({ amount: 5000 }).expect(200)
    // Outside a request, the form path runs in the Operator's scope (worker, A1).
    const tenant = app.get(TenantDatabase)
    expect(await tenant.asOperator(() => app.get(SalaryService).grossSalaryPolicyForForms())).toBeNull()
    await candidate.put("/v1/salary/gross-salary-policy").send({ amount: 48000, period: "year" }).expect(200)
    expect((await tenant.asOperator(() => app.get(SalaryService).grossSalaryPolicyForForms()))?.display).toBe("USD 48,000 per year")
  })

  it("the net preference cannot be sent as a gross figure: a month_net period is refused", async () => {
    const response = await candidate.put("/v1/salary/gross-salary-policy").send({ amount: 5000, period: "month_net" }).expect(400)
    expect(response.body.error.code).toBe("bad_request")
    expect(await database.db.selectFrom("gross_salary_answer").selectAll().execute()).toEqual([])
  })

  it("the database refuses a net period in a gross row", async () => {
    await expect(
      sql`insert into gross_salary_answer (candidate_id, kind, amount, currency, period, updated_at) values (${database.operatorId}, 'gross_salary_policy', 5000, 'USD', 'month_net', now())`.execute(database.db)
    ).rejects.toThrow(/check/)
  })

  it("current salary is optional and can be cleared", async () => {
    await candidate.put("/v1/salary/current-salary").send({ amount: 3000.5, currency: "EUR", period: "month" }).expect(200)
    const cleared = await candidate.delete("/v1/salary/current-salary").expect(200)
    expect(cleared.body.currentSalary).toBeNull()
  })

  it.each([
    [{ amount: 0, period: "year" }],
    [{ amount: -1, period: "year" }],
    [{ amount: 1.234, period: "year" }],
    [{ amount: 1000, currency: "usd", period: "year" }],
    [{ amount: "48000", period: "year" }],
  ])("refuses an invalid gross figure %o", async (body) => {
    await candidate.put("/v1/salary/gross-salary-policy").send(body).expect(400)
  })
})

describe("work authorization (AC 1.5)", () => {
  it("changes to Nigeria and Canada", async () => {
    const response = await candidate.put("/v1/candidate-settings/work-authorization").send({ workAuthorization: "Nigeria and Canada" }).expect(200)
    expect(response.body).toEqual({ workAuthorization: "Nigeria and Canada" })
    expect((await candidate.get("/v1/candidate-settings").expect(200)).body.workAuthorization).toBe("Nigeria and Canada")
  })

  it("refuses an empty value", async () => {
    await candidate.put("/v1/candidate-settings/work-authorization").send({ workAuthorization: "  " }).expect(400)
    expect((await candidate.get("/v1/candidate-settings").expect(200)).body.workAuthorization).toBe("none outside Nigeria")
  })
})

// career-profile.feature @r4 salary outlines (CR2-03, decision 2026-10-18).
describe("salary amounts with at most 2 decimals (@r4)", () => {
  const cards = [
    ["gross-salary policy", "/v1/salary/gross-salary-policy", { period: "year" }, "grossSalaryPolicy"],
    ["current salary", "/v1/salary/current-salary", { period: "month" }, "currentSalary"],
    ["preferred net pay", "/v1/salary/preferred-net-pay", {}, "preferredNetPay"],
  ] as const

  for (const [card, path, extra, field] of cards) {
    it.each([0.07, 0.29, 4800.1, 0.01, 4800])(`stores %s on the ${card} card exactly`, async (amount) => {
      const response = await candidate.put(path).send({ amount, ...extra }).expect(200)
      expect(response.body[field].amount).toBe(amount)
      const read = await candidate.get("/v1/salary").expect(200)
      expect(read.body[field].amount).toBe(amount)
    })

    it.each([0, 0.0, -1, 4800.105, 0.075, 100_000_000.01])(`refuses %s on the ${card} card and keeps the previous value`, async (amount) => {
      await candidate.put(path).send({ amount: 1234.5, ...extra }).expect(200)
      const response = await candidate.put(path).send({ amount, ...extra }).expect(400)
      expect(response.body.error.code).toBe("bad_request")
      expect((await candidate.get("/v1/salary").expect(200)).body[field].amount).toBe(1234.5)
    })
  }

  it("accepts the maximum, 100,000,000", async () => {
    await candidate.put("/v1/salary/preferred-net-pay").send({ amount: 100_000_000 }).expect(200)
  })

  it("the database refuses an amount not above zero or over the maximum, whatever the caller", async () => {
    const now = new Date()
    await expect(
      database.db.insertInto("preferred_net_pay").values({ candidate_id: database.operatorId, amount: "0.00", currency: "USD", updated_at: now }).execute()
    ).rejects.toThrow(/check/)
    await expect(
      database.db.insertInto("gross_salary_answer").values({ candidate_id: database.operatorId, kind: "current_salary", amount: "100000000.01", currency: "USD", period: "year", updated_at: now }).execute()
    ).rejects.toThrow(/check/)
  })
})
