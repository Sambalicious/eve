import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { DELETE_DETAILS_PATH, applicationDetailSchema, createApplicationResponseSchema } from "@eve/contracts"
import { sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { CandidateScope } from "../src/db/candidate-scope.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { DocumentsService } from "../src/documents/documents.service.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0009 QA gate (independent of the implementation session): end-to-end blocks through the real
 * validator, the detail response, Generate again from a blocked Application (OD-2), the 0039
 * constraints by the names the contract and Gherkin pin, deletion, and tenant isolation.
 * Facts are the Gherkin background; the model sees them as F1 to F10 in profile order.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let candidate: SignedInCandidate
let browser: Browser
let storage: string
let otherId: string
const clock = new TestClock("2026-11-10T09:00:00.000Z")

const FACTS = [
  ["F1", "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd"],
  ["F2", "Senior Frontend Engineer at Brightwave Ltd, 2021–2024"],
  ["F3", "Mentored 6 junior developers"],
  ["F4", "Cut release cycle from 2 weeks to 3 days"],
  ["F5", "Cut our release cycle from 3 weeks to 2 days"],
  ["R1", "Acted as the primary frontend partner to product, backend and testing teams, translating ambiguous product requirements into clear technical solutions while identifying scope risks trade offs and reducing implementation rework by 50%."],
  ["R2", "Identified and resolved stability issues, leading to a 25% reduction in production crashes and improved error observability across critical user journeys"],
  ["WIND", "Built wind farm financial models for offshore projects, forecasting revenue and cost"],
  ["PAY", "Supported the payments migration"],
  ["MIG", "Moved the billing service to Kubernetes"],
] as const
/** The alias the model uses for a Gherkin fact label (profile order). */
const alias = (label: string) => `F${FACTS.findIndex(([l]) => l === label) + 1}`
const PROFILE = [
  {
    id: "s1",
    kind: "experience",
    title: "Senior Frontend Engineer",
    organization: "Brightwave Ltd",
    period: "2021–2024",
    sourceQuote: null,
    facts: FACTS.map(([, text], i) => ({ id: `6f1c0e8a-${String(i + 1).padStart(4, "0")}-4a6b-9a01-0000000000${String(i + 1).padStart(2, "0")}`, text, sourceQuote: null })),
  },
]

const GOOD_RESUME = {
  summary: [{ text: "Senior Frontend Engineer who builds products from scratch to production.", factIds: ["F1", "F2"] }],
  experience: [
    {
      heading: { text: "Senior Frontend Engineer, Brightwave Ltd, 2021–2024", factIds: ["F2"] },
      bullets: [
        { text: "Built a React and TypeScript merchant dashboard from scratch to production.", factIds: ["F1"] },
        { text: "Mentored 6 junior developers.", factIds: ["F3"] },
      ],
    },
  ],
  skills: [{ text: "React, TypeScript", factIds: ["F1"] }],
  education: [],
}
const GOOD = {
  resume: GOOD_RESUME,
  coverLetter: { paragraphs: [{ text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] }] },
}
const SUPPORTS_ALL = { results: Array.from({ length: 200 }, (_, id) => ({ id, supported: true })) }
const letter = (text: string, factIds: string[]) => ({ resume: GOOD_RESUME, coverLetter: { paragraphs: [{ text, factIds }] } })

const ZORVEX = "I built a React and TypeScript merchant dashboard at Brightwave Ltd on the Zorvex platform."
const CONTACT = "You can reach me at sam@example.com for references from Brightwave Ltd."
const REDDIT =
  "I work well in remote teams. I acted as the main frontend partner to product, backend and testing teams and cut implementation rework by 50%. At another company, I cut production crashes by 25%."

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-qa-e9-"))
  markStorageMigratedSync(join(storage, "candidates"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({
    databaseUrl: database.url,
    clock,
    config: { candidateStorageDir: join(storage, "candidates"), anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, "claude-sonnet-5-5") },
  })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
  otherId = await insertSecondCandidate(database.db)
  await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(PROFILE), created_at: new Date(), approved_at: new Date() })
    .execute()
  await candidate.put("/v1/candidate-settings/contact").send({ fullName: "Sam Example", lines: ["Lagos, Nigeria", "sam@example.com"] }).expect(200)
})

beforeEach(async () => {
  await app.get(DocumentsService).settled()
  anthropic.install()
  anthropic.reset()
  await database.db.deleteFrom("tailored_document").execute()
  await database.db.deleteFrom("ai_call").execute()
  await database.db.deleteFrom("application").execute()
  await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

async function redditApplication(): Promise<string> {
  const id = crypto.randomUUID()
  await insertPostingFor(database.db, database.operatorId, {
    id,
    application_url: "https://boards.greenhouse.io/reddit/jobs/1",
    requisition_id: "R-Reddit",
    apply_url: "https://boards.greenhouse.io/reddit/jobs/1",
    application_system: "Greenhouse",
    apply_mode: "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title: "Frontend Engineer, Ads",
    company: "Reddit",
    posting_text: "Frontend Engineer, Ads at Reddit. Remote, open to candidates in Nigeria. Build React features.",
    status: "ranked",
    skip_reason: null,
    skip_detail: null,
    evaluation_failure: null,
    role_family: "senior_frontend",
    discovered_at: new Date(),
    evaluated_at: new Date(),
  })
  const response = await candidate.post("/v1/applications").send({ jobPostingId: id })
  return createApplicationResponseSchema.parse(response.body).application.id
}

async function generate(id: string) {
  const started = await candidate.post(`/v1/applications/${id}/documents/generate`)
  await app.get(DocumentsService).settled()
  const detail = await candidate.get(`/v1/applications/${id}`).expect(200)
  return { started, raw: detail.body as Record<string, unknown>, detail: applicationDetailSchema.parse(detail.body) }
}

const row = (id: string) => database.db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow()

/** The pg error code and constraint name of a refused write, or null when the write went through. */
async function refusal(work: () => Promise<unknown>): Promise<{ code: string; constraint: string } | null> {
  try {
    await work()
    return null
  } catch (error) {
    const e = error as { code?: string; constraint?: string }
    return { code: e.code ?? "?", constraint: e.constraint ?? "?" }
  }
}

/** A row in documents_blocked on its cover letter, set directly (no cause), for the constraint tests. */
async function blockedRow(): Promise<string> {
  const id = await redditApplication()
  await database.db.updateTable("application").set({ state: "documents_blocked", blocked_document: "cover_letter", blocked_claim: ZORVEX }).where("id", "=", id).execute()
  return id
}
const setCause = (id: string, cause: string | null, terms: string[] | null, more: number | null) =>
  database.db.updateTable("application").set({ blocked_claim_cause: cause, blocked_claim_terms: terms, blocked_claim_more_terms: more } as never).where("id", "=", id).execute()

describe("QA EPIC-0009: end-to-end blocks through the real validator", () => {
  it("@ac-1.1: the Zorvex letter is unsupported_terms with the as-written term, and the detail response carries it", async () => {
    const id = await redditApplication()
    anthropic.replyWithObject(letter(ZORVEX, ["F1"]))
    const { detail, raw } = await generate(id)
    expect(detail).toMatchObject({ state: "documents_blocked", blockedDocument: "cover_letter", blockedClaim: ZORVEX })
    expect(raw).toMatchObject({ blockedClaimCause: "unsupported_terms", blockedClaimTerms: ["Zorvex"], blockedClaimMoreTerms: 0 })
  })

  it("@ac-1.5: the owner's Reddit reproduction blocks on the single word remote", async () => {
    const id = await redditApplication()
    anthropic.replyWithObject(letter(REDDIT, [alias("R1"), alias("R2")]))
    const { raw } = await generate(id)
    // The claim the alert quotes is the sentence that failed, not the paragraph that held it.
    expect(raw).toMatchObject({ state: "documents_blocked", blockedClaim: "I work well in remote teams.", blockedClaimCause: "unsupported_terms", blockedClaimTerms: ["remote"], blockedClaimMoreTerms: 0 })
  })

  it("@ac-3.1 / @ac-7.5: a contact detail is contact_detail, with no terms keys, no file and no document row", async () => {
    const id = await redditApplication()
    anthropic.replyWithObject(letter(CONTACT, ["F1"]))
    const { raw } = await generate(id)
    expect(raw).toMatchObject({ state: "documents_blocked", blockedDocument: "cover_letter", blockedClaim: CONTACT, blockedClaimCause: "contact_detail" })
    expect(raw).not.toHaveProperty("blockedClaimTerms")
    expect(raw).not.toHaveProperty("blockedClaimMoreTerms")
    expect(await database.db.selectFrom("tailored_document").select("id").where("application_id", "=", id).execute()).toEqual([])
    expect(await row(id)).toMatchObject({ blocked_claim_cause: "contact_detail", blocked_claim_terms: null, blocked_claim_more_terms: null })
  })

  it("@ac-1.8 r1: a letter paragraph citing no fact is no_fact with its terms as written", async () => {
    const id = await redditApplication()
    anthropic.replyWithObject(letter("I have 10 years of Kubernetes experience.", []))
    const { raw } = await generate(id)
    expect(raw).toMatchObject({ state: "documents_blocked", blockedClaimCause: "no_fact", blockedClaimTerms: ["10", "Kubernetes"], blockedClaimMoreTerms: 0 })
  })

  it("@ac-2.1: a number-order letter block is number_order", async () => {
    const id = await redditApplication()
    anthropic.replyWithObject(letter("I cut our release cycle from 2 days to 3 weeks.", [alias("F5")]))
    const { raw } = await generate(id)
    expect(raw).toMatchObject({ state: "documents_blocked", blockedClaimCause: "number_order", blockedClaimTerms: ["2", "3"], blockedClaimMoreTerms: 0 })
  })

  it("@ac-4.1: a letter naming the employer is names_target with no terms keys", async () => {
    const id = await redditApplication()
    anthropic.replyWithObject(letter("I built a React and TypeScript merchant dashboard and want to bring that to Reddit.", ["F1"]))
    const { raw } = await generate(id)
    expect(raw).toMatchObject({ state: "documents_blocked", blockedClaimCause: "names_target" })
    expect(raw).not.toHaveProperty("blockedClaimTerms")
  })

  it("@ac-5.1: a resume line citing a fact outside the approved version is unknown_fact", async () => {
    const id = await redditApplication()
    anthropic.replyWithObject({ ...GOOD, resume: { ...GOOD_RESUME, summary: [{ text: "Staff Engineer at Brightwave Ltd", factIds: ["F99"] }] } })
    const { raw } = await generate(id)
    expect(raw).toMatchObject({ state: "documents_blocked", blockedDocument: "resume", blockedClaim: "Staff Engineer at Brightwave Ltd", blockedClaimCause: "unknown_fact" })
    expect(raw).not.toHaveProperty("blockedClaimTerms")
  })

  it("@ac-9.2: an unconfirmed letter paragraph is not_confirmed with no terms keys", async () => {
    const id = await redditApplication()
    anthropic.replyWithObject(letter("I mentored 6 junior developers through the year.", [alias("F3")]))
    anthropic.replyWithObject({ results: [] })
    const { raw } = await generate(id)
    expect(raw).toMatchObject({ state: "documents_blocked", blockedClaim: "I mentored 6 junior developers through the year.", blockedClaimCause: "not_confirmed" })
    expect(raw).not.toHaveProperty("blockedClaimTerms")
  })
})

describe("QA EPIC-0009: Generate again from a blocked Application (OD-2, @ac-11.x, @ac-8.1, @ac-8.2, @ac-8.10)", () => {
  async function zorvexBlocked(): Promise<string> {
    const id = await redditApplication()
    anthropic.replyWithObject(letter(ZORVEX, ["F1"]))
    expect((await generate(id)).raw).toMatchObject({ blockedClaimCause: "unsupported_terms", blockedClaimTerms: ["Zorvex"] })
    anthropic.reset()
    return id
  }

  it("@ac-11.1 / @ac-11.2 r1 / @ac-8.2 r1: Generate again is 202 generating, then documents_ready with no block data", async () => {
    const id = await zorvexBlocked()
    anthropic.replyWithObjectWhenReleased(GOOD)
    anthropic.replyWithObject(SUPPORTS_ALL)
    const started = await candidate.post(`/v1/applications/${id}/documents/generate`)
    expect(started.status).toBe(202)
    expect(started.body).toMatchObject({ state: "generating" })
    expect(started.body).not.toHaveProperty("blockedClaimCause")
    const during = (await candidate.get(`/v1/applications/${id}`).expect(200)).body
    expect(during).toMatchObject({ state: "generating", blockedDocument: null, blockedClaim: null })
    expect(JSON.stringify(during)).not.toContain("Zorvex")
    await anthropic.waitForHeld()
    anthropic.releaseHeld()
    await app.get(DocumentsService).settled()
    const after = (await candidate.get(`/v1/applications/${id}`).expect(200)).body
    expect(after).toMatchObject({ state: "documents_ready", blockedDocument: null, blockedClaim: null })
    expect(JSON.stringify(after)).not.toContain("Zorvex")
    expect(await row(id)).toMatchObject({ blocked_document: null, blocked_claim: null, blocked_claim_cause: null, blocked_claim_terms: null, blocked_claim_more_terms: null })
  })

  it("@ac-8.1: a new block replaces the paragraph, kind, terms and count together", async () => {
    const id = await zorvexBlocked()
    anthropic.replyWithObject(letter(CONTACT, ["F1"]))
    const { started, raw } = await generate(id)
    expect(started.status).toBe(202)
    expect(raw).toMatchObject({ state: "documents_blocked", blockedClaim: CONTACT, blockedClaimCause: "contact_detail" })
    expect(raw).not.toHaveProperty("blockedClaimTerms")
    expect(raw).not.toHaveProperty("blockedClaimMoreTerms")
    expect(JSON.stringify(raw)).not.toContain("Zorvex")
  })

  it("@ac-11.2 r3 / @ac-8.2 r2: a provider failure after Generate again leaves no block data", async () => {
    const id = await zorvexBlocked()
    anthropic.replyWithStatus(500)
    const { started, raw } = await generate(id)
    expect(started.status).toBe(202)
    expect(raw.state).toBe("documents_failed")
    expect(JSON.stringify(raw)).not.toContain("Zorvex")
    expect(await row(id)).toMatchObject({ blocked_document: null, blocked_claim: null, blocked_claim_cause: null, blocked_claim_terms: null, blocked_claim_more_terms: null })
  })

  it("@ac-11.4 / @ac-6.4 absent: a pre-release blocked row (no cause) omits the keys, then recovers with Generate again", async () => {
    const id = await zorvexBlocked()
    await setCause(id, null, null, null)
    const before = (await candidate.get(`/v1/applications/${id}`).expect(200)).body
    expect(before).toMatchObject({ state: "documents_blocked", blockedDocument: "cover_letter", blockedClaim: ZORVEX })
    for (const key of ["blockedClaimCause", "blockedClaimTerms", "blockedClaimMoreTerms"]) expect(before).not.toHaveProperty(key)
    anthropic.replyWithObject(GOOD)
    anthropic.replyWithObject(SUPPORTS_ALL)
    const { started, raw } = await generate(id)
    expect(started.status).toBe(202)
    expect(raw.state).toBe("documents_ready")
  })

  it("@ac-11.3 / @ac-11.6 r1: a start refused on deleted details changes nothing", async () => {
    const id = await zorvexBlocked()
    const deletedAt = new Date("2026-11-10T08:00:00.000Z")
    await database.db.updateTable("application").set({ details_deleted_at: deletedAt, final_status: "documents_blocked" } as never).where("id", "=", id).execute()
    const before = await row(id)
    const started = await candidate.post(`/v1/applications/${id}/documents/generate`)
    expect(started.status).toBeGreaterThanOrEqual(400)
    await app.get(DocumentsService).settled()
    expect(anthropic.requests).toHaveLength(0)
    expect(await row(id)).toEqual(before)
  })

  it("@ac-11.3 / @ac-11.6: a start refused without a contact name changes nothing", async () => {
    const id = await zorvexBlocked()
    await database.db.updateTable("candidate_contact").set({ full_name: "" }).execute()
    try {
      const before = await row(id)
      const started = await candidate.post(`/v1/applications/${id}/documents/generate`)
      expect(started.status).toBeGreaterThanOrEqual(400)
      await app.get(DocumentsService).settled()
      expect(anthropic.requests).toHaveLength(0)
      expect(await row(id)).toEqual(before)
    } finally {
      await database.db.updateTable("candidate_contact").set({ full_name: "Sam Example" }).execute()
    }
  })

  it("@ac-11.7: a second start while generating returns the current summary and runs one generation", async () => {
    const id = await zorvexBlocked()
    anthropic.replyWithObjectWhenReleased(GOOD)
    anthropic.replyWithObject(SUPPORTS_ALL)
    await candidate.post(`/v1/applications/${id}/documents/generate`).expect(202)
    const second = await candidate.post(`/v1/applications/${id}/documents/generate`)
    expect(second.status).toBe(202)
    expect(second.body).toMatchObject({ state: "generating" })
    await anthropic.waitForHeld()
    anthropic.releaseHeld()
    await app.get(DocumentsService).settled()
    expect((await row(id)).state).toBe("documents_ready")
  })
})

describe("QA EPIC-0009: the 0039 constraints by name (@ac-8.9, @ac-8.1 :594, @ac-8.10, contract terms bound, @ac-11.5)", () => {
  it.each(["unsupported_terms", "number_order", "no_fact"])("@ac-8.9 accepts the terms cause %s with terms", async (cause) => {
    const id = await blockedRow()
    expect(await refusal(() => setCause(id, cause, ["Zorvex"], 0))).toBeNull()
  })

  it.each(["contact_detail", "names_target", "unknown_fact", "not_confirmed", null])("@ac-8.9 accepts the no-terms cause %s", async (cause) => {
    const id = await blockedRow()
    expect(await refusal(() => setCause(id, cause, null, null))).toBeNull()
  })

  it.each(["fallback", "goal_completion", "unsourced_quote"])("@ac-8.9 refuses %s by application_blocked_claim_cause_check", async (cause) => {
    const id = await blockedRow()
    expect(await refusal(() => setCause(id, cause, null, null))).toEqual({ code: "23514", constraint: "application_blocked_claim_cause_check" })
  })

  it("@ac-8.1 :594: not_confirmed with an empty list and count 0 is refused by application_blocked_claim_terms_kind; the row keeps its values", async () => {
    const id = await blockedRow()
    await setCause(id, "unsupported_terms", ["Zorvex"], 0)
    expect(await refusal(() => setCause(id, "not_confirmed", [], 0))).toEqual({ code: "23514", constraint: "application_blocked_claim_terms_kind" })
    expect(await row(id)).toMatchObject({ blocked_claim_cause: "unsupported_terms", blocked_claim_terms: ["Zorvex"], blocked_claim_more_terms: 0 })
  })

  it("contract: terms with no cause are refused by application_blocked_claim_terms_kind", async () => {
    const id = await blockedRow()
    expect(await refusal(() => setCause(id, null, ["Zorvex"], 0))).toEqual({ code: "23514", constraint: "application_blocked_claim_terms_kind" })
  })

  it("@ac-8.10: a cause on a row with no blocked document is refused by application_blocked_claim_cause_blocked", async () => {
    const id = await redditApplication()
    expect(await refusal(() => setCause(id, "number_order", ["2", "3"], 0))).toEqual({ code: "23514", constraint: "application_blocked_claim_cause_blocked" })
  })

  it("contract: 21 terms are refused by application_blocked_claim_terms_bound", async () => {
    const id = await blockedRow()
    const terms = Array.from({ length: 21 }, (_, i) => `t${i}`)
    expect(await refusal(() => setCause(id, "unsupported_terms", terms, 0))).toEqual({ code: "23514", constraint: "application_blocked_claim_terms_bound" })
  })

  it("contract: terms without a count are refused by application_blocked_claim_terms_pair", async () => {
    const id = await blockedRow()
    expect(await refusal(() => setCause(id, "unsupported_terms", ["Zorvex"], null))).toEqual({ code: "23514", constraint: "application_blocked_claim_terms_pair" })
  })

  it("contract: a negative count is refused by application_blocked_claim_more_terms_check", async () => {
    const id = await blockedRow()
    expect((await refusal(() => setCause(id, "unsupported_terms", ["Zorvex"], -1)))?.code).toBe("23514")
  })

  it.each([
    ["documents_blocked", null],
    ["generating", "cover_letter"],
    ["documents_ready", "resume"],
  ] as const)("@ac-11.5: %s with blocked document %s is refused by application_blocked_pair", async (state, document) => {
    const id = await redditApplication()
    const result = await refusal(() => database.db.updateTable("application").set({ state, blocked_document: document } as never).where("id", "=", id).execute())
    expect(result).toEqual({ code: "23514", constraint: "application_blocked_pair" })
  })
})

describe("QA EPIC-0009: read rule, deletion and isolation (@ac-8.4, @ac-8.5, TM-0009-07 / OD-7)", () => {
  it("@ac-8.4: deleting detailed records clears the cause, terms and count with the paragraph", async () => {
    const id = await blockedRow()
    await setCause(id, "unsupported_terms", ["Zorvex"], 0)
    await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [id] }).expect(200)
    expect(await row(id)).toMatchObject({ state: "documents_blocked", blocked_document: "cover_letter", blocked_claim: null, blocked_claim_cause: null, blocked_claim_terms: null, blocked_claim_more_terms: null })
    const body = (await candidate.get(`/v1/applications/${id}`).expect(200)).body
    for (const key of ["blockedClaimCause", "blockedClaimTerms", "blockedClaimMoreTerms"]) expect(body).not.toHaveProperty(key)
  })

  it("contract read rule: a deleted-details row that still holds a cause (rollback residue) does not send it", async () => {
    const id = await blockedRow()
    await setCause(id, "unsupported_terms", ["Zorvex"], 0)
    await database.db.updateTable("application").set({ details_deleted_at: new Date(), final_status: "documents_blocked" } as never).where("id", "=", id).execute()
    const body = (await candidate.get(`/v1/applications/${id}`).expect(200)).body
    for (const key of ["blockedClaimCause", "blockedClaimTerms", "blockedClaimMoreTerms"]) expect(body).not.toHaveProperty(key)
  })

  it("TM-0009-04: a stored over-long term is dropped and counted, and the list still parses", async () => {
    const id = await blockedRow()
    await setCause(id, "unsupported_terms", ["Zorvex", "x".repeat(121)], 0)
    const body = (await candidate.get(`/v1/applications/${id}`).expect(200)).body
    expect(body).toMatchObject({ blockedClaimCause: "unsupported_terms", blockedClaimTerms: ["Zorvex"], blockedClaimMoreTerms: 1 })
    expect(applicationDetailSchema.safeParse(body).success).toBe(true)
  })

  it("@ac-8.5 r2: an unauthenticated read is refused and carries no term", async () => {
    const id = await blockedRow()
    await setCause(id, "unsupported_terms", ["Zorvex"], 0)
    const response = await browser.http().get(`/v1/applications/${id}`)
    expect(response.status).toBe(401)
    expect(response.text).not.toContain("Zorvex")
  })

  it("@ac-8.5 r3: a query under another Candidate's tenant returns no row of the Application", async () => {
    const id = await blockedRow()
    await setCause(id, "unsupported_terms", ["Zorvex"], 0)
    const seen = await CandidateScope.run(otherId, () =>
      app.get(TenantDatabase).run((tx) => tx.selectFrom("application").select(["id", "blocked_claim_cause", "blocked_claim_terms"]).where("id", "=", id).execute())
    )
    expect(seen).toEqual([])
  })
})

describe("QA EPIC-0009: migration 0039 on this database and the newest migration after it (@ac-6.3, marker)", () => {
  it("0039 is applied: its marker is recorded and the three columns exist", async () => {
    expect((await sql`select 1 from migration_marker where name = '0039-blocked-claim-cause'`.execute(database.db)).rows).toHaveLength(1)
    const columns = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_name = 'application' and column_name like 'blocked_claim%' order by column_name`.execute(database.db)
    expect(columns.rows.map((c) => c.column_name)).toEqual(["blocked_claim", "blocked_claim_cause", "blocked_claim_more_terms", "blocked_claim_terms"])
  })

  it("@ac-6.3: rolling back the newest migration and re-applying it restores its marker and leaves a pre-release blocked row as it was, with no cause", async () => {
    const id = await blockedRow()
    const before = await row(id)
    // The newest migration is read from the list, never hard-coded: a later epic may add one.
    const context = { operatorGoogleSub: "unused-at-0039" }
    const names = Object.keys(migrationsFor(context)).sort((a, b) => a.localeCompare(b))
    const newest = names[names.length - 1]!
    const previous = names[names.length - 2]!
    const markerCount = async (name: string) => (await sql`select 1 from migration_marker where name = ${name}`.execute(database.db)).rows.length
    const migrator = new Migrator({ db: database.db as never, provider: { getMigrations: async () => migrationsFor(context) } })
    expect(await markerCount(newest)).toBe(1)
    const down = await migrator.migrateDown()
    expect(down.error).toBeUndefined()
    expect(down.results?.[0]).toMatchObject({ migrationName: newest, direction: "Down", status: "Success" })
    // Rolling back the newest migration removes its marker and leaves the previous one in place.
    expect(await markerCount(newest)).toBe(0)
    expect(await markerCount(previous)).toBe(1)
    const up = await migrator.migrateToLatest()
    expect(up.error).toBeUndefined()
    expect(await markerCount(newest)).toBe(1)
    const after = await row(id)
    expect(after).toEqual(before)
    expect(after).toMatchObject({ state: "documents_blocked", blocked_document: "cover_letter", blocked_claim: ZORVEX, blocked_claim_cause: null, blocked_claim_terms: null, blocked_claim_more_terms: null })
  })
})
