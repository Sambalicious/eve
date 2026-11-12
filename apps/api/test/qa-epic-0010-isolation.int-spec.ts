import { apiErrorResponseSchema, createApplicationResponseSchema, jobPostingDetailSchema, pasteJobLinkResponseSchema } from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import {
  COMPANY,
  LINKS,
  type PasteStack,
  STRONG_EXTRACTION,
  TITLE,
  allPostings,
  decide,
  descPaystack,
  documentsReady,
  holdsOf,
  startPasteStack,
} from "./support/qa-epic-0010.js"

/**
 * QA test authoring, step [5e], EPIC-0010. Candidate isolation of pasted-description
 * postings (ADR 0013, forced RLS on job_posting) and shared-row integrity, through the
 * real api and Postgres with two signed-in Candidates. Expected red until the
 * integrated candidate lands.
 *
 * Covers: EV:198, EV:207, EV:214, EV:221, RP:240, DOC:210, MO:207; threat-model.md
 * C-02, C-03, C-04, C-06, C-08 (evaluation of a private row), C-48.
 * C-01 and C-05 are code reads for the Security candidate pass, not tests.
 */
let s: PasteStack
let runtime: Kysely<Database>
let tenant: TenantDatabase

beforeAll(async () => {
  s = await startPasteStack()
  runtime = createDatabase(s.database.url)
  tenant = new TenantDatabase(runtime)
})

beforeEach(async () => {
  await s.reset()
  // Bola's postings may be evaluated in these scenarios ("bola may have her postings evaluated"),
  // but isolation must hold whether or not they are: the assertions never depend on her status.
})

afterAll(async () => {
  await runtime?.destroy()
  await s?.stop()
})

function feedEvaluations(n = 8): void {
  for (let i = 0; i < n; i += 1) s.anthropic.replyWithObject(STRONG_EXTRACTION)
}

const parse = (body: unknown) => pasteJobLinkResponseSchema.parse(body)

/** Ada's ranked pasted-description posting from a unique text. */
async function adaPasted(marker: string, url?: string): Promise<{ id: string; text: string }> {
  feedEvaluations()
  const text = descPaystack(marker)
  const response = await s.paste(s.ada, { ...(url ? { url } : {}), description: text, title: TITLE, company: COMPANY })
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  const id = parse(response.body).posting.id
  await decide(s.database.db, s.database.operatorId, id, "ranked")
  return { id, text }
}

/** Every list Bola can read, serialised. */
async function everythingBolaSees(): Promise<string> {
  const paths = ["/v1/job-postings?tab=all", "/v1/job-postings?tab=ranked", "/v1/applications", "/v1/documents", "/v1/minimal-records"]
  const bodies = await Promise.all(paths.map(async (path) => JSON.stringify((await s.bola.get(path)).body)))
  return bodies.join("\n")
}

describe("C-02 forced RLS on job_posting (migration 0031)", () => {
  it("job_posting has relrowsecurity and relforcerowsecurity; the runtime role cannot bypass RLS", async () => {
    const { rows } = await sql<{ rls: boolean; forced: boolean }>`select relrowsecurity as rls, relforcerowsecurity as forced from pg_class where relname = 'job_posting'`.execute(s.database.db)
    expect(rows).toEqual([{ rls: true, forced: true }])
    const role = await sql<{ bypass: boolean }>`select rolbypassrls as bypass from pg_roles where rolname = current_user`.execute(runtime)
    expect(role.rows).toEqual([{ bypass: false }])
  })

  it("as Bola's scope and as the shared scope, Ada's private row is invisible; as Ada's scope it is visible", async () => {
    const { id } = await adaPasted("QA-C02")
    const asBola = await tenant.forCandidate(s.bolaId, (tx) => tx.selectFrom("job_posting").select("id").where("id", "=", id).execute())
    expect(asBola).toEqual([])
    const asShared = await tenant.forShared((tx) => tx.selectFrom("job_posting").select("id").where("id", "=", id).execute())
    expect(asShared).toEqual([])
    const asAda = await tenant.forCandidate(s.database.operatorId, (tx) => tx.selectFrom("job_posting").select("id").where("id", "=", id).execute())
    expect(asAda).toEqual([{ id }])
  })
})

describe("C-03 / EV:207 / EV:221 / DOC:210 / MO:207: Bola gets 404 for Ada's private posting and its Application on every route", () => {
  it("EV:207 GET /v1/job-postings/{id} → 404 not_found; Ada's text appears in none of Bola's lists", async () => {
    const { id } = await adaPasted("QA-EV207-SECRET")
    const response = await s.bola.get(`/v1/job-postings/${id}`)
    expect(response.status).toBe(404)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("not_found")
    const seen = await everythingBolaSees()
    expect(seen).not.toContain("QA-EV207-SECRET")
    expect(seen).not.toContain(id)
  })

  it("EV:221 POST /v1/applications naming Ada's posting → 404 not_found; no Application exists for it", async () => {
    const { id } = await adaPasted("QA-EV221")
    const response = await s.bola.post("/v1/applications").send({ jobPostingId: id })
    expect(response.status).toBe(404)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("not_found")
    expect(await s.database.db.selectFrom("application").select("id").where("job_posting_id", "=", id).execute()).toEqual([])
  })

  it("DOC:210 / MO:207 Bola cannot download, queue, sample or approve Ada's pasted Application (404); it stays documents ready, not queued", async () => {
    const { id } = await adaPasted("QA-DOC210")
    const created = createApplicationResponseSchema.parse((await s.ada.post("/v1/applications").send({ jobPostingId: id }).expect(201)).body)
    const applicationId = created.application.id
    await documentsReady(s.database.db, s.database.operatorId, applicationId)
    for (const file of ["resume.pdf", "resume.docx", "cover-letter.pdf", "cover-letter.docx"]) {
      expect((await s.bola.get(`/v1/applications/${applicationId}/documents/${file}`)).status, file).toBe(404)
    }
    // Orchestrator note (backend epic-0010/be): an invitee's queue/sample hits the converted-feature
    // guard before scope, so 409 feature_not_yet_available is accepted beside 404 not_found. Either way: refused, nothing of Ada's revealed.
    for (const action of ["queue", "sample", "sample/approve"]) {
      const response = await s.bola.post(`/v1/applications/${applicationId}/${action}`).send({})
      const code = apiErrorResponseSchema.parse(response.body).error.code
      expect([`404 not_found`, `409 feature_not_yet_available`], action).toContain(`${response.status} ${code}`)
      expect(JSON.stringify(response.body)).not.toContain("QA-DOC210")
    }
    expect((await s.bola.get(`/v1/applications/${applicationId}`)).status).toBe(404)
    const row = await s.database.db.selectFrom("application").select(["state", "submission_state"]).where("id", "=", applicationId).executeTakeFirstOrThrow()
    expect(row).toEqual({ state: "documents_ready", submission_state: null })
  })
})

describe("C-04 / EV:198 two Candidates paste the same LinkedIn link with different descriptions", () => {
  it("each has exactly one private posting for the link and reads only their own text", async () => {
    feedEvaluations(12)
    const adaText = descPaystack("QA-EV198-ADA")
    const bolaText = `${descPaystack("QA-EV198-BOLA").slice(0, 880)} Bola's own text.`
    const adaResponse = await s.paste(s.ada, { url: LINKS.linkedIn, description: adaText, title: TITLE, company: COMPANY })
    const bolaResponse = await s.paste(s.bola, { url: LINKS.linkedIn, description: bolaText, title: "Frontend Engineer", company: COMPANY })
    expect(adaResponse.status, JSON.stringify(adaResponse.body)).toBe(201)
    // C-48: Bola's paste is new for her: never already_pasted, replaced, attached or 409.
    expect(bolaResponse.status, JSON.stringify(bolaResponse.body)).toBe(201)
    expect(parse(bolaResponse.body).descriptionOutcome).toBe("stored")
    const adaId = parse(adaResponse.body).posting.id
    const bolaId = parse(bolaResponse.body).posting.id
    expect(bolaId).not.toBe(adaId)

    expect(await holdsOf(s.database.db, s.database.operatorId)).toEqual([expect.objectContaining({ job_posting_id: adaId, posting_text: adaText })])
    expect(await holdsOf(s.database.db, s.bolaId)).toEqual([expect.objectContaining({ job_posting_id: bolaId, posting_text: bolaText })])
    const adaDetail = jobPostingDetailSchema.parse((await s.ada.get(`/v1/job-postings/${adaId}`).expect(200)).body)
    const bolaDetail = jobPostingDetailSchema.parse((await s.bola.get(`/v1/job-postings/${bolaId}`).expect(200)).body)
    expect(adaDetail.postingText).toBe(adaText)
    expect(bolaDetail.postingText).toBe(bolaText)
    expect(JSON.stringify(bolaDetail)).not.toContain("QA-EV198-ADA")
    expect(JSON.stringify(adaDetail)).not.toContain("QA-EV198-BOLA")
    expect((await s.bola.get(`/v1/job-postings/${adaId}`)).status).toBe(404)
  })
})

describe("C-48 / RP:240 no duplicate oracle across Candidates", () => {
  it("RP:240 Bola's identical description-only paste is a new posting for her, never already_pasted", async () => {
    await adaPasted("QA-RP240")
    const response = await s.paste(s.bola, { description: descPaystack("QA-RP240"), title: TITLE, company: COMPANY })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(parse(response.body)).toMatchObject({ created: true, descriptionOutcome: "stored" })
    expect(await holdsOf(s.database.db, s.bolaId)).toHaveLength(1)
  })

  it("C-48 Bola pastes Ada's exact LinkedIn link and text while Ada's posting is checking: 201 stored for Bola, never 409", async () => {
    const { id } = await adaPasted("QA-C48", LINKS.linkedIn)
    await decide(s.database.db, s.database.operatorId, id, "checking")
    const response = await s.paste(s.bola, { url: LINKS.linkedIn, description: descPaystack("QA-C48"), title: TITLE, company: COMPANY })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(parse(response.body).descriptionOutcome).toBe("stored")
  })
})

describe("C-06 / EV:214 shared-row integrity", () => {
  it("C-06 Ada and Bola hold the same shared empty LinkedIn row; Ada's description makes her a new private row and leaves the shared row and Bola's view unchanged", async () => {
    await s.paste(s.ada, { url: LINKS.linkedIn })
    await s.paste(s.bola, { url: LINKS.linkedIn })
    const shared = await allPostings(s.database.db)
    expect(shared).toHaveLength(1)
    const sharedBefore = shared[0]!
    const bolaBefore = (await s.bola.get(`/v1/job-postings/${sharedBefore.id}`).expect(200)).body as unknown

    feedEvaluations()
    const response = await s.paste(s.ada, { url: LINKS.linkedIn, description: descPaystack("QA-C06"), title: "INJECTED TITLE", company: "INJECTED CO" })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const attached = parse(response.body)
    expect(attached.descriptionOutcome).toBe("attached")
    expect(attached.posting.id).not.toBe(sharedBefore.id)

    const after = (await allPostings(s.database.db)).find((row) => row.id === sharedBefore.id)
    // Still held by Bola, so not deleted; and byte-identical.
    expect(after).toEqual(sharedBefore)
    expect((await s.bola.get(`/v1/job-postings/${sharedBefore.id}`).expect(200)).body).toEqual(bolaBefore)
    expect(await holdsOf(s.database.db, s.database.operatorId)).toEqual([expect.objectContaining({ job_posting_id: attached.posting.id, origin: "pasted_description" })])
  })

  it("EV:214 Bola's later link-only paste of Ada's pasted LinkedIn link gets a shared pasted_link row with empty text, skipped unsupported", async () => {
    await adaPasted("QA-EV214", LINKS.linkedIn)
    const response = await s.paste(s.bola, { url: LINKS.linkedIn })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const pasted = parse(response.body)
    expect(pasted).toMatchObject({ descriptionOutcome: null, posting: { origin: "pasted_link", status: "skipped", skipReason: "unsupported_application_system" } })
    const [hold] = await holdsOf(s.database.db, s.bolaId)
    expect(hold).toMatchObject({ origin: "pasted_link", posting_text: "" })
    expect(JSON.stringify(response.body)).not.toContain("QA-EV214")
  })

  it("C-08 evaluating Ada's private row leaves every shared row's technologies, ats_skills and role_family unchanged", async () => {
    await s.paste(s.bola, { url: LINKS.flutterwave })
    const before = (await allPostings(s.database.db)).filter((row) => row.owner_candidate_id === null)
    await adaPasted("QA-C08", LINKS.flutterwave)
    const after = (await allPostings(s.database.db)).filter((row) => row.owner_candidate_id === null)
    expect(after.map(({ id, technologies, ats_skills, role_family, posting_text, title, company }) => ({ id, technologies, ats_skills, role_family, posting_text, title, company }))).toEqual(
      before.map(({ id, technologies, ats_skills, role_family, posting_text, title, company }) => ({ id, technologies, ats_skills, role_family, posting_text, title, company }))
    )
  })
})
