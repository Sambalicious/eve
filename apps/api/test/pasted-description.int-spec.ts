import type { INestApplication } from "@nestjs/common"
import {
  JOB_POSTING_LINKS_PATH,
  PASTE_DESCRIPTION_ERROR_MESSAGES,
  applicationSummarySchema,
  apiErrorResponseSchema,
  jobPostingDetailSchema,
  pasteJobLinkResponseSchema,
} from "@eve/contracts"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { Browser } from "./support/browser.js"
import { clearPostings, setCriteria, signInSecondCandidate, statusOf } from "./support/epic-0006.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0010 backend (api-contract v1.27.0): POST /v1/job-postings/links with a description,
 * the Candidate-private posting, re-paste rules, visibility exemption, the pasted Application
 * create and the manual-only refusals. Ada is the Operator (evaluated), Kofi an invitee (D13).
 * Each case names its Gherkin key (FILE:line, see gherkin-responsibility.md).
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let ada: SignedInCandidate
let kofi: SignedInCandidate
let kofiId: string
const clock = new TestClock("2026-11-02T09:00:00.000Z")

const BODY_TEXT = "Remote, open to candidates in Nigeria. Salary USD 60,000–80,000 per year. Build React features."
const DESCRIPTION = `Senior Frontend Engineer\r\n\r\n${BODY_TEXT}\n\n${"We ship a payments dashboard used across Africa. ".repeat(4)}`
const LINKEDIN = "https://www.linkedin.com/jobs/view/4012345678"
const GREENHOUSE = "https://boards.greenhouse.io/acme/jobs/4019999"
const GREENHOUSE_API = "https://boards-api.greenhouse.io/v1/boards/acme/jobs/4019999"

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

const requests: string[] = []
const record = ({ request }: { request: Request }) => {
  requests.push(new URL(request.url).hostname)
}

async function paste(who: SignedInCandidate, body: Record<string, unknown>) {
  return who.post(JOB_POSTING_LINKS_PATH).send(body)
}

async function pasteOk(who: SignedInCandidate, body: Record<string, unknown>, status: 200 | 201) {
  const response = await paste(who, body)
  expect(response.status, JSON.stringify(response.body)).toBe(status)
  return pasteJobLinkResponseSchema.parse(response.body)
}

function refusal(response: { status: number; body: unknown }) {
  return { status: response.status, error: apiErrorResponseSchema.parse(response.body).error }
}

const named = { title: "Senior Frontend Engineer", company: "Paystack" }
const jobPostingRows = () => database.db.selectFrom("job_posting").select(["id", "origin", "posting_text", "owner_candidate_id"]).execute()

/** Ends a hanging model call once it has arrived (a release before the request would leave it hanging). */
async function releaseHanging(): Promise<void> {
  for (let i = 0; i < 200 && anthropic.requests.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25))
  anthropic.release()
}

async function settle(): Promise<void> {
  await app.get(DiscoveryService).settled()
}

/** A pasted posting Ada holds, decided as `status` without an evaluation. */
async function decided(status: "ranked" | "skipped" | "excluded", body: Record<string, unknown> = { description: DESCRIPTION, ...named }) {
  const pasted = await pasteOk(ada, body, 201)
  await settle()
  await database.db
    .updateTable("candidate_posting")
    .set({ status, skip_reason: status === "skipped" ? "weak_core_match" : null, evaluation_failure: null })
    .where("job_posting_id", "=", pasted.posting.id)
    .execute()
  return pasted.posting.id
}

async function createApplication(who: SignedInCandidate, jobPostingId: string) {
  return who.post("/v1/applications").send({ jobPostingId })
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  ;({ candidate: kofi, id: kofiId } = await signInSecondCandidate(app, google, database.db, { sub: "200000000000000001010", email: "kofi.pasted@example.test" }))
  await ada.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  for (const candidateId of [database.operatorId, kofiId]) {
    await setCriteria(database.db, candidateId, { targets: ["senior_frontend"], floor: "hide_entry_level", min: 70 })
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: candidateId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(SECTIONS), created_at: new Date(), approved_at: new Date() })
      .execute()
  }
  google.server.events.on("request:start", record)
})

beforeEach(async () => {
  anthropic?.reset()
  await settle()
  google.server.resetHandlers()
  anthropic.install()
  // No reply queued: an evaluation that reaches the model fails (evaluation_failed) unless a test queues one.
  anthropic.reset()
  await clearPostings(database.db)
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  requests.length = 0
})

afterAll(async () => {
  google?.server.events.removeListener("request:start", record)
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("storing a pasted description (PD-1, PD-2.1)", () => {
  it("PD:58 EV:28 a description-only paste stores a private, manual pasted_description posting with no link", async () => {
    const pasted = await pasteOk(ada, { description: DESCRIPTION, ...named }, 201)
    expect(pasted).toMatchObject({ created: true, descriptionOutcome: "stored", applicationId: null, waitingReason: null })
    const id = pasted.posting.id
    expect(pasted.posting).toMatchObject({
      origin: "pasted_description",
      applyMode: "manual",
      applicationUrl: null,
      applyUrl: null,
      applicationSystem: "none",
      requisitionId: `pasted:${id}`,
      title: "Senior Frontend Engineer",
      company: "Paystack",
      hiddenReason: null,
      status: "checking",
    })
    const row = await database.db.selectFrom("job_posting").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
    expect(row.owner_candidate_id).toBe(database.operatorId)
    expect(row.application_url).toBe(`urn:eve:pasted:${id}`)
    // Line endings normalised, trimmed: the stored text is the normalised description.
    expect(row.posting_text).toBe(DESCRIPTION.replace(/\r\n?/g, "\n").trim())
    expect(row.paste_fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it("PD:73 EV:34 PD:262 PD:271 a LinkedIn link with a description keeps the link, never requests LinkedIn or Google", async () => {
    const pasted = await pasteOk(ada, { url: LINKEDIN, description: DESCRIPTION, ...named }, 201)
    expect(pasted.descriptionOutcome).toBe("stored")
    expect(pasted.posting).toMatchObject({ origin: "pasted_description", applyMode: "manual", applicationUrl: "https://linkedin.com/jobs/view/4012345678", applyUrl: LINKEDIN, applicationSystem: "linkedin.com" })
    await settle()
    expect(requests.filter((host) => /linkedin|google/.test(host) && host !== "oauth2.googleapis.com")).toEqual([])
  })

  it("PD:91 PD:99 a link-only paste (and a blank description) is today's path with descriptionOutcome null", async () => {
    const linkOnly = await pasteOk(ada, { url: LINKEDIN }, 201)
    expect(linkOnly).toMatchObject({ created: true, descriptionOutcome: null, applicationId: null, posting: { origin: "pasted_link", status: "skipped", skipReason: "unsupported_application_system" } })
    const blank = await pasteOk(ada, { url: LINKEDIN, description: "  \n \r\n " }, 200)
    expect(blank).toMatchObject({ created: false, descriptionOutcome: null, posting: { id: linkOnly.posting.id } })
  })

  it("PD:112 link-only refusals are unchanged", async () => {
    expect(refusal(await paste(ada, { url: "" })).error.code).toBe("job_link_empty")
    expect(refusal(await paste(ada, { url: "linkedin.com/x" })).error.code).toBe("job_link_invalid")
  })

  it("PD:146 a blank description with no link is too short; PD:133 200 is accepted, 199 refused", async () => {
    const blank = refusal(await paste(ada, { description: " \n " }))
    expect(blank).toMatchObject({ status: 422, error: { code: "job_description_too_short", message: PASTE_DESCRIPTION_ERROR_MESSAGES.job_description_too_short, fieldErrors: [{ field: "description", position: null, problem: "too_short" }] } })
    expect(refusal(await paste(ada, { description: `  ${"a".repeat(199)}  `, ...named })).error.code).toBe("job_description_too_short")
    await pasteOk(ada, { description: `  ${"a".repeat(200)}  `, ...named }, 201)
    await pasteOk(ada, { description: "b".repeat(30_000), ...named }, 201)
  })

  it("PD:161 PD:175 45,000 characters pass the raw cap and are refused, never truncated; nothing stored", async () => {
    const response = refusal(await paste(ada, { description: "c".repeat(45_000), ...named }))
    expect(response).toMatchObject({ status: 422, error: { code: "job_description_too_long", fieldErrors: [{ field: "description", problem: "too_long" }] } })
    expect(await jobPostingRows()).toEqual([])
    expect((await paste(ada, { description: "c".repeat(65_537), ...named })).status).toBe(400)
  })

  it("PD:181 PD:238 a refused description stores nothing for its link; an invalid link refuses the whole request first", async () => {
    expect(refusal(await paste(ada, { url: LINKEDIN, description: "short", ...named })).error.code).toBe("job_description_too_short")
    expect(refusal(await paste(ada, { url: "ftp://x.test/job", description: "short" }))).toMatchObject({ status: 422, error: { code: "job_link_invalid" } })
    expect(refusal(await paste(ada, { url: "ftp://x.test/job", description: "short" })).error.fieldErrors).toBeUndefined()
    expect(await jobPostingRows()).toEqual([])
  })

  it("PD:191 PD:205 names are required without a link and with a non-ATS link; every missing field is reported", async () => {
    const none = refusal(await paste(ada, { description: DESCRIPTION }))
    expect(none).toMatchObject({
      status: 422,
      error: { code: "job_title_required", message: "Enter the job title.", fieldErrors: [{ field: "title", position: null, problem: "required" }, { field: "company", position: null, problem: "required" }] },
    })
    expect(refusal(await paste(ada, { url: LINKEDIN, description: DESCRIPTION, title: "Engineer" })).error).toMatchObject({ code: "company_required", fieldErrors: [{ field: "company", problem: "required" }] })
    expect(await jobPostingRows()).toEqual([])
  })

  it("PD:211 PD:217 PD:227 names are cleaned, kept whole up to 200, and come only from what was typed", async () => {
    const title = `${"T".repeat(199)}x`
    const pasted = await pasteOk(ada, { description: DESCRIPTION, title: `  ${title}\u200b `, company: "Pay\u0007stack \n Ltd" }, 201)
    expect(pasted.posting.title).toBe(title)
    expect(pasted.posting.company).toBe("Pay stack Ltd")
  })

  it("PD:222 an over-long title or company is refused, never cut", async () => {
    const response = refusal(await paste(ada, { description: DESCRIPTION, title: "T".repeat(201), company: "C".repeat(201) }))
    expect(response.error).toMatchObject({ code: "job_title_too_long", fieldErrors: [{ field: "title", problem: "too_long" }, { field: "company", problem: "too_long" }] })
    expect(await jobPostingRows()).toEqual([])
  })

  it("PD:252 an over-long link with a description is a 400 as today", async () => {
    expect((await paste(ada, { url: `https://x.test/${"a".repeat(2048)}`, description: DESCRIPTION, ...named })).status).toBe(400)
  })
})

describe("Greenhouse, Lever and Ashby links with a description (PD-5.1, OQ-3, I-6)", () => {
  const readable = () =>
    http.get(GREENHOUSE_API, () =>
      HttpResponse.json({ id: 4019999, title: "Staff Frontend Engineer", absolute_url: GREENHOUSE, requisition_id: "4019999", company_name: "Acme", content: BODY_TEXT, first_published: "2026-10-30T10:00:00Z" })
    )
  const missing = () => http.get(GREENHOUSE_API, () => new HttpResponse(null, { status: 404 }))

  it("PD:284 RP:46 RP:88 a readable ATS link uses the employer's text; the description is discarded; names not needed", async () => {
    google.server.use(readable())
    const pasted = await pasteOk(ada, { url: GREENHOUSE, description: DESCRIPTION }, 201)
    expect(pasted).toMatchObject({ created: true, descriptionOutcome: "employer_page_used", posting: { origin: "pasted_link", applyMode: "automatic", title: "Staff Frontend Engineer" } })
    const rows = await jobPostingRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.posting_text).toContain(BODY_TEXT)
    expect(rows[0]!.posting_text).not.toContain("payments dashboard")
    expect(requests).toContain("boards-api.greenhouse.io")
  })

  it("RP:156 a held ATS posting with text keeps it; no lookup, 200 employer_page_used", async () => {
    google.server.use(readable())
    const first = await pasteOk(ada, { url: GREENHOUSE }, 201)
    requests.length = 0
    const again = await pasteOk(ada, { url: GREENHOUSE, description: DESCRIPTION, ...named }, 200)
    expect(again).toMatchObject({ created: false, descriptionOutcome: "employer_page_used", posting: { id: first.posting.id } })
    expect(requests).not.toContain("boards-api.greenhouse.io")
  })

  it("RP:96 a failed lookup falls back to the description, manual only: 201 stored_lookup_failed", async () => {
    google.server.use(missing())
    const pasted = await pasteOk(ada, { url: GREENHOUSE, description: DESCRIPTION, ...named }, 201)
    expect(pasted).toMatchObject({ descriptionOutcome: "stored_lookup_failed", posting: { origin: "pasted_description", applyMode: "manual", applicationUrl: GREENHOUSE, applicationSystem: "Greenhouse" } })
  })

  it("RP:113 a failed lookup with no names is employer_page_unreadable and stores nothing", async () => {
    google.server.use(missing())
    const response = refusal(await paste(ada, { url: GREENHOUSE, description: DESCRIPTION, title: "Engineer" }))
    expect(response).toMatchObject({ status: 422, error: { code: "employer_page_unreadable", message: PASTE_DESCRIPTION_ERROR_MESSAGES.employer_page_unreadable, fieldErrors: [{ field: "company", position: null, problem: "required" }] } })
    expect(await jobPostingRows()).toEqual([])
  })
})

describe("re-paste and duplicates (PD-5)", () => {
  it("RP:130 (a) a description attaches to a held link with no text: new id, old hold and shared row gone", async () => {
    const linkOnly = await pasteOk(ada, { url: LINKEDIN }, 201)
    const attached = await pasteOk(ada, { url: LINKEDIN, description: DESCRIPTION, ...named }, 200)
    expect(attached).toMatchObject({ created: false, descriptionOutcome: "attached", posting: { origin: "pasted_description" } })
    expect(attached.posting.id).not.toBe(linkOnly.posting.id)
    const rows = await jobPostingRows()
    expect(rows.map((row) => row.id)).toEqual([attached.posting.id])
  })

  it("RP:139 (a) a held ATS link whose lookup failed: attach with no ATS request", async () => {
    google.server.use(http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4019999", () => new HttpResponse(null, { status: 404 })))
    const linkOnly = await pasteOk(ada, { url: GREENHOUSE }, 201)
    await settle()
    await database.db.updateTable("candidate_posting").set({ status: "evaluation_failed" }).where("job_posting_id", "=", linkOnly.posting.id).execute()
    requests.length = 0
    const attached = await pasteOk(ada, { url: GREENHOUSE, description: DESCRIPTION, ...named }, 200)
    expect(attached.descriptionOutcome).toBe("attached")
    expect(requests).not.toContain("boards-api.greenhouse.io")
  })

  it("RP:148 (b) a new description replaces the private one in place and is checked again; 409 while checking", async () => {
    anthropic.replyByHanging()
    const first = await pasteOk(ada, { url: LINKEDIN, description: DESCRIPTION, ...named }, 201)
    expect(refusal(await paste(ada, { url: LINKEDIN, description: `${DESCRIPTION} v2`, ...named }))).toMatchObject({
      status: 409,
      error: { code: "posting_still_checking", message: PASTE_DESCRIPTION_ERROR_MESSAGES.posting_still_checking },
    })
    await releaseHanging()
    await settle()
    expect((await statusOf(database.db, database.operatorId, first.posting.id)).status).toBe("evaluation_failed")
    anthropic.replyWithObject(EXTRACTION)
    const replaced = await pasteOk(ada, { url: LINKEDIN, description: `${DESCRIPTION} v2`, title: "Lead Frontend Engineer", company: "Paystack" }, 200)
    expect(replaced).toMatchObject({ created: false, descriptionOutcome: "replaced", posting: { id: first.posting.id, title: "Lead Frontend Engineer", status: "checking" } })
    await settle()
    const row = await database.db.selectFrom("job_posting").select(["posting_text"]).where("id", "=", first.posting.id).executeTakeFirstOrThrow()
    expect(row.posting_text.endsWith("v2")).toBe(true)
  })

  it("RP:164 a known link sent again without a description is unchanged (C-LINK-2)", async () => {
    const first = await pasteOk(ada, { url: LINKEDIN, description: DESCRIPTION, ...named }, 201)
    await settle()
    const again = await pasteOk(ada, { url: LINKEDIN }, 200)
    expect(again).toMatchObject({ created: false, descriptionOutcome: null, posting: { id: first.posting.id } })
  })

  it("RP:182 MO:199 (c) a link with an Application changes nothing: 200 unchanged_has_application", async () => {
    const id = await decided("ranked", { url: LINKEDIN, description: DESCRIPTION, ...named })
    const created = await createApplication(ada, id)
    expect(created.status).toBe(201)
    const again = await pasteOk(ada, { url: LINKEDIN, description: `${DESCRIPTION} new`, ...named }, 200)
    expect(again).toMatchObject({ created: false, descriptionOutcome: "unchanged_has_application", applicationId: created.body.application.id, posting: { id } })
  })

  it("RP:205 RP:214 RP:221 RP:234 identical description-only pastes match (whitespace aside); any other change is new", async () => {
    const first = await pasteOk(ada, { description: DESCRIPTION, ...named }, 201)
    const spaced = await pasteOk(ada, { description: `  ${DESCRIPTION.replace(/ /g, "  \n")}  `, title: " Senior  Frontend Engineer ", company: "Paystack" }, 200)
    expect(spaced).toMatchObject({ created: false, descriptionOutcome: "already_pasted", posting: { id: first.posting.id } })
    expect((await pasteOk(ada, { description: DESCRIPTION, title: "senior frontend engineer", company: "Paystack" }, 201)).descriptionOutcome).toBe("stored")
    expect((await pasteOk(ada, { description: `${DESCRIPTION}.`, ...named }, 201)).descriptionOutcome).toBe("stored")
    // A linked paste with the same text is a different posting, and does not match the description-only one.
    expect((await pasteOk(ada, { url: LINKEDIN, description: DESCRIPTION, ...named }, 201)).descriptionOutcome).toBe("stored")
  })

  it("RP:240 EV:198 a description-only paste never matches another Candidate's; the same link gives each their own posting", async () => {
    const adas = await pasteOk(ada, { url: LINKEDIN, description: DESCRIPTION, ...named }, 201)
    const kofis = await pasteOk(kofi, { url: LINKEDIN, description: DESCRIPTION, ...named }, 201)
    expect(kofis.posting.id).not.toBe(adas.posting.id)
    expect((await pasteOk(kofi, { description: DESCRIPTION, ...named }, 201)).descriptionOutcome).toBe("stored")
  })

  it("RP:252 RP:260 concurrent identical pastes make one posting and one evaluation, and never a 5xx", async () => {
    const [a, b] = await Promise.all([paste(ada, { description: DESCRIPTION, ...named }), paste(ada, { description: DESCRIPTION, ...named })])
    expect([a.status, b.status].sort()).toEqual([200, 201])
    const outcomes = [a, b].map((response) => pasteJobLinkResponseSchema.parse(response.body).descriptionOutcome).sort()
    expect(outcomes).toEqual(["already_pasted", "stored"])
    const [c, d] = await Promise.all([paste(ada, { url: LINKEDIN, description: DESCRIPTION, ...named }), paste(ada, { url: LINKEDIN, description: DESCRIPTION, ...named })])
    expect([c.status, d.status].every((status) => status < 500)).toBe(true)
    await settle()
    expect((await jobPostingRows()).length).toBe(2)
    expect(anthropic.requests.length).toBeLessThanOrEqual(2)
  })
})

describe("evaluation, visibility and privacy (PD-2)", () => {
  it("EV:57 EV:81 EV:149 the existing evaluation runs; keywords land on the private row; never hidden though undated", async () => {
    anthropic.replyWithObject(EXTRACTION)
    const pasted = await pasteOk(ada, { description: DESCRIPTION, ...named }, 201)
    await settle()
    const status = await statusOf(database.db, database.operatorId, pasted.posting.id)
    expect(["ranked", "skipped", "excluded"]).toContain(status.status)
    // Eligibility and Match were recorded for the private row (no early preference exit).
    const evidence = await database.db.selectFrom("match_evidence").select(["covered_count"]).where("job_posting_id", "=", pasted.posting.id).execute()
    expect(evidence).toEqual([{ covered_count: 1 }])
    expect(anthropic.requests).toHaveLength(1)
    expect(FakeAnthropic.promptOf(anthropic.requests[0]!)).toContain("payments dashboard")
    const detail = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${pasted.posting.id}`).expect(200)).body)
    expect(detail).toMatchObject({ hiddenReason: null, postedAt: null, applyAnyway: null, pastedPrepareOffered: true, postingText: DESCRIPTION.replace(/\r\n?/g, "\n").trim() })
  })

  it("EV:57 a pasted description never stores forward statements (EPIC-0012 rule 4)", async () => {
    anthropic.replyWithObject({ ...EXTRACTION, forwardStatements: ["We ship a payments dashboard used across Africa."] })
    const pasted = await pasteOk(ada, { description: DESCRIPTION, ...named }, 201)
    await settle()
    const row = await database.db.selectFrom("job_posting").select("forward_statements").where("id", "=", pasted.posting.id).executeTakeFirstOrThrow()
    expect(row.forward_statements).toBeNull()
  })

  it("EV:207 EV:221 another Candidate gets 404 for the posting and its create", async () => {
    const pasted = await pasteOk(ada, { description: DESCRIPTION, ...named }, 201)
    expect((await kofi.get(`/v1/job-postings/${pasted.posting.id}`)).status).toBe(404)
    expect((await createApplication(kofi, pasted.posting.id)).status).toBe(404)
  })

  it("EV:214 another Candidate's link-only paste of the same link gets a shared row with no text", async () => {
    await pasteOk(ada, { url: LINKEDIN, description: DESCRIPTION, ...named }, 201)
    const kofis = await pasteOk(kofi, { url: LINKEDIN }, 201)
    expect(kofis.posting.origin).toBe("pasted_link")
    const row = await database.db.selectFrom("job_posting").select(["posting_text", "owner_candidate_id"]).where("id", "=", kofis.posting.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ posting_text: "", owner_candidate_id: null })
  })

  it("SAFE:152 during a cost pause the paste is saved waiting with waitingReason cost_pause and no model call", async () => {
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    const pasted = await pasteOk(ada, { description: DESCRIPTION, ...named }, 201)
    expect(pasted).toMatchObject({ waitingReason: "cost_pause", posting: { status: "waiting_to_be_checked" } })
    await settle()
    expect(anthropic.requests).toHaveLength(0)
  })

  it("SAFE:195 SAFE:205 an invitee's paste waits (checks_not_enabled) and cannot become an Application", async () => {
    const pasted = await pasteOk(kofi, { description: DESCRIPTION, ...named }, 201)
    expect(pasted).toMatchObject({ waitingReason: "checks_not_enabled", posting: { status: "waiting_to_be_checked" } })
    expect(refusal(await createApplication(kofi, pasted.posting.id))).toMatchObject({ status: 409, error: { code: "application_not_eligible" } })
  })
})

describe("Applications from pasted postings (PD-3, PD-4)", () => {
  it("DOC:25 MO:170 skipped and excluded pasted postings create with no override; marked pasted and manual only", async () => {
    for (const status of ["skipped", "excluded"] as const) {
      const id = await decided(status, { description: `${DESCRIPTION} ${status}`, ...named })
      const created = await createApplication(ada, id)
      expect(created.status).toBe(201)
      const application = applicationSummarySchema.parse(created.body.application)
      expect(application).toMatchObject({ pastedDescription: true, manualOnly: true, override: null, applicationUrl: null, requisitionId: `pasted:${id}`, state: "prepared" })
    }
    const list = (await ada.get("/v1/applications").expect(200)).body.applications as { pastedDescription: boolean; manualOnly: boolean }[]
    expect(list.every((row) => row.pastedDescription && row.manualOnly)).toBe(true)
  })

  it("DOC:44 creation is refused while checking", async () => {
    anthropic.replyByHanging()
    const pasted = await pasteOk(ada, { description: DESCRIPTION, ...named }, 201)
    expect(refusal(await createApplication(ada, pasted.posting.id))).toMatchObject({ status: 409, error: { code: "application_not_eligible" } })
    await releaseHanging()
  })

  it("DOC:65 an acknowledgement is refused override_not_allowed; DOC:202 MO:192 a second create returns the first", async () => {
    const id = await decided("skipped")
    const acknowledged = await ada.post("/v1/applications").send({ jobPostingId: id, acknowledgement: { confirmed: true, decision: { status: "skipped", skipReason: "weak_core_match", skipDetail: null, violatedRules: [] } } })
    expect(refusal(acknowledged)).toMatchObject({ status: 409, error: { code: "override_not_allowed" } })
    const first = await createApplication(ada, id)
    const second = await createApplication(ada, id)
    expect([first.status, second.status]).toEqual([201, 200])
    expect(second.body.application.id).toBe(first.body.application.id)
    const detail = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${id}`).expect(200)).body)
    expect(detail.pastedPrepareOffered).toBe(false)
  })

  it("MO:29 MO:46 MO:60 queue, sample, approval and the worker claim refuse a manual-only Application; nothing changes", async () => {
    const id = await decided("ranked")
    const created = await createApplication(ada, id)
    const applicationId = created.body.application.id as string
    await database.db.updateTable("application").set({ state: "documents_ready" }).where("id", "=", applicationId).execute()
    for (const path of ["queue", "sample"]) {
      expect(refusal(await ada.post(`/v1/applications/${applicationId}/${path}`).send({}))).toMatchObject({
        status: 409,
        error: { code: "manual_application_only", message: PASTE_DESCRIPTION_ERROR_MESSAGES.manual_application_only },
      })
    }
    await database.db.updateTable("application").set({ sample_state: "awaiting_review" }).where("id", "=", applicationId).execute()
    expect(refusal(await ada.post(`/v1/applications/${applicationId}/sample/approve`).send({})).error.code).toBe("manual_application_only")
    await database.db.updateTable("application").set({ sample_state: null, submission_state: "queued", submission_kind: "automatic" }).where("id", "=", applicationId).execute()
    const claimed = await CandidateScope.run(database.operatorId, () => app.get(SubmissionRepository).claim(applicationId, "automatic", "2026-11-02", clock.now()))
    expect(claimed).toEqual({ refused: "not_claimable" })
    const row = await database.db.selectFrom("application").select(["submission_state", "sample_state", "attempt_id"]).where("id", "=", applicationId).executeTakeFirstOrThrow()
    expect(row).toEqual({ submission_state: "queued", sample_state: null, attempt_id: null })
    expect(await database.db.selectFrom("submission_day").select("day").execute()).toEqual([])
  })

  it("MO:207 another Candidate cannot queue or sample it (the invitee hits the existing submission guard first); nothing changes", async () => {
    const id = await decided("ranked")
    const applicationId = (await createApplication(ada, id)).body.application.id as string
    for (const path of ["queue", "sample"]) {
      const response = refusal(await kofi.post(`/v1/applications/${applicationId}/${path}`).send({}))
      expect([404, 409]).toContain(response.status)
      expect(["not_found", "feature_not_yet_available"]).toContain(response.error.code)
    }
    expect(await database.db.selectFrom("application").select(["submission_state", "sample_state"]).where("id", "=", applicationId).executeTakeFirstOrThrow()).toEqual({ submission_state: null, sample_state: null })
  })

  it("MO:182 a pasted_link Application carries neither mark", async () => {
    google.server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4019999", () =>
        HttpResponse.json({ id: 4019999, title: "Senior Frontend Engineer", absolute_url: GREENHOUSE, requisition_id: "4019999", company_name: "Acme", content: BODY_TEXT, first_published: "2026-10-30T10:00:00Z" })
      )
    )
    const pasted = await pasteOk(ada, { url: GREENHOUSE }, 201)
    await settle()
    await database.db.updateTable("candidate_posting").set({ status: "ranked" }).where("job_posting_id", "=", pasted.posting.id).execute()
    const created = await createApplication(ada, pasted.posting.id)
    expect(created.status).toBe(201)
    expect(created.body.application).toMatchObject({ pastedDescription: false, manualOnly: false })
  })
})
