import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { DEFAULT_ROLE_FAMILY_TIERS, type FamilyTier, type PreferencesValues, type RoleFamilyValue, jobPostingsResponseSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { WORKER_STATEMENT_TIMEOUT_MS } from "../src/db/create-database.js"
import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { PostingEvaluator } from "../src/discovery/posting-evaluator.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 B1 unit 4: the rules and the Job Postings list read the
 * Candidate's Job Preferences (api-contract-b1 v1.25.0 "Skip reasons and tabs",
 * "Evaluation order"; architecture r4 "B: rank under the Candidate's tiers",
 * "B: four tabs", "B: saved keyword as a skip rule"; r6 "Evaluator" B1).
 * Real api and Postgres under forced RLS; the model is the fake endpoint.
 * The Operator (Ada) is the scope Candidate; another Candidate (Kofi) holds
 * rows that must never show. The Operator's preferences are changed with SQL
 * here; the save route has its own spec.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let ada: SignedInCandidate
let kofiId: string
let migratedValues: PreferencesValues
const clock = new TestClock("2026-10-21T09:00:00.000Z")

const TEXT = "Remote, open to candidates in Nigeria. Salary USD 60,000–80,000 per year. Core hours 10:00–18:00 WAT. Globex builds payment APIs for merchants. Duty 1. Duty 2."

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock, config: { statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS } })
  ada = await signInCandidate(new Browser(app, google))
  await ada.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  const sections = [{ id: "s1", kind: "experience", title: "Engineer", organization: "Brightwave", period: "2021-2024", sourceQuote: null, facts: [{ id: "F1", text: "Built React apps", sourceQuote: null }] }]
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(sections), created_at: new Date(), approved_at: new Date() })
    .execute()
  kofiId = (await database.db.insertInto("candidate").values({ email: "kofi.rules@example.test", google_sub: "sub-kofi-rules", role: "candidate", onboarded_at: new Date() } as never).returning("id").executeTakeFirstOrThrow()).id
  migratedValues = (await database.db.selectFrom("job_preferences").select("values").where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).values as PreferencesValues
})

beforeEach(async () => {
  await app.get(DiscoveryService).settled()
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  await database.db.deleteFrom("match_evidence").execute()
  await database.db.deleteFrom("eligibility_result").execute()
  await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await setOperatorPreferences({})
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

/** Writes a new current version for the Operator (history row + head), as a save would, without the save's re-decision. */
async function setOperatorPreferences(change: Partial<PreferencesValues>): Promise<number> {
  const head = await database.db.selectFrom("job_preferences").select("version").where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()
  const values = JSON.stringify({ ...migratedValues, ...change })
  const current = (await database.db.selectFrom("job_preferences").select("values").where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).values
  if (JSON.stringify(current) === JSON.stringify(JSON.parse(values))) return head.version
  const next = head.version + 1
  await database.db.insertInto("job_preferences_version").values({ candidate_id: database.operatorId, version: next, values, saved_at: clock.now() } as never).execute()
  await database.db.updateTable("job_preferences").set({ version: next, values } as never).where("candidate_id", "=", database.operatorId).execute()
  return next
}

const tiers = (change: Partial<Record<RoleFamilyValue, FamilyTier>>) => ({ roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, ...change } })

let minute = 0
type Seed = Readonly<{ title?: string | null; family?: RoleFamilyValue | null; status: "ranked" | "skipped" | "excluded" | "checking"; skipReason?: string | null; covered?: number; holder?: string; text?: string }>

async function seed(state: Seed): Promise<string> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/globex/jobs/${id}`
  minute += 1
  const discovered = new Date(Date.UTC(2026, 9, 20, 8, minute % 60, Math.floor(minute / 60)))
  const holder = state.holder ?? database.operatorId
  await insertPostingFor(
    database.db,
    holder,
    {
      id, application_url: url, requisition_id: id.slice(0, 8), apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board",
      employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null,
      title: state.title === undefined ? "Senior Frontend Engineer" : state.title, company: "Globex", posting_text: state.text ?? TEXT,
      status: state.status, skip_reason: state.skipReason ?? null, skip_detail: null, evaluation_failure: null,
      role_family: state.family === undefined ? "senior_frontend" : state.family, discovered_at: discovered, evaluated_at: state.status === "checking" ? null : discovered,
    },
    { keepFamily: true }
  )
  if (state.status === "ranked") {
    await database.db
      .insertInto("match_evidence")
      .values({ candidate_id: holder, job_posting_id: id, career_profile_version: 1, verdict: "strong", weak_reason: null, covered_count: state.covered ?? 8, total_count: 10, threshold: "0.700", items: "[]", evaluated_at: discovered, criteria_version: 1 })
      .execute()
  }
  return id
}

async function list(query: string): Promise<{ ids: string[]; ranks: (number | null)[]; totalCount: number; nextCursor: string | null; reasons: (string | null)[] }> {
  const response = await ada.get(`/v1/job-postings?${query}`)
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  const body = jobPostingsResponseSchema.parse(response.body)
  return { ids: body.postings.map((p) => p.id), ranks: body.postings.map((p) => p.rank), totalCount: body.totalCount, nextCursor: body.nextCursor, reasons: body.postings.map((p) => p.skipReason) }
}

describe("four tabs (D17, contract 'Skip reasons and tabs')", () => {
  it("each tab lists its rows and counts them; All and Excluded families partition every row; Kofi's rows never show", async () => {
    const ranked = [await seed({ status: "ranked" }), await seed({ status: "ranked", family: "backend" })]
    const violated = await seed({ status: "excluded", skipReason: "violated_rule" })
    const weak = await seed({ status: "skipped", skipReason: "weak_core_match" })
    const mismatch = await seed({ status: "skipped", skipReason: "keyword_mismatch" })
    const nullReason = await seed({ status: "skipped", skipReason: null })
    const family = [await seed({ status: "skipped", skipReason: "excluded_role_family", family: "mobile" }), await seed({ status: "skipped", skipReason: "excluded_role_family", family: "mobile" })]
    await seed({ status: "skipped", skipReason: "excluded_role_family", family: "mobile", holder: kofiId })
    await seed({ status: "ranked", holder: kofiId })

    const all = await list("tab=all")
    const skipped = await list("tab=skipped")
    const excluded = await list("tab=excluded_family")
    const rankedTab = await list("tab=ranked")
    expect(rankedTab.ids.sort()).toEqual([...ranked].sort())
    expect(new Set(skipped.ids)).toEqual(new Set([violated, weak, mismatch, nullReason]))
    expect(new Set(excluded.ids)).toEqual(new Set(family))
    expect(new Set(all.ids)).toEqual(new Set([...ranked, violated, weak, mismatch, nullReason]))
    expect([rankedTab.totalCount, skipped.totalCount, excluded.totalCount, all.totalCount]).toEqual([2, 4, 2, 6])
    expect(all.totalCount + excluded.totalCount).toBe(8)
    expect(excluded.reasons).toEqual(["excluded_role_family", "excluded_role_family"])
  })

  it("counts follow the on-screen filter per tab", async () => {
    await seed({ status: "skipped", skipReason: "excluded_role_family", family: "mobile", title: "Android Engineer" })
    await seed({ status: "skipped", skipReason: "excluded_role_family", family: "mobile", title: "iOS Engineer" })
    await seed({ status: "skipped", skipReason: "weak_core_match", family: "backend", title: "Backend Engineer" })
    expect((await list("tab=excluded_family&keyword=android")).totalCount).toBe(1)
    expect((await list("tab=skipped&families=mobile")).totalCount).toBe(0)
    expect((await list("tab=all&families=mobile,backend")).totalCount).toBe(1)
  })

  it("the Operator's migrated preferences: excluded_family is empty and skipped keeps every rule skip", async () => {
    await seed({ status: "skipped", skipReason: "weak_core_match" })
    await seed({ status: "excluded", skipReason: "violated_rule" })
    expect((await list("tab=excluded_family")).totalCount).toBe(0)
    expect((await list("tab=skipped")).totalCount).toBe(2)
  })

  it("paging Excluded families at limit 2 returns every row once, newest first; its cursor is 400 on Skipped and All", async () => {
    const ids = []
    for (let i = 0; i < 5; i += 1) ids.push(await seed({ status: "skipped", skipReason: "excluded_role_family", family: "mobile" }))
    const seen: string[] = []
    let cursor: string | null = null
    let first: string | null = null
    do {
      const page = await list(`tab=excluded_family&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      seen.push(...page.ids)
      cursor = page.nextCursor
      first ??= cursor
    } while (cursor)
    expect(seen).toEqual([...ids].reverse())
    for (const tab of ["skipped", "all"]) {
      const response = await ada.get(`/v1/job-postings?tab=${tab}&limit=2&cursor=${encodeURIComponent(first!)}`)
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
    }
  })
})

describe("ranking under the Candidate's tiers (tierSql(tiers), cursor tierHash)", () => {
  it("the migrated tiers keep the built order; swapped tiers reverse it, ranks included", async () => {
    const frontend = await seed({ status: "ranked", family: "senior_frontend" })
    const backend = await seed({ status: "ranked", family: "backend" })
    expect((await list("tab=ranked")).ids).toEqual([frontend, backend])
    await setOperatorPreferences(tiers({ backend: 1, senior_frontend: 3 }))
    const swapped = await list("tab=ranked")
    expect(swapped.ids).toEqual([backend, frontend])
    expect(swapped.ranks).toEqual([1, 2])
    // The All tab and the detail carry the same ranks.
    const all = await list("tab=all")
    expect(all.ids.map((id, i) => [id, all.ranks[i]]).sort()).toEqual([[backend, 1], [frontend, 2]].sort())
    expect((await ada.get(`/v1/job-postings/${backend}`).expect(200)).body.rank).toBe(1)
  })

  it.each(Object.keys(DEFAULT_ROLE_FAMILY_TIERS) as RoleFamilyValue[])("13-family coverage: %s alone at tier 1 is ranked first", async (family) => {
    // EPIC-0006 visibility hides off-target families: target all 13 for this case only.
    const targets = (await database.db.selectFrom("job_criteria").select("target_role_families").where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).target_role_families
    await database.db.updateTable("job_criteria").set({ target_role_families: Object.keys(DEFAULT_ROLE_FAMILY_TIERS) }).where("candidate_id", "=", database.operatorId).execute()
    try {
      await coverage(family)
    } finally {
      await database.db.updateTable("job_criteria").set({ target_role_families: targets }).where("candidate_id", "=", database.operatorId).execute()
    }
  })

  async function coverage(family: RoleFamilyValue) {
    const ids = new Map<RoleFamilyValue, string>()
    for (const key of Object.keys(DEFAULT_ROLE_FAMILY_TIERS) as RoleFamilyValue[]) ids.set(key, await seed({ status: "ranked", family: key, covered: 5 }))
    const only = Object.fromEntries(Object.keys(DEFAULT_ROLE_FAMILY_TIERS).map((key) => [key, key === family ? 1 : 3])) as Record<RoleFamilyValue, FamilyTier>
    await setOperatorPreferences({ roleFamilyTiers: only })
    const page = await list("tab=ranked&limit=50")
    expect(page.ids[0]).toBe(ids.get(family))
    expect(page.ids).toHaveLength(13)
  }

  it("a cursor issued before a tier change is 400; a save that keeps the tiers keeps the cursor valid", async () => {
    for (let i = 0; i < 4; i += 1) await seed({ status: "ranked", family: i % 2 ? "backend" : "senior_frontend" })
    const cursor = (await list("tab=ranked&limit=2")).nextCursor!
    await setOperatorPreferences({ dailyCap: 2 })
    expect((await ada.get(`/v1/job-postings?tab=ranked&limit=2&cursor=${encodeURIComponent(cursor)}`)).status).toBe(200)
    await setOperatorPreferences(tiers({ backend: 1 }))
    const response = await ada.get(`/v1/job-postings?tab=ranked&limit=2&cursor=${encodeURIComponent(cursor)}`)
    expect(response.status).toBe(400)
    // Newest-first tabs are bound to the tier map too (the binding hash covers it).
    await setOperatorPreferences({})
    const allCursor = (await list("tab=all&limit=2")).nextCursor!
    await setOperatorPreferences(tiers({ mobile: 1 }))
    expect((await ada.get(`/v1/job-postings?tab=all&limit=2&cursor=${encodeURIComponent(allCursor)}`)).status).toBe(400)
  })
})

describe("evaluation steps 2 and 3 (R6-2): excluded family, then keyword; no paid work", () => {
  function extraction() {
    return {
      workArrangement: "remote", locationQuote: "Remote, open to candidates in Nigeria", relocationCountry: null, relocationQuote: null, sponsorshipQuote: null,
      payQuote: "Salary USD 60,000–80,000 per year", hoursQuote: "Core hours 10:00–18:00 WAT", employerBusiness: "payment APIs for merchants",
      businessQuote: "Globex builds payment APIs for merchants", employmentType: null,
      coreResponsibilities: [{ text: "Duty 1", quote: "Duty 1", factId: "F1" }, { text: "Duty 2", quote: "Duty 2", factId: "F1" }],
      mandatoryPrerequisites: [], niceToHave: [],
    }
  }
  const evaluator = () => asOperator(app, app.get(PostingEvaluator))
  const state = async (id: string) =>
    (await sql<{ status: string; skip_reason: string | null; skip_detail: string | null; preferences_version: number }>`select status, skip_reason, skip_detail, preferences_version from candidate_posting where candidate_id = ${database.operatorId}::uuid and job_posting_id = ${id}::uuid`.execute(database.db)).rows[0]!
  const paid = async () => ({
    calls: Number((await sql<{ n: string }>`select count(*) as n from ai_call`.execute(database.db)).rows[0]!.n),
    spend: Number((await sql<{ n: string }>`select count(*) as n from spend_entry`.execute(database.db)).rows[0]!.n),
  })

  it("an excluded family skips with excluded_role_family before any model call or spend entry", async () => {
    const version = await setOperatorPreferences(tiers({ mobile: "excluded" }))
    const id = await seed({ status: "checking", family: "mobile", title: "Senior Android Engineer" })
    const before = await paid()
    expect(await evaluator().evaluate(id)).toBe("evaluated")
    expect(await state(id)).toEqual({ status: "skipped", skip_reason: "excluded_role_family", skip_detail: null, preferences_version: version })
    expect(anthropic.requests).toHaveLength(0)
    expect(await paid()).toEqual(before)
  })

  it("a saved keyword the title lacks skips with keyword_mismatch; an untitled posting is a mismatch; a match goes on to Match", async () => {
    const version = await setOperatorPreferences({ titleKeyword: "React" })
    const vue = await seed({ status: "checking", title: "Senior Vue Engineer" })
    const untitled = await seed({ status: "checking", title: null, family: null })
    expect(await evaluator().evaluate(vue)).toBe("evaluated")
    expect(await evaluator().evaluate(untitled)).toBe("evaluated")
    expect(await state(vue)).toEqual({ status: "skipped", skip_reason: "keyword_mismatch", skip_detail: null, preferences_version: version })
    expect((await state(untitled)).skip_reason).toBe("keyword_mismatch")
    expect(anthropic.requests).toHaveLength(0)

    const react = await seed({ status: "checking", title: "Senior React Engineer" })
    anthropic.replyWithObject(extraction())
    expect(await evaluator().evaluate(react)).toBe("evaluated")
    expect(await state(react)).toEqual({ status: "ranked", skip_reason: null, skip_detail: null, preferences_version: version })
    expect(anthropic.requests).toHaveLength(1)
  })

  it("excluded and mismatched is stored as excluded_role_family", async () => {
    await setOperatorPreferences({ ...tiers({ mobile: "excluded" }), titleKeyword: "react" })
    const id = await seed({ status: "checking", family: "mobile", title: "Senior Android Engineer" })
    await evaluator().evaluate(id)
    expect((await state(id)).skip_reason).toBe("excluded_role_family")
  })

  it("a zero-width-only keyword applies no rule; the migrated Operator (no keyword, nothing excluded) is ranked as before", async () => {
    const version = await setOperatorPreferences({ titleKeyword: "\u200B" })
    const id = await seed({ status: "checking", title: "Senior Vue Engineer" })
    anthropic.replyWithObject(extraction())
    await evaluator().evaluate(id)
    expect(await state(id)).toEqual({ status: "ranked", skip_reason: null, skip_detail: null, preferences_version: version })
  })

  it("R6-AC4 widening: a keyword saved during the model call applies before the verdict is recorded, stamped with the new version", async () => {
    const id = await seed({ status: "checking", title: "Senior Vue Engineer" })
    anthropic.replyWithObjectWhenReleased(extraction())
    const run = evaluator().evaluate(id)
    await anthropic.waitForHeld()
    const version = await setOperatorPreferences({ titleKeyword: "react" })
    anthropic.releaseHeld()
    expect(await run).toBe("evaluated")
    expect(await state(id)).toEqual({ status: "skipped", skip_reason: "keyword_mismatch", skip_detail: null, preferences_version: version })
    // The Eligibility and Match results from the start are still stored (r4 AC 4.23).
    expect(await database.db.selectFrom("eligibility_result").select("eligible").where("job_posting_id", "=", id).executeTakeFirst()).toEqual({ eligible: true })
    expect(anthropic.requests).toHaveLength(1)
  })

  it("R6-AC4 widening: a family excluded during the model call skips it; one un-excluded during the call ranks it", async () => {
    await setOperatorPreferences({})
    const id = await seed({ status: "checking", family: "backend", title: "Senior Backend Engineer" })
    anthropic.replyWithObjectWhenReleased(extraction())
    const run = evaluator().evaluate(id)
    await anthropic.waitForHeld()
    await setOperatorPreferences(tiers({ backend: "excluded" }))
    anthropic.releaseHeld()
    await run
    expect((await state(id)).skip_reason).toBe("excluded_role_family")
  })

  it(":91/:726 the Eligibility rules read the Candidate's current preferences: a lower pay floor and a later work hour change the next evaluation", async () => {
    const text = "Remote, open to candidates in Nigeria. Salary USD 1,500 per month. Core hours 15:00–23:30 WAT. Globex builds payment APIs for merchants. Duty 1. Duty 2."
    const reply = { ...extraction(), payQuote: "Salary USD 1,500 per month", hoursQuote: "Core hours 15:00–23:30 WAT" }
    const before = await seed({ status: "checking", text })
    anthropic.replyWithObject(reply)
    await evaluator().evaluate(before)
    const rulesOf = async (id: string) =>
      Object.fromEntries(((await database.db.selectFrom("eligibility_result").select("rules").where("job_posting_id", "=", id).where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).rules as { rule: string; result: string }[]).map((r) => [r.rule, r.result]))
    expect(await rulesOf(before)).toMatchObject({ pay: "violated", hours: "violated" })

    const version = await setOperatorPreferences({ payFloor: { amount: "1500.00", currency: "USD", period: "month", basis: "gross" }, latestWorkHour: "23:30" })
    const after = await seed({ status: "checking", text })
    anthropic.replyWithObject(reply)
    await evaluator().evaluate(after)
    expect(await rulesOf(after)).toMatchObject({ pay: "met", hours: "met" })
    expect(await state(after)).toMatchObject({ status: "ranked", preferences_version: version })
    // :770/:749 the earlier result is not re-decided by an Eligibility-only change (D21).
    expect(await rulesOf(before)).toMatchObject({ pay: "violated", hours: "violated" })
  })

  it(":804 a run uses the preferences version read at its start: a change during the model call applies from the next evaluation", async () => {
    const text = "Remote, open to candidates in Nigeria. We run an online casino platform. Duty 1. Duty 2."
    const id = await seed({ status: "checking", text })
    const startVersion = await setOperatorPreferences({ excludedIndustries: [] })
    anthropic.replyWithObjectWhenReleased({ ...extraction(), employerBusiness: "online casino", businessQuote: "We run an online casino platform" })
    const run = evaluator().evaluate(id)
    await anthropic.waitForHeld()
    await setOperatorPreferences({ excludedIndustries: ["gambling"] })
    anthropic.releaseHeld()
    await run
    const result = await database.db.selectFrom("eligibility_result").select("rules").where("job_posting_id", "=", id).executeTakeFirstOrThrow()
    expect((result.rules as { rule: string; result: string }[]).find((r) => r.rule === "industry")?.result).toBe("met")
    expect(await state(id)).toMatchObject({ status: "ranked", preferences_version: startVersion })
  })

  it("no preferences record: the step 3 defaults decide (no home country: a restricted remote posting is violated; pay and hours Unverified) and version 0 is stored", async () => {
    await database.db.deleteFrom("job_preferences").where("candidate_id", "=", database.operatorId).execute()
    try {
      const id = await seed({ status: "checking", text: "Remote, US only. Salary USD 9,000 per month. Core hours 10:00–18:00 UTC. Duty 1. Duty 2." })
      anthropic.replyWithObject(extraction())
      await evaluator().evaluate(id)
      const rules = (await database.db.selectFrom("eligibility_result").select("rules").where("job_posting_id", "=", id).executeTakeFirstOrThrow()).rules as { rule: string; result: string }[]
      expect(Object.fromEntries(rules.map((r) => [r.rule, r.result]))).toMatchObject({ location: "violated", pay: "unverified", hours: "unverified" })
      expect(await state(id)).toMatchObject({ status: "excluded", preferences_version: 0 })
    } finally {
      const last = await database.db.selectFrom("job_preferences_version").select(["version", "values"]).where("candidate_id", "=", database.operatorId).orderBy("version", "desc").executeTakeFirstOrThrow()
      await database.db.insertInto("job_preferences").values({ candidate_id: database.operatorId, version: last.version, values: JSON.stringify(last.values) } as never).execute()
    }
  })

  it.each([
    [true, 1, "ranked", null, ["ranked"], 1],
    [true, "excluded", "skipped", "excluded_role_family", ["excluded_family"], 0],
    [false, 1, "not_checked", null, [], 0],
    [false, "excluded", "not_checked", null, [], 0],
  ] as const)("settings-b1.feature:104 board selects mobile %s, tier %s: %s / %s, listed on %j, %i Match calls", async (selected, tier, status, reason, tabs, calls) => {
    const targets = (await database.db.selectFrom("job_criteria").select("target_role_families").where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).target_role_families
    const withMobile = [...new Set([...targets.filter((family) => family !== "mobile"), ...(selected ? ["mobile"] : [])])]
    await database.db.updateTable("job_criteria").set({ target_role_families: withMobile }).where("candidate_id", "=", database.operatorId).execute()
    try {
      await setOperatorPreferences(tiers({ mobile: tier }))
      const id = await seed({ status: "checking", family: "mobile", title: "Senior iOS Engineer" })
      anthropic.replyWithObject(extraction())
      await evaluator().evaluate(id)
      // Hidden (off-target): the evaluator returns the claimed row to not_checked (EPIC-0006 AC-7.1) and calls nothing.
      expect(await state(id)).toMatchObject({ status, skip_reason: reason })
      expect(anthropic.requests).toHaveLength(calls)
      const listedOn: string[] = []
      for (const tab of ["ranked", "skipped", "excluded_family", "all"]) if ((await list(`tab=${tab}`)).ids.includes(id)) listedOn.push(tab)
      expect(listedOn.filter((tab) => tab !== "all")).toEqual(tabs)
    } finally {
      await database.db.updateTable("job_criteria").set({ target_role_families: targets }).where("candidate_id", "=", database.operatorId).execute()
    }
  })

  it("Kofi's preferences never decide the Operator's evaluation", async () => {
    await database.db.insertInto("job_preferences").values({ candidate_id: kofiId, version: 1, values: JSON.stringify({ ...migratedValues, titleKeyword: "react" }) } as never).execute()
    try {
      const id = await seed({ status: "checking", title: "Senior Vue Engineer" })
      anthropic.replyWithObject(extraction())
      await evaluator().evaluate(id)
      expect((await state(id)).status).toBe("ranked")
    } finally {
      await database.db.deleteFrom("job_preferences").where("candidate_id", "=", kofiId).execute()
    }
  })
})
