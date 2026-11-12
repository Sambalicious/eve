import type { INestApplication } from "@nestjs/common"
import { jobPostingDetailSchema, pasteJobLinkResponseSchema } from "@eve/contracts"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { Browser } from "./support/browser.js"
import { clearPostings, queuedEvaluations, setCriteria, signInSecondCandidate, statusOf } from "./support/epic-0006.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0007 Phase 1 repair wave 2, finding P1-B-01 (owner decisions D12, D13;
 * EPIC-0002 D13; check-this-job.feature r3 :269). POST /v1/job-postings/links
 * reads the same `evaluationAllowed` rule as Check again and the worker before
 * it answers: an invitee's new visible pasted row is stored and returned as
 * `waiting_to_be_checked`, with no job queued, no model call and no spend. The
 * Operator's path, hidden pastes (`not_checked`) and the cost pause are unchanged.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let ada: SignedInCandidate
let kofi: SignedInCandidate
let kofiId: string
const clock = new TestClock("2026-10-24T09:00:00.000Z")

const GREENHOUSE_URL = "https://boards.greenhouse.io/acme/jobs/4012345"
const POSTING_TEXT = "Remote, open to candidates in Nigeria. Salary USD 60,000–80,000 per year. Build React features."

const SECTIONS = [
  { id: "s1", kind: "experience", title: "Senior Frontend Engineer", organization: "Brightwave Ltd", period: "2021-2024", sourceQuote: null, facts: [{ id: "F1", text: "Built React features", sourceQuote: null }] },
]

const EXTRACTION = {
  workArrangement: "remote",
  locationQuote: "Remote, open to candidates in Nigeria",
  relocationCountry: null,
  relocationQuote: null,
  sponsorshipQuote: null,
  payQuote: "Salary USD 60,000–80,000 per year",
  hoursQuote: null,
  employerBusiness: null,
  businessQuote: null,
  employmentType: null,
  coreResponsibilities: [{ text: "Build React features", quote: "Build React features", factId: "F1" }],
  mandatoryPrerequisites: [],
  niceToHave: [],
}

/** A visible posting: dated 4 days before the test clock, Frontend, mid-or-higher. */
const visiblePosting = () =>
  http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345", () =>
    HttpResponse.json({ id: 4012345, title: "Senior Frontend Engineer", absolute_url: GREENHOUSE_URL, requisition_id: "4012345", company_name: "Acme", content: POSTING_TEXT, first_published: "2026-10-20T10:00:00Z" })
  )

/** The same Greenhouse posting with no posted date: hidden as undated. */
const undatedPosting = () =>
  http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345", () =>
    HttpResponse.json({ id: 4012345, title: "Senior Frontend Engineer", absolute_url: GREENHOUSE_URL, requisition_id: "4012345", company_name: "Acme", content: POSTING_TEXT })
  )

/** The same Greenhouse posting dated more than 60 days before the test clock: hidden as too old. */
const staleDatedPosting = () =>
  http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345", () =>
    HttpResponse.json({ id: 4012345, title: "Senior Frontend Engineer", absolute_url: GREENHOUSE_URL, requisition_id: "4012345", company_name: "Acme", content: POSTING_TEXT, first_published: "2026-08-01T10:00:00Z" })
  )

/**
 * A different link to the same requisition. A re-paste of the stored URL is
 * answered from the stored row before any ATS read, so only another URL for the
 * same posting reaches the backfill.
 */
const EMBED_URL = "https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345"

/** An undated Lever posting: hidden as undated for both Candidates. */
const HIDDEN_LINK = "https://jobs.lever.co/acme/fe-undated-1"
const hiddenPosting = () =>
  http.get("https://api.lever.co/v0/postings/acme/fe-undated-1", () =>
    HttpResponse.json({ id: "fe-undated-1", text: "Senior Frontend Engineer", hostedUrl: HIDDEN_LINK, descriptionPlain: "Remote." })
  )

const spendRows = () => database.db.selectFrom("spend_entry").select("id").execute()
const aiCalls = () => database.db.selectFrom("ai_call").select("id").execute()

/** The POST response as sent, before any background evaluation is awaited. */
async function pasteRaw(who: SignedInCandidate, url: string) {
  const response = await who.post("/v1/job-postings/links").send({ url })
  return { status: response.status, body: pasteJobLinkResponseSchema.parse(response.body) }
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  ;({ candidate: kofi, id: kofiId } = await signInSecondCandidate(app, google, database.db, { sub: "200000000000000000808", email: "kofi.paste@example.test" }))
  await ada.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  for (const candidateId of [database.operatorId, kofiId]) {
    await setCriteria(database.db, candidateId, { targets: ["senior_frontend"], floor: "hide_entry_level", min: 70 })
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: candidateId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(SECTIONS), created_at: new Date(), approved_at: new Date() })
      .execute()
  }
})

beforeEach(async () => {
  await app.get(DiscoveryService).settled()
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  await clearPostings(database.db)
  await database.db.deleteFrom("spend_entry").execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("P1-B-01: an invitee's new pasted posting is stored and returned as waiting_to_be_checked (D13)", () => {
  it("201 with status waiting_to_be_checked in the response itself; the row is stored waiting; no job, no model call, no ai_call, no spend", async () => {
    google.server.use(visiblePosting())
    const pasted = await pasteRaw(kofi, GREENHOUSE_URL)
    expect(pasted.status).toBe(201)
    expect(pasted.body).toMatchObject({ created: true, posting: { origin: "pasted_link", status: "waiting_to_be_checked", hiddenReason: null } })
    expect((await statusOf(database.db, kofiId, pasted.body.posting.id)).status).toBe("waiting_to_be_checked")

    await app.get(DiscoveryService).settled()
    expect((await statusOf(database.db, kofiId, pasted.body.posting.id)).status).toBe("waiting_to_be_checked")
    expect(await queuedEvaluations(database.db)).toEqual([])
    expect(anthropic.requests).toHaveLength(0)
    expect(await aiCalls()).toEqual([])
    expect(await spendRows()).toEqual([])
    const detail = jobPostingDetailSchema.parse((await kofi.get(`/v1/job-postings/${pasted.body.posting.id}`).expect(200)).body)
    expect(detail).toMatchObject({ status: "waiting_to_be_checked", eligibility: null, match: null })
  })

  it("a second paste of the same URL by the invitee answers 200 created false, still waiting, with nothing queued", async () => {
    google.server.use(visiblePosting())
    const first = await pasteRaw(kofi, GREENHOUSE_URL)
    const again = await pasteRaw(kofi, GREENHOUSE_URL)
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ created: false, posting: { id: first.body.posting.id, status: "waiting_to_be_checked" } })
    await app.get(DiscoveryService).settled()
    expect(await queuedEvaluations(database.db)).toEqual([])
    expect(anthropic.requests).toHaveLength(0)
  })

  it("a hidden pasted posting for the invitee keeps its EPIC-0006 behaviour: not_checked with the hidden reason, no model call", async () => {
    google.server.use(hiddenPosting())
    const pasted = await pasteRaw(kofi, HIDDEN_LINK)
    expect(pasted.status).toBe(201)
    expect(pasted.body).toMatchObject({ created: true, posting: { status: "not_checked", hiddenReason: "undated" } })
    await app.get(DiscoveryService).settled()
    expect((await statusOf(database.db, kofiId, pasted.body.posting.id)).status).toBe("not_checked")
    expect(anthropic.requests).toHaveLength(0)
    expect(await queuedEvaluations(database.db)).toEqual([])
  })

  it("during the cost pause the invitee's paste is waiting_to_be_checked, with no model call and no spend", async () => {
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    google.server.use(visiblePosting())
    const pasted = await pasteRaw(kofi, GREENHOUSE_URL)
    expect(pasted.body.posting.status).toBe("waiting_to_be_checked")
    await app.get(DiscoveryService).settled()
    expect((await statusOf(database.db, kofiId, pasted.body.posting.id)).status).toBe("waiting_to_be_checked")
    expect(anthropic.requests).toHaveLength(0)
    expect(await spendRows()).toEqual([])
  })
})

describe("CR-P1-01 / O-1: an invitee paste that backfills the posted date of her not_checked row (AC-5.8 claim under D13)", () => {
  it("claims the row straight to waiting_to_be_checked: 200 created false, status waiting in the response, no job, no model call, no ai_call, no spend", async () => {
    google.server.use(undatedPosting())
    const first = await pasteRaw(kofi, GREENHOUSE_URL)
    expect(first.body).toMatchObject({ created: true, posting: { status: "not_checked", hiddenReason: "undated" } })
    await app.get(DiscoveryService).settled()
    const postedBefore = await database.db.selectFrom("job_posting").select("posted_at").where("id", "=", first.body.posting.id).executeTakeFirstOrThrow()
    expect(postedBefore.posted_at).toBeNull()

    google.server.resetHandlers()
    google.server.use(visiblePosting())
    const backfill = await pasteRaw(kofi, EMBED_URL)
    expect(backfill.status).toBe(200)
    expect(backfill.body).toMatchObject({ created: false, posting: { id: first.body.posting.id, status: "waiting_to_be_checked", hiddenReason: null } })
    // The backfill really happened (the shared posting is now dated), so this is the AC-5.8 claim path.
    const postedAfter = await database.db.selectFrom("job_posting").select("posted_at").where("id", "=", first.body.posting.id).executeTakeFirstOrThrow()
    expect(postedAfter.posted_at).not.toBeNull()
    expect((await statusOf(database.db, kofiId, first.body.posting.id)).status).toBe("waiting_to_be_checked")

    await app.get(DiscoveryService).settled()
    expect((await statusOf(database.db, kofiId, first.body.posting.id)).status).toBe("waiting_to_be_checked")
    expect(await queuedEvaluations(database.db)).toEqual([])
    expect(anthropic.requests).toHaveLength(0)
    expect(await aiCalls()).toEqual([])
    expect(await spendRows()).toEqual([])
  })
})

describe("P1-B-01: the Operator's paste path is unchanged", () => {
  it("the response says checking, the evaluation runs in the api after the response and ranks the posting", async () => {
    google.server.use(visiblePosting())
    anthropic.replyWithObject(EXTRACTION)
    const pasted = await pasteRaw(ada, GREENHOUSE_URL)
    expect(pasted.status).toBe(201)
    expect(pasted.body).toMatchObject({ created: true, posting: { origin: "pasted_link", status: "checking", hiddenReason: null } })
    await app.get(DiscoveryService).settled()
    expect(anthropic.requests).toHaveLength(1)
    expect((await statusOf(database.db, database.operatorId, pasted.body.posting.id)).status).toBe("ranked")
  })

  it("during the cost pause the Operator's response says checking and the row then waits, as before (no model call, no spend)", async () => {
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    google.server.use(visiblePosting())
    const pasted = await pasteRaw(ada, GREENHOUSE_URL)
    expect(pasted.body.posting.status).toBe("checking")
    await app.get(DiscoveryService).settled()
    expect((await statusOf(database.db, database.operatorId, pasted.body.posting.id)).status).toBe("waiting_to_be_checked")
    expect(anthropic.requests).toHaveLength(0)
    expect(await spendRows()).toEqual([])
  })

  it("a hidden pasted posting for the Operator is still not_checked with its hidden reason", async () => {
    google.server.use(hiddenPosting())
    const pasted = await pasteRaw(ada, HIDDEN_LINK)
    expect(pasted.body).toMatchObject({ created: true, posting: { status: "not_checked", hiddenReason: "undated" } })
    await app.get(DiscoveryService).settled()
    expect(anthropic.requests).toHaveLength(0)
  })
})

/**
 * FU-4 (owner decision 2026-10-29; EPIC-0006 AC-5.8 on the paste path). The
 * Operator pastes an undated link (stored hidden, `not_checked`), then re-pastes
 * the same requisition through a dated link. The backfill makes the row visible
 * and claims it to `checking`; that claim is evaluated right away, the same as a
 * new paste. Invitees still wait (CR-P1-01 above, D13). The cost pause, EPIC-0006
 * hidden rules and idempotency hold.
 */
describe("FU-4: an Operator re-paste that backfills the posted date evaluates the claimed row", () => {
  /** The Operator's first, undated paste: `not_checked`, hidden as undated. Returns the posting id. */
  async function pasteUndated(): Promise<string> {
    google.server.use(undatedPosting())
    const first = await pasteRaw(ada, GREENHOUSE_URL)
    expect(first.body).toMatchObject({ created: true, posting: { status: "not_checked", hiddenReason: "undated" } })
    await app.get(DiscoveryService).settled()
    google.server.resetHandlers()
    anthropic.install()
    return first.body.posting.id
  }

  const postedAt = async (id: string) => (await database.db.selectFrom("job_posting").select("posted_at").where("id", "=", id).executeTakeFirstOrThrow()).posted_at

  it("REG-001: 200 created false with status checking, then one evaluation ranks the posting", async () => {
    const id = await pasteUndated()
    google.server.use(visiblePosting())
    anthropic.replyWithObject(EXTRACTION)
    const again = await pasteRaw(ada, EMBED_URL)
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ created: false, posting: { id, status: "checking", hiddenReason: null } })
    expect(await postedAt(id)).not.toBeNull()

    await app.get(DiscoveryService).settled()
    expect(anthropic.requests).toHaveLength(1)
    expect((await statusOf(database.db, database.operatorId, id)).status).toBe("ranked")
    // The paste path evaluates in the api, as a new paste does; it queues no worker job.
    expect(await queuedEvaluations(database.db)).toEqual([])
  })

  it("REG-003: during the cost pause the response says checking and the row then waits, with no model call and no spend", async () => {
    const id = await pasteUndated()
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    google.server.use(visiblePosting())
    const again = await pasteRaw(ada, EMBED_URL)
    expect(again.body).toMatchObject({ created: false, posting: { id, status: "checking" } })
    await app.get(DiscoveryService).settled()
    expect((await statusOf(database.db, database.operatorId, id)).status).toBe("waiting_to_be_checked")
    expect(anthropic.requests).toHaveLength(0)
    expect(await aiCalls()).toEqual([])
    expect(await spendRows()).toEqual([])
  })

  it("REG-004: during the global pause the evaluation still runs and ranks the posting (only submission waits)", async () => {
    const id = await pasteUndated()
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    google.server.use(visiblePosting())
    anthropic.replyWithObject(EXTRACTION)
    const again = await pasteRaw(ada, EMBED_URL)
    expect(again.body).toMatchObject({ created: false, posting: { id, status: "checking" } })
    await app.get(DiscoveryService).settled()
    expect(anthropic.requests).toHaveLength(1)
    expect((await statusOf(database.db, database.operatorId, id)).status).toBe("ranked")
  })

  it("REG-005: repeated re-pastes, sequential and concurrent, start exactly one evaluation", async () => {
    const id = await pasteUndated()
    google.server.use(visiblePosting())
    anthropic.replyWithObject(EXTRACTION)
    const concurrent = await Promise.all([pasteRaw(ada, EMBED_URL), pasteRaw(ada, EMBED_URL), pasteRaw(ada, EMBED_URL)])
    for (const again of concurrent) expect(again.body).toMatchObject({ created: false, posting: { id } })
    const sequential = await pasteRaw(ada, EMBED_URL)
    expect(sequential.body).toMatchObject({ created: false, posting: { id } })
    await app.get(DiscoveryService).settled()
    const later = await pasteRaw(ada, EMBED_URL)
    expect(later.body).toMatchObject({ created: false, posting: { id, status: "ranked" } })
    await app.get(DiscoveryService).settled()
    expect(anthropic.requests).toHaveLength(1)
    expect(await aiCalls()).toHaveLength(1)
    expect((await statusOf(database.db, database.operatorId, id)).status).toBe("ranked")
    expect(await queuedEvaluations(database.db)).toEqual([])
  })

  it("REG-006a: a re-paste of an already-ranked dated posting through another link starts no evaluation", async () => {
    google.server.use(visiblePosting())
    anthropic.replyWithObject(EXTRACTION)
    const first = await pasteRaw(ada, GREENHOUSE_URL)
    await app.get(DiscoveryService).settled()
    expect((await statusOf(database.db, database.operatorId, first.body.posting.id)).status).toBe("ranked")
    expect(anthropic.requests).toHaveLength(1)

    const again = await pasteRaw(ada, EMBED_URL)
    expect(again.body).toMatchObject({ created: false, posting: { id: first.body.posting.id, status: "ranked" } })
    await app.get(DiscoveryService).settled()
    expect(anthropic.requests).toHaveLength(1)
    expect((await statusOf(database.db, database.operatorId, first.body.posting.id)).status).toBe("ranked")
  })

  it("REG-006b: a backfill onto a row the Operator already has ranked claims nothing and starts no evaluation", async () => {
    const id = await pasteUndated()
    // An evaluated row whose shared posting is still undated (evaluated before EPIC-0006 hid undated postings).
    await database.db.updateTable("candidate_posting").set({ status: "ranked", evaluated_at: new Date() }).where("candidate_id", "=", database.operatorId).where("job_posting_id", "=", id).execute()
    google.server.use(visiblePosting())
    const again = await pasteRaw(ada, EMBED_URL)
    expect(again.status).toBe(200)
    expect(await postedAt(id)).not.toBeNull()
    await app.get(DiscoveryService).settled()
    expect(anthropic.requests).toHaveLength(0)
    expect((await statusOf(database.db, database.operatorId, id)).status).toBe("ranked")
  })

  it("REG-007: a backfilled date that is still hidden (older than 60 days) leaves the row not_checked, with no model call", async () => {
    const id = await pasteUndated()
    google.server.use(staleDatedPosting())
    const again = await pasteRaw(ada, EMBED_URL)
    expect(again.body).toMatchObject({ created: false, posting: { id, status: "not_checked", hiddenReason: "older_than_60_days" } })
    expect(await postedAt(id)).not.toBeNull()
    await app.get(DiscoveryService).settled()
    expect(anthropic.requests).toHaveLength(0)
    expect((await statusOf(database.db, database.operatorId, id)).status).toBe("not_checked")
  })
})
