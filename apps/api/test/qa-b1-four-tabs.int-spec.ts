import { DEFAULT_ROLE_FAMILY_TIERS, jobPostingsResponseSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { type B1World, clearPostings, clearPreferences, kenyaValues, listTab, seedPosting, startB1World } from "./support/qa-b1.js"
import type { SignedInCandidate } from "./support/signed-in.js"

/**
 * EPIC-0002 B1 QA (qa-author, qa-tests-1): the four tabs over stored rows
 * (api-contract-b1.md "Skip reasons and tabs"; job-postings-per-candidate.feature
 * :385 to :781, D17). Rows are seeded with the two new reasons directly, so these
 * tests prove the list query, not the save (qa-b1-save-redecision covers that).
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
  kofi = await w.session(w.kofi)
})

const ids = (page: { postings: { id: string }[] }) => page.postings.map((p) => p.id)

describe("tab values (jppc :630)", () => {
  it.each(["ranked", "manual", "skipped", "excluded_family", "all"])("tab=%s is accepted", async (tab) => {
    const response = await kofi.get(`/v1/job-postings?tab=${tab}`)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(jobPostingsResponseSchema.safeParse(response.body).success).toBe(true)
  })

  it.each(["excluded", "EXCLUDED_FAMILY", "excluded_families", "Skipped"])("tab=%s is 400 bad_request with no postings", async (tab) => {
    const response = await kofi.get(`/v1/job-postings?tab=${tab}`)
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
  })
})

describe("which rows each tab lists (jppc :385, :514, :535, :805)", () => {
  it.each([
    ["excluded_family", "", true],
    ["excluded_family", "&families=mobile", true],
    ["skipped", "", false],
    ["skipped", "&families=mobile", false],
    ["ranked", "", false],
    ["ranked", "&families=mobile", false],
    ["all", "", false],
    ["all", "&families=mobile", false],
  ])(":385 an excluded_role_family posting on tab %s%s is listed: %s", async (tab, filter, listed) => {
    const ios = await seedPosting(w.db, w.kofi.id, { title: "Senior iOS Engineer", family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    expect(ids(await listTab(kofi, `tab=${tab}${filter}`)).includes(ios)).toBe(listed)
  })

  it.each([
    ["skipped", "not_software_role", true, false, true, false],
    ["skipped", "unsupported_application_system", false, false, true, true],
    ["excluded", "violated_rule", true, false, true, false],
    ["skipped", "uncovered_mandatory_prerequisite", true, false, true, false],
    ["skipped", "weak_core_match", true, false, true, false],
    ["skipped", "no_core_responsibilities", true, false, true, false],
    ["skipped", "keyword_mismatch", true, false, true, false],
    ["skipped", "excluded_role_family", false, true, false, false],
  ] as const)(":514 status %s reason %s: skipped %s, excluded_family %s, all %s, manual %s, never ranked", async (status, reason, onSkipped, onExcluded, onAll, onManual) => {
    // qa-1 gate correction: EPIC-0006 visibility (visibility.ts:113) hides a titled posting
    // with a pre-filter skip as off_target, on every tab. Off-target needs a title, so the
    // not_software_role row is seeded untitled (title_folded null, as the legacy rows in
    // discovery.int-spec.ts PRE-18), which keeps it visible and tests the tab rule itself.
    const x = await seedPosting(w.db, w.kofi.id, {
      title: reason === "not_software_role" ? null : "Posting X",
      family: reason === "not_software_role" ? null : "mobile",
      prefilterSkip: reason === "not_software_role" ? "not_software_role" : null,
      status,
      skipReason: reason,
    })
    expect(ids(await listTab(kofi, "tab=skipped")).includes(x)).toBe(onSkipped)
    expect(ids(await listTab(kofi, "tab=excluded_family")).includes(x)).toBe(onExcluded)
    expect(ids(await listTab(kofi, "tab=all")).includes(x)).toBe(onAll)
    // v1.28.0 manual lane: an unsupported application system is its own tab and no longer a "Not a match".
    expect(ids(await listTab(kofi, "tab=manual")).includes(x)).toBe(onManual)
    expect(ids(await listTab(kofi, "tab=ranked")).includes(x)).toBe(false)
  })

  it(":535 a skipped posting with no stored reason stays on Skipped by rules, not Excluded families", async () => {
    const legacy = await seedPosting(w.db, w.kofi.id, { title: "Legacy Skip", status: "skipped", skipReason: null })
    expect(ids(await listTab(kofi, "tab=skipped"))).toContain(legacy)
    expect(ids(await listTab(kofi, "tab=excluded_family"))).not.toContain(legacy)
  })

  it.each([["skipped", true], ["all", true], ["ranked", false], ["excluded_family", false]] as const)(
    ":805 a keyword_mismatch posting on tab %s is listed: %s",
    async (tab, listed) => {
      const vue = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "skipped", skipReason: "keyword_mismatch" })
      expect(ids(await listTab(kofi, `tab=${tab}`)).includes(vue)).toBe(listed)
    }
  )

  it("both new reasons carry skipDetail null in the list", async () => {
    await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "skipped", skipReason: "keyword_mismatch" })
    await seedPosting(w.db, w.kofi.id, { title: "iOS", family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    for (const tab of ["skipped", "excluded_family"]) for (const p of (await listTab(kofi, `tab=${tab}`)).postings) expect(p.skipDetail).toBeNull()
  })
})

describe("totalCount per tab (jppc :403, :497, :542, :559, :581)", () => {
  it(":403 10 ranked, 3 violated_rule, 4 excluded_role_family: all 13, skipped 3, excluded_family 4", async () => {
    for (let i = 0; i < 10; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Ranked ${i}`, status: "ranked" })
    for (let i = 0; i < 3; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Violated ${i}`, status: "excluded", skipReason: "violated_rule" })
    for (let i = 0; i < 4; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Mobile ${i}`, family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    expect((await listTab(kofi, "tab=all")).totalCount).toBe(13)
    expect((await listTab(kofi, "tab=skipped")).totalCount).toBe(3)
    expect((await listTab(kofi, "tab=excluded_family")).totalCount).toBe(4)
  })

  it.each([
    ["ranked", "", 10],
    ["skipped", "", 6],
    ["excluded_family", "", 4],
    ["all", "", 16],
    ["skipped", "&families=backend", 6],
    ["excluded_family", "&families=backend", 0],
    ["excluded_family", "&families=mobile", 4],
    ["all", "&families=backend,mobile", 16],
  ] as const)(":542 tab %s%s has totalCount %i", async (tab, filter, total) => {
    for (let i = 0; i < 10; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Backend ${i}`, family: "backend", status: "ranked" })
    for (let i = 0; i < 2; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Weak ${i}`, family: "backend", status: "skipped", skipReason: "weak_core_match" })
    for (let i = 0; i < 3; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Violated ${i}`, family: "backend", status: "excluded", skipReason: "violated_rule" })
    await seedPosting(w.db, w.kofi.id, { title: "Keyword", family: "backend", status: "skipped", skipReason: "keyword_mismatch" })
    for (let i = 0; i < 4; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Mobile ${i}`, family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    expect((await listTab(kofi, `tab=${tab}${filter}`)).totalCount).toBe(total)
  })

  it(":497 only excluded-family postings: ranked, skipped and all are 0, excluded_family is 5", async () => {
    for (let i = 0; i < 5; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Mobile ${i}`, family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    for (const tab of ["all", "ranked", "skipped"]) expect((await listTab(kofi, `tab=${tab}`)).totalCount, tab).toBe(0)
    expect((await listTab(kofi, "tab=excluded_family")).totalCount).toBe(5)
  })

  it(":559 every posting is counted on exactly one of All and Excluded families", async () => {
    const reasons = [
      ["ranked", null], ["waiting_to_be_checked", null], ["checking", null], ["evaluation_failed", null],
      ["excluded", "violated_rule"], ["skipped", "weak_core_match"], ["skipped", "keyword_mismatch"], ["skipped", "no_core_responsibilities"],
    ] as const
    for (let i = 0; i < 32; i += 1) {
      const [status, skipReason] = reasons[i % reasons.length]!
      await seedPosting(w.db, w.kofi.id, { title: `Row ${i}`, family: "backend", status, skipReason })
    }
    for (let i = 0; i < 5; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Mobile ${i}`, family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    const all = await listTab(kofi, "tab=all&limit=100")
    const excluded = await listTab(kofi, "tab=excluded_family&limit=100")
    expect(all.totalCount).toBe(32)
    expect(excluded.totalCount).toBe(5)
    expect(ids(all).filter((id) => ids(excluded).includes(id))).toEqual([])
  })

  it(":581 the All tab hides excluded-family postings whatever the filter: mobile,backend + engineer gives 2", async () => {
    for (let i = 0; i < 4; i += 1) await seedPosting(w.db, w.kofi.id, { title: "Mobile Engineer", family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    for (let i = 0; i < 2; i += 1) await seedPosting(w.db, w.kofi.id, { title: "Backend Engineer", family: "backend", status: "skipped", skipReason: "weak_core_match" })
    const page = await listTab(kofi, "tab=all&families=mobile,backend&keyword=engineer")
    expect(page.totalCount).toBe(2)
    expect(page.postings.some((p) => p.skipReason === "excluded_role_family")).toBe(false)
  })
})

describe("cursors are bound to their tab (jppc :644, :660, :674)", () => {
  async function thirtyEach(): Promise<void> {
    for (let i = 0; i < 30; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Weak ${i}`, family: "backend", status: "skipped", skipReason: "weak_core_match" })
    for (let i = 0; i < 30; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Mobile ${i}`, family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    for (let i = 0; i < 30; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Ranked ${i}`, family: "backend", status: "ranked" })
  }

  it.each([
    ["skipped", "excluded_family"],
    ["excluded_family", "skipped"],
    ["excluded_family", "all"],
    ["all", "excluded_family"],
    ["ranked", "excluded_family"],
  ])(":644 a cursor issued for %s presented on %s is 400 with no postings, count or cursor", async (issued, presented) => {
    await thirtyEach()
    const cursor = (await listTab(kofi, `tab=${issued}&limit=25`)).nextCursor
    expect(cursor).toEqual(expect.any(String))
    const response = await kofi.get(`/v1/job-postings?tab=${presented}&limit=25&cursor=${encodeURIComponent(cursor!)}`)
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
  })

  it(":660 following nextCursor on excluded_family at limit 25 returns the 30 postings once each, newest first", async () => {
    for (let i = 0; i < 30; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Mobile ${i}`, family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: Awaited<ReturnType<typeof listTab>> = await listTab(kofi, `tab=excluded_family&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      seen.push(...page.postings.map((p) => p.title ?? ""))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toHaveLength(30)
    expect(new Set(seen).size).toBe(30)
    expect(seen[0]).toBe("Mobile 29")
    expect(seen[29]).toBe("Mobile 0")
  })

  it("jppc :919 a zero-width-only on-screen keyword gives the same cursor binding as no keyword", async () => {
    for (let i = 0; i < 6; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Row ${i}`, status: "ranked" })
    const cursor = (await listTab(kofi, "tab=all&limit=2")).nextCursor!
    const next = await kofi.get(`/v1/job-postings?tab=all&limit=2&keyword=${encodeURIComponent("\u200B")}&cursor=${encodeURIComponent(cursor)}`)
    expect(next.status).toBe(200)
  })

  it.each(["\u200B", "\u0301", "\u200B\u200D"])("jppc :906 on-screen keyword %j behaves as no keyword: 7 postings, 2 untitled listed", async (keyword) => {
    for (let i = 0; i < 5; i += 1) await seedPosting(w.db, w.kofi.id, { title: `Row ${i}`, status: "ranked" })
    for (let i = 0; i < 2; i += 1) await seedPosting(w.db, w.kofi.id, { title: null, family: "other", status: "skipped", skipReason: "weak_core_match" })
    const page = await listTab(kofi, `tab=all&keyword=${encodeURIComponent(keyword)}`)
    expect(page.totalCount).toBe(7)
    expect(page.postings.filter((p) => p.title === null)).toHaveLength(2)
  })
})

describe("the family label and the saved keyword in the list (jppc :757, :766, :1004, :1017, :725)", () => {
  it(":766 families=frontend stays 400; families=senior_frontend is accepted and keyed senior_frontend", async () => {
    await seedPosting(w.db, w.kofi.id, { title: "Senior React Engineer", family: "senior_frontend", status: "ranked" })
    expect((await kofi.get("/v1/job-postings?tab=all&families=frontend")).status).toBe(400)
    const page = await listTab(kofi, "tab=all&families=senior_frontend")
    expect(page.postings.map((p) => p.roleFamily)).toEqual(["senior_frontend"])
  })

  it(":1004 the list response carries no saved-keyword field and applies no on-screen keyword", async () => {
    await kofi.put("/v1/me/preferences").send({ baseVersion: null, values: kenyaValues({ titleKeyword: "react" }) }).expect(200)
    await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "skipped", skipReason: "keyword_mismatch" })
    const response = await kofi.get("/v1/job-postings?tab=all").expect(200)
    expect(jobPostingsResponseSchema.strict().safeParse(response.body).success, JSON.stringify(Object.keys(response.body))).toBe(true)
    expect(JSON.stringify(response.body)).not.toMatch(/titleKeyword|savedKeyword/)
    expect(response.body.totalCount).toBe(1)
  })

  it(":1017 the migrated Operator has no posting skipped as keyword_mismatch or excluded_role_family", async () => {
    const { rows } = await sql<{ n: string }>`select count(*) as n from candidate_posting
      where candidate_id = ${w.ada.id} and skip_reason in ('keyword_mismatch', 'excluded_role_family')`.execute(w.db)
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it(":725 Kofi's Excluded families tab never lists Wanjiru's 6 excluded postings", async () => {
    for (let i = 0; i < 6; i += 1) await seedPosting(w.db, w.wanjiru.id, { title: `Wanjiru mobile ${i}`, family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    const mine = await seedPosting(w.db, w.kofi.id, { title: "Kofi mobile", family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    const page = await listTab(kofi, "tab=excluded_family")
    expect(page.totalCount).toBe(1)
    expect(ids(page)).toEqual([mine])
  })

  it("jppc :120 ranks follow each Candidate's own tiers: opposite tiers give opposite orders", async () => {
    const backend = await seedPosting(w.db, w.kofi.id, { title: "Backend Engineer", family: "backend", status: "ranked", holders: [w.kofi.id, w.wanjiru.id] })
    const frontend = await seedPosting(w.db, w.kofi.id, { title: "Frontend Engineer", family: "senior_frontend", status: "ranked", holders: [w.kofi.id, w.wanjiru.id] })
    await kofi.put("/v1/me/preferences").send({ baseVersion: null, values: kenyaValues({ roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, backend: 1, senior_frontend: 3 } }) }).expect(200)
    const wanjiru = await w.session(w.wanjiru)
    await clearPreferences(w.db, w.wanjiru.id)
    await wanjiru.put("/v1/me/preferences").send({ baseVersion: null, values: kenyaValues({ roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, backend: 3, senior_frontend: 1 } }) }).expect(200)
    expect((await listTab(kofi, "tab=ranked")).postings.map((p) => [p.id, p.rank])).toEqual([[backend, 1], [frontend, 2]])
    expect((await listTab(wanjiru, "tab=ranked")).postings.map((p) => [p.id, p.rank])).toEqual([[frontend, 1], [backend, 2]])
  })
})
