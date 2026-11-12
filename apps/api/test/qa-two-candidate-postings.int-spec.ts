import type { INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { PostingCursorCodec, TIER_HASH } from "../src/discovery/posting-cursor.js"
import { Browser } from "./support/browser.js"
import { insertCandidatePosting, targetEveryFamily, visibleByDefault } from "./support/candidate-posting.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA-owned gap test (EPIC-0002 A1, run epic-0002-a0-a1c, qa-1). Two Candidates,
 * both signed in over HTTP (Ada the Operator, Kofi an invitee), each with their
 * own postings and one shared posting with a different status per Candidate.
 *
 * job-postings-per-candidate.feature @slice-A1: :54 totalCount per Candidate,
 * :63 every tab, :77 waitingToBeCheckedCount, :85 shared posting status, :93
 * filter narrows own postings, :110 ranks, :164 own cursor to the end, :172 and
 * :188 cross-Candidate cursor 400 (byte-identical to a forged cursor), :217 and
 * :234 the time range (architecture r4 "A1: cursor": 1970-01-01 to 2200-01-01).
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
let kofi: SignedInCandidate
let kofiId: string
const clock = new TestClock("2026-10-21T09:00:00.000Z")
const KOFI_SUB = "200000000000000000777"
const SHARED = "00000000-0000-4000-8000-00000000c0de"

type Page = { postings: { id: string; status: string; rank?: number | null; title: string | null }[]; totalCount: number; waitingToBeCheckedCount: number; nextCursor: string | null }

async function posting(id: string, title: string, family: string, minute: number): Promise<void> {
  const url = `https://boards.greenhouse.io/qa2/jobs/${id}`
  await database.db
    .insertInto("job_posting")
    // EPIC-0006: dated and marked like a stored posting (support/candidate-posting.ts visibleByDefault).
    .values(visibleByDefault({ id, application_url: url, requisition_id: id, apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title, title_folded: title.toLowerCase(), company: "QA2", posting_text: "Remote.", role_family: family, discovered_at: new Date(Date.UTC(2026, 9, 20, 8, minute)) }))
    .execute()
}

async function strong(candidateId: string, id: string): Promise<void> {
  await database.db
    .insertInto("match_evidence")
    .values({ candidate_id: candidateId, job_posting_id: id, career_profile_version: 1, verdict: "strong", weak_reason: null, covered_count: 8, total_count: 10, threshold: "0.700", items: "[]", evaluated_at: new Date("2026-10-20T09:00:00Z"), criteria_version: 1 })
    .execute()
}

const uuid = (prefix: string, n: number) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, "0")}`

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  kofiId = (await database.db.insertInto("candidate").values({ email: "kofi.qa@example.test", google_sub: KOFI_SUB, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub: KOFI_SUB, email: "kofi.qa@example.test", email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  kofi = new (ada.constructor as typeof SignedInCandidate)(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, "kofi.qa@example.test")
  await database.db.insertInto("job_criteria").values({ candidate_id: kofiId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  // EPIC-0006: this spec is about order and tenancy, not visibility; every family is a target (support/candidate-posting.ts).
  await targetEveryFamily(database.db, database.operatorId)
  await targetEveryFamily(database.db, kofiId)

  // Ada: 3 ranked (frontend), 1 waiting. Kofi: 12 ranked (backend and mobile), 2 waiting, 1 skipped.
  for (let n = 1; n <= 3; n += 1) {
    await posting(uuid("a", n), `Ada Frontend ${n}`, "senior_frontend", n)
    await insertCandidatePosting(database.db, database.operatorId, uuid("a", n), { status: "ranked" })
    await strong(database.operatorId, uuid("a", n))
  }
  await posting(uuid("a", 9), "Ada Waiting", "senior_frontend", 9)
  await insertCandidatePosting(database.db, database.operatorId, uuid("a", 9), { status: "waiting_to_be_checked" })
  for (let n = 1; n <= 12; n += 1) {
    await posting(uuid("b", n), `Kofi ${n % 2 === 0 ? "Backend" : "Mobile"} ${n}`, n % 2 === 0 ? "backend" : "mobile", 10 + n)
    await insertCandidatePosting(database.db, kofiId, uuid("b", n), { status: "ranked" })
    await strong(kofiId, uuid("b", n))
  }
  for (const n of [20, 21]) {
    await posting(uuid("b", n), `Kofi Waiting ${n}`, "backend", 30 + n)
    await insertCandidatePosting(database.db, kofiId, uuid("b", n), { status: "waiting_to_be_checked" })
  }
  // One posting both hold: ranked for Ada, skipped for Kofi.
  await posting(SHARED, "Shared Frontend", "senior_frontend", 59)
  await insertCandidatePosting(database.db, database.operatorId, SHARED, { status: "ranked" })
  await strong(database.operatorId, SHARED)
  await insertCandidatePosting(database.db, kofiId, SHARED, { status: "skipped", skipReason: "weak_core_match" })
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const page = async (who: SignedInCandidate, query: string, status = 200) => (await who.get(`/v1/job-postings?${query}`).expect(status)).body as Page

describe("per-Candidate counts, ranks and statuses (A1 scope)", () => {
  it(":54/:63 each Candidate's totalCount on every tab counts only their own postings", async () => {
    expect((await page(ada, "tab=ranked")).totalCount).toBe(4)
    expect((await page(ada, "tab=all")).totalCount).toBe(5)
    expect((await page(ada, "tab=skipped")).totalCount).toBe(0)
    expect((await page(kofi, "tab=ranked")).totalCount).toBe(12)
    expect((await page(kofi, "tab=all")).totalCount).toBe(15)
    expect((await page(kofi, "tab=skipped")).totalCount).toBe(1)
  })

  it(":77 waitingToBeCheckedCount counts only the signed-in Candidate's waiting postings", async () => {
    expect((await page(ada, "tab=all")).waitingToBeCheckedCount).toBe(1)
    expect((await page(kofi, "tab=all")).waitingToBeCheckedCount).toBe(2)
  })

  it(":85 the shared posting is ranked for Ada and skipped for Kofi; neither list holds the other's postings", async () => {
    const adaAll = await page(ada, "tab=all&limit=100")
    const kofiAll = await page(kofi, "tab=all&limit=100")
    expect(adaAll.postings.find((p) => p.id === SHARED)?.status).toBe("ranked")
    expect(kofiAll.postings.find((p) => p.id === SHARED)?.status).toBe("skipped")
    expect(adaAll.postings.some((p) => p.title?.startsWith("Kofi"))).toBe(false)
    expect(kofiAll.postings.some((p) => p.title?.startsWith("Ada"))).toBe(false)
  })

  it(":93 the family filter narrows only the signed-in Candidate's postings", async () => {
    expect((await page(ada, "tab=ranked&families=backend")).totalCount).toBe(0)
    expect((await page(kofi, "tab=ranked&families=backend")).totalCount).toBe(6)
    expect((await page(kofi, "tab=ranked&families=senior_frontend")).totalCount).toBe(0)
  })

  it(":110 rank numbers count only the signed-in Candidate's ranked postings (1..n each)", async () => {
    const adaRanks = (await page(ada, "tab=ranked&limit=100")).postings.map((p) => p.rank)
    const kofiRanks = (await page(kofi, "tab=ranked&limit=100")).postings.map((p) => p.rank)
    expect(adaRanks).toEqual([1, 2, 3, 4])
    expect(kofiRanks).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })

  it("another Candidate's posting by ID is 404 and the body reveals nothing", async () => {
    const res = await kofi.get(`/v1/job-postings/${uuid("a", 1)}`).expect(404)
    expect(JSON.stringify(res.body)).not.toMatch(/Ada Frontend/)
    const missing = await kofi.get("/v1/job-postings/00000000-0000-4000-8000-ffffffffffff").expect(404)
    expect(res.body).toEqual(missing.body)
  })
})

describe("cursor version 2 over HTTP (C30, C40)", () => {
  it(":164 Kofi follows his own cursor to the end: 5, 5, 2 and each of 12 exactly once", async () => {
    const seen: string[] = []
    const sizes: number[] = []
    let cursor: string | null = null
    do {
      const body: Page = await page(kofi, `tab=ranked&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      sizes.push(body.postings.length)
      seen.push(...body.postings.map((p) => p.id))
      cursor = body.nextCursor
    } while (cursor !== null)
    expect(sizes).toEqual([5, 5, 2])
    expect(new Set(seen).size).toBe(12)
  })

  it.each(["ranked", "all"])(":172/:188 Kofi's cursor (tab %s) presented by Ada is 400, byte-identical to a never-issued cursor, and names nothing of Kofi's", async (tab) => {
    const issued = (await page(kofi, `tab=${tab}&limit=5`)).nextCursor
    expect(issued).toEqual(expect.any(String))
    const refused = await ada.get(`/v1/job-postings?tab=${tab}&limit=5&cursor=${encodeURIComponent(issued!)}`).expect(400)
    const forged = await ada.get(`/v1/job-postings?tab=${tab}&limit=5&cursor=${encodeURIComponent(`${issued!.split(".")[0]}.${"A".repeat(43)}`)}`).expect(400)
    expect(refused.body).toEqual(forged.body)
    expect(refused.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
    expect(JSON.stringify(refused.body)).not.toMatch(/Kofi|backend|mobile|totalCount|rank/)
  })

  it("Ada's cursor presented by Kofi is 400 too", async () => {
    await insertCandidatePosting(database.db, database.operatorId, uuid("b", 1), { status: "waiting_to_be_checked" }).catch(() => undefined)
    const issued = (await page(ada, "tab=all&limit=1")).nextCursor
    await kofi.get(`/v1/job-postings?tab=all&limit=1&cursor=${encodeURIComponent(issued!)}`).expect(400)
  })

  const codec = new PostingCursorCodec(TEST_CLIENT_SECRET)
  const sign = (micros: string) => codec.encode({ tab: "all", families: [], foldedKeyword: null, candidateId: kofiId, tierHash: TIER_HASH }, { kind: "newest", discoveredUs: micros, id: uuid("b", 1) })

  it.each([
    ["-1 (1969-12-31T23:59:59.999999Z)", "-1"],
    ["2200-01-01T00:00:00.000001Z", "7258118400000001"],
    ["9223372036854775807", "9223372036854775807"],
    ["-9223372036854775808", "-9223372036854775808"],
    ["1.5", "1.5"],
  ])(":217 a validly signed cursor with time %s is 400, never 500", async (_label, micros) => {
    const res = await kofi.get(`/v1/job-postings?tab=all&cursor=${encodeURIComponent(sign(micros))}`)
    expect(res.status).toBe(400)
  })

  it.each([
    ["1970-01-01T00:00:00.000000Z", "0"],
    ["2200-01-01T00:00:00.000000Z", "7258118400000000"],
  ])(":234 a validly signed cursor at the edge %s is accepted", async (_label, micros) => {
    await kofi.get(`/v1/job-postings?tab=all&cursor=${encodeURIComponent(sign(micros))}`).expect(200)
  })
})

describe("concurrent paging (job-postings-per-candidate.feature:1020)", () => {
  it("Ada and Kofi paging their All tabs at the same time each receive exactly their own postings once", async () => {
    const walk = async (who: SignedInCandidate) => {
      const ids: string[] = []
      let cursor: string | null = null
      do {
        const body: Page = await page(who, `tab=all&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
        ids.push(...body.postings.map((p) => p.id))
        cursor = body.nextCursor
      } while (cursor !== null)
      return ids
    }
    const [adaIds, kofiIds] = await Promise.all([walk(ada), walk(kofi)])
    const adaTotal = (await page(ada, "tab=all")).totalCount
    expect(adaIds.length).toBe(adaTotal)
    expect(new Set(adaIds).size).toBe(adaTotal)
    expect(kofiIds.length).toBe(15)
    expect(new Set(kofiIds).size).toBe(15)
    expect(kofiIds.filter((id) => id.startsWith("00000000-0000-4000-8000-a")).length).toBe(0)
  })
})

