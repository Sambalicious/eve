import { apiErrorResponseSchema, createApplicationResponseSchema, jobPostingDetailSchema, pasteJobLinkResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  COMPANY,
  EMPLOYER_TEXT,
  LINKS,
  PD_COPY,
  POSTING_TABLES,
  type PasteStack,
  STRONG_EXTRACTION,
  TITLE,
  allPostings,
  atsStubs,
  decide,
  descPaystack,
  descPaystackV2,
  holdsOf,
  postingsContaining,
  requestsWith,
  startPasteStack,
} from "./support/qa-epic-0010.js"

/**
 * QA test authoring, step [5e], EPIC-0010. Contract v1.27.0 "Store" table and every
 * `descriptionOutcome`, through the real route, Postgres and the in-process evaluation
 * (model calls answered by FakeAnthropic; ATS public APIs by msw). Expected red until
 * the integrated candidate lands.
 *
 * Covers: PD:58 (api), PD:73, PD:262, PD:271, PD:284; EV:28, EV:34, EV:101 (api part),
 * EV:149 (api), EV:188; RP:46, RP:88, RP:96, RP:113, RP:120, RP:130, RP:139, RP:148,
 * RP:156, RP:164, RP:172, RP:182, RP:194, RP:205, RP:214, RP:221, RP:234, RP:252, RP:260,
 * RP:267; MO:199; SAFE:152, SAFE:169, SAFE:195 (api parts); threat-model C-07, C-28,
 * C-36 (paste races), C-39, C-40 (paste response).
 */
let s: PasteStack

beforeAll(async () => {
  s = await startPasteStack()
})

beforeEach(async () => {
  await s.reset()
})

afterAll(async () => {
  await s?.stop()
})

function feedEvaluations(n = 8): void {
  for (let i = 0; i < n; i += 1) s.anthropic.replyWithObject(STRONG_EXTRACTION)
}

const ada = () => s.ada
const adaHolds = () => holdsOf(s.database.db, s.database.operatorId)
const parse = (body: unknown) => pasteJobLinkResponseSchema.parse(body)
const detail = async (id: string) => jobPostingDetailSchema.parse((await s.ada.get(`/v1/job-postings/${id}`).expect(200)).body)

/** Ada's description-only paste of `description` with the fixture names. */
const pasteText = (description: string, title = TITLE, company = COMPANY) => s.paste(ada(), { description, title, company })
const pasteLink = (url: string, description: string, title: string | undefined = TITLE, company: string | undefined = COMPANY) =>
  s.paste(ada(), { url, description, ...(title === undefined ? {} : { title }), ...(company === undefined ? {} : { company }) })

const hosts = () => s.outbound.urls.map((line) => new URL(line.split(" ")[1]!).hostname)

describe("stored: description only and non-ATS links (PD-1.1, PD-2.1)", () => {
  it("PD:58 / EV:28 description only → 201 stored; private, manual, no link, synthetic requisition, never hidden; text stored", async () => {
    feedEvaluations()
    const text = descPaystack("QA-PD58")
    const response = await pasteText(text)
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const pasted = parse(response.body)
    expect(pasted).toMatchObject({
      created: true,
      descriptionOutcome: "stored",
      applicationId: null,
      waitingReason: null,
      posting: { title: TITLE, company: COMPANY, applicationUrl: null, applyUrl: null, applicationSystem: "none", applyMode: "manual", origin: "pasted_description", hiddenReason: null },
    })
    expect(pasted.posting.requisitionId).toBe(`pasted:${pasted.posting.id}`)
    // C-40: the internal URN never leaves the api.
    expect(JSON.stringify(response.body)).not.toContain("urn:eve:pasted")

    const rows = await allPostings(s.database.db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: pasted.posting.id, origin: "pasted_description", owner_candidate_id: s.database.operatorId, apply_mode: "manual", posting_text: text, title: TITLE, company: COMPANY })
    expect(rows[0]!.paste_fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(await adaHolds()).toEqual([expect.objectContaining({ job_posting_id: pasted.posting.id, origin: "pasted_description" })])

    const shown = await detail(pasted.posting.id)
    expect(shown).toMatchObject({ origin: "pasted_description", postingText: text, applyAnyway: null, applicationUrl: null, hiddenReason: null })
    expect(JSON.stringify(shown)).not.toContain("urn:eve:pasted")
  })

  it("PD:73 / EV:34 a non-ATS link with a description → 201 stored, link kept, origin pasted_description; the link is never fetched", async () => {
    feedEvaluations()
    const text = descPaystack("QA-PD73")
    const response = await pasteLink(LINKS.flutterwave, text, TITLE, "Flutterwave")
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const pasted = parse(response.body)
    expect(pasted).toMatchObject({ created: true, descriptionOutcome: "stored", posting: { applicationUrl: LINKS.flutterwave, applyUrl: LINKS.flutterwave, origin: "pasted_description", applyMode: "manual", title: TITLE, company: "Flutterwave" } })
    const [row] = await allPostings(s.database.db)
    expect(row).toMatchObject({ posting_text: text, application_url: LINKS.flutterwave, paste_fingerprint: null })
    expect(hosts().filter((host) => host !== "api.anthropic.com")).toEqual([])
  })

  it("C-28 the stored link is the checked (normalised) link, never the raw body string", async () => {
    feedEvaluations()
    const response = await pasteLink("HTTPS://Careers.Flutterwave.com/jobs/senior-frontend-42", descPaystack("QA-C28"), TITLE, "Flutterwave")
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const [row] = await allPostings(s.database.db)
    expect(row!.apply_url).not.toBe("HTTPS://Careers.Flutterwave.com/jobs/senior-frontend-42")
    expect(row!.apply_url).toBe(new URL("HTTPS://Careers.Flutterwave.com/jobs/senior-frontend-42").toString())
  })

  it.each([
    ["PD:262 LinkedIn", LINKS.linkedIn],
    ["PD:271 Flutterwave careers", LINKS.flutterwave],
    ["PD:271 Workday", LINKS.workday],
    ["C-39 a Greenhouse look-alike host", LINKS.greenhouseLookalike],
  ])("%s link with a description: no request to the link's host, LinkedIn or Google; only the AI provider", async (_label, url) => {
    feedEvaluations()
    const response = await pasteLink(url, descPaystack("QA-NOFETCH"), TITLE, COMPANY)
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(parse(response.body)).toMatchObject({ descriptionOutcome: "stored", posting: { origin: "pasted_description" } })
    const seen = hosts()
    expect(seen.filter((host) => host !== "api.anthropic.com")).toEqual([])
    expect(seen.some((host) => host.endsWith("linkedin.com") || host.endsWith("google.com"))).toBe(false)
  })

  it("EV:101 (api part) a pasted-description posting is evaluated whatever its link host: not skipped as unsupported", async () => {
    feedEvaluations()
    const pasted = parse((await pasteLink(LINKS.workday, descPaystack("QA-EV101"))).body)
    const shown = await detail(pasted.posting.id)
    expect(shown.skipReason).not.toBe("unsupported_application_system")
    expect(shown.status).not.toBe("not_checked")
    expect(requestsWith(s.anthropic.requests, "QA-EV101")).toBeGreaterThan(0)
  })

  it("EV:188 a link-only LinkedIn paste keeps the hiding rule and origin pasted_link", async () => {
    const pasted = parse((await s.paste(ada(), { url: LINKS.linkedIn })).body)
    expect(pasted).toMatchObject({ descriptionOutcome: null, posting: { origin: "pasted_link", hiddenReason: "undated" } })
  })
})

describe("readable ATS link wins (OQ-3): employer_page_used", () => {
  it.each([
    ["Greenhouse", LINKS.greenhouse, () => atsStubs.greenhouseOk()],
    ["Lever", LINKS.lever, () => atsStubs.leverOk()],
    ["Ashby", LINKS.ashby, () => atsStubs.ashbyOk()],
  ])("RP:46 / PD:284 %s: 201 employer_page_used, pasted_link with the employer's text and names; the description is stored nowhere; one public API lookup", async (_system, link, stub) => {
    feedEvaluations()
    s.google.server.use(stub())
    const marker = `QA-RP46-${_system}`
    // Oracle: what the unchanged link path stores for the same link (title, optional Location line, then the body).
    const linkOnly = await s.paste(ada(), { url: link })
    expect(linkOnly.status, JSON.stringify(linkOnly.body)).toBe(201)
    const linkOnlyRows = await allPostings(s.database.db)
    expect(linkOnlyRows).toHaveLength(1)
    const linkOnlyText = linkOnlyRows[0]!.posting_text
    expect(linkOnlyText).toContain(EMPLOYER_TEXT.trim())
    for (const table of POSTING_TABLES) await s.database.db.deleteFrom(table).execute()
    s.outbound.reset()
    const response = await pasteLink(link, descPaystack(marker), "INJECTED Frontend Lead", "INJECTED Paystack")
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const pasted = parse(response.body)
    expect(pasted).toMatchObject({ created: true, descriptionOutcome: "employer_page_used", applicationId: null, posting: { origin: "pasted_link", title: TITLE } })
    expect(pasted.posting.applyMode).not.toBe("manual")
    const rows = await allPostings(s.database.db)
    expect(rows).toHaveLength(1)
    // C-07: the shared row's names come from the ATS API, never the typed ones.
    expect(rows[0]).toMatchObject({ origin: "pasted_link", owner_candidate_id: null, posting_text: linkOnlyText })
    expect(rows[0]!.posting_text).toContain(EMPLOYER_TEXT.trim())
    expect(rows[0]!.title).not.toContain("INJECTED")
    expect(rows[0]!.company ?? "").not.toContain("INJECTED")
    expect(await postingsContaining(s.database.db, marker)).toBe(0)
    expect(await postingsContaining(s.database.db, "INJECTED")).toBe(0)
    // The only non-model request is the public API lookup a link-only paste makes.
    const nonModel = s.outbound.urls.filter((line) => !line.includes("api.anthropic.com"))
    expect(nonModel).toHaveLength(1)
    expect(nonModel[0]).toMatch(/^GET https:\/\/(boards-api\.greenhouse\.io|api\.lever\.co|api\.ashbyhq\.com)\//)
  })

  it("RP:88 an ATS link needs no names: 201 employer_page_used with the ATS title and company", async () => {
    feedEvaluations()
    s.google.server.use(atsStubs.ashbyOk())
    const response = await pasteLink(LINKS.ashby, descPaystack("QA-RP88"), undefined, undefined)
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(parse(response.body)).toMatchObject({ descriptionOutcome: "employer_page_used", posting: { origin: "pasted_link", title: TITLE } })
  })

  it("C-07 a later link-only paste of the same Greenhouse link by another Candidate shows the ATS title, not Ada's typed one", async () => {
    feedEvaluations()
    s.google.server.use(atsStubs.greenhouseOk())
    await pasteLink(LINKS.greenhouse, descPaystack("QA-C07"), "INJECTED", "INJECTED")
    const bolaPasted = parse((await s.paste(s.bola, { url: LINKS.greenhouse })).body)
    expect(bolaPasted.posting.title).toBe(TITLE)
    expect(JSON.stringify(bolaPasted)).not.toContain("INJECTED")
  })

  it("RP:72 a readable undated Lever posting stays hidden as today; the description is stored nowhere", async () => {
    feedEvaluations()
    s.google.server.use(atsStubs.leverUndated())
    const response = await pasteLink(LINKS.leverUndated, descPaystack("QA-RP72"), TITLE, "Acme")
    expect(parse(response.body)).toMatchObject({ descriptionOutcome: "employer_page_used", posting: { origin: "pasted_link", hiddenReason: "undated" } })
    expect(await postingsContaining(s.database.db, "QA-RP72")).toBe(0)
  })

  it("RP:156 a held ATS posting with the employer's text: 200 employer_page_used, no lookup, description not stored", async () => {
    feedEvaluations()
    s.google.server.use(atsStubs.greenhouseOk())
    const first = parse((await s.paste(ada(), { url: LINKS.greenhouse })).body)
    s.outbound.reset()
    const response = await pasteLink(LINKS.greenhouse, descPaystack("QA-RP156"), "Frontend Lead", COMPANY)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(parse(response.body)).toMatchObject({ created: false, descriptionOutcome: "employer_page_used", posting: { id: first.posting.id } })
    expect(s.outbound.urls.filter((line) => line.includes("greenhouse"))).toEqual([])
    expect(await postingsContaining(s.database.db, "QA-RP156")).toBe(0)
    expect(await adaHolds()).toHaveLength(1)
  })
})

describe("ATS lookup failure falls back to the description (OQ-3, I-6)", () => {
  it.each([
    ["Greenhouse 404", LINKS.greenhouseMissing, () => atsStubs.greenhouse404()],
    ["Lever network failure (times out)", LINKS.leverMissing, () => atsStubs.leverNetworkFailure()],
    ["Ashby 500", LINKS.ashbyMissing, () => atsStubs.ashby500()],
    ["Greenhouse no job content", LINKS.greenhouseNoContent, () => atsStubs.greenhouseNoContent()],
  ])("RP:96 %s with names → 201 stored_lookup_failed, pasted_description, manual, link kept, text stored", async (_label, link, stub) => {
    feedEvaluations()
    s.google.server.use(stub())
    const text = descPaystack("QA-RP96")
    const response = await pasteLink(link, text)
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(parse(response.body)).toMatchObject({ created: true, descriptionOutcome: "stored_lookup_failed", posting: { origin: "pasted_description", applyMode: "manual", applicationUrl: link } })
    const rows = await allPostings(s.database.db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ origin: "pasted_description", apply_mode: "manual", posting_text: text, owner_candidate_id: s.database.operatorId })
  })

  it.each([
    ["no names", {}, [{ field: "title", position: null, problem: "required" }, { field: "company", position: null, problem: "required" }]],
    ["no company", { title: TITLE }, [{ field: "company", position: null, problem: "required" }]],
  ])("RP:113 Greenhouse 404 with %s → 422 employer_page_unreadable with fieldErrors; nothing stored", async (_label, names, fieldErrors) => {
    s.google.server.use(atsStubs.greenhouse404())
    const response = await s.paste(ada(), { url: LINKS.greenhouseMissing, description: descPaystack("QA-RP113"), ...names })
    expect(response.status, JSON.stringify(response.body)).toBe(422)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "employer_page_unreadable", message: PD_COPY.employerPageUnreadable, fieldErrors })
    expect(await allPostings(s.database.db)).toEqual([])
    expect(await adaHolds()).toEqual([])
  })

  it("RP:120 a link-only ATS paste whose lookup fails behaves as today: pasted_link, empty text, not_checked", async () => {
    s.google.server.use(atsStubs.greenhouse404())
    const response = await s.paste(ada(), { url: LINKS.greenhouseMissing })
    expect(parse(response.body)).toMatchObject({ descriptionOutcome: null, posting: { origin: "pasted_link", status: "not_checked" } })
    const [row] = await allPostings(s.database.db)
    expect(row!.posting_text).toBe("")
  })
})

describe("re-paste rules (OQ-4 a to d)", () => {
  it("RP:130 (a) a held LinkedIn link with no text → 200 attached: new private posting id, one hold, evaluated, no longer unsupported", async () => {
    const old = parse((await s.paste(ada(), { url: LINKS.linkedIn })).body)
    expect(old.posting).toMatchObject({ origin: "pasted_link", status: "skipped", skipReason: "unsupported_application_system" })
    feedEvaluations()
    const text = descPaystack("QA-RP130")
    const response = await pasteLink(LINKS.linkedIn, text)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const attached = parse(response.body)
    expect(attached).toMatchObject({ created: false, descriptionOutcome: "attached", applicationId: null, posting: { origin: "pasted_description" } })
    expect(attached.posting.id).not.toBe(old.posting.id)
    const holds = await adaHolds()
    expect(holds).toEqual([expect.objectContaining({ job_posting_id: attached.posting.id, origin: "pasted_description", posting_text: text })])
    expect(holds[0]!.skip_reason).not.toBe("unsupported_application_system")
    // Nobody else held the old shared row, so deleteUnheldPosting removed it.
    expect((await allPostings(s.database.db)).map((row) => row.id)).toEqual([attached.posting.id])
    expect(requestsWith(s.anthropic.requests, "QA-RP130")).toBeGreaterThan(0)
    // The old id is gone for her.
    expect((await s.ada.get(`/v1/job-postings/${old.posting.id}`)).status).toBe(404)
  })

  it("RP:139 (a) a held Lever link whose lookup failed (not_checked, no text) → attached with no request to the Lever API", async () => {
    s.google.server.use(atsStubs.leverNetworkFailure())
    const old = parse((await s.paste(ada(), { url: LINKS.leverMissing })).body)
    expect(old.posting.status).toBe("not_checked")
    s.outbound.reset()
    feedEvaluations()
    const response = await pasteLink(LINKS.leverMissing, descPaystack("QA-RP139"))
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(parse(response.body)).toMatchObject({ descriptionOutcome: "attached", posting: { origin: "pasted_description", applyMode: "manual" } })
    expect(s.outbound.urls.filter((line) => line.includes("lever.co"))).toEqual([])
    expect(await adaHolds()).toHaveLength(1)
  })

  it("RP:148 (b) a held pasted description with no Application → 200 replaced: same id, new text, results cleared, evaluated again", async () => {
    feedEvaluations()
    const first = parse((await pasteLink(LINKS.linkedIn, descPaystack("QA-RP148"))).body)
    await decide(s.database.db, s.database.operatorId, first.posting.id, "skipped", { skipReason: "weak_core_match" })
    const before = s.anthropic.requests.length
    feedEvaluations()
    const v2 = descPaystackV2("QA-RP148")
    const response = await pasteLink(LINKS.linkedIn, v2)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(parse(response.body)).toMatchObject({ created: false, descriptionOutcome: "replaced", posting: { id: first.posting.id, origin: "pasted_description" } })
    const holds = await adaHolds()
    expect(holds).toHaveLength(1)
    expect(holds[0]!.posting_text).toBe(v2)
    const v2Requests = s.anthropic.requests.slice(before).filter((r) => JSON.stringify(r.body).includes("Storybook"))
    expect(v2Requests.length).toBeGreaterThan(0)
  })

  it("contract: replace keeps the names rule: a held LinkedIn pasted posting re-pasted without names → 422 job_title_required, unchanged", async () => {
    feedEvaluations()
    const text = descPaystack("QA-REPLACE-NAMES")
    await pasteLink(LINKS.linkedIn, text)
    const response = await s.paste(ada(), { url: LINKS.linkedIn, description: descPaystackV2("QA-REPLACE-NAMES") })
    expect(response.status).toBe(422)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("job_title_required")
    expect((await adaHolds())[0]!.posting_text).toBe(text)
  })

  it("contract: re-paste while the posting is checking → 409 posting_still_checking with C-PD-28; nothing changes", async () => {
    feedEvaluations()
    const text = descPaystack("QA-409")
    const first = parse((await pasteLink(LINKS.linkedIn, text)).body)
    await decide(s.database.db, s.database.operatorId, first.posting.id, "checking")
    const before = s.anthropic.requests.length
    const response = await pasteLink(LINKS.linkedIn, descPaystackV2("QA-409"))
    expect(response.status, JSON.stringify(response.body)).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "posting_still_checking", message: PD_COPY.stillChecking })
    expect((await adaHolds())[0]).toMatchObject({ job_posting_id: first.posting.id, posting_text: text, status: "checking" })
    expect(s.anthropic.requests.length).toBe(before)
  })

  it("RP:164 a held pasted link sent again link-only → 200 created false (C-LINK-2), text unchanged, no evaluation", async () => {
    feedEvaluations()
    const text = descPaystack("QA-RP164")
    const first = parse((await pasteLink(LINKS.linkedIn, text)).body)
    const before = s.anthropic.requests.length
    const response = await s.paste(ada(), { url: LINKS.linkedIn })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(parse(response.body)).toMatchObject({ created: false, descriptionOutcome: null, posting: { id: first.posting.id } })
    expect((await adaHolds())[0]!.posting_text).toBe(text)
    expect(s.anthropic.requests.length).toBe(before)
  })

  it("RP:172 description, then V2, then link-only for one LinkedIn link: one posting for the link throughout", async () => {
    await s.paste(ada(), { url: LINKS.linkedIn })
    feedEvaluations()
    const first = await pasteLink(LINKS.linkedIn, descPaystack("QA-RP172"))
    const firstId = parse(first.body).posting.id
    await decide(s.database.db, s.database.operatorId, firstId, "ranked")
    await pasteLink(LINKS.linkedIn, descPaystackV2("QA-RP172"))
    await s.paste(ada(), { url: LINKS.linkedIn })
    const holds = await adaHolds()
    expect(holds).toHaveLength(1)
    const rows = await allPostings(s.database.db)
    // The stored link is the normalised one (C-28): https://linkedin.com/jobs/view/4012345678.
    const normalised = "https://linkedin.com/jobs/view/4012345678"
    expect(rows.filter((row) => row.application_url === normalised)).toHaveLength(1)
    expect((await holdsOf(s.database.db, s.database.operatorId)).filter((hold) => hold.application_url === normalised)).toHaveLength(1)
  })

  it("RP:182 / MO:199 (c) a link whose posting has an Application → 200 unchanged_has_application with applicationId; text unchanged; no evaluation", async () => {
    feedEvaluations()
    const text = descPaystack("QA-RP182")
    const first = parse((await pasteLink(LINKS.linkedIn, text)).body)
    await decide(s.database.db, s.database.operatorId, first.posting.id, "ranked")
    const created = createApplicationResponseSchema.parse((await s.ada.post("/v1/applications").send({ jobPostingId: first.posting.id }).expect(201)).body)
    const before = s.anthropic.requests.length
    const response = await pasteLink(LINKS.linkedIn, descPaystackV2("QA-RP182"))
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(parse(response.body)).toMatchObject({ created: false, descriptionOutcome: "unchanged_has_application", applicationId: created.application.id, posting: { id: first.posting.id } })
    expect((await adaHolds())[0]!.posting_text).toBe(text)
    expect(await s.database.db.selectFrom("application").select("id").execute()).toHaveLength(1)
    expect(s.anthropic.requests.length).toBe(before)
  })

  it("RP:194 (c) a no-text Lever link with an Application (any origin) → unchanged_has_application; nothing changes, no lookup", async () => {
    s.google.server.use(atsStubs.leverNetworkFailure())
    feedEvaluations()
    const first = parse((await pasteLink(LINKS.leverMissing, descPaystack("QA-RP194"))).body)
    await decide(s.database.db, s.database.operatorId, first.posting.id, "ranked")
    const created = createApplicationResponseSchema.parse((await s.ada.post("/v1/applications").send({ jobPostingId: first.posting.id }).expect(201)).body)
    s.outbound.reset()
    const response = await pasteLink(LINKS.leverMissing, descPaystackV2("QA-RP194"))
    expect(parse(response.body)).toMatchObject({ descriptionOutcome: "unchanged_has_application", applicationId: created.application.id })
    expect(s.outbound.urls.filter((line) => line.includes("lever"))).toEqual([])
    expect((await adaHolds())[0]!.posting_text).toBe(descPaystack("QA-RP194"))
  })

  it("RP:205 (d) an identical description-only paste → 200 already_pasted with the earlier posting; one posting; no evaluation", async () => {
    feedEvaluations()
    const text = descPaystack("QA-RP205")
    const first = parse((await pasteText(text)).body)
    const before = s.anthropic.requests.length
    const response = await pasteText(text)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(parse(response.body)).toMatchObject({ created: false, descriptionOutcome: "already_pasted", applicationId: null, posting: { id: first.posting.id } })
    expect(await adaHolds()).toHaveLength(1)
    expect(s.anthropic.requests.length).toBe(before)
  })

  it("RP:214 (d) whitespace differences and a padded title still match", async () => {
    feedEvaluations()
    const text = descPaystack("QA-RP214")
    const first = parse((await pasteText(text)).body)
    const words = text.split(" ")
    const spaced = `  ${[words[0], "", ...words.slice(1)].join(" ")}\n`
    const response = await pasteText(spaced, ` ${TITLE} `, COMPANY)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(parse(response.body)).toMatchObject({ descriptionOutcome: "already_pasted", posting: { id: first.posting.id } })
    expect(await adaHolds()).toHaveLength(1)
  })

  it.each([
    ["V2 text", () => descPaystackV2("QA-RP221"), TITLE, COMPANY],
    ["another title", () => descPaystack("QA-RP221"), "Staff Frontend Engineer", COMPANY],
    ["another company", () => descPaystack("QA-RP221"), TITLE, "Flutterwave"],
    ["different case in the text (case kept)", () => descPaystack("QA-RP221").toUpperCase(), TITLE, COMPANY],
  ])("RP:221 a description-only paste with %s → 201 stored, two postings", async (_label, text, title, company) => {
    feedEvaluations()
    await pasteText(descPaystack("QA-RP221"))
    const response = await pasteText(text(), title, company)
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(parse(response.body).descriptionOutcome).toBe("stored")
    expect(await adaHolds()).toHaveLength(2)
  })

  it("RP:234 a description-only paste does not match a pasted posting that has a link", async () => {
    feedEvaluations()
    const text = descPaystack("QA-RP234")
    await pasteLink(LINKS.linkedIn, text)
    const response = await pasteText(text)
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(parse(response.body)).toMatchObject({ descriptionOutcome: "stored", posting: { applicationUrl: null } })
    expect(await adaHolds()).toHaveLength(2)
  })
})

describe("concurrency (PD-5.5, threat model T10-9 / C-36): one posting, one evaluation, never 5xx", () => {
  /** Model requests one uncontended evaluation of a fresh description makes (reference for "one evaluation"). */
  async function requestsPerEvaluation(): Promise<number> {
    feedEvaluations()
    await pasteText(descPaystack("QA-REFERENCE-EVAL"), "Reference Engineer", "Reference Co")
    const n = requestsWith(s.anthropic.requests, "QA-REFERENCE-EVAL")
    await s.reset()
    return n
  }

  it("RP:252 / C-36 ten parallel identical description-only pastes → one 201 stored, nine 200 already_pasted, one posting, one evaluation", async () => {
    const perEvaluation = await requestsPerEvaluation()
    expect(perEvaluation).toBeGreaterThan(0)
    feedEvaluations(20)
    const text = descPaystack("QA-RP252")
    const responses = await Promise.all(Array.from({ length: 10 }, () => s.ada.post("/v1/job-postings/links").send({ description: text, title: TITLE, company: COMPANY })))
    await s.settle()
    const statuses = responses.map((r) => r.status).sort()
    expect(statuses, JSON.stringify(responses.map((r) => r.body))).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201])
    const outcomes = responses.map((r) => parse(r.body).descriptionOutcome).sort()
    expect(outcomes).toEqual([...Array(9).fill("already_pasted"), "stored"])
    expect(new Set(responses.map((r) => parse(r.body).posting.id)).size).toBe(1)
    expect(await adaHolds()).toHaveLength(1)
    expect(requestsWith(s.anthropic.requests, "QA-RP252")).toBe(perEvaluation)
  })

  it("RP:260 two concurrent pastes of the same LinkedIn link and description → one posting, one evaluation, no error", async () => {
    const perEvaluation = await requestsPerEvaluation()
    feedEvaluations(10)
    const text = descPaystack("QA-RP260")
    const responses = await Promise.all([0, 1].map(() => s.ada.post("/v1/job-postings/links").send({ url: LINKS.linkedIn, description: text, title: TITLE, company: COMPANY })))
    await s.settle()
    for (const r of responses) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500)
    // Contract r1 "Idempotency": the race loser answers 200 (same text) or 409 posting_still_checking while the winner evaluates.
    const statuses = responses.map((r) => r.status).sort()
    expect([JSON.stringify([200, 201]), JSON.stringify([201, 409])]).toContain(JSON.stringify(statuses))
    if (statuses.includes(409)) expect(apiErrorResponseSchema.parse(responses.find((r) => r.status === 409)!.body).error.code).toBe("posting_still_checking")
    expect(await adaHolds()).toHaveLength(1)
    expect(requestsWith(s.anthropic.requests, "QA-RP260")).toBe(perEvaluation)
  })

  it("RP:267 two concurrent descriptions attaching to one held no-text link → one posting with the text, at most one evaluation running, never 5xx", async () => {
    const perEvaluation = await requestsPerEvaluation()
    await s.paste(ada(), { url: LINKS.linkedIn })
    feedEvaluations(10)
    const text = descPaystack("QA-RP267")
    const responses = await Promise.all([0, 1].map(() => s.ada.post("/v1/job-postings/links").send({ url: LINKS.linkedIn, description: text, title: TITLE, company: COMPANY })))
    await s.settle()
    for (const r of responses) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500)
    const outcomes = responses.map((r) => (r.status === 409 ? apiErrorResponseSchema.parse(r.body).error.code : parse(r.body).descriptionOutcome))
    expect(outcomes).toContain("attached")
    for (const outcome of outcomes) expect(["attached", "replaced", "posting_still_checking"]).toContain(outcome)
    const holds = await adaHolds()
    expect(holds).toHaveLength(1)
    expect(holds[0]).toMatchObject({ origin: "pasted_description", posting_text: text })
    expect(requestsWith(s.anthropic.requests, "QA-RP267")).toBeLessThanOrEqual(2 * perEvaluation)
  })
})

describe("waiting (PD-6.3, PD-6.4): waitingReason", () => {
  it("SAFE:152 Candidate cost pause → 201 stored, waiting_to_be_checked, waitingReason cost_pause, text stored, no AI call", async () => {
    await s.database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    const text = descPaystack("QA-SAFE152")
    const response = await pasteText(text)
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(parse(response.body)).toMatchObject({ descriptionOutcome: "stored", waitingReason: "cost_pause", posting: { status: "waiting_to_be_checked" } })
    expect((await adaHolds())[0]).toMatchObject({ posting_text: text, status: "waiting_to_be_checked" })
    expect(s.anthropic.requests).toHaveLength(0)
  })

  it("SAFE:195 an invitee whose postings may not be evaluated → waitingReason checks_not_enabled, no AI call", async () => {
    const response = await s.paste(s.bola, { description: descPaystack("QA-SAFE195"), title: TITLE, company: COMPANY })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(parse(response.body)).toMatchObject({ descriptionOutcome: "stored", waitingReason: "checks_not_enabled", posting: { status: "waiting_to_be_checked", origin: "pasted_description" } })
    expect(s.anthropic.requests).toHaveLength(0)
  })

  it("EV:149 (api part) a pasted-description posting is listed with hiddenReason null even with no posted date and an off-target title", async () => {
    feedEvaluations()
    const pasted = parse((await pasteText(descPaystack("QA-EV149"), "Senior Data Engineer", COMPANY)).body)
    await decide(s.database.db, s.database.operatorId, pasted.posting.id, "ranked")
    const list = (await s.ada.get("/v1/job-postings?tab=all").expect(200)).body as { postings?: { id: string; hiddenReason: unknown; origin: string }[] }
    const row = JSON.stringify(list).includes(pasted.posting.id)
    expect(row).toBe(true)
    expect((await detail(pasted.posting.id)).hiddenReason).toBeNull()
  })
})
