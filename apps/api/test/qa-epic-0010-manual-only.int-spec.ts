import { apiErrorResponseSchema, applicationDetailSchema, applicationsResponseSchema, createApplicationResponseSchema, documentsListResponseSchema, jobPostingDetailSchema, pasteJobLinkResponseSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  COMPANY,
  LINKS,
  PD_COPY,
  type PasteStack,
  STRONG_EXTRACTION,
  TITLE,
  atsStubs,
  decide,
  descPaystack,
  documentsReady,
  startPasteStack,
  submissionSnapshot,
} from "./support/qa-epic-0010.js"

/**
 * QA test authoring, step [5e], EPIC-0010. Application creation from a pasted
 * description and manual-only enforcement (contract v1.27.0 `POST /v1/applications`,
 * `ApplicationSummary.pastedDescription`/`manualOnly`, `JobPostingDetail.pastedPrepareOffered`,
 * queue/sample/sample-approve `409 manual_application_only`). Real api and Postgres.
 * Expected red until the integrated candidate lands.
 *
 * Covers: DOC:25, DOC:44, DOC:59 (api flag), DOC:65, DOC:202, EV:174, MO:29, MO:46,
 * MO:170, MO:182, MO:192, RP:63 (manualOnly false for a readable ATS posting),
 * RP:80, SAFE:205; threat-model.md C-17 (behaviour), C-18, C-19, C-21.
 * Not covered here (backend/worker internals, for the gate session): MO:60 claim,
 * pre-attempt and pre-click checks (C-20), MO:95/103/111 cap and Activation Gate counts.
 */
let s: PasteStack

beforeAll(async () => {
  s = await startPasteStack()
})

beforeEach(async () => {
  await s.reset()
  await s.database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-11-01T12:00:00Z"), automatic_enabled: true, existing_applications_completed_at: new Date() }).execute()
  await s.database.db.updateTable("candidate_contact").set({ full_name: "Ada Okafor", lines: JSON.stringify(["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"]) }).execute()
})

afterAll(async () => {
  await s?.stop()
})

function feedEvaluations(n = 8): void {
  for (let i = 0; i < n; i += 1) s.anthropic.replyWithObject(STRONG_EXTRACTION)
}

/** Ada's pasted-description posting (optionally with a link), set to `status` as an evaluation would leave it. */
async function pasted(
  status: Parameters<typeof decide>[3],
  options: Readonly<{ url?: string; marker?: string; skipReason?: string; violated?: readonly string[] }> = {}
): Promise<string> {
  feedEvaluations()
  const response = await s.paste(s.ada, { ...(options.url ? { url: options.url } : {}), description: descPaystack(options.marker ?? `QA-MO-${status}`), title: TITLE, company: COMPANY })
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  const id = pasteJobLinkResponseSchema.parse(response.body).posting.id
  await decide(s.database.db, s.database.operatorId, id, status, { skipReason: options.skipReason ?? null, violated: options.violated ?? [] })
  return id
}

const create = (jobPostingId: string, body: Record<string, unknown> = {}) => s.ada.post("/v1/applications").send({ jobPostingId, ...body })

const overrideColumns = async (applicationId: string) =>
  (await sql<{ override_created_at: Date | null; override_status: string | null }>`select override_created_at, override_status from application where id = ${applicationId}`.execute(s.database.db)).rows[0]

const DECISIONS = [
  ["ranked", { status: "ranked" as const }],
  ["skipped weak_core_match", { status: "skipped" as const, skipReason: "weak_core_match" }],
  ["skipped technology_mismatch", { status: "skipped" as const, skipReason: "technology_mismatch" }],
  ["skipped no_core_responsibilities", { status: "skipped" as const, skipReason: "no_core_responsibilities" }],
  ["excluded location", { status: "excluded" as const, violated: ["location"] }],
  ["excluded sponsorship, pay, hours", { status: "excluded" as const, violated: ["sponsorship", "pay", "hours"] }],
  ["excluded industry", { status: "excluded" as const, violated: ["industry"] }],
] as const

describe("PD-3.1 create from a finished pasted-description posting, any decision, no override", () => {
  it.each(DECISIONS)("DOC:25 %s: pastedPrepareOffered true; create with no acknowledgement → 201 prepared, override null, pasted and manual-only", async (_label, decision) => {
    const id = await pasted(decision.status, { skipReason: "skipReason" in decision ? decision.skipReason : undefined, violated: "violated" in decision ? decision.violated : [] })
    const shown = jobPostingDetailSchema.parse((await s.ada.get(`/v1/job-postings/${id}`).expect(200)).body)
    expect(shown).toMatchObject({ pastedPrepareOffered: true, applyAnyway: null, applyMode: "manual", origin: "pasted_description" })

    const response = await create(id)
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const created = createApplicationResponseSchema.parse(response.body)
    expect(created).toMatchObject({ created: true, application: { jobPostingId: id, state: "prepared", override: null, pastedDescription: true, manualOnly: true, applicationUrl: null } })
    expect(created.application.requisitionId).toBe(`pasted:${id}`)
    expect(await overrideColumns(created.application.id)).toEqual({ override_created_at: null, override_status: null })
    // Once it has an Application, the create action is no longer offered.
    expect(jobPostingDetailSchema.parse((await s.ada.get(`/v1/job-postings/${id}`).expect(200)).body).pastedPrepareOffered).toBe(false)
  })

  it.each(["checking", "waiting_to_be_checked", "not_checked", "evaluation_failed"] as const)("DOC:44 / DOC:59 / SAFE:205 status %s: pastedPrepareOffered false; create → 409 application_not_eligible with its message; nothing created", async (status) => {
    const id = await pasted(status)
    expect(jobPostingDetailSchema.parse((await s.ada.get(`/v1/job-postings/${id}`).expect(200)).body).pastedPrepareOffered).toBe(false)
    const response = await create(id)
    expect(response.status, JSON.stringify(response.body)).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "application_not_eligible", message: PD_COPY.notEligible })
    expect(await s.database.db.selectFrom("application").select("id").execute()).toEqual([])
  })

  it("DOC:65 / C-21 a create with an Apply anyway acknowledgement on a skipped pasted posting → 409 override_not_allowed; no Application, no override", async () => {
    const id = await pasted("skipped", { skipReason: "weak_core_match" })
    const response = await create(id, { acknowledgement: { confirmed: true, decision: { status: "skipped", skipReason: "weak_core_match", skipDetail: null, violatedRules: [] } } })
    expect(response.status, JSON.stringify(response.body)).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "override_not_allowed", message: PD_COPY.overrideNotAllowed })
    expect((await sql<{ n: number }>`select count(*)::int as n from application where override_created_at is not null or job_posting_id = ${id}`.execute(s.database.db)).rows[0]!.n).toBe(0)
  })

  it("DOC:202 / MO:192 two creates (one parallel pair, then a later one) give one Application: 201 then 200 created false, documents unchanged", async () => {
    const id = await pasted("ranked")
    const [a, b] = await Promise.all([create(id), create(id)])
    expect([a.status, b.status].sort()).toEqual([200, 201])
    const first = createApplicationResponseSchema.parse((a.status === 201 ? a : b).body)
    await documentsReady(s.database.db, s.database.operatorId, first.application.id)
    const documentsBefore = await s.database.db.selectFrom("tailored_document").selectAll().where("application_id", "=", first.application.id).orderBy("id").execute()
    const again = await create(id)
    expect(again.status).toBe(200)
    expect(createApplicationResponseSchema.parse(again.body)).toMatchObject({ created: false, application: { id: first.application.id } })
    expect(await s.database.db.selectFrom("application").select("id").where("job_posting_id", "=", id).execute()).toHaveLength(1)
    expect(await s.database.db.selectFrom("tailored_document").selectAll().where("application_id", "=", first.application.id).orderBy("id").execute()).toEqual(documentsBefore)
  })

  it("EV:174 an off-target, undated pasted posting is never refused as posting_hidden", async () => {
    feedEvaluations()
    const response = await s.paste(s.ada, { description: descPaystack("QA-EV174"), title: "Senior Data Engineer", company: COMPANY })
    const id = pasteJobLinkResponseSchema.parse(response.body).posting.id
    await decide(s.database.db, s.database.operatorId, id, "ranked")
    const created = await create(id)
    expect(created.status, JSON.stringify(created.body)).toBe(201)
  })
})

describe("PD-4.1 queue, sample and sample approval refuse a pasted-description Application (409 manual_application_only)", () => {
  const LINKED = [
    ["with no link", undefined, undefined],
    ["with a LinkedIn link", LINKS.linkedIn, undefined],
    ["with a Greenhouse link whose lookup failed", LINKS.greenhouseMissing, () => atsStubs.greenhouse404()],
    ["with a Lever link whose lookup failed", LINKS.leverMissing, () => atsStubs.leverNetworkFailure()],
    ["with an Ashby link whose lookup failed", LINKS.ashbyMissing, () => atsStubs.ashby500()],
  ] as const

  async function readyApplication(url?: string): Promise<string> {
    const id = await pasted("ranked", { url, marker: `QA-MO29-${url ?? "none"}` })
    const created = createApplicationResponseSchema.parse((await create(id).expect(201)).body)
    await documentsReady(s.database.db, s.database.operatorId, created.application.id)
    return created.application.id
  }

  it.each(LINKED)("MO:29 / C-18 a queue request for a ranked pasted Application %s → 409 manual_application_only; nothing written", async (_label, url, stub) => {
    if (stub) s.google.server.use(stub())
    const applicationId = await readyApplication(url)
    const before = await submissionSnapshot(s.database.db, s.database.operatorId)
    const response = await s.ada.post(`/v1/applications/${applicationId}/queue`).send({})
    expect(response.status, JSON.stringify(response.body)).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "manual_application_only", message: PD_COPY.manualOnly })
    expect(await submissionSnapshot(s.database.db, s.database.operatorId)).toEqual(before)
    const row = await s.database.db.selectFrom("application").select(["state", "submission_state"]).where("id", "=", applicationId).executeTakeFirstOrThrow()
    expect(row).toEqual({ state: "documents_ready", submission_state: null })
  })

  it.each(["sample", "sample/approve"])("MO:46 / C-18 gate not passed: a %s request → 409 manual_application_only; samples and counts unchanged", async (action) => {
    await s.database.db.updateTable("activation_state").set({ gate_passed_at: null, automatic_enabled: false }).execute()
    s.google.server.use(atsStubs.greenhouse404())
    const applicationId = await readyApplication(LINKS.greenhouseMissing)
    if (action === "sample/approve") {
      // Placed as an awaiting sample by any means: the approve check still refuses before any write.
      await s.database.db.updateTable("application").set({ submission_kind: "sample", sample_state: "awaiting_review" }).where("id", "=", applicationId).execute()
    }
    const before = await submissionSnapshot(s.database.db, s.database.operatorId)
    const response = await s.ada.post(`/v1/applications/${applicationId}/${action}`).send({})
    expect(response.status, JSON.stringify(response.body)).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "manual_application_only", message: PD_COPY.manualOnly })
    expect(await submissionSnapshot(s.database.db, s.database.operatorId)).toEqual(before)
  })

  it("C-19 the database refuses apply_mode 'automatic' on a pasted-description row (check violation)", async () => {
    const id = await pasted("ranked")
    await expect(sql`update job_posting set apply_mode = 'automatic' where id = ${id}`.execute(s.database.db)).rejects.toThrow(/check constraint|violates/i)
  })
})

describe("PD-4.4 marks: pastedDescription and manualOnly on every Application route", () => {
  it("MO:170 an excluded pasted Application is pasted and manual-only, never Override, in the list, detail and Documents rows", async () => {
    const id = await pasted("excluded", { violated: ["location"] })
    const created = createApplicationResponseSchema.parse((await create(id).expect(201)).body)
    await documentsReady(s.database.db, s.database.operatorId, created.application.id)
    const list = applicationsResponseSchema.parse((await s.ada.get("/v1/applications").expect(200)).body)
    expect(list.applications.find((row) => row.id === created.application.id)).toMatchObject({ pastedDescription: true, manualOnly: true, override: null })

    const shown = applicationDetailSchema.parse((await s.ada.get(`/v1/applications/${created.application.id}`).expect(200)).body)
    expect(shown).toMatchObject({ pastedDescription: true, manualOnly: true, override: null, applicationUrl: null })

    const documents = documentsListResponseSchema.parse((await s.ada.get("/v1/documents").expect(200)).body)
    expect(documents.rows.find((row) => row.applicationId === created.application.id)).toMatchObject({ pastedDescription: true })
  })

  it("MO:182 / RP:63 an Application from a readable Greenhouse posting pasted with a description: both marks false, applyMode automatic", async () => {
    feedEvaluations()
    s.google.server.use(atsStubs.greenhouseOk())
    const response = await s.paste(s.ada, { url: LINKS.greenhouse, description: descPaystack("QA-RP63"), title: "Frontend Lead", company: COMPANY })
    const posting = pasteJobLinkResponseSchema.parse(response.body)
    expect(posting).toMatchObject({ descriptionOutcome: "employer_page_used", posting: { origin: "pasted_link" } })
    await decide(s.database.db, s.database.operatorId, posting.posting.id, "ranked")
    const created = createApplicationResponseSchema.parse((await create(posting.posting.id).expect(201)).body)
    expect(created.application).toMatchObject({ pastedDescription: false, manualOnly: false })
    expect(jobPostingDetailSchema.parse((await s.ada.get(`/v1/job-postings/${posting.posting.id}`).expect(200)).body).pastedPrepareOffered).toBe(false)
  })

  it("RP:80 a readable Greenhouse posting excluded for location follows the Apply anyway bounds: acknowledgement → 409 override_not_allowed", async () => {
    feedEvaluations()
    s.google.server.use(atsStubs.greenhouseOk("4012346"))
    const posting = pasteJobLinkResponseSchema.parse((await s.paste(s.ada, { url: LINKS.greenhouseExcluded, description: descPaystack("QA-RP80"), title: TITLE, company: "Acme" })).body)
    await decide(s.database.db, s.database.operatorId, posting.posting.id, "excluded", { violated: ["location"] })
    const response = await create(posting.posting.id, { acknowledgement: { confirmed: true, decision: { status: "excluded", skipReason: "violated_rule", skipDetail: "location", violatedRules: ["location"] } } })
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("override_not_allowed")
    expect(await s.database.db.selectFrom("application").select("id").execute()).toEqual([])
  })
})
