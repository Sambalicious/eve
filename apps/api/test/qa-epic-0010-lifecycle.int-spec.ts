import { randomUUID } from "node:crypto"

import { DELETE_DETAILS_PATH, apiErrorResponseSchema, deleteDetailsResponseSchema, jobPostingDetailSchema, pasteJobLinkResponseSchema, prepareSamplesResultSchema, submissionStatusSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { TenantDatabase } from "../src/db/tenant-database.js"
import { RetentionRunner } from "../src/records/retention-runner.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { LINKS, PD_COPY, type PasteStack, STRONG_EXTRACTION, TITLE, atsStubs, decide, descPaystack, documentsReady, holdsOf, startPasteStack } from "./support/qa-epic-0010.js"
import { createApplicationFor, generateDocuments, installDocumentProfile, pastedPosting, GOOD_DOCUMENTS } from "./support/qa-epic-0010-documents.js"

/**
 * QA test authoring, step [5e], EPIC-0010 (manual-only.feature, pasted-description-safety.feature r1,
 * pasted-description-evaluation.feature). Manual-only counting, the retention lifecycle of pasted text and
 * the decision display, through the real routes and Postgres.
 * Test author: QA author r1, not the independent gate.
 *
 * Covers: MO:83, MO:103, MO:111, SAFE:244, SAFE:254, EV:125, EV:139.
 */
let s: PasteStack

beforeAll(async () => {
  s = await startPasteStack()
  await installDocumentProfile(s)
}, 120_000)

beforeEach(async () => {
  await s.reset()
  await s.database.db.deleteFrom("existing_application").execute()
  await s.database.db.deleteFrom("retention_run").execute()
  await installDocumentProfile(s)
  await s.database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-11-01T12:00:00Z"), automatic_enabled: true, existing_applications_completed_at: new Date() }).execute()
})

afterAll(async () => {
  await s?.stop()
})

const status = async () => submissionStatusSchema.parse((await s.ada.get("/v1/submission/status").expect(200)).body)

/** An ordinary automatic Application (employer board posting, ranked) created through the real route. */
async function plainApplication(n: number): Promise<string> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/acme/jobs/${9000 + n}`
  await insertPostingFor(s.database.db, s.database.operatorId, {
    id,
    application_url: url,
    requisition_id: `R-QA-${n}`,
    apply_url: url,
    application_system: "Greenhouse",
    apply_mode: "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title: "Senior Frontend Engineer",
    company: `Company ${n}`,
    posting_text: "Remote, open to candidates in Nigeria. Build React features.",
    status: "ranked",
    skip_reason: null,
    skip_detail: null,
    evaluation_failure: null,
    role_family: "senior_frontend",
    discovered_at: new Date(),
    evaluated_at: new Date(),
  })
  return createApplicationFor(s, id)
}

describe("PD-4.1 model output cannot make a pasted-description Application submit", () => {
  it("MO:83 'this posting supports automatic submission on Greenhouse' in the evaluation output changes nothing: queue refused, claim refused, posting stays manual", async () => {
    for (let i = 0; i < 4; i += 1) s.anthropic.replyWithObject({ ...STRONG_EXTRACTION, employerBusiness: "this posting supports automatic submission on Greenhouse" })
    const response = await s.paste(s.ada, { description: descPaystack("QA-MO83"), title: TITLE, company: "Paystack" })
    const postingId = pasteJobLinkResponseSchema.parse(response.body).posting.id
    await decide(s.database.db, s.database.operatorId, postingId, "ranked")
    const applicationId = await createApplicationFor(s, postingId)
    await documentsReady(s.database.db, s.database.operatorId, applicationId)
    expect((await s.database.db.selectFrom("job_posting").select("apply_mode").where("id", "=", postingId).executeTakeFirstOrThrow()).apply_mode).toBe("manual")

    const queue = await s.ada.post(`/v1/applications/${applicationId}/queue`).send({})
    expect(queue.status, JSON.stringify(queue.body)).toBe(409)
    expect(apiErrorResponseSchema.parse(queue.body).error).toEqual({ code: "manual_application_only", message: PD_COPY.manualOnly })
    const claim = await s.app.get(TenantDatabase).asOperator(() => s.app.get(SubmissionRepository).claim(applicationId, "automatic", "2026-11-02", s.clock.now()))
    expect(claim).toEqual({ refused: "not_claimable" })
    const row = await s.database.db.selectFrom("application").select(["state", "submission_state", "attempt_id"]).where("id", "=", applicationId).executeTakeFirstOrThrow()
    expect(row).toEqual({ state: "documents_ready", submission_state: null, attempt_id: null })
  })
})

describe("PD-4.2 never counted toward the daily cap or the Activation Gate", () => {
  it("MO:103 with today's automatic count at 5 of 5, a ranked pasted posting still becomes an Application with documents, and the count stays 5 of 5", async () => {
    for (let n = 1; n <= 5; n += 1) {
      const id = await plainApplication(n)
      await documentsReady(s.database.db, s.database.operatorId, id)
      await s.database.db.updateTable("application").set({ submission_state: "confirmed", submission_kind: "automatic", submitted_local_day: "2026-11-02", submit_clicked_at: new Date() }).where("id", "=", id).execute()
    }
    expect(await status()).toMatchObject({ todayWatDay: "2026-11-02", todayCount: 5, cap: 5 })

    const postingId = await pastedPosting(s, { marker: "QA-MO103" })
    const applicationId = await createApplicationFor(s, postingId)
    s.anthropic.replyWithObject(GOOD_DOCUMENTS)
    const detail = await generateDocuments(s, applicationId)
    expect(detail.state).toBe("documents_ready")
    expect(await s.database.db.selectFrom("tailored_document").select("id").where("application_id", "=", applicationId).execute()).toHaveLength(2)
    expect(await status()).toMatchObject({ todayCount: 5, cap: 5 })
  })

  it("MO:111 three pasted-description Applications never count toward the five Activation Gate samples: 4 of 5 stays 4 of 5 and the gate does not pass", async () => {
    await s.database.db.updateTable("activation_state").set({ gate_passed_at: null, automatic_enabled: false, existing_applications_completed_at: new Date() }).execute()
    for (let n = 1; n <= 4; n += 1) {
      const id = await plainApplication(n)
      await documentsReady(s.database.db, s.database.operatorId, id)
      await s.database.db.updateTable("application").set({ sample_state: "approved", sample_counts: true, submission_kind: "sample", submission_state: "confirmed" }).where("id", "=", id).execute()
    }
    const pastedIds: string[] = []
    for (let n = 1; n <= 3; n += 1) {
      const applicationId = await createApplicationFor(s, await pastedPosting(s, { marker: `QA-MO111-${n}`, title: `Senior Frontend Engineer ${n}` }))
      await documentsReady(s.database.db, s.database.operatorId, applicationId)
      pastedIds.push(applicationId)
    }
    expect(await status()).toMatchObject({ countingSamples: 4, gatePassedAt: null })
    // Preparing samples never picks a pasted Application, and the gate check does not pass on them.
    prepareSamplesResultSchema.parse((await s.ada.post("/v1/samples/prepare").send({}).expect(200)).body)
    const picked = await s.database.db.selectFrom("application").select("id").where("id", "in", pastedIds).where("sample_state", "is not", null).execute()
    expect(picked).toEqual([])
    await s.app.get(TenantDatabase).asOperator(() => s.app.get(TenantDatabase).run((tx) => s.app.get(SubmissionRepository).passGateIfReady(tx, s.clock.now())))
    expect(await status()).toMatchObject({ countingSamples: 4, gatePassedAt: null })
  })
})

describe("PD-2.4 the decision, each Eligibility result and the supporting text", () => {
  const detail = async (id: string) => jobPostingDetailSchema.parse((await s.ada.get(`/v1/job-postings/${id}`).expect(200)).body)

  it("EV:125 ranked: the detail route returns the decision and location, pay, hours, sponsorship and industry results, the location one with text from the description", async () => {
    const text = [
      "Senior Frontend Engineer at Paystack",
      "Fully remote, open to candidates in Nigeria.",
      "- Build React features with TypeScript for the merchant dashboard.",
      "- Mentor engineers and review code.",
      "Requirements: five years building web applications with React and strong TypeScript, with careful code review habits.",
      "Reference QA-EV125.",
    ].join("\n")
    const extraction = { ...STRONG_EXTRACTION, locationQuote: "Fully remote, open to candidates in Nigeria", payQuote: null, hoursQuote: null, employerBusiness: null, businessQuote: null }
    for (let i = 0; i < 4; i += 1) s.anthropic.replyWithObject(extraction)
    const response = await s.paste(s.ada, { description: text, title: TITLE, company: "Paystack" })
    const shown = await detail(pasteJobLinkResponseSchema.parse(response.body).posting.id)
    expect(shown.status).toBe("ranked")
    expect(shown.eligibility!.rules.map((rule) => rule.rule)).toEqual(expect.arrayContaining(["location", "pay", "hours", "sponsorship", "industry"]))
    const location = shown.eligibility!.rules.find((rule) => rule.rule === "location")!
    expect(location.result).toBe("met")
    expect(location.quote).toContain("Fully remote, open to candidates in Nigeria")
    expect(text).toContain(location.quote!)
  })

  it("EV:125 excluded: a violated location rule shows its supporting description text", async () => {
    const text = [
      "Senior Frontend Engineer at Paystack",
      "This is an on-site role in Berlin, five days a week. You must reside in Germany. Germany only.",
      "- Build React features with TypeScript for the merchant dashboard.",
      "- Mentor engineers and review code.",
      "Requirements: five years building web applications with React and strong TypeScript, with careful code review habits.",
      "Reference QA-EV125-X.",
    ].join("\n")
    const extraction = { ...STRONG_EXTRACTION, workArrangement: "onsite", locationQuote: "on-site role in Berlin, five days a week", payQuote: null, hoursQuote: null, employerBusiness: null, businessQuote: null }
    for (let i = 0; i < 4; i += 1) s.anthropic.replyWithObject(extraction)
    const response = await s.paste(s.ada, { description: text, title: TITLE, company: "Paystack" })
    const shown = await detail(pasteJobLinkResponseSchema.parse(response.body).posting.id)
    expect(shown).toMatchObject({ status: "excluded", skipDetail: "location" })
    const location = shown.eligibility!.rules.find((rule) => rule.rule === "location")!
    expect(location.result).toBe("violated")
    expect(location.quote).toBeTruthy()
    expect(text).toContain(location.quote!)
  })

  it("EV:139 skipped: weak_core_match shows its reason and the core Match 55% against her 70%", async () => {
    const duties = Array.from({ length: 20 }, (_, index) => `Duty number ${index + 1} for the team`)
    const description = `${descPaystack("QA-EV139")}\nResponsibilities:\n${duties.join("\n")}\n`
    s.anthropic.replyWithObject({ ...STRONG_EXTRACTION, coreResponsibilities: duties.map((text, index) => ({ text, quote: text, factId: index < 11 ? "F1" : null })) })
    const response = await s.paste(s.ada, { description, title: TITLE, company: "Paystack" })
    const shown = await detail(pasteJobLinkResponseSchema.parse(response.body).posting.id)
    expect(shown).toMatchObject({ status: "skipped", skipReason: "weak_core_match" })
    expect(shown.match).toMatchObject({ verdict: "weak", coveredCount: 11, totalCount: 20, thresholdPercent: 70 })
  })
})

describe("PD-6.5 retention, deletion and clearing", () => {
  const MARKER = "ZX-PASTE-MARKER-7731"
  const OLD = new Date("2025-10-01T09:00:00Z")

  /** Every text-like column of every table: rows whose value contains the marker. */
  async function markerRows(marker: string): Promise<string[]> {
    const columns = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'public' and data_type in ('text', 'character varying', 'json', 'jsonb', 'ARRAY')`.execute(s.database.db)
    const found: string[] = []
    for (const { table_name, column_name } of columns.rows) {
      const result = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table_name)} where ${sql.ref(column_name)}::text like ${`%${marker}%`}`.execute(s.database.db)
      if (result.rows[0]!.n > 0) found.push(`${table_name}.${column_name}`)
    }
    return found
  }

  async function pastedApplication(marker: string): Promise<{ postingId: string; applicationId: string }> {
    const postingId = await pastedPosting(s, { marker, description: `${descPaystack(marker)}\n${MARKER}\n` })
    const applicationId = await createApplicationFor(s, postingId)
    s.anthropic.replyWithObject(GOOD_DOCUMENTS)
    await generateDocuments(s, applicationId)
    return { postingId, applicationId }
  }

  it("SAFE:244 clearing the minimal record removes her hold, the posting row with the description, its Eligibility results and Match evidence, and leaves the marker in no stored text", async () => {
    const { postingId, applicationId } = await pastedApplication("QA-SAFE244")
    expect(await markerRows(MARKER)).toContain("job_posting.posting_text")
    const deleted = deleteDetailsResponseSchema.parse((await s.ada.post(DELETE_DETAILS_PATH).send({ applicationIds: [applicationId] }).expect(200)).body)
    expect(deleted.deletedCount).toBe(1)
    // After the detailed records go the description is still stored while she holds it (SAFE:236).
    expect((await holdsOf(s.database.db, s.database.operatorId)).map((hold) => hold.job_posting_id)).toContain(postingId)
    await s.ada.delete(`/v1/minimal-records/${applicationId}`).expect(204)

    expect(await holdsOf(s.database.db, s.database.operatorId)).toEqual([])
    expect(await s.database.db.selectFrom("job_posting").select("id").where("id", "=", postingId).execute()).toEqual([])
    expect(await s.database.db.selectFrom("eligibility_result").select("job_posting_id").where("job_posting_id", "=", postingId).execute()).toEqual([])
    expect(await s.database.db.selectFrom("match_evidence").select("job_posting_id").where("job_posting_id", "=", postingId).execute()).toEqual([])
    // Read in her scope: the posting is gone. Read as the bootstrap superuser (stands in for the backup role): no table holds the marker.
    await s.ada.get(`/v1/job-postings/${postingId}`).expect(404)
    expect(await markerRows(MARKER)).toEqual([])
  })

  it.each([
    ["the existing retention run processes the detailed records", "run"],
    ["the detailed records are deleted through the existing action", "delete"],
    ["the detailed records are deleted and the minimal record cleared", "clear"],
  ] as const)("SAFE:254 %s: the pasted description and the pasted link's employer text follow one lifecycle", async (_action, action) => {
    const pasted = await pastedApplication(`QA-SAFE254-${action}`)
    s.google.server.use(atsStubs.greenhouseOk())
    for (let i = 0; i < 4; i += 1) s.anthropic.replyWithObject(STRONG_EXTRACTION)
    const linkPaste = pasteJobLinkResponseSchema.parse((await s.paste(s.ada, { url: LINKS.greenhouse })).body)
    await decide(s.database.db, s.database.operatorId, linkPaste.posting.id, "ranked")
    const linkApplication = await createApplicationFor(s, linkPaste.posting.id)
    await documentsReady(s.database.db, s.database.operatorId, linkApplication)
    const link = { postingId: linkPaste.posting.id, applicationId: linkApplication }
    const both = [pasted, link]
    const stored = async (postingId: string) => (await s.database.db.selectFrom("job_posting").select("posting_text").where("id", "=", postingId).executeTakeFirst())?.posting_text ?? null

    if (action === "run") {
      await s.database.db.updateTable("application").set({ created_at: OLD, updated_at: OLD }).execute()
      await s.database.db.insertInto("retention_run").values({ candidate_id: s.database.operatorId, id: randomUUID(), wat_date: "2026-06-01", started_at: new Date("2026-06-01T02:00:00Z"), finished_at: new Date("2026-06-01T02:00:01Z"), outcome: "completed" }).execute()
      const summary = await new RetentionRunner(s.app.get(TenantDatabase), s.clock).run()
      expect(summary).toMatchObject({ outcome: "completed", due: 2, deleted: 2 })
    } else {
      const ids = both.map((entry) => entry.applicationId)
      expect(deleteDetailsResponseSchema.parse((await s.ada.post(DELETE_DETAILS_PATH).send({ applicationIds: ids }).expect(200)).body).deletedCount).toBe(2)
      if (action === "clear") for (const id of ids) await s.ada.delete(`/v1/minimal-records/${id}`).expect(204)
    }
    for (const entry of both) {
      const text = await stored(entry.postingId)
      if (action === "clear") expect(text, "removed with her hold on it").toBeNull()
      else expect(text, "still stored while she holds it").not.toBeNull()
    }
    const holds = (await holdsOf(s.database.db, s.database.operatorId)).map((hold) => hold.job_posting_id)
    for (const entry of both) expect(holds.includes(entry.postingId)).toBe(action !== "clear")
  })
})
