import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { apiErrorResponseSchema, jobPostingDetailSchema, jobPostingStatusSchema } from "@eve/contracts"
import { sql } from "kysely"
import pg from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { evaluationLockKey } from "../src/discovery/discovery.repository.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import {
  ALL_FAMILIES,
  DATED,
  DEFAULT_TARGETS,
  POSTING_HIDDEN_MESSAGE,
  TODAY,
  clearPostings,
  counts,
  hold,
  ids,
  insertPosting,
  list,
  resetCriteria,
  seed,
  setCriteria,
  signInSecondCandidate,
  snapshotPosting,
  statusOf,
  wat,
  zeroCounts,
} from "./support/epic-0006.js"

/**
 * EPIC-0006 QA test authoring (step [5e]): GET /v1/job-postings, GET
 * /v1/job-postings/{id} and the 409 posting_hidden refusal against the real
 * api and Postgres. Source: api-contract.r1.md v1.18.0 and gherkin r4
 * (hidden-postings-board, posting-age, seniority-floor visibility,
 * hidden-postings-applications-and-links API scenarios, per-candidate-tenancy
 * counts and notices). Expected to fail until the EPIC-0006 backend lands.
 *
 * Ada is the Operator; Kofi is a second, non-Operator Candidate.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let ada: SignedInCandidate
let kofi: SignedInCandidate
let adaId: string
let kofiId: string
const clock = new TestClock(TODAY)

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  adaId = database.operatorId
  ;({ candidate: kofi, id: kofiId } = await signInSecondCandidate(app, google, database.db))
})

beforeEach(async () => {
  clock.set(TODAY)
  anthropic.install()
  anthropic.reset()
  await clearPostings(database.db)
  await resetCriteria(database.db)
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const ranked = { status: "ranked" } as const

describe("AC-1.7 @AC-1.7 @AC-3.2 off-target postings appear on no tab (hidden-postings-board.feature:47-103)", () => {
  it("board:48 the motivating paralegal and marketing rows appear on no tab; the frontend posting is on Ranked and All", async () => {
    const paralegal = await seed(database.db, adaId, { title: "Hotline Paralegal", family: null, prefilterSkip: "not_software_role", marker: "none" }, { status: "skipped", skipReason: "not_software_role" })
    const marketing = await seed(database.db, adaId, { title: "Marketing Operations Specialist", family: null, prefilterSkip: "not_software_role", marker: "none" }, { status: "skipped", skipReason: "not_software_role" })
    const frontend = await seed(database.db, adaId, { title: "Senior Frontend Engineer" }, ranked)
    for (const tab of ["ranked", "skipped", "all"]) {
      const page = await list(ada, `tab=${tab}&limit=100`)
      expect(ids(page)).not.toContain(paralegal)
      expect(ids(page)).not.toContain(marketing)
    }
    expect(ids(await list(ada, "tab=ranked"))).toEqual([frontend])
    expect(ids(await list(ada, "tab=all"))).toEqual([frontend])
  })

  it("board:60 a not_software_role posting is off-target even when every family is targeted", async () => {
    await setCriteria(database.db, adaId, { targets: ALL_FAMILIES })
    const id = await seed(database.db, adaId, { title: "Customer Success Engineer", family: null, prefilterSkip: "not_software_role" }, { status: "skipped", skipReason: "not_software_role" })
    const page = await list(ada, "tab=skipped")
    expect(ids(page)).not.toContain(id)
    expect(page.hiddenCounts).toEqual(counts({ offTarget: 1 }))
  })

  it.each([
    ["Solutions Architect", "solutions_customer", "evaluation_failed"],
    ["TAM Architect", "solutions_customer", "evaluation_failed"],
    ["Senior Data Engineer", "data_ml", "ranked"],
    ["Site Reliability Engineer", "devops_platform", "skipped"],
    ["QA Automation Engineer", "other", "excluded"],
  ] as const)("board:68 %s (%s, %s) is outside the default targets and is not listed", async (title, family, status) => {
    const id = await seed(database.db, adaId, { title, family }, { status, evaluationFailure: status === "evaluation_failed" ? "not_configured" : null, skipReason: status === "skipped" ? "weak_core_match" : status === "excluded" ? "violated_rule" : null })
    expect(ids(await list(ada, "tab=all"))).not.toContain(id)
  })

  it.each([
    ["Senior Frontend Engineer", "senior_frontend"],
    ["Lead Engineer", "technical_lead"],
    ["Full Stack Developer", "fullstack"],
    ["Product Engineer", "product_engineering"],
    ["Senior Software Engineer", "software_engineering"],
    ["Senior Backend Engineer", "backend"],
    ["Senior iOS Engineer", "mobile"],
    ["Senior Platform Engineer", "platform_engineering"],
    ["Engineering Manager", "people_management"],
  ] as const)("board:82 %s (%s) is in the default targets and is listed on Ranked", async (title, family) => {
    const id = await seed(database.db, adaId, { title, family }, ranked)
    expect(ids(await list(ada, "tab=ranked"))).toContain(id)
  })

  it.each(["Data Scientist at Initech", "Head of Data Science at Hooli", "Technical Account Manager, Enterprise at Globex", "TAM at Umbrella", "Sales Architect at Acme", "Solutions Engineer at Contoso"])(
    "board r5 (P17) pre-filter-skipped %s stays off-target with data_ml and solutions_customer targeted",
    async (title) => {
      await setCriteria(database.db, adaId, { targets: [...DEFAULT_TARGETS, "data_ml", "solutions_customer"] })
      const id = await seed(database.db, adaId, { title, family: null, prefilterSkip: "not_software_role", marker: "none" }, { status: "skipped", skipReason: "not_software_role" })
      for (const tab of ["ranked", "skipped", "all"]) expect(ids(await list(ada, `tab=${tab}`))).not.toContain(id)
      expect((await list(ada, "tab=all")).hiddenCounts).toEqual(counts({ offTarget: 1 }))
    }
  )

  it.each([
    ["Senior Data Engineer at Initech", "data_ml"],
    ["ML Engineer at Hooli", "data_ml"],
    ["Solutions Architect at Globex", "solutions_customer"],
    ["Customer Architect at Umbrella", "solutions_customer"],
    ["TAM Architect at Acme", "solutions_customer"],
  ] as const)("board r5 (P17) %s (%s, passes the pre-filter) is listed on Ranked when targeted", async (title, family) => {
    await setCriteria(database.db, adaId, { targets: [...DEFAULT_TARGETS, "data_ml", "solutions_customer"] })
    const id = await seed(database.db, adaId, { title, family }, ranked)
    expect(ids(await list(ada, "tab=ranked"))).toContain(id)
  })

  it("board:100 an untitled dated posting is never off-target", async () => {
    const id = await seed(database.db, adaId, { title: null, family: "other", origin: "pasted_link" }, { status: "waiting_to_be_checked" })
    expect(ids(await list(ada, "tab=all"))).toContain(id)
  })
})

describe("AC-3.2 @AC-3.2 hidden postings appear on no tab, page or filter; counts are visible-only (board:107-163)", () => {
  async function seedSix() {
    return {
      V1: await seed(database.db, adaId, { title: "Senior Frontend Engineer at Acme" }, ranked),
      V2: await seed(database.db, adaId, { title: "Frontend Engineer at Globex" }, { status: "skipped", skipReason: "weak_core_match", covered: 5 }),
      H1: await seed(database.db, adaId, { title: "Senior Data Engineer at Initech", family: "data_ml" }, ranked),
      H2: await seed(database.db, adaId, { title: "Junior Frontend Developer at Hooli", marker: "entry" }, { status: "skipped", skipReason: "weak_core_match", covered: 5 }),
      H3: await seed(database.db, adaId, { title: "Senior Frontend Engineer at Contoso", postedAt: null }, ranked),
      H4: await seed(database.db, adaId, { title: "Staff Frontend Engineer at Umbrella", postedAt: wat("2026-08-24") }, ranked),
    }
  }

  it.each([
    ["ranked", "", ""],
    ["skipped", "", ""],
    ["all", "", ""],
    ["all", "senior_frontend", ""],
    ["all", "data_ml", ""],
    ["all", "", "Frontend"],
    ["ranked", "senior_frontend,data_ml", "Engineer"],
  ])("board:108 tab %s families %j keyword %j returns no hidden posting and totalCount equals the visible rows", async (tab, families, keyword) => {
    const s = await seedSix()
    const query = [`tab=${tab}`, "limit=100", families ? `families=${families}` : "", keyword ? `keyword=${keyword}` : ""].filter(Boolean).join("&")
    const page = await list(ada, query)
    for (const hidden of [s.H1, s.H2, s.H3, s.H4]) expect(ids(page)).not.toContain(hidden)
    expect(page.totalCount).toBe(page.postings.length)
    for (const posting of page.postings) expect(posting.hiddenReason).toBeNull()
  })

  it("board:132 totalCount counts only visible postings (30 visible, 12 data_ml)", async () => {
    for (let n = 0; n < 30; n++) await seed(database.db, adaId, { title: `Senior Frontend Engineer ${n}` }, ranked)
    for (let n = 0; n < 12; n++) await seed(database.db, adaId, { title: `Senior Data Engineer ${n}`, family: "data_ml" }, ranked)
    const page = await list(ada, "tab=ranked")
    expect(page.totalCount).toBe(30)
    expect(page.postings).toHaveLength(25)
    expect(page.nextCursor).toEqual(expect.any(String))
  })

  it("board:139 waitingToBeCheckedCount counts only visible waiting postings", async () => {
    for (let n = 0; n < 2; n++) await seed(database.db, adaId, { title: "Senior Frontend Engineer" }, { status: "waiting_to_be_checked" })
    for (let n = 0; n < 3; n++) await seed(database.db, adaId, { title: "Solutions Architect", family: "solutions_customer" }, { status: "waiting_to_be_checked" })
    await seed(database.db, adaId, { title: "Senior Backend Engineer", family: "backend", postedAt: null }, { status: "waiting_to_be_checked" })
    for (let n = 0; n < 4; n++) await seed(database.db, adaId, { title: "Senior Frontend Engineer" }, { status: "not_checked" })
    await seed(database.db, adaId, { title: "Senior Frontend Engineer" }, { status: "checking", checkingSince: clock.now() })
    const page = await list(ada, "tab=all")
    expect(page.waitingToBeCheckedCount).toBe(2)
    expect(page.recheckableCount).toBe(4)
  })

  it("board:149 the EPIC-0004 criteria empty state ignores hidden skips", async () => {
    await setCriteria(database.db, adaId, { min: 90 })
    await seed(database.db, adaId, { title: "Senior Data Engineer at Initech", family: "data_ml" }, { status: "skipped", skipReason: "weak_core_match", covered: 8 })
    expect((await list(ada, "tab=ranked")).criteriaEmptyState).toBe(false)
  })

  it("board:157 the EPIC-0004 criteria empty state still shows for a visible weak-Match skip", async () => {
    await setCriteria(database.db, adaId, { min: 90 })
    await seed(database.db, adaId, { title: "Frontend Engineer at Initech" }, { status: "skipped", skipReason: "weak_core_match", covered: 8 })
    expect((await list(ada, "tab=ranked")).criteriaEmptyState).toBe(true)
  })

  it("board:165 @AC-3.1 / board:483 @AC-3.11 a hidden posting keeps every stored fact and column after every tab is loaded", async () => {
    const id = await seed(database.db, adaId, { title: "Senior Data Engineer at Initech", family: "data_ml" }, ranked)
    await sql`update job_posting set technologies = ${JSON.stringify([{ name: "Python", quote: "Python" }])} where id = ${id}`.execute(database.db)
    const before = await snapshotPosting(database.db, id)
    for (const tab of ["ranked", "skipped", "all"]) await list(ada, `tab=${tab}`)
    await ada.get(`/v1/job-postings/${id}`).expect(200)
    expect(await snapshotPosting(database.db, id)).toBe(before)
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
  })

  it("board:173 @AC-3.1 hidden is not a posting status: detail shows status ranked and the contract has no 'hidden' status", async () => {
    const id = await seed(database.db, adaId, { title: "Senior Data Engineer at Initech", family: "data_ml" }, ranked)
    const detail = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${id}`).expect(200)).body)
    expect(detail.status).toBe("ranked")
    expect(jobPostingStatusSchema.options).not.toContain("hidden")
    expect(jobPostingStatusSchema.options).toContain("not_checked")
  })
})

describe("AC-3.3 @AC-3.3 ranks over visible ranked postings only (board:181-220)", () => {
  it("board:182 unchecking Data and ML through a save moves the postings below it up", async () => {
    await setCriteria(database.db, adaId, { targets: ALL_FAMILIES })
    const sf = await seed(database.db, adaId, { title: "Senior Frontend Engineer at Acme", family: "senior_frontend" }, ranked)
    const data = await seed(database.db, adaId, { title: "Senior Data Engineer at Initech", family: "data_ml" }, ranked)
    const full = await seed(database.db, adaId, { title: "Fullstack Engineer at Hooli", family: "fullstack" }, ranked)
    const back = await seed(database.db, adaId, { title: "Senior Backend Engineer at Umbrella", family: "backend" }, ranked)
    expect((await list(ada, "tab=ranked")).postings.map((p) => p.rank)).toEqual([1, 2, 3, 4])
    const targets = ALL_FAMILIES.filter((f) => f !== "data_ml")
    await ada.put("/v1/candidate-settings/job-criteria").send({ minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: targets, seniorityFloor: "hide_entry_level" }).expect(200)
    const page = await list(ada, "tab=ranked")
    expect(page.postings.map((p) => [p.id, p.rank])).toEqual([
      [sf, 1],
      [full, 2],
      [back, 3],
    ])
    expect(ids(page)).not.toContain(data)
  })

  it("board:199 a ranked posting that ages past 60 days leaves Ranked and the one below moves up", async () => {
    const old = await seed(database.db, adaId, { title: "Senior Frontend Engineer at Acme", postedAt: wat("2026-08-25") }, { status: "ranked", covered: 10 })
    const fresh = await seed(database.db, adaId, { title: "Fullstack Engineer at Hooli", family: "fullstack" }, ranked)
    expect((await list(ada, "tab=ranked")).postings.map((p) => [p.id, p.rank])).toEqual([
      [old, 1],
      [fresh, 2],
    ])
    clock.set("2026-10-25T09:00:00+01:00")
    expect((await list(ada, "tab=ranked")).postings.map((p) => [p.id, p.rank])).toEqual([[fresh, 1]])
  })

  it("board:210 the All tab shows global visible ranks and no rank for unranked postings", async () => {
    const sf = await seed(database.db, adaId, { title: "Senior Frontend Engineer at Acme" }, ranked)
    await seed(database.db, adaId, { title: "Senior Data Engineer at Initech", family: "data_ml" }, ranked)
    const full = await seed(database.db, adaId, { title: "Fullstack Engineer at Hooli", family: "fullstack" }, ranked)
    const skipped = await seed(database.db, adaId, { title: "Frontend Engineer at Globex" }, { status: "skipped", skipReason: "weak_core_match", covered: 5 })
    const rankOf = new Map((await list(ada, "tab=all")).postings.map((p) => [p.id, p.rank]))
    expect(rankOf.get(sf)).toBe(1)
    expect(rankOf.get(full)).toBe(2)
    expect(rankOf.get(skipped)).toBeNull()
  })
})

describe("AC-3.4 @AC-3.4 hiddenCounts by first reason, ignoring tab, filter and cursor (board:224-264, 491)", () => {
  it("board:225 each hidden posting counts once under its first reason", async () => {
    await seed(database.db, adaId, { title: "Hotline Paralegal", family: null, prefilterSkip: "not_software_role", marker: "none" }, { status: "skipped", skipReason: "not_software_role" })
    await seed(database.db, adaId, { title: "Junior Data Engineer", family: "data_ml", postedAt: null, marker: "entry" }, ranked)
    await seed(database.db, adaId, { title: "Junior Frontend Developer", postedAt: wat("2026-08-01"), marker: "entry" }, { status: "skipped", skipReason: "weak_core_match", covered: 5 })
    await seed(database.db, adaId, { title: "Senior Frontend Engineer", postedAt: null }, { status: "evaluation_failed", evaluationFailure: "not_configured" })
    await seed(database.db, adaId, { title: "Staff Frontend Engineer", postedAt: wat("2026-08-24") }, ranked)
    await seed(database.db, adaId, { title: "Senior Frontend Engineer" }, ranked)
    const page = await list(ada, "tab=ranked")
    expect(page.hiddenCounts).toEqual({ offTarget: 2, belowSeniorityFloor: 1, undated: 1, olderThan60Days: 1, total: 5 })
  })

  it.each([
    ["tab=ranked", 1],
    ["tab=ranked", 2],
    ["tab=skipped", 1],
    ["tab=all&families=mobile", 1],
    ["tab=all&families=other&keyword=zzz", 1],
  ])("board:239 %s page %i gives off-target 3, undated 2", async (query, pageNo) => {
    for (let n = 0; n < 3; n++) await seed(database.db, adaId, { title: "Solutions Architect", family: "solutions_customer" }, { status: "evaluation_failed", evaluationFailure: "not_configured" })
    for (let n = 0; n < 2; n++) await seed(database.db, adaId, { title: "Senior Frontend Engineer", postedAt: null }, ranked)
    for (let n = 0; n < 30; n++) await seed(database.db, adaId, { title: "Senior Frontend Engineer" }, ranked)
    let page = await list(ada, query)
    if (pageNo === 2) page = await list(ada, `${query}&cursor=${encodeURIComponent(page.nextCursor!)}`)
    expect(page.hiddenCounts).toEqual(counts({ offTarget: 3, undated: 2 }))
  })

  it("board:255 all zero when nothing is hidden", async () => {
    for (let n = 0; n < 3; n++) await seed(database.db, adaId, {}, ranked)
    expect((await list(ada, "tab=all")).hiddenCounts).toEqual(zeroCounts())
  })

  it("board:261 all zero with no postings; the response carries every v1.18.0 key", async () => {
    const page = await list(ada, "tab=ranked")
    expect(page).toEqual({
      postings: [],
      waitingToBeCheckedCount: 0,
      nextCursor: null,
      totalCount: 0,
      criteriaEmptyState: false,
      hiddenCounts: zeroCounts(),
      recheckableCount: 0,
      targetRoleFamilies: [...DEFAULT_TARGETS],
      waitingReason: null,
    })
  })

  it("board:492 a visitor without a session gets 401 'Sign in to continue.' and no hidden counts", async () => {
    await seed(database.db, adaId, { postedAt: null }, ranked)
    const anonymous = await new Browser(app, google).http().get("/v1/job-postings?tab=all").expect(401)
    expect(anonymous.body).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } })
    expect(JSON.stringify(anonymous.body)).not.toMatch(/hiddenCounts|offTarget/)
  })
})

describe("AC-3.7 @AC-3.7 family filter, target families and cursors across a save (board:402-471)", () => {
  it("targetRoleFamilies is the session Candidate's targets in catalog order", async () => {
    await setCriteria(database.db, adaId, { targets: ["other", "data_ml", "senior_frontend"] })
    expect((await list(ada, "tab=all")).targetRoleFamilies).toEqual(["senior_frontend", "data_ml", "other"])
  })

  it("board:423 a non-target family filter is accepted and returns an empty last page", async () => {
    for (let n = 0; n < 3; n++) await seed(database.db, adaId, { title: "QA Engineer", family: "other" }, ranked)
    for (let n = 0; n < 5; n++) await seed(database.db, adaId, {}, ranked)
    const page = await list(ada, "tab=all&families=other")
    expect(page.postings).toEqual([])
    expect(page.totalCount).toBe(0)
    expect(page.nextCursor).toBeNull()
  })

  it("board:431 a target and a non-target family lists only the target family's visible postings", async () => {
    for (let n = 0; n < 3; n++) await seed(database.db, adaId, { title: "Senior Data Engineer", family: "data_ml" }, ranked)
    const backend = [await seed(database.db, adaId, { title: "Senior Backend Engineer", family: "backend" }, ranked), await seed(database.db, adaId, { title: "Senior Backend Engineer", family: "backend" }, ranked)]
    const page = await list(ada, "tab=all&families=backend,data_ml")
    expect(ids(page).sort()).toEqual([...backend].sort())
    expect(page.totalCount).toBe(2)
  })

  it.each(ALL_FAMILIES)("board:439 @AC-1.1 family key %s is a valid filter value", async (family) => {
    await ada.get(`/v1/job-postings?tab=all&families=${family}`).expect(200)
  })

  it("an unknown family key is still 400", async () => {
    const response = await ada.get("/v1/job-postings?tab=all&families=robotics").expect(400)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("bad_request")
  })

  it("board:453 a cursor issued before a save keeps working and skips postings that became hidden", async () => {
    await setCriteria(database.db, adaId, { targets: ALL_FAMILIES })
    const start = Date.parse("2026-10-20T08:00:00Z")
    const dataIds: string[] = []
    // 40 skipped postings; the 10 oldest are data_ml.
    for (let n = 0; n < 40; n++) {
      const family = n < 10 ? "data_ml" : "senior_frontend"
      const id = await seed(database.db, adaId, { title: `Engineer ${n}`, family, discoveredAt: new Date(start + n * 60_000) }, { status: "skipped", skipReason: "weak_core_match", covered: 5 })
      if (family === "data_ml") dataIds.push(id)
    }
    const page1 = await list(ada, "tab=skipped&limit=25")
    await ada.put("/v1/candidate-settings/job-criteria").send({ minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: ALL_FAMILIES.filter((f) => f !== "data_ml"), seniorityFloor: "hide_entry_level" }).expect(200)
    const page2 = await list(ada, `tab=skipped&limit=25&cursor=${encodeURIComponent(page1.nextCursor!)}`)
    expect(page2.postings).toHaveLength(5)
    expect(new Set(ids(page2)).size).toBe(5)
    for (const id of dataIds) expect(ids(page2)).not.toContain(id)
    for (const id of ids(page2)) expect(ids(page1)).not.toContain(id)
  })

  it("board:464 a cursor issued before a save does not return a posting that became visible before the cursor", async () => {
    const start = Date.parse("2026-10-20T08:00:00Z")
    for (let n = 0; n < 30; n++) await seed(database.db, adaId, { title: `Frontend ${n}`, discoveredAt: new Date(start + n * 60_000) }, { status: "skipped", skipReason: "weak_core_match", covered: 5 })
    const newest = await seed(database.db, adaId, { title: "Data Engineer", family: "data_ml", discoveredAt: new Date(start + 99 * 60_000) }, { status: "skipped", skipReason: "weak_core_match", covered: 5 })
    const page1 = await list(ada, "tab=skipped&limit=25")
    await ada.put("/v1/candidate-settings/job-criteria").send({ minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: [...DEFAULT_TARGETS, "data_ml"], seniorityFloor: "hide_entry_level" }).expect(200)
    const page2 = await list(ada, `tab=skipped&limit=25&cursor=${encodeURIComponent(page1.nextCursor!)}`)
    expect(page2.postings).toHaveLength(5)
    expect(ids(page2)).not.toContain(newest)
  })
})

describe("AC-2.2 @AC-2.2 @AC-2.1 the seniority floor hides entry-level markers only when it hides entry levels", () => {
  it("hide_entry_level hides an entry marker; mid_plus and none stay; all_levels shows all three", async () => {
    const entry = await seed(database.db, adaId, { title: "Junior Frontend Developer", marker: "entry" }, ranked)
    const mid = await seed(database.db, adaId, { title: "Senior/Junior Developer", family: "software_engineering", marker: "mid_plus" }, ranked)
    const none = await seed(database.db, adaId, { title: "Frontend Engineer", marker: "none" }, ranked)
    const page = await list(ada, "tab=all")
    expect(ids(page)).not.toContain(entry)
    expect(ids(page)).toEqual(expect.arrayContaining([mid, none]))
    expect(page.hiddenCounts).toEqual(counts({ belowSeniorityFloor: 1 }))
    await setCriteria(database.db, adaId, { floor: "all_levels" })
    expect(ids(await list(ada, "tab=all"))).toEqual(expect.arrayContaining([entry, mid, none]))
  })

  it("seniority-floor:202 @AC-2.4 an untitled posting is never below the floor", async () => {
    const id = await seed(database.db, adaId, { title: null, family: "other", marker: null, postingText: "Junior developer internship" }, { status: "waiting_to_be_checked" })
    expect(ids(await list(ada, "tab=all"))).toContain(id)
  })
})

describe("AC-6.1 @AC-6.1 @AC-6.2 @AC-6.6 posting age in WAT days, computed by the server (posting-age.feature)", () => {
  it.each([
    ["2026-09-24", true, 30],
    ["2026-09-23", true, 31],
    ["2026-08-25", true, 60],
    ["2026-08-24", false, 61],
  ])("posting-age:48 posted %s WAT at today 2026-10-24: returned %s, ageDays %i", async (date, returned, age) => {
    const id = await seed(database.db, adaId, { postedAt: wat(date) }, ranked)
    const page = await list(ada, "tab=all")
    const row = page.postings.find((p) => p.id === id)
    if (returned) {
      expect(row).toMatchObject({ ageDays: age, postedOn: date, postedDateKind: "published", postedAt: wat(date).toISOString(), hiddenReason: null })
    } else {
      expect(row).toBeUndefined()
      expect(page.hiddenCounts).toEqual(counts({ olderThan60Days: 1 }))
      const detail = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${id}`).expect(200)).body)
      expect(detail).toMatchObject({ ageDays: age, hiddenReason: "older_than_60_days", rank: null })
    }
  })

  it.each([
    ["2026-10-24", "09:00"],
    ["2026-09-24", "00:00"],
    ["2026-09-24", "23:59"],
    ["2026-09-23", "23:59"],
    ["2026-09-23", "00:00"],
    ["2026-08-25", "00:00"],
    ["2026-08-25", "23:59"],
  ])("posting-age:27 posted %s %s WAT is listed", async (date, time) => {
    const id = await seed(database.db, adaId, { postedAt: wat(date, time) }, ranked)
    expect(ids(await list(ada, "tab=all"))).toContain(id)
  })

  it.each([
    ["2026-08-24", "23:59"],
    ["2026-08-24", "00:00"],
    ["2026-07-01", "12:00"],
  ])("posting-age:27 posted %s %s WAT is not listed", async (date, time) => {
    const id = await seed(database.db, adaId, { postedAt: wat(date, time) }, ranked)
    expect(ids(await list(ada, "tab=all"))).not.toContain(id)
  })

  it.each([
    ["2026-09-23T23:00:00Z", 30, "2026-09-24"],
    ["2026-09-23T22:59:59Z", 31, "2026-09-23"],
    ["2026-08-24T23:00:00Z", 60, "2026-08-25"],
  ])("posting-age:79 posted instant %s takes its WAT date: age %i", async (instant, age, postedOn) => {
    const id = await seed(database.db, adaId, { postedAt: new Date(instant) }, ranked)
    expect((await list(ada, "tab=all")).postings.find((p) => p.id === id)).toMatchObject({ ageDays: age, postedOn })
  })

  it("posting-age:79 posted instant 2026-08-24T22:59:59Z is age 61 and hidden", async () => {
    const id = await seed(database.db, adaId, { postedAt: new Date("2026-08-24T22:59:59Z") }, ranked)
    expect(ids(await list(ada, "tab=all"))).not.toContain(id)
  })

  it.each([
    ["2026-09-23T23:59:00+01:00", 0],
    ["2026-09-24T00:00:00+01:00", 1],
    ["2026-09-23T23:00:00Z", 1],
    ["2026-09-23T22:59:59Z", 0],
  ])("posting-age:65 the PRD WAT example: posted 2026-09-23T23:30+01:00, now %s gives age %i", async (now, age) => {
    const id = await seed(database.db, adaId, { postedAt: new Date("2026-09-23T23:30:00+01:00") }, ranked)
    // Q-1: rewinding the clock >14 days would touch the shared session in the past and expire it for the rest
    // of the file. Use a session of the same Operator signed in at the rewound time, then restore the clock.
    clock.set(now)
    try {
      const rewound = await signInCandidate(new Browser(app, google))
      expect((await list(rewound, "tab=all")).postings.find((p) => p.id === id)?.ageDays).toBe(age)
    } finally {
      clock.set(TODAY)
    }
  })

  it("posting-age:107 the server returns ageDays 40 for 2026-09-14 WAT", async () => {
    const id = await seed(database.db, adaId, { postedAt: wat("2026-09-14") }, ranked)
    expect((await list(ada, "tab=all")).postings.find((p) => p.id === id)?.ageDays).toBe(40)
  })

  it("posting-age:193 @AC-6.5 a posting reaches age 31 at 00:00 WAT with no job run", async () => {
    const id = await seed(database.db, adaId, { postedAt: wat("2026-09-24") }, ranked)
    clock.set("2026-10-24T23:59:00+01:00")
    expect((await list(ada, "tab=all")).postings.find((p) => p.id === id)?.ageDays).toBe(30)
    clock.set("2026-10-25T00:00:00+01:00")
    expect((await list(ada, "tab=all")).postings.find((p) => p.id === id)?.ageDays).toBe(31)
  })

  it("posting-age:202 / :212 @AC-6.5 a posting leaves Ranked at 00:00 WAT on day 61 and nothing is written to it", async () => {
    const id = await seed(database.db, adaId, { postedAt: wat("2026-08-25") }, ranked)
    clock.set("2026-10-24T23:59:00+01:00")
    expect((await list(ada, "tab=ranked")).postings.find((p) => p.id === id)?.ageDays).toBe(60)
    const before = await snapshotPosting(database.db, id)
    clock.set("2026-10-25T00:00:00+01:00")
    expect(ids(await list(ada, "tab=ranked"))).not.toContain(id)
    expect(await snapshotPosting(database.db, id)).toBe(before)
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
  })

  it("posting-age:226 @AC-3.4 three over-60 and two at 60: olderThan60Days 3, totalCount 2", async () => {
    for (let n = 0; n < 3; n++) await seed(database.db, adaId, { postedAt: wat("2026-08-24") }, ranked)
    for (let n = 0; n < 2; n++) await seed(database.db, adaId, { postedAt: wat("2026-08-25") }, ranked)
    const page = await list(ada, "tab=ranked")
    expect(page.hiddenCounts).toEqual(counts({ olderThan60Days: 3 }))
    expect(page.totalCount).toBe(2)
  })

  it("posting-age:235 @AC-5.3 an updated-basis date over 60 days old hides the posting too", async () => {
    const id = await seed(database.db, adaId, { postedAt: wat("2026-08-01"), kind: "updated" }, ranked)
    expect(ids(await list(ada, "tab=ranked"))).not.toContain(id)
  })

  it("posted fields are all null for an undated posting and all set for a dated one (contract invariant)", async () => {
    const dated = await seed(database.db, adaId, { postedAt: wat("2026-09-09"), kind: "updated" }, ranked)
    const undated = await seed(database.db, adaId, { postedAt: null }, ranked)
    const page = await list(ada, "tab=all")
    expect(page.postings.find((p) => p.id === dated)).toMatchObject({ postedAt: wat("2026-09-09").toISOString(), postedOn: "2026-09-09", postedDateKind: "updated", ageDays: 45 })
    const detail = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${undated}`).expect(200)).body)
    expect(detail).toMatchObject({ postedAt: null, postedOn: null, postedDateKind: null, ageDays: null, hiddenReason: "undated" })
  })
})

describe("AC-3.8 @AC-3.8 a hidden posting's detail is 200 with its first reason and no rank (applications-and-links:32-110)", () => {
  it.each([
    ["Senior Data Engineer", "data_ml", DATED, "mid_plus", "off_target"],
    ["Junior Frontend Developer", "senior_frontend", DATED, "entry", "below_seniority_floor"],
    ["Senior Frontend Engineer", "senior_frontend", null, "mid_plus", "undated"],
    ["Staff Frontend Engineer", "senior_frontend", wat("2026-08-01", "11:00"), "mid_plus", "older_than_60_days"],
    ["Junior Frontend Developer", "senior_frontend", null, "entry", "below_seniority_floor"],
    ["Junior Data Engineer", "data_ml", null, "entry", "off_target"],
  ] as const)("detail of %s (%s) gives hiddenReason by AC-3.4 order", async (title, family, postedAt, marker, reason) => {
    const id = await seed(database.db, adaId, { title, family, postedAt, marker }, ranked)
    const detail = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${id}`).expect(200)).body)
    expect(detail).toMatchObject({ hiddenReason: reason, rank: null, status: "ranked" })
  })

  it("applications-and-links:108 a visible posting's detail has no hidden reason and keeps its rank", async () => {
    const id = await seed(database.db, adaId, {}, ranked)
    expect(jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${id}`).expect(200)).body)).toMatchObject({ hiddenReason: null, rank: 1 })
  })

  it("posting-age:176 @AC-6.4 a hidden over-60-day posting's detail still carries its posted date", async () => {
    const id = await seed(database.db, adaId, { postedAt: new Date("2026-08-01T10:00:00Z") }, ranked)
    expect(jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${id}`).expect(200)).body)).toMatchObject({ postedOn: "2026-08-01", hiddenReason: "older_than_60_days" })
  })

  it("applications-and-links:115 the detail needs a session", async () => {
    const id = await seed(database.db, adaId, { postedAt: null }, ranked)
    await new Browser(app, google).http().get(`/v1/job-postings/${id}`).expect(401)
  })
})

describe("AC-3.9 @AC-3.9 409 posting_hidden on POST /v1/applications and POST /v1/applications/{id}/sample", () => {
  async function application(postingId: string, state = "prepared") {
    const id = randomUUID()
    await database.db
      .insertInto("application")
      .values({ candidate_id: adaId, id, job_posting_id: postingId, application_url: `https://boards.greenhouse.io/qa6/jobs/${postingId}`, requisition_id: "R-1", company: "Umbrella", role_title: "Staff Frontend Engineer", state: state as never, career_profile_version: null, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date() })
      .execute()
    return id
  }

  it("applications-and-links:158 a Manual Application cannot be created from a hidden posting: 409 with the exact message, no Application", async () => {
    const id = await seed(database.db, adaId, { title: "Staff Frontend Engineer", company: "Umbrella", postedAt: wat("2026-08-01"), applyMode: "manual" }, ranked)
    const response = await ada.post("/v1/applications").send({ jobPostingId: id }).expect(409)
    expect(response.body).toEqual({ error: { code: "posting_hidden", message: POSTING_HIDDEN_MESSAGE } })
    expect(await database.db.selectFrom("application").select("id").where("job_posting_id", "=", id).execute()).toEqual([])
  })

  it("applications-and-links:165 an existing Application does not bypass the refusal and stays prepared", async () => {
    const posting = await seed(database.db, adaId, { title: "Staff Frontend Engineer", postedAt: wat("2026-08-01"), applyMode: "manual" }, ranked)
    const existing = await application(posting)
    const response = await ada.post("/v1/applications").send({ jobPostingId: posting }).expect(409)
    expect(response.body.error.code).toBe("posting_hidden")
    const rows = await database.db.selectFrom("application").select(["id", "state"]).where("job_posting_id", "=", posting).execute()
    expect(rows).toEqual([{ id: existing, state: "prepared" }])
  })

  it("applications-and-links:173 sample generation for an Application whose posting is hidden is 409 with no model call", async () => {
    const posting = await seed(database.db, adaId, { title: "Senior Platform Engineer", family: "platform_engineering" }, ranked)
    await setCriteria(database.db, adaId, { targets: DEFAULT_TARGETS.filter((f) => f !== "platform_engineering") })
    const app6 = await application(posting, "documents_ready")
    const response = await ada.post(`/v1/applications/${app6}/sample`).expect(409)
    expect(response.body).toEqual({ error: { code: "posting_hidden", message: POSTING_HIDDEN_MESSAGE } })
    expect(anthropic.requests).toHaveLength(0)
    const row = await database.db.selectFrom("application").select(["sample_state", "submission_kind"]).where("id", "=", app6).executeTakeFirstOrThrow()
    expect(row).toEqual({ sample_state: null, submission_kind: null })
  })

  it("order of checks: a posting the session Candidate does not hold is 404, even when hidden for the holder", async () => {
    const id = await seed(database.db, adaId, { postedAt: null }, ranked)
    const response = await kofi.post("/v1/applications").send({ jobPostingId: id }).expect(404)
    expect(response.body.error.code).toBe("not_found")
  })

  it("a visible ranked posting still becomes an Application (201)", async () => {
    const id = await seed(database.db, adaId, {}, ranked)
    await ada.post("/v1/applications").send({ jobPostingId: id }).expect(201)
  })
})

describe("per-candidate-tenancy: hidden, counts, ranks and notices per Candidate (@AC-3.1 @AC-3.2 @AC-3.4 @AC-7.10)", () => {
  it("per-candidate:73 the same posting is hidden for Ada and visible for Kofi", async () => {
    const id = await insertPosting(database.db, { title: "Senior Data Engineer at Initech", family: "data_ml" })
    await hold(database.db, adaId, id, ranked)
    await hold(database.db, kofiId, id, ranked)
    await setCriteria(database.db, kofiId, { targets: [...DEFAULT_TARGETS, "data_ml"] })
    expect(ids(await list(kofi, "tab=all"))).toContain(id)
    const adaPage = await list(ada, "tab=all")
    expect(ids(adaPage)).not.toContain(id)
    expect(adaPage.hiddenCounts.offTarget).toBe(1)
  })

  it("per-candidate:82 @AC-2.2 the floor hides a posting only for the Candidate whose floor hides entry levels", async () => {
    const id = await insertPosting(database.db, { title: "Junior Frontend Developer at Hooli", marker: "entry" })
    await hold(database.db, adaId, id, ranked)
    await hold(database.db, kofiId, id, ranked)
    await setCriteria(database.db, kofiId, { floor: "all_levels" })
    expect(ids(await list(kofi, "tab=ranked"))).toContain(id)
    expect(ids(await list(ada, "tab=ranked"))).not.toContain(id)
  })

  it("per-candidate:90 undated and over-60 postings are hidden for every holder", async () => {
    const undated = await insertPosting(database.db, { postedAt: null })
    const old = await insertPosting(database.db, { postedAt: wat("2026-08-01") })
    for (const c of [adaId, kofiId]) for (const p of [undated, old]) await hold(database.db, c, p, ranked)
    await setCriteria(database.db, kofiId, { targets: ALL_FAMILIES, floor: "all_levels" })
    for (const who of [ada, kofi]) {
      const page = await list(who, "tab=all")
      expect(ids(page)).not.toContain(undated)
      expect(ids(page)).not.toContain(old)
    }
  })

  async function seedBoth() {
    for (let n = 0; n < 5; n++) await seed(database.db, adaId, {}, ranked)
    for (let n = 0; n < 2; n++) await seed(database.db, adaId, {}, { status: "waiting_to_be_checked" })
    for (let n = 0; n < 3; n++) await seed(database.db, adaId, {}, { status: "evaluation_failed", evaluationFailure: "not_configured" })
    for (let n = 0; n < 4; n++) await seed(database.db, adaId, { title: "Senior Data Engineer", family: "data_ml" }, ranked)
    for (let n = 0; n < 9; n++) await seed(database.db, kofiId, {}, ranked)
    await seed(database.db, kofiId, {}, { status: "waiting_to_be_checked" })
    for (let n = 0; n < 6; n++) await seed(database.db, kofiId, {}, { status: "not_checked" })
    for (let n = 0; n < 7; n++) await seed(database.db, kofiId, { postedAt: null }, ranked)
  }

  it("per-candidate:100 every count covers only Ada's postings", async () => {
    await seedBoth()
    const page = await list(ada, "tab=all")
    expect(page).toMatchObject({ totalCount: 10, waitingToBeCheckedCount: 2, recheckableCount: 3, hiddenCounts: counts({ offTarget: 4 }) })
  })

  it("per-candidate:110 Kofi's counts exclude the Operator's postings", async () => {
    await seedBoth()
    const page = await list(kofi, "tab=all")
    expect(page).toMatchObject({ totalCount: 16, waitingToBeCheckedCount: 1, recheckableCount: 6, hiddenCounts: counts({ undated: 7 }) })
  })

  it("per-candidate:120 @AC-3.6 Kofi with no postings gets zero counts while Ada's board is all hidden", async () => {
    for (let n = 0; n < 20; n++) await seed(database.db, adaId, { postedAt: null }, { status: "evaluation_failed", evaluationFailure: "not_configured" })
    const page = await list(kofi, "tab=ranked")
    expect(page).toMatchObject({ totalCount: 0, hiddenCounts: zeroCounts(), recheckableCount: 0 })
    expect((await list(kofi, "tab=all")).totalCount).toBe(0)
  })

  it("per-candidate:129 @AC-3.3 ranks are computed over each Candidate's own visible ranked postings", async () => {
    const shared = [await insertPosting(database.db, { title: "Senior Frontend Engineer A" }), await insertPosting(database.db, { title: "Senior Data Engineer B", family: "data_ml" }), await insertPosting(database.db, { title: "Fullstack Engineer C", family: "fullstack" })]
    for (const c of [adaId, kofiId]) for (const p of shared) await hold(database.db, c, p, ranked)
    await setCriteria(database.db, kofiId, { targets: ALL_FAMILIES })
    expect((await list(ada, "tab=ranked")).postings.map((p) => p.rank)).toEqual([1, 2])
    expect((await list(kofi, "tab=ranked")).postings.map((p) => p.rank)).toEqual([1, 2, 3])
  })

  it("per-candidate:141 @AC-3.7 targetRoleFamilies follows the session Candidate", async () => {
    await setCriteria(database.db, kofiId, { targets: ["backend", "data_ml"] })
    expect((await list(kofi, "tab=all")).targetRoleFamilies).toEqual(["backend", "data_ml"])
    expect((await list(ada, "tab=all")).targetRoleFamilies).toEqual([...DEFAULT_TARGETS])
  })

  it("per-candidate:151 @AC-3.8 the detail notice reason follows the session Candidate's criteria", async () => {
    const id = await insertPosting(database.db, { title: "Senior Data Engineer", family: "data_ml" })
    await hold(database.db, adaId, id, ranked)
    await hold(database.db, kofiId, id, ranked)
    await setCriteria(database.db, kofiId, { targets: [...DEFAULT_TARGETS, "data_ml"] })
    expect(jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${id}`).expect(200)).body).hiddenReason).toBe("off_target")
    expect(jobPostingDetailSchema.parse((await kofi.get(`/v1/job-postings/${id}`).expect(200)).body).hiddenReason).toBeNull()
  })

  it("per-candidate:161 @AC-3.9 a Manual Application is refused for the Candidate the posting is hidden for and allowed for the other", async () => {
    const id = await insertPosting(database.db, { title: "Senior Data Engineer", family: "data_ml", applyMode: "manual" })
    await hold(database.db, adaId, id, ranked)
    await hold(database.db, kofiId, id, ranked)
    await setCriteria(database.db, kofiId, { targets: [...DEFAULT_TARGETS, "data_ml"] })
    expect((await ada.post("/v1/applications").send({ jobPostingId: id }).expect(409)).body).toEqual({ error: { code: "posting_hidden", message: POSTING_HIDDEN_MESSAGE } })
    await kofi.post("/v1/applications").send({ jobPostingId: id }).expect(201)
  })

  it("per-candidate:179 @AC-4.3 the same posting is not_checked for Kofi and ranked for Ada; each sees their own status", async () => {
    const id = await insertPosting(database.db, {})
    await hold(database.db, adaId, id, ranked)
    await hold(database.db, kofiId, id, { status: "not_checked" })
    expect((await list(ada, "tab=all")).postings.find((p) => p.id === id)?.status).toBe("ranked")
    const kofiRow = (await list(kofi, "tab=all")).postings.find((p) => p.id === id)
    expect(kofiRow).toMatchObject({ status: "not_checked", rank: null, evaluationFailure: null })
    expect((await list(kofi, "tab=all")).recheckableCount).toBe(1)
    expect(ids(await list(kofi, "tab=ranked"))).not.toContain(id)
    expect(ids(await list(kofi, "tab=skipped"))).not.toContain(id)
  })

  it("per-candidate:199 @AC-5.1 every holder sees the same posted date and age", async () => {
    const id = await insertPosting(database.db, { postedAt: wat("2026-09-09") })
    await hold(database.db, adaId, id, ranked)
    await hold(database.db, kofiId, id, ranked)
    const a = (await list(ada, "tab=all")).postings.find((p) => p.id === id)!
    const k = (await list(kofi, "tab=all")).postings.find((p) => p.id === id)!
    for (const key of ["postedAt", "postedOn", "postedDateKind", "ageDays"] as const) expect(k[key]).toEqual(a[key])
    expect(a.ageDays).toBe(45)
  })
})

describe("AC-7.4 @AC-7.4 @AC-7.10 waitingReason and recheckableCount (per-candidate:347-398, check-again:96-142)", () => {
  it("per-candidate:347 the Operator's visible waiting postings give waitingReason cost_pause", async () => {
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    for (let n = 0; n < 2; n++) await seed(database.db, adaId, {}, { status: "waiting_to_be_checked" })
    expect(await list(ada, "tab=ranked")).toMatchObject({ waitingToBeCheckedCount: 2, waitingReason: "cost_pause" })
  })

  it("per-candidate:358 a non-Operator's visible waiting postings give waitingReason checks_not_enabled", async () => {
    for (let n = 0; n < 3; n++) await seed(database.db, kofiId, {}, { status: "waiting_to_be_checked" })
    expect(await list(kofi, "tab=ranked")).toMatchObject({ waitingToBeCheckedCount: 3, waitingReason: "checks_not_enabled" })
  })

  it.each(["ada", "kofi"] as const)("per-candidate:374 %s with only a hidden waiting posting gets count 0 and waitingReason null", async (who) => {
    await seed(database.db, who === "ada" ? adaId : kofiId, { title: "Senior Data Engineer", family: "data_ml" }, { status: "waiting_to_be_checked" })
    expect(await list(who === "ada" ? ada : kofi, "tab=ranked")).toMatchObject({ waitingToBeCheckedCount: 0, waitingReason: null })
  })

  it("per-candidate:389 the waiting reason follows the session Candidate, not the posting", async () => {
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    const id = await insertPosting(database.db, {})
    await hold(database.db, adaId, id, { status: "waiting_to_be_checked" })
    await hold(database.db, kofiId, id, { status: "waiting_to_be_checked" })
    expect((await list(ada, "tab=ranked")).waitingReason).toBe("cost_pause")
    expect((await list(kofi, "tab=ranked")).waitingReason).toBe("checks_not_enabled")
  })

  it("waitingReason and recheckableCount are the same on every tab, page and filter", async () => {
    for (let n = 0; n < 30; n++) await seed(database.db, kofiId, {}, ranked)
    await seed(database.db, kofiId, {}, { status: "waiting_to_be_checked" })
    await seed(database.db, kofiId, {}, { status: "evaluation_failed", evaluationFailure: "timed_out" })
    const first = await list(kofi, "tab=ranked")
    const second = await list(kofi, `tab=ranked&cursor=${encodeURIComponent(first.nextCursor!)}`)
    for (const page of [first, second, await list(kofi, "tab=skipped"), await list(kofi, "tab=all&families=mobile&keyword=zzz")]) {
      expect(page).toMatchObject({ waitingReason: "checks_not_enabled", waitingToBeCheckedCount: 1, recheckableCount: 1 })
    }
  })

  it("check-again:97 one combined count of visible failed and not-checked postings", async () => {
    await seed(database.db, adaId, { title: "Senior Frontend Engineer at Globex" }, { status: "evaluation_failed", evaluationFailure: "not_configured" })
    await seed(database.db, adaId, { title: "Senior Backend Engineer at Hooli", family: "backend" }, { status: "evaluation_failed", evaluationFailure: "provider_error" })
    await seed(database.db, adaId, { title: "Fullstack Engineer at Initech", family: "fullstack" }, { status: "evaluation_failed", evaluationFailure: "timed_out" })
    await seed(database.db, adaId, { title: "Senior Software Engineer at Lumon", family: "software_engineering" }, { status: "not_checked" })
    await seed(database.db, adaId, { title: "Senior iOS Engineer at Pied Piper", family: "mobile" }, { status: "checking", checkingSince: clock.now() })
    await seed(database.db, adaId, { title: "Lead Engineer at Vandelay", family: "technical_lead" }, { status: "waiting_to_be_checked" })
    await seed(database.db, adaId, { title: "Solutions Architect at Acme", family: "solutions_customer" }, { status: "evaluation_failed", evaluationFailure: "not_configured" })
    await seed(database.db, adaId, { title: "TAM Architect at Umbrella", family: "solutions_customer" }, { status: "not_checked" })
    await seed(database.db, adaId, { title: "Product Engineer at Contoso", family: "product_engineering" }, ranked)
    expect((await list(ada, "tab=all")).recheckableCount).toBe(4)
  })

  it.each([
    ["not_checked", 1, 0],
    ["checking", 0, 0],
    ["waiting_to_be_checked", 0, 1],
    ["evaluation_failed", 1, 0],
    ["ranked", 0, 0],
    ["skipped", 0, 0],
    ["excluded", 0, 0],
  ] as const)("check-again:114 a visible %s posting counts %i toward Check again and %i toward waiting", async (status, recheck, waiting) => {
    // r4 (AC-7.11): the checking row is not stuck: it moved into checking at the request moment.
    await seed(database.db, adaId, {}, { status, evaluationFailure: status === "evaluation_failed" ? "provider_error" : null, skipReason: status === "skipped" ? "weak_core_match" : status === "excluded" ? "violated_rule" : null, checkingSince: clock.now() })
    expect(await list(ada, "tab=all")).toMatchObject({ recheckableCount: recheck, waitingToBeCheckedCount: waiting })
  })

  it("check-again:114 (r4, AC-7.11) a visible checking posting whose evaluation holds the lock counts in neither count, however long it has run", async () => {
    const id = await seed(database.db, adaId, {}, { status: "checking", checkingSince: new Date(clock.now().getTime() - 3_600_000) })
    const locker = new pg.Client({ connectionString: database.adminUrl })
    await locker.connect()
    try {
      await locker.query("select pg_advisory_lock($1::bigint)", [String(evaluationLockKey(adaId, id))])
      expect(await list(ada, "tab=all")).toMatchObject({ recheckableCount: 0, waitingToBeCheckedCount: 0 })
    } finally {
      await locker.end()
    }
    // Without the lock the same row is stuck and counts toward Check again (stuck-checking-recovery.feature).
    expect(await list(ada, "tab=all")).toMatchObject({ recheckableCount: 1, waitingToBeCheckedCount: 0 })
  })

  it.each(["not_checked", "waiting_to_be_checked", "evaluation_failed"] as const)("check-again:131 a hidden %s posting counts in neither count", async (status) => {
    await seed(database.db, adaId, { title: "Senior Data Engineer", family: "data_ml" }, { status, evaluationFailure: status === "evaluation_failed" ? "not_configured" : null })
    expect(await list(ada, "tab=all")).toMatchObject({ recheckableCount: 0, waitingToBeCheckedCount: 0 })
  })

  it.each(["not_configured", "not_approved", "no_career_profile", "provider_error", "invalid_output", "timed_out", "posting_unavailable"])(
    "check-again:144 failure kind %s counts toward Check again",
    async (kind) => {
      await seed(database.db, adaId, {}, { status: "evaluation_failed", evaluationFailure: kind })
      expect((await list(ada, "tab=all")).recheckableCount).toBe(1)
    }
  )

  it("contract: evaluationFailure is null for a checking row even when a kind is stored", async () => {
    const id = await seed(database.db, adaId, {}, { status: "checking", evaluationFailure: "not_configured" })
    expect((await list(ada, "tab=all")).postings.find((p) => p.id === id)?.evaluationFailure).toBeNull()
  })

  it.each([
    ["Senior Frontend Engineer at Himalayas Co", "senior_frontend"],
    ["Senior Backend Engineer at Remotive Co", "backend"],
  ] as const)("check-again r5 (P16) a store-time skip %s keeps skipped/unsupported_application_system and counts in neither count", async (title, family) => {
    await setCriteria(database.db, adaId, { targets: ALL_FAMILIES })
    const id = await seed(database.db, adaId, { title, family, origin: "remote_board", applyMode: "manual" }, { status: "skipped", skipReason: "unsupported_application_system" })
    const page = await list(ada, "tab=all")
    expect(page.postings.find((p) => p.id === id)).toMatchObject({ status: "skipped", skipReason: "unsupported_application_system" })
    expect(page).toMatchObject({ recheckableCount: 0, waitingToBeCheckedCount: 0 })
  })

  it("check-again r5 (P16) a dated pre-filter skip with every family targeted lists nothing and counts in neither count", async () => {
    await setCriteria(database.db, adaId, { targets: ALL_FAMILIES })
    await seed(database.db, adaId, { title: "Data Scientist at Initech", family: null, prefilterSkip: "not_software_role", marker: "none" }, { status: "skipped", skipReason: "not_software_role" })
    const page = await list(ada, "tab=all")
    expect(page.postings).toEqual([])
    expect(page).toMatchObject({ recheckableCount: 0, waitingToBeCheckedCount: 0 })
  })

  it("check-again:259 @AC-8.4 every posting undated: recheckableCount is 0", async () => {
    for (let n = 0; n < 10; n++) await seed(database.db, adaId, { postedAt: null }, { status: "evaluation_failed", evaluationFailure: "not_configured" })
    expect((await list(ada, "tab=all")).recheckableCount).toBe(0)
  })
})
