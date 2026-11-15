import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { type ExtensionFillRequest, extensionFillResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { Browser } from "./support/browser.js"
import { insertEligibilityFor, insertPostingFor } from "./support/candidate-posting.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * ADR 0016 slice 1: `POST /v1/extension/fill` against real Postgres and the
 * real api app. The extension's page reader is simulated by the request body;
 * nothing reaches a network host, and the endpoint writes nothing.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
const clock = new TestClock("2026-10-20T09:00:00.000Z")
/** Each test lands in its own 60-second fill window: the in-process throttle is per read-only Candidate. */
let testIndex = 0
const APPLY_HOST = "boards.greenhouse.io"
const FILL = "/v1/extension/fill"

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

beforeEach(async () => {
  testIndex += 1
  clock.set(new Date(Date.parse("2026-10-20T09:00:00.000Z") + testIndex * 61_000).toISOString())
  for (const table of ["application", "candidate_posting", "job_posting", "eligibility_result", "approved_answer", "submission_event"] as const) {
    await database.db.deleteFrom(table).execute()
  }
  await database.db.updateTable("candidate_contact").set({ full_name: "Ada Okafor", lines: JSON.stringify(["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"]) }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

/** A documents-ready Application whose stored URL is the employer's form. */
async function readyApplication(owner: string, options: { company?: string; url?: string } = {}) {
  const postingId = randomUUID()
  const requisition = `R-${randomUUID().slice(0, 6)}`
  const company = options.company ?? "Acme Payments"
  const url = options.url ?? `https://${APPLY_HOST}/${company.toLowerCase().replace(/\W+/g, "")}/jobs/${requisition}`
  await insertPostingFor(database.db, owner, {
    id: postingId,
    application_url: url,
    requisition_id: requisition,
    apply_url: url,
    application_system: "greenhouse",
    apply_mode: "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title: "Senior Frontend Engineer",
    company,
    posting_text: "Remote, open to candidates in Nigeria.",
    status: "ranked",
    skip_reason: null,
    skip_detail: null,
    evaluation_failure: null,
    role_family: "senior_frontend",
    discovered_at: new Date("2026-10-19T09:00:00.000Z"),
    evaluated_at: new Date("2026-10-19T09:00:00.000Z"),
  })
  await insertEligibilityFor(database.db, owner, postingId)
  const id = randomUUID()
  await database.db
    .insertInto("application")
    .values({
      candidate_id: owner,
      id,
      job_posting_id: postingId,
      application_url: url,
      requisition_id: requisition,
      company,
      role_title: "Senior Frontend Engineer",
      state: "documents_ready",
      career_profile_version: 1,
      blocked_document: null,
      blocked_claim: null,
      failure: null,
      created_at: new Date("2026-10-19T09:00:00.000Z"),
      updated_at: new Date("2026-10-19T09:00:00.000Z"),
    })
    .execute()
  return { id, url, company }
}

const row = (id: string) => database.db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow()

/** The contact fields the answer rules fill from settings alone. */
const CONTACT_FIELDS: ExtensionFillRequest["fields"] = [
  { ref: "f0", label: "First name", kind: "text", required: true },
  { ref: "f1", label: "Email", kind: "text", required: true },
  { ref: "f2", label: "Location", kind: "text", required: true },
  // A document answer is named in `documents`, never in `values`.
  { ref: "f3", label: "Resume", kind: "file", required: true },
]

const fill = (body: ExtensionFillRequest) => candidate.post(FILL).send(body)

describe("POST /v1/extension/fill: the Candidate's own Application", () => {
  it("returns the planned values and names the document to attach, never its bytes", async () => {
    const application = await readyApplication(database.operatorId)
    const response = await fill({ url: application.url, fields: CONTACT_FIELDS }).expect(200)
    const body = extensionFillResponseSchema.parse(response.body)
    expect(body.application).toEqual({ id: application.id, company: "Acme Payments", roleTitle: "Senior Frontend Engineer" })
    expect(body.values).toEqual([
      { ref: "f0", value: "Ada", kind: "text" },
      { ref: "f1", value: "ada@example.com", kind: "text" },
      { ref: "f2", value: "Lagos, Nigeria", kind: "text" },
    ])
    // A document answer is named for attachment, not typed as a value, and carries no page label.
    expect(body.documents).toEqual([{ ref: "f3", document: "resume" }])
    // A resume-only form asks for no cover letter, so none is planned.
    expect(body.documents.map((document) => document.document)).toEqual(["resume"])
    expect(body.values.some((value) => value.kind === "file")).toBe(false)
    expect(body.values.map((value) => value.ref)).not.toContain("f3")
    expect(JSON.stringify(body)).not.toContain("base64")
    expect(body.unanswered).toEqual([])
    expect(response.headers["cache-control"]).toBe("no-store")
  })

  it("returns both documents and skips Ashby's autofill uploader", async () => {
    const application = await readyApplication(database.operatorId)
    const fields: ExtensionFillRequest["fields"] = [
      { ref: "f0", label: "First name", kind: "text", required: true },
      { ref: "f1", label: "Resume", kind: "file", required: true },
      { ref: "f2", label: "Cover Letter", kind: "file", required: true },
      { ref: "f3", label: "Autofill from resume", kind: "file", required: false },
    ]
    const body = extensionFillResponseSchema.parse((await fill({ url: application.url, fields }).expect(200)).body)
    expect(body.values).toEqual([{ ref: "f0", value: "Ada", kind: "text" }])
    expect(body.documents).toEqual([
      { ref: "f1", document: "resume" },
      { ref: "f2", document: "cover_letter" },
    ])
    expect(body.documents.map((document) => document.ref)).not.toContain("f3")
    expect(body.unanswered).toEqual([])
  })

  it("matches host and path when the page adds a trailing slash, a query and a fragment", async () => {
    const application = await readyApplication(database.operatorId)
    const page = `${application.url}/?utm_source=linkedin#apply`
    const body = extensionFillResponseSchema.parse((await fill({ url: page, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body.application?.id).toBe(application.id)
    expect(body.values).toHaveLength(3)
  })

  it("answers application null for a page no owned Application has", async () => {
    await readyApplication(database.operatorId)
    const body = extensionFillResponseSchema.parse((await fill({ url: `https://${APPLY_HOST}/someone-else/jobs/xyz`, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body).toEqual({ application: null, values: [], documents: [], unanswered: [] })
  })

  it("never matches another Candidate's Application URL", async () => {
    const otherId = await insertSecondCandidate(database.db)
    const foreign = await readyApplication(otherId, { company: "Other Co" })
    const body = extensionFillResponseSchema.parse((await fill({ url: foreign.url, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body).toEqual({ application: null, values: [], documents: [], unanswered: [] })
  })

  it("answers null for an Application that can no longer be applied to", async () => {
    const application = await readyApplication(database.operatorId)
    for (const submission_state of ["manual", "declined", "not_submitted", "uncertain", "confirmed"] as const) {
      await database.db.updateTable("application").set({ submission_state }).where("id", "=", application.id).execute()
      const before = await row(application.id)
      const body = extensionFillResponseSchema.parse((await fill({ url: application.url, fields: CONTACT_FIELDS }).expect(200)).body)
      expect(body).toEqual({ application: null, values: [], documents: [], unanswered: [] })
      expect(await row(application.id)).toEqual(before)
    }
  })

  it("matches a blocked Application: the Candidate is applying by hand", async () => {
    const application = await readyApplication(database.operatorId)
    await database.db.updateTable("application").set({ submission_state: "blocked", blocked_reason: "automation_incomplete" }).where("id", "=", application.id).execute()
    const body = extensionFillResponseSchema.parse((await fill({ url: application.url, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body.application).toEqual({ id: application.id, company: "Acme Payments", roleTitle: "Senior Frontend Engineer" })
    expect(body.values).toHaveLength(3)
  })

  it("answers null for a queued Application: the worker could submit it while the Candidate fills it", async () => {
    const application = await readyApplication(database.operatorId)
    await database.db.updateTable("application").set({ submission_state: "queued" }).where("id", "=", application.id).execute()
    const body = extensionFillResponseSchema.parse((await fill({ url: application.url, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body).toEqual({ application: null, values: [], documents: [], unanswered: [] })
  })

  it("does not bind two jobs that share a careers page and differ only in gh_jid", async () => {
    const application = await readyApplication(database.operatorId, { url: "https://jobs.example.com/careers?gh_jid=111" })
    const same = extensionFillResponseSchema.parse((await fill({ url: "https://jobs.example.com/careers?gh_jid=111", fields: CONTACT_FIELDS }).expect(200)).body)
    expect(same.application?.id).toBe(application.id)
    const other = extensionFillResponseSchema.parse((await fill({ url: "https://jobs.example.com/careers?gh_jid=222", fields: CONTACT_FIELDS }).expect(200)).body)
    expect(other).toEqual({ application: null, values: [], documents: [], unanswered: [] })
  })

  it("does not fill a page served over plain http", async () => {
    const application = await readyApplication(database.operatorId, { url: "http://insecure.example/jobs/1" })
    const body = extensionFillResponseSchema.parse((await fill({ url: application.url, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body).toEqual({ application: null, values: [], documents: [], unanswered: [] })
  })

  it("answers null for an Application that is not documents_ready", async () => {
    const application = await readyApplication(database.operatorId)
    for (const state of ["prepared", "generating", "documents_blocked", "documents_failed"] as const) {
      await database.db
        .updateTable("application")
        .set({ state, blocked_document: state === "documents_blocked" ? "resume" : null })
        .where("id", "=", application.id)
        .execute()
      const body = extensionFillResponseSchema.parse((await fill({ url: application.url, fields: CONTACT_FIELDS }).expect(200)).body)
      expect(body).toEqual({ application: null, values: [], documents: [], unanswered: [] })
    }
  })

  it("does not match the same host and path served on a different port", async () => {
    await readyApplication(database.operatorId, { url: "https://employer.example/jobs/7001" })
    const body = extensionFillResponseSchema.parse((await fill({ url: "https://employer.example:8443/jobs/7001", fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body).toEqual({ application: null, values: [], documents: [], unanswered: [] })
  })

  it("does not fall back to a stored URL that carries a query when the page has none", async () => {
    await readyApplication(database.operatorId, { url: "https://employer.example/jobs/7002?team=alpha" })
    const body = extensionFillResponseSchema.parse((await fill({ url: "https://employer.example/jobs/7002", fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body).toEqual({ application: null, values: [], documents: [], unanswered: [] })
  })

  it("returns the partial values and the required question it cannot answer, without guessing", async () => {
    const application = await readyApplication(database.operatorId)
    const fields: ExtensionFillRequest["fields"] = [
      { ref: "f0", label: "First name", kind: "text", required: true },
      { ref: "f1", label: "What is your favourite colour?", kind: "text", required: true },
    ]
    const body = extensionFillResponseSchema.parse((await fill({ url: application.url, fields }).expect(200)).body)
    expect(body.values).toEqual([{ ref: "f0", value: "Ada", kind: "text" }])
    expect(body.unanswered).toEqual([
      { ref: "f1", label: "What is your favourite colour?", detail: 'The form asks "What is your favourite colour?" and you have no Approved Answer for it. Nothing was guessed.' },
    ])
  })

  it("keeps going after a hard block: every later field is filled or listed with its reason", async () => {
    const application = await readyApplication(database.operatorId)
    const fields: ExtensionFillRequest["fields"] = [
      { ref: "f0", label: "First name", kind: "text", required: true },
      { ref: "f1", label: "I certify that the information above is true", kind: "checkbox", required: true },
      { ref: "f2", label: "Email", kind: "text", required: true },
      { ref: "f3", label: "What is your favourite colour?", kind: "text", required: true },
      { ref: "f4", label: "Resume", kind: "file", required: true },
    ]
    const body = extensionFillResponseSchema.parse((await fill({ url: application.url, fields }).expect(200)).body)
    expect(body.values).toEqual([
      { ref: "f0", value: "Ada", kind: "text" },
      { ref: "f2", value: "ada@example.com", kind: "text" },
    ])
    expect(body.documents).toEqual([{ ref: "f4", document: "resume" }])
    expect(body.unanswered.map((field) => field.ref)).toEqual(["f1", "f3"])
    expect(body.unanswered[0]?.detail).toContain("declaration")
    expect(body.unanswered[1]?.detail).toContain("favourite colour")
  })

  it("matches a Lever application page that adds /apply", async () => {
    const jobId = randomUUID()
    const application = await readyApplication(database.operatorId, { url: `https://jobs.lever.co/acme/${jobId}` })
    const body = extensionFillResponseSchema.parse((await fill({ url: `https://jobs.lever.co/acme/${jobId}/apply`, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body.application?.id).toBe(application.id)
    expect(body.values).toHaveLength(3)
  })

  it("matches an Ashby application page that adds /application", async () => {
    const jobId = randomUUID()
    const application = await readyApplication(database.operatorId, { url: `https://jobs.ashbyhq.com/acme/${jobId}` })
    const body = extensionFillResponseSchema.parse((await fill({ url: `https://jobs.ashbyhq.com/acme/${jobId}/application`, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body.application?.id).toBe(application.id)
  })

  it("matches a Greenhouse board that moved from boards to job-boards", async () => {
    const jobId = String(Math.floor(Math.random() * 1_000_000_000))
    const application = await readyApplication(database.operatorId, { url: `https://boards.greenhouse.io/acme/jobs/${jobId}` })
    const body = extensionFillResponseSchema.parse((await fill({ url: `https://job-boards.greenhouse.io/acme/jobs/${jobId}`, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body.application?.id).toBe(application.id)
  })

  it("lets an exact query win over another Application on the same host and path", async () => {
    const page = "https://boards.greenhouse.io/acme/jobs/4242"
    await readyApplication(database.operatorId, { url: `${page}?team=alpha`, company: "Alpha Co" })
    const beta = await readyApplication(database.operatorId, { url: `${page}?team=beta`, company: "Beta Co" })
    const body = extensionFillResponseSchema.parse((await fill({ url: `${page}?team=beta`, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body.application?.id).toBe(beta.id)
    expect(body.application?.company).toBe("Beta Co")
  })

  it("answers null when two Applications share one host and path with no query to tell them apart", async () => {
    const page = "https://boards.greenhouse.io/acme/jobs/4343"
    await readyApplication(database.operatorId, { url: page, company: "First Co" })
    await readyApplication(database.operatorId, { url: page, company: "Second Co" })
    const body = extensionFillResponseSchema.parse((await fill({ url: page, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body).toEqual({ application: null, values: [], documents: [], unanswered: [] })
  })

  it("never matches an Application whose details were deleted", async () => {
    const application = await readyApplication(database.operatorId)
    await database.db.updateTable("application").set({ details_deleted_at: new Date("2026-10-20T09:00:00.000Z"), final_status: "not_submitted" }).where("id", "=", application.id).execute()
    const body = extensionFillResponseSchema.parse((await fill({ url: application.url, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body).toEqual({ application: null, values: [], documents: [], unanswered: [] })
  })

  it("answers null for a non-http page URL", async () => {
    await readyApplication(database.operatorId)
    const body = extensionFillResponseSchema.parse((await fill({ url: "javascript:alert(1)", fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body).toEqual({ application: null, values: [], documents: [], unanswered: [] })
  })

  it("writes nothing: the Application row, its state and its updated_at are byte-equal after the call", async () => {
    const application = await readyApplication(database.operatorId)
    const before = await row(application.id)
    await fill({ url: application.url, fields: CONTACT_FIELDS }).expect(200)
    expect(await row(application.id)).toEqual(before)
    expect(await database.db.selectFrom("submission_event").selectAll().where("application_id", "=", application.id).execute()).toEqual([])
  })

  it("refuses signed-out callers with 401 unauthenticated", async () => {
    const application = await readyApplication(database.operatorId)
    const response = await browser.http().post(FILL).send({ url: application.url, fields: CONTACT_FIELDS }).expect(401)
    expect(response.body.error.code).toBe("unauthenticated")
  })

  it("lets a draft Candidate fill their own form: the route has no ConvertedFeature gate", async () => {
    const sub = `draft-${randomUUID()}`
    const email = `draft-${randomUUID()}@example.test`
    const draftId = (await database.db.insertInto("candidate").values({ email, google_sub: sub, role: "candidate" }).returning("id").executeTakeFirstOrThrow()).id
    await database.db.insertInto("candidate_contact").values({ candidate_id: draftId, full_name: "Ada Okafor", lines: JSON.stringify(["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"]) }).execute()
    const application = await readyApplication(draftId, { company: "Draft Co" })
    const { sessionCookie } = await browser.signIn({ sub, email, email_verified: true })
    const csrfToken = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
    const draft = new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrfToken, email)
    const body = extensionFillResponseSchema.parse((await draft.post(FILL).send({ url: application.url, fields: CONTACT_FIELDS }).expect(200)).body)
    expect(body.application).toEqual({ id: application.id, company: "Draft Co", roleTitle: "Senior Frontend Engineer" })
    expect(body.values).toHaveLength(3)
  })

  it("refuses two fields with the same ref with 400 bad_request", async () => {
    const application = await readyApplication(database.operatorId)
    const fields: ExtensionFillRequest["fields"] = [
      { ref: "f0", label: "First name", kind: "text", required: true },
      { ref: "f0", label: "Email", kind: "text", required: true },
    ]
    const response = await fill({ url: application.url, fields }).expect(400)
    expect(response.body.error.code).toBe("bad_request")
  })

  it("refuses 201 fields with 400 bad_request", async () => {
    const application = await readyApplication(database.operatorId)
    const fields = Array.from({ length: 201 }, (_value, index): ExtensionFillRequest["fields"][number] => ({ ref: `f${index}`, label: `Question ${index}`, kind: "text", required: false }))
    const response = await fill({ url: application.url, fields }).expect(400)
    expect(response.body.error.code).toBe("bad_request")
  })

  it("refuses a request with no CSRF token with 403 csrf_invalid", async () => {
    const application = await readyApplication(database.operatorId)
    const response = await browser
      .http()
      .post(FILL)
      .set("cookie", candidate.cookie)
      .send({ url: application.url, fields: CONTACT_FIELDS })
      .expect(403)
    expect(response.body.error.code).toBe("csrf_invalid")
  })
})
