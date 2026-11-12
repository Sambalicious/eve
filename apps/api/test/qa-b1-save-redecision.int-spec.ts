import { DEFAULT_ROLE_FAMILY_TIERS } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  type B1World,
  candidateSnapshot,
  clearPostings,
  clearPreferences,
  createRecord,
  failPostingUpdatesFor,
  kenyaValues,
  listTab,
  paidWork,
  read,
  save,
  saveOnTop,
  seedPosting,
  startB1World,
  stateOf,
  versionCount,
} from "./support/qa-b1.js"
import type { SignedInCandidate } from "./support/signed-in.js"

/**
 * EPIC-0002 B1 QA (qa-author, qa-tests-1): the keyword and family re-decision a
 * save does at once (api-contract-b1.md PUT side effects 1 to 4; architecture.r6
 * "Save and re-decision" steps 1 to 5). Kofi's postings are seeded rows; every
 * change is made through `PUT /v1/me/preferences` and read back from
 * `candidate_posting` and the list API.
 *
 * Gherkin: job-criteria-in-preferences.feature :446 to :630 (B1 rows);
 * job-postings-per-candidate.feature :428, :435, :925, :966, :973, :1011;
 * job-preferences.feature :207.
 */
let w: B1World
let kofi: SignedInCandidate

beforeAll(async () => {
  w = await startB1World()
})

afterAll(async () => {
  await w?.stop()
})

beforeEach(async () => {
  await clearPostings(w.db)
  await clearPreferences(w.db, w.kofi.id)
  await clearPreferences(w.db, w.wanjiru.id)
  kofi = await w.session(w.kofi)
  await createRecord(kofi)
})

const tiers = (change: Record<string, 1 | 2 | 3 | "excluded">) => ({ ...DEFAULT_ROLE_FAMILY_TIERS, ...change })

describe("keyword at save (jcip :446, :469, :484, :493, :586; jppc :925, :966, :973, :1011; jp :207)", () => {
  it(":446 setting react skips the ranked 'Senior Vue Engineer' at once (not waiting) with no paid call", async () => {
    const vue = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked" })
    const paid = await paidWork(w.db)
    await saveOnTop(kofi, { titleKeyword: "react" })
    expect(await stateOf(w.db, w.kofi.id, vue)).toMatchObject({ status: "skipped", skip_reason: "keyword_mismatch", skip_detail: null })
    expect(await paidWork(w.db)).toEqual(paid)
    const page = await listTab(kofi, "tab=skipped")
    expect(page.postings.find((p) => p.id === vue)).toMatchObject({ status: "skipped", skipReason: "keyword_mismatch", skipDetail: null })
  })

  it(":973 changing 'engineer' to 'react engineer' skips 'React Developer' and keeps 'Senior React Engineer' ranked, no paid call", async () => {
    await saveOnTop(kofi, { titleKeyword: "engineer" })
    const keep = await seedPosting(w.db, w.kofi.id, { title: "Senior React Engineer", status: "ranked" })
    const drop = await seedPosting(w.db, w.kofi.id, { title: "React Developer", status: "ranked" })
    const paid = await paidWork(w.db)
    await saveOnTop(kofi, { titleKeyword: "react engineer" })
    expect((await stateOf(w.db, w.kofi.id, drop)).skip_reason).toBe("keyword_mismatch")
    expect((await stateOf(w.db, w.kofi.id, keep)).status).toBe("ranked")
    expect(await paidWork(w.db)).toEqual(paid)
  })

  it(":469/:925 clearing the keyword returns the 2 keyword-mismatch postings to waiting_to_be_checked with no reason", async () => {
    await saveOnTop(kofi, { titleKeyword: "react" })
    const a = await seedPosting(w.db, w.kofi.id, { title: "Backend Engineer", family: "backend", status: "skipped", skipReason: "keyword_mismatch" })
    const b = await seedPosting(w.db, w.kofi.id, { title: "Go Engineer", family: "backend", status: "skipped", skipReason: "keyword_mismatch" })
    const paid = await paidWork(w.db)
    const saved = await saveOnTop(kofi, { titleKeyword: "" })
    expect(saved.values.titleKeyword).toBeNull()
    for (const id of [a, b]) expect(await stateOf(w.db, w.kofi.id, id)).toMatchObject({ status: "waiting_to_be_checked", skip_reason: null })
    expect((await paidWork(w.db)).aiCalls).toBe(paid.aiCalls)
    expect((await paidWork(w.db)).spend).toBe(paid.spend)
  })

  it(":966 changing react to engineer returns the 4 '... Engineer' mismatches to waiting in the same save", async () => {
    await saveOnTop(kofi, { titleKeyword: "react" })
    const ids = []
    for (const t of ["Go Engineer", "Rust Engineer", "Platform Engineer", "Data Engineer"]) ids.push(await seedPosting(w.db, w.kofi.id, { title: t, family: "backend", status: "skipped", skipReason: "keyword_mismatch" }))
    await saveOnTop(kofi, { titleKeyword: "engineer" })
    for (const id of ids) expect((await stateOf(w.db, w.kofi.id, id)).status).toBe("waiting_to_be_checked")
  })

  it(":484 changing react to vue returns 'Senior Vue Engineer' to waiting and skips 'React Engineer'", async () => {
    await saveOnTop(kofi, { titleKeyword: "react" })
    const vue = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "skipped", skipReason: "keyword_mismatch" })
    const react = await seedPosting(w.db, w.kofi.id, { title: "React Engineer", status: "ranked" })
    await saveOnTop(kofi, { titleKeyword: "vue" })
    expect((await stateOf(w.db, w.kofi.id, vue)).status).toBe("waiting_to_be_checked")
    expect((await stateOf(w.db, w.kofi.id, react)).skip_reason).toBe("keyword_mismatch")
  })

  it(":493 an old mismatch that misses the new keyword stays skipped as keyword_mismatch", async () => {
    await saveOnTop(kofi, { titleKeyword: "react" })
    const angular = await seedPosting(w.db, w.kofi.id, { title: "Senior Angular Engineer", status: "skipped", skipReason: "keyword_mismatch" })
    await saveOnTop(kofi, { titleKeyword: "vue" })
    expect(await stateOf(w.db, w.kofi.id, angular)).toMatchObject({ status: "skipped", skip_reason: "keyword_mismatch" })
  })

  it(":586 a newly set keyword overrides a pay-rule exclusion at the save, no paid call", async () => {
    const vue = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "excluded", skipReason: "violated_rule" })
    const paid = await paidWork(w.db)
    await saveOnTop(kofi, { titleKeyword: "react" })
    expect(await stateOf(w.db, w.kofi.id, vue)).toMatchObject({ status: "skipped", skip_reason: "keyword_mismatch" })
    expect(await paidWork(w.db)).toEqual(paid)
  })

  it(":1011 the saved keyword changes no rank among matching postings", async () => {
    const a = await seedPosting(w.db, w.kofi.id, { title: "React Engineer A", status: "ranked", covered: 9 })
    const b = await seedPosting(w.db, w.kofi.id, { title: "React Engineer B", status: "ranked", covered: 8 })
    const before = (await listTab(kofi, "tab=ranked")).postings.map((p) => [p.id, p.rank])
    expect(before).toEqual([[a, 1], [b, 2]])
    await saveOnTop(kofi, { titleKeyword: "react" })
    expect((await listTab(kofi, "tab=ranked")).postings.map((p) => [p.id, p.rank])).toEqual(before)
  })

  it("an untitled ranked posting is skipped as keyword_mismatch when a keyword is set (jppc :864 at save)", async () => {
    const untitled = await seedPosting(w.db, w.kofi.id, { title: null, family: "other", status: "ranked" })
    await saveOnTop(kofi, { titleKeyword: "engineer" })
    expect((await stateOf(w.db, w.kofi.id, untitled)).skip_reason).toBe("keyword_mismatch")
  })

  it("a zero-width-only keyword is no keyword: no ranked posting is skipped (jppc :877, :893 at save)", async () => {
    const untitled = await seedPosting(w.db, w.kofi.id, { title: null, family: "other", status: "ranked" })
    const vue = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked" })
    await saveOnTop(kofi, { titleKeyword: "\u200B" })
    expect((await stateOf(w.db, w.kofi.id, untitled)).status).toBe("ranked")
    expect((await stateOf(w.db, w.kofi.id, vue)).status).toBe("ranked")
  })

  it.each([
    ["%", "Senior Engineer", "keyword_mismatch"],
    ["_", "Senior Engineer", "keyword_mismatch"],
    ["\\", "Senior Engineer", "keyword_mismatch"],
    ["C++_", "C++_Platform Engineer", "ranked"],
    ["100%", "Engineer, 100% remote", "ranked"],
    ["Réact", "Senior React Engineer", "ranked"],
    ["REACT", "Senior React Engineer", "ranked"],
    ["act", "Senior React Engineer", "ranked"],
    ["backend", "Back-end Engineer", "keyword_mismatch"],
    ["re\u200Bact", "Senior React Engineer", "ranked"],
  ])("jppc :819/:850/:953 at save: keyword %j against %j leaves %s", async (keyword, title, expected) => {
    const id = await seedPosting(w.db, w.kofi.id, { title, family: "software_engineering", status: "ranked" })
    await saveOnTop(kofi, { titleKeyword: keyword })
    const state = await stateOf(w.db, w.kofi.id, id)
    if (expected === "ranked") expect(state.status).toBe("ranked")
    else expect(state).toMatchObject({ status: "skipped", skip_reason: expected })
  })

  it("jppc :835 the keyword is tested against the title only, not company or description", async () => {
    const id = await seedPosting(w.db, w.kofi.id, { title: "Senior Frontend Engineer", status: "ranked" })
    await w.db.updateTable("job_posting").set({ company: "React Labs", posting_text: "React ".repeat(12) }).where("id", "=", id).execute()
    await saveOnTop(kofi, { titleKeyword: "react" })
    expect((await stateOf(w.db, w.kofi.id, id)).skip_reason).toBe("keyword_mismatch")
  })

  it("jppc :842 the rule reads the stored folded title: a posting whose stored fold lacks the keyword is skipped even though its title has it", async () => {
    const id = await seedPosting(w.db, w.kofi.id, { title: "Senior Réact Engineer", status: "ranked" })
    await w.db.updateTable("job_posting").set({ title_folded: "senior frontend engineer" }).where("id", "=", id).execute()
    await saveOnTop(kofi, { titleKeyword: "react" })
    expect((await stateOf(w.db, w.kofi.id, id)).skip_reason).toBe("keyword_mismatch")
  })
})

describe("families at save (jcip :455, :463, :477; jppc :428, :435)", () => {
  it(":435/:455 excluding mobile skips the rank-2 'Senior Flutter Engineer' at once; Excluded families lists it; not Ranked or All; no paid call", async () => {
    await seedPosting(w.db, w.kofi.id, { title: "Senior React Engineer", status: "ranked", covered: 9 })
    const flutter = await seedPosting(w.db, w.kofi.id, { title: "Senior Flutter Engineer", family: "mobile", status: "ranked", covered: 8 })
    expect((await listTab(kofi, "tab=ranked")).postings.find((p) => p.id === flutter)?.rank).toBe(2)
    const paid = await paidWork(w.db)
    await saveOnTop(kofi, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    expect(await stateOf(w.db, w.kofi.id, flutter)).toMatchObject({ status: "skipped", skip_reason: "excluded_role_family", skip_detail: null })
    expect((await listTab(kofi, "tab=excluded_family")).postings.map((p) => p.id)).toEqual([flutter])
    expect((await listTab(kofi, "tab=ranked")).postings.map((p) => p.id)).not.toContain(flutter)
    expect((await listTab(kofi, "tab=all")).postings.map((p) => p.id)).not.toContain(flutter)
    expect((await listTab(kofi, "tab=skipped")).postings.map((p) => p.id)).not.toContain(flutter)
    expect(await paidWork(w.db)).toEqual(paid)
  })

  it(":463 a newly excluded family overrides a pay-rule exclusion at the save", async () => {
    const android = await seedPosting(w.db, w.kofi.id, { title: "Senior Android Engineer", family: "mobile", status: "excluded", skipReason: "violated_rule" })
    await saveOnTop(kofi, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    expect(await stateOf(w.db, w.kofi.id, android)).toMatchObject({ status: "skipped", skip_reason: "excluded_role_family" })
  })

  it(":428/:477 un-excluding mobile (to tier 2) returns its 3 postings to waiting_to_be_checked in the same save, no paid call", async () => {
    await saveOnTop(kofi, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    const ids = []
    for (const t of ["iOS Engineer", "Android Engineer", "Flutter Engineer"]) ids.push(await seedPosting(w.db, w.kofi.id, { title: t, family: "mobile", status: "skipped", skipReason: "excluded_role_family" }))
    const paid = await paidWork(w.db)
    await saveOnTop(kofi, { roleFamilyTiers: tiers({ mobile: 2 }) })
    for (const id of ids) expect(await stateOf(w.db, w.kofi.id, id)).toMatchObject({ status: "waiting_to_be_checked", skip_reason: null })
    expect((await paidWork(w.db)).aiCalls).toBe(paid.aiCalls)
    expect((await paidWork(w.db)).spend).toBe(paid.spend)
  })

  it("jppc :959 at save: a posting in an excluded family that also misses the keyword stores excluded_role_family only", async () => {
    const kotlin = await seedPosting(w.db, w.kofi.id, { title: "Senior Kotlin Engineer", family: "mobile", status: "ranked" })
    await saveOnTop(kofi, { roleFamilyTiers: tiers({ mobile: "excluded" }), titleKeyword: "react" })
    expect((await stateOf(w.db, w.kofi.id, kotlin)).skip_reason).toBe("excluded_role_family")
    expect((await listTab(kofi, "tab=all")).postings.map((p) => p.id)).not.toContain(kotlin)
  })

  it("un-excluding the family of a posting that still misses the keyword moves it to keyword_mismatch, not waiting", async () => {
    await saveOnTop(kofi, { roleFamilyTiers: tiers({ mobile: "excluded" }), titleKeyword: "react" })
    const kotlin = await seedPosting(w.db, w.kofi.id, { title: "Senior Kotlin Engineer", family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    await saveOnTop(kofi, { roleFamilyTiers: tiers({ mobile: 2 }) })
    expect(await stateOf(w.db, w.kofi.id, kotlin)).toMatchObject({ status: "skipped", skip_reason: "keyword_mismatch" })
  })

  it("jppc :198/:206 a tier change invalidates an open Ranked cursor; a save that keeps the tiers does not", async () => {
    for (let i = 0; i < 4; i += 1) await seedPosting(w.db, w.kofi.id, { title: `React Engineer ${i}`, status: "ranked" })
    const kept = (await listTab(kofi, "tab=ranked&limit=2")).nextCursor!
    await saveOnTop(kofi, { dailyCap: 2 })
    expect((await kofi.get(`/v1/job-postings?tab=ranked&limit=2&cursor=${encodeURIComponent(kept)}`)).status).toBe(200)
    await saveOnTop(kofi, { roleFamilyTiers: tiers({ backend: 1 }) })
    const refused = await kofi.get(`/v1/job-postings?tab=ranked&limit=2&cursor=${encodeURIComponent(kept)}`)
    expect(refused.status).toBe(400)
    expect(refused.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
  })

  it("jppc :732 excluding a family invalidates an open Skipped by rules cursor; page 1 of excluded_family works", async () => {
    for (let i = 0; i < 4; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Weak ${i}`, family: "mobile", status: "skipped", skipReason: "weak_core_match" })
    const cursor = (await listTab(kofi, "tab=skipped&limit=2")).nextCursor!
    await saveOnTop(kofi, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    expect((await kofi.get(`/v1/job-postings?tab=skipped&limit=2&cursor=${encodeURIComponent(cursor)}`)).status).toBe(400)
    await listTab(kofi, "tab=excluded_family")
  })
})

describe("what a save does not touch (jcip :533, :541, :547, :580, :594; jp :207)", () => {
  it(":207 react plus betting in one save: Vue skipped at once, 'Betway React Engineer' passes and stays ranked", async () => {
    const vue = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked" })
    const betway = await seedPosting(w.db, w.kofi.id, { title: "Betway React Engineer", status: "ranked" })
    await saveOnTop(kofi, { titleKeyword: "react", excludedIndustries: ["betting"] })
    expect((await stateOf(w.db, w.kofi.id, vue)).skip_reason).toBe("keyword_mismatch")
    expect((await stateOf(w.db, w.kofi.id, betway)).status).toBe("ranked")
  })

  it(":533 a pay-floor change with keyword engineer: the ranked React posting stays ranked, the pay-excluded 'Frontend Lead' becomes keyword_mismatch", async () => {
    const ranked = await seedPosting(w.db, w.kofi.id, { title: "Senior React Engineer", status: "ranked" })
    const lead = await seedPosting(w.db, w.kofi.id, { title: "Frontend Lead", status: "excluded", skipReason: "violated_rule" })
    await saveOnTop(kofi, { payFloor: { amount: "6000.00", currency: "USD", period: "month", basis: "gross" }, titleKeyword: "engineer" })
    expect((await stateOf(w.db, w.kofi.id, ranked)).status).toBe("ranked")
    expect(await stateOf(w.db, w.kofi.id, lead)).toMatchObject({ status: "skipped", skip_reason: "keyword_mismatch" })
  })

  it(":541 a pay-floor-only save changes no stored posting (statuses, reasons and versions byte-equal)", async () => {
    await seedPosting(w.db, w.kofi.id, { title: "Senior React Engineer", status: "ranked" })
    await seedPosting(w.db, w.kofi.id, { title: "Frontend Lead", status: "excluded", skipReason: "violated_rule" })
    await seedPosting(w.db, w.kofi.id, { title: "Weak One", status: "skipped", skipReason: "weak_core_match" })
    const before = await w.db.selectFrom("candidate_posting").selectAll().where("candidate_id", "=", w.kofi.id).orderBy("job_posting_id").execute()
    await saveOnTop(kofi, { payFloor: { amount: "6000.00", currency: "USD", period: "month", basis: "gross" } })
    expect(await w.db.selectFrom("candidate_posting").selectAll().where("candidate_id", "=", w.kofi.id).orderBy("job_posting_id").execute()).toEqual(before)
  })

  it.each([
    ["waiting_to_be_checked", null, null],
    ["checking", null, null],
    ["evaluation_failed", null, null],
    ["skipped", "not_software_role", "not_software_role"],
    ["skipped", "unsupported_application_system", null],
  ] as const)(":547 'Data Engineer' with status %s / reason %s keeps its state after saving react", async (status, reason, prefilter) => {
    const id = await seedPosting(w.db, w.kofi.id, { title: "Data Engineer", family: prefilter ? null : "data_ml", prefilterSkip: prefilter, status, skipReason: reason })
    const before = await stateOf(w.db, w.kofi.id, id)
    await saveOnTop(kofi, { titleKeyword: "react" })
    expect(await stateOf(w.db, w.kofi.id, id)).toEqual(before)
  })

  it(":580 a save with no stored postings succeeds and writes no posting", async () => {
    const saved = await saveOnTop(kofi, { titleKeyword: "react" })
    expect(saved.version).toBe(2)
    expect(await w.db.selectFrom("candidate_posting").select("job_posting_id").where("candidate_id", "=", w.kofi.id).execute()).toEqual([])
  })

  it(":594 only changed rows take the new preferences version: Vue records 2, React keeps its earlier stamp", async () => {
    const vue = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked" })
    const react = await seedPosting(w.db, w.kofi.id, { title: "React Engineer", status: "ranked" })
    const reactBefore = await stateOf(w.db, w.kofi.id, react)
    const saved = await saveOnTop(kofi, { titleKeyword: "react" })
    expect(saved.version).toBe(2)
    expect(await stateOf(w.db, w.kofi.id, vue)).toMatchObject({ status: "skipped", skip_reason: "keyword_mismatch", preferences_version: 2 })
    expect(await stateOf(w.db, w.kofi.id, react)).toEqual(reactBefore)
  })

  it("a save makes no Application row and sends no email", async () => {
    await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked" })
    const outbox = await w.db.selectFrom("notification_outbox").select("id").execute()
    await saveOnTop(kofi, { titleKeyword: "react" })
    expect(await w.db.selectFrom("application").select("id").execute()).toEqual([])
    expect(await w.db.selectFrom("notification_outbox").select("id").execute()).toEqual(outbox)
  })
})

describe("stale and failed saves re-decide nothing (jcip :602, :613; R6-AC11)", () => {
  it(":602 a stale keyword save (baseVersion 6 at version 7) is 409 and 'Senior Vue Engineer' is still ranked, version still 7, no keyword", async () => {
    for (let i = 0; i < 6; i += 1) await saveOnTop(kofi, {})
    expect((await read(kofi)).version).toBe(7)
    const vue = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked" })
    const before = await candidateSnapshot(w.db, w.kofi.id)
    const response = await save(kofi, 6, kenyaValues({ titleKeyword: "react" }))
    expect(response.status).toBe(409)
    expect(response.body.error).toMatchObject({ code: "preferences_stale", currentVersion: 7 })
    expect((await stateOf(w.db, w.kofi.id, vue)).status).toBe("ranked")
    const after = await read(kofi)
    expect(after.version).toBe(7)
    expect(after.values.titleKeyword).toBeNull()
    expect(await candidateSnapshot(w.db, w.kofi.id)).toBe(before)
  })

  it("a time-zone-limited save (409) with a keyword change re-decides nothing", async () => {
    w.clock.set("2026-10-23T09:00:00.000Z")
    await saveOnTop(kofi, { timeZone: "Africa/Lagos" })
    const vue = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked" })
    const current = await read(kofi)
    w.clock.set("2026-10-23T10:00:00.000Z")
    const response = await save(kofi, current.version, { ...current.values, timeZone: "Europe/Berlin", titleKeyword: "react" })
    expect(response.status).toBe(409)
    expect((await stateOf(w.db, w.kofi.id, vue)).status).toBe("ranked")
  })

  it(":613 a failure during re-decision is 500 and leaves record, version, postings and history unchanged", async () => {
    const vue = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked" })
    const before = await candidateSnapshot(w.db, w.kofi.id)
    const restore = await failPostingUpdatesFor(w.db, w.kofi.id)
    try {
      const response = await save(kofi, 1, kenyaValues({ titleKeyword: "react" }))
      expect(response.status).toBe(500)
      expect(response.body.error.code).toBe("internal_error")
      expect(JSON.stringify(response.body)).not.toMatch(/qa injected fault/)
    } finally {
      await restore()
    }
    expect((await read(kofi)).version).toBe(1)
    expect((await read(kofi)).values.titleKeyword).toBeNull()
    expect((await stateOf(w.db, w.kofi.id, vue)).status).toBe("ranked")
    expect(await versionCount(w.db, w.kofi.id)).toBe(1)
    expect(await candidateSnapshot(w.db, w.kofi.id)).toBe(before)
  })
})

describe("one Candidate's save never touches another's postings (jcip :630; jppc :419, :1024)", () => {
  it(":630 Wanjiru saving react skips 'Senior Vue Engineer' for her; Kofi's record, version and postings are byte-equal", async () => {
    const shared = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked", holders: [w.kofi.id, w.wanjiru.id] })
    const wanjiru = await w.session(w.wanjiru)
    await createRecord(wanjiru)
    const before = await candidateSnapshot(w.db, w.kofi.id)
    await saveOnTop(wanjiru, { titleKeyword: "react" })
    expect((await stateOf(w.db, w.wanjiru.id, shared)).skip_reason).toBe("keyword_mismatch")
    expect(await candidateSnapshot(w.db, w.kofi.id)).toBe(before)
  })

  it("jppc :419 Kofi excluding mobile leaves the shared mobile posting ranked for Wanjiru", async () => {
    const shared = await seedPosting(w.db, w.kofi.id, { title: "Senior Flutter Engineer", family: "mobile", status: "ranked", holders: [w.kofi.id, w.wanjiru.id] })
    await saveOnTop(kofi, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    expect((await stateOf(w.db, w.kofi.id, shared)).skip_reason).toBe("excluded_role_family")
    expect((await stateOf(w.db, w.wanjiru.id, shared)).status).toBe("ranked")
    expect((await w.db.selectFrom("job_posting").select("role_family").where("id", "=", shared).executeTakeFirstOrThrow()).role_family).toBe("mobile")
  })

  it("jppc :1024 Kofi's keyword skips the shared posting for Kofi only", async () => {
    const shared = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked", holders: [w.kofi.id, w.wanjiru.id] })
    await saveOnTop(kofi, { titleKeyword: "react" })
    expect((await stateOf(w.db, w.kofi.id, shared)).skip_reason).toBe("keyword_mismatch")
    expect((await stateOf(w.db, w.wanjiru.id, shared)).status).not.toBe("skipped")
  })

  it("two Candidates saving at the same moment each re-decide only their own rows", async () => {
    const shared = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked", holders: [w.kofi.id, w.wanjiru.id] })
    const wanjiru = await w.session(w.wanjiru)
    await createRecord(wanjiru)
    await Promise.all([saveOnTop(kofi, { titleKeyword: "vue" }), saveOnTop(wanjiru, { titleKeyword: "react" })])
    expect((await stateOf(w.db, w.kofi.id, shared)).status).toBe("ranked")
    expect((await stateOf(w.db, w.wanjiru.id, shared)).skip_reason).toBe("keyword_mismatch")
  })
})
