import type { INestApplication } from "@nestjs/common"
import { pasteJobLinkResponseSchema } from "@eve/contracts"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { Browser } from "./support/browser.js"
import { clearPostings, queuedEvaluations, setCriteria, signInSecondCandidate, statusOf } from "./support/epic-0006.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0006 r4 posted-date.feature @r4 scenarios not already covered by
 * paste-evaluation-allowed.int-spec.ts (REG-001 to REG-007, CR-P1-01) or
 * ingestion-and-evaluation.epic-0006.int-spec.ts (posted-date:450). Real api,
 * Postgres and the MSW Greenhouse lookup; Anthropic is the fake.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let ada: SignedInCandidate
let kofi: SignedInCandidate
let adaId: string
let kofiId: string
const clock = new TestClock("2026-10-24T09:00:00.000Z")

const STORED_URL = "https://boards.greenhouse.io/acme/jobs/4012345"
const EMBED_URL = "https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345"
const LOOKUP = "https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345"
const TEXT = "Remote, open to candidates in Nigeria. Build React features."

/** The Greenhouse lookup for GH-4012345, with `first_published` when given. */
const lookup = (title: string, firstPublished?: string) =>
  http.get(LOOKUP, () =>
    HttpResponse.json({ id: 4012345, title, absolute_url: STORED_URL, requisition_id: "4012345", company_name: "Acme", content: TEXT, ...(firstPublished ? { first_published: firstPublished } : {}) })
  )

async function paste(who: SignedInCandidate, url: string) {
  const response = await who.post("/v1/job-postings/links").send({ url })
  return { status: response.status, body: pasteJobLinkResponseSchema.parse(response.body) }
}

/** `who` pastes the stored link while its lookup has no posted date: their row is not_checked, hidden as undated. */
async function storeUndated(who: SignedInCandidate, title = "Senior Frontend Engineer"): Promise<string> {
  google.server.use(lookup(title))
  const first = await paste(who, STORED_URL)
  // Off-target comes before undated in the hidden-reason order, so an off-target title reports off_target.
  expect(first.body.posting).toMatchObject({ status: "not_checked", hiddenReason: title === "Senior Frontend Engineer" ? "undated" : "off_target" })
  await app.get(DiscoveryService).settled()
  google.server.resetHandlers()
  anthropic.install()
  return first.body.posting.id
}

const facts = async (id: string) => database.db.selectFrom("job_posting").select(["posted_at", "posted_date_kind"]).where("id", "=", id).executeTakeFirstOrThrow()
const lookups = () => outbound.urls.filter((url) => url.startsWith(`GET ${LOOKUP}`))
const noSpend = async () => {
  expect(anthropic.requests).toHaveLength(0)
  expect(await database.db.selectFrom("spend_entry").select("id").where("category", "=", "ai").execute()).toEqual([])
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  adaId = database.operatorId
  ;({ candidate: kofi, id: kofiId } = await signInSecondCandidate(app, google, database.db, { sub: "200000000000000000927", email: "kofi.repaste@example.test" }))
  await ada.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  for (const id of [adaId, kofiId]) await setCriteria(database.db, id, { targets: ["senior_frontend"], floor: "hide_entry_level", min: 70 })
})

beforeEach(async () => {
  await app.get(DiscoveryService).settled()
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  outbound.reset()
  await clearPostings(database.db)
  await database.db.deleteFrom("spend_entry").execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("posted-date @r4: a different-link re-paste looks up and backfills (AC-5.6)", () => {
  it("posted-date:488 pasting another link to a stored undated requisition looks it up and backfills published 2026-10-10; one posting exists", async () => {
    const id = await storeUndated(ada)
    outbound.reset()
    google.server.use(lookup("Senior Frontend Engineer", "2026-10-10T09:00:00Z"))
    const again = await paste(ada, EMBED_URL)
    expect(again.body).toMatchObject({ created: false, posting: { id } })
    expect(lookups(), JSON.stringify(outbound.urls)).toHaveLength(1)
    expect(await facts(id)).toEqual({ posted_at: new Date("2026-10-10T09:00:00Z"), posted_date_kind: "published" })
    expect(await database.db.selectFrom("job_posting").select("id").execute()).toEqual([{ id }])
  })

  it("posted-date:498 a different-link re-paste never overwrites a stored posted date and basis", async () => {
    const id = await storeUndated(ada)
    await database.db.updateTable("job_posting").set({ posted_at: new Date("2026-10-12T09:00:00Z"), posted_date_kind: "updated" }).where("id", "=", id).execute()
    google.server.use(lookup("Senior Frontend Engineer", "2026-10-10T09:00:00Z"))
    await paste(ada, EMBED_URL)
    expect(await facts(id)).toEqual({ posted_at: new Date("2026-10-12T09:00:00Z"), posted_date_kind: "updated" })
  })
})

describe("posted-date @r4: a backfilling re-paste that claims nothing starts no evaluation (AC-5.8)", () => {
  it.each([
    ["ranked", null],
    ["skipped", "weak_core_match"],
    ["evaluation_failed", null],
    ["waiting_to_be_checked", null],
  ] as const)("posted-date:602 Ada's row is %s: created false with that status, the date is stored, no call, no spend", async (status, skipReason) => {
    const id = await storeUndated(ada)
    await database.db
      .updateTable("candidate_posting")
      .set({ status, skip_reason: skipReason, evaluation_failure: status === "evaluation_failed" ? "provider_error" : null })
      .where("candidate_id", "=", adaId)
      .where("job_posting_id", "=", id)
      .execute()
    google.server.use(lookup("Senior Frontend Engineer", "2026-10-10T09:00:00Z"))
    const again = await paste(ada, EMBED_URL)
    expect(again.body).toMatchObject({ created: false, posting: { id, status } })
    expect((await facts(id)).posted_at).toEqual(new Date("2026-10-10T09:00:00Z"))
    await app.get(DiscoveryService).settled()
    await noSpend()
    expect((await statusOf(database.db, adaId, id)).status).toBe(status)
    expect(await queuedEvaluations(database.db)).toEqual([])
  })

  it("posted-date:629 (off-target row) a backfilled date that leaves the posting hidden as off_target keeps it not_checked with no call", async () => {
    const id = await storeUndated(ada, "Senior Data Engineer")
    google.server.use(lookup("Senior Data Engineer", "2026-10-10T09:00:00Z"))
    const again = await paste(ada, EMBED_URL)
    expect(again.body).toMatchObject({ created: false, posting: { id, status: "not_checked", hiddenReason: "off_target" } })
    expect((await facts(id)).posted_at).toEqual(new Date("2026-10-10T09:00:00Z"))
    await app.get(DiscoveryService).settled()
    await noSpend()
  })
})

describe("posted-date @r4: per Candidate (AC-5.8, AC-5.6)", () => {
  it("posted-date:655 Kofi's backfilling re-paste dates the posting for Ada too but claims none of Ada's rows", async () => {
    const id = await storeUndated(ada)
    google.server.use(lookup("Senior Frontend Engineer"))
    // Kofi holds the same requisition, also not_checked and undated (his paste of the stored link answers from the row).
    expect((await paste(kofi, STORED_URL)).body.posting).toMatchObject({ id, status: "not_checked" })
    google.server.resetHandlers()
    anthropic.install()
    google.server.use(lookup("Senior Frontend Engineer", "2026-10-10T09:00:00Z"))
    const again = await paste(kofi, EMBED_URL)
    expect(again.body).toMatchObject({ created: false, posting: { id, status: "waiting_to_be_checked" } })
    expect((await facts(id)).posted_at).toEqual(new Date("2026-10-10T09:00:00Z"))
    await app.get(DiscoveryService).settled()
    expect((await statusOf(database.db, adaId, id)).status).toBe("not_checked")
    expect(anthropic.requests).toHaveLength(0)
    expect(await queuedEvaluations(database.db)).toEqual([])
  })
})
