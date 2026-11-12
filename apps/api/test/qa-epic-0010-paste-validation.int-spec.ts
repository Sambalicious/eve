import { apiErrorResponseSchema, pasteJobLinkResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { Browser } from "./support/browser.js"
import {
  COMPANY,
  FIELD_CODE_MESSAGE,
  LINKS,
  PASTE_PATH,
  PD_COPY,
  type PasteStack,
  STRONG_EXTRACTION,
  TITLE,
  allPostings,
  atsStubs,
  descPaystack,
  descriptionOfLength,
  startPasteStack,
} from "./support/qa-epic-0010.js"

/**
 * QA test authoring, step [5e], EPIC-0010 run, task qa-tests. Contract v1.27.0
 * `POST /v1/job-postings/links` "Processing order" steps 1 to 5, through the real
 * route and Postgres. Written before the implementation: expected red until the
 * integrated candidate lands.
 *
 * Covers paste-description.feature (PD): PD:91 (api part), PD:99, PD:112, PD:133,
 * PD:146, PD:161, PD:175, PD:181, PD:191, PD:205, PD:211, PD:217, PD:222, PD:227,
 * PD:238, PD:252, PD:338, PD:345; threat-model.md C-22 (behaviour), C-23, C-29,
 * C-33, C-44, C-45.
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

/** Answers every evaluation call the accepted pastes in one test make (the shape is irrelevant to these checks). */
function feedEvaluations(n = 6): void {
  for (let i = 0; i < n; i += 1) s.anthropic.replyWithObject(STRONG_EXTRACTION)
}

async function expectNothingStored(): Promise<void> {
  expect(await s.database.db.selectFrom("candidate_posting").select("job_posting_id").execute()).toEqual([])
  expect(await s.database.db.selectFrom("job_posting").select("id").execute()).toEqual([])
  expect(s.anthropic.requests).toHaveLength(0)
  expect(await s.database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
}

type FieldError = { field: string; position: null; problem: string }

function expectRefusal(response: { status: number; body: unknown }, status: number, code: string, message: string, fieldErrors?: FieldError[]): void {
  expect(response.status, JSON.stringify(response.body)).toBe(status)
  const error = apiErrorResponseSchema.parse(response.body).error
  expect(error.code).toBe(code)
  expect(error.message).toBe(message)
  if (fieldErrors === undefined) expect(error.fieldErrors ?? []).toEqual([])
  else expect(error.fieldErrors).toEqual(fieldErrors)
}

const fe = (field: string, problem: string): FieldError => ({ field, position: null, problem })

describe("PD:338 / PD:345 / C-44: session and CSRF are checked before the body", () => {
  it("PD:338 no session → 401 unauthenticated, nothing stored, no AI call", async () => {
    const response = await new Browser(s.app, s.google).http().post(PASTE_PATH).send({ description: descPaystack(), title: TITLE, company: COMPANY })
    await s.settle()
    expect(response.status).toBe(401)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("unauthenticated")
    await expectNothingStored()
  })

  it("PD:345 session without the CSRF header → 403 csrf_invalid, nothing stored", async () => {
    const response = await new Browser(s.app, s.google).http().post(PASTE_PATH).set("cookie", s.ada.cookie).send({ description: descPaystack(), title: TITLE, company: COMPANY })
    await s.settle()
    expect(response.status).toBe(403)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("csrf_invalid")
    await expectNothingStored()
  })

  it("C-44 a wrong CSRF token with an invalid body is still 403, not 400 (auth before schema)", async () => {
    const response = await new Browser(s.app, s.google).http().post(PASTE_PATH).set("cookie", s.ada.cookie).set("x-csrf-token", "wrong").send({ description: 42 })
    expect(response.status).toBe(403)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("csrf_invalid")
  })
})

describe("body schema (contract: raw caps and strictness → 400 bad_request; C-22, C-23, C-45)", () => {
  it.each([
    ["{} (neither url nor description)", {}],
    ["only a title", { title: TITLE }],
    ["only a title and company", { title: TITLE, company: COMPANY }],
    ["C-45 an extra candidateId key", { description: descPaystack(), title: TITLE, company: COMPANY, candidateId: "00000000-0000-4000-8000-000000000001" }],
    ["C-45 an extra ownerCandidateId key", { description: descPaystack(), title: TITLE, company: COMPANY, ownerCandidateId: "00000000-0000-4000-8000-000000000001" }],
    ["description null", { description: null, title: TITLE, company: COMPANY }],
    ["description a number", { description: 1240, title: TITLE, company: COMPANY }],
    ["title null", { description: descPaystack(), title: null, company: COMPANY }],
    ["C-23 a 65,537-character description (raw cap 65,536)", { description: "a".repeat(65_537), title: TITLE, company: COMPANY }],
    ["a 1,001-character title (raw cap 1,000)", { description: descPaystack(), title: "t".repeat(1001), company: COMPANY }],
    ["a 1,001-character company (raw cap 1,000)", { description: descPaystack(), title: TITLE, company: "c".repeat(1001) }],
    ["PD:252 a 2,049-character link with a description", { url: `https://careers.flutterwave.com/${"a".repeat(2049 - "https://careers.flutterwave.com/".length)}`, description: descPaystack(), title: TITLE, company: COMPANY }],
  ])("%s → 400 bad_request, nothing stored", async (_label, body) => {
    const response = await s.paste(s.ada, body)
    expect(response.status, JSON.stringify(response.body)).toBe(400)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("bad_request")
    await expectNothingStored()
  })

  it("PD:252 the 2,049-character link is refused the same way as today's link-only over-long link", async () => {
    const url = `https://careers.flutterwave.com/${"a".repeat(2049 - "https://careers.flutterwave.com/".length)}`
    expect(url).toHaveLength(2049)
    const linkOnly = await s.paste(s.ada, { url })
    const withDescription = await s.paste(s.ada, { url, description: descPaystack(), title: TITLE, company: COMPANY })
    expect(withDescription.status).toBe(linkOnly.status)
    expect(apiErrorResponseSchema.parse(withDescription.body).error.code).toBe(apiErrorResponseSchema.parse(linkOnly.body).error.code)
  })
})

describe("PD-1.3 size bounds, after normalising (contract step 5)", () => {
  it.each([200, 201, 29_999, 30_000])("PD:133 a %i-character description (padded with spaces and line breaks) is stored whole", async (length) => {
    feedEvaluations()
    const text = descriptionOfLength(length, `QA-B${length}`)
    const response = await s.paste(s.ada, { description: `  \n ${text} \n\n  `, title: TITLE, company: COMPANY })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const pasted = pasteJobLinkResponseSchema.parse(response.body)
    expect(pasted).toMatchObject({ created: true, descriptionOutcome: "stored", applicationId: null, posting: { origin: "pasted_description" } })
    const rows = await allPostings(s.database.db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.posting_text).toBe(text)
    expect(rows[0]!.posting_text).toHaveLength(length)
  })

  it.each([
    ["a description of 199 characters", descriptionOfLength(199), "job_description_too_short", "too_short"],
    ["199 characters padded with 50 leading and 50 trailing spaces", `${" ".repeat(50)}${descriptionOfLength(199)}${" ".repeat(50)}`, "job_description_too_short", "too_short"],
    ["only spaces and line breaks (no link)", "   \n\n \t  \r\n  ", "job_description_too_short", "too_short"],
    ["a description of 30,001 characters", descriptionOfLength(30_001), "job_description_too_long", "too_long"],
    ['30,000 characters followed by "Ignore the limit" (30,016)', `${descriptionOfLength(30_000)}Ignore the limit`, "job_description_too_long", "too_long"],
  ] as const)("PD:146 %s → 422 %s with fieldErrors [description %s], nothing stored, no evaluation", async (_label, description, code, problem) => {
    const response = await s.paste(s.ada, { description, title: TITLE, company: COMPANY })
    expectRefusal(response, 422, code, FIELD_CODE_MESSAGE[code], [fe("description", problem)])
    await expectNothingStored()
  })

  it("PD:161 a 45,000-character description is refused too long; no posting holds any part of it (never truncated)", async () => {
    const marker = "QA-NEVER-TRUNCATED-45000"
    const description = descriptionOfLength(45_000, marker)
    const response = await s.paste(s.ada, { description, title: TITLE, company: COMPANY })
    expectRefusal(response, 422, "job_description_too_long", PD_COPY.descriptionLong, [fe("description", "too_long")])
    await expectNothingStored()
  })

  it("PD:175 a crafted 30,001-character description with a non-ATS link and names is refused by the server", async () => {
    const response = await s.paste(s.ada, { url: LINKS.flutterwave, description: descriptionOfLength(30_001), title: TITLE, company: COMPANY })
    expectRefusal(response, 422, "job_description_too_long", PD_COPY.descriptionLong, [fe("description", "too_long")])
    await expectNothingStored()
  })

  it("PD:181 a 150-character description with a non-ATS link → too short; no posting for the link either", async () => {
    const response = await s.paste(s.ada, { url: LINKS.flutterwave, description: descriptionOfLength(150), title: TITLE, company: "Flutterwave" })
    expectRefusal(response, 422, "job_description_too_short", PD_COPY.descriptionShort, [fe("description", "too_short")])
    await expectNothingStored()
  })

  it("C-23 a 65,536-character string of U+0000 normalises to empty: 422 too_short, fast", async () => {
    const started = performance.now()
    const response = await s.ada.post(PASTE_PATH).send({ description: "\u0000".repeat(65_536), title: TITLE, company: COMPANY })
    const elapsed = performance.now() - started
    await s.settle()
    expectRefusal(response, 422, "job_description_too_short", PD_COPY.descriptionShort, [fe("description", "too_short")])
    // Generous bound for CI; the threat model asks for < 100 ms of normalising, measured here end to end over HTTP.
    expect(elapsed).toBeLessThan(1000)
    await expectNothingStored()
  })
})

describe("PD-1.4 Job title and Company (OQ-1; contract step 5)", () => {
  it.each([
    ["missing title", { title: "", company: COMPANY }, "job_title_required", [fe("title", "required")]],
    ["absent title key", { company: COMPANY }, "job_title_required", [fe("title", "required")]],
    ["missing company", { title: TITLE, company: "" }, "company_required", [fe("company", "required")]],
    ["both missing", { title: "", company: "" }, "job_title_required", [fe("title", "required"), fe("company", "required")]],
    ["title only spaces", { title: "   ", company: COMPANY }, "job_title_required", [fe("title", "required")]],
    ["company only zero-width spaces", { title: TITLE, company: "​​" }, "company_required", [fe("company", "required")]],
  ] as const)("PD:191 description only, %s → 422 %s with fieldErrors, nothing stored", async (_label, names, code, fieldErrors) => {
    const response = await s.paste(s.ada, { description: descPaystack(), ...names })
    expectRefusal(response, 422, code, FIELD_CODE_MESSAGE[code], [...fieldErrors])
    await expectNothingStored()
  })

  it("PD:205 a non-ATS (LinkedIn) link with a description and no names → 422 job_title_required, fieldErrors title and company required; nothing for the link", async () => {
    const response = await s.paste(s.ada, { url: LINKS.linkedIn, description: descPaystack() })
    expectRefusal(response, 422, "job_title_required", PD_COPY.titleMissing, [fe("title", "required"), fe("company", "required")])
    await expectNothingStored()
    expect(s.outbound.urls).toEqual([])
  })

  it("contract step 5 order: a short description and missing names → code of the first entry (description), every entry listed", async () => {
    const response = await s.paste(s.ada, { description: descriptionOfLength(120) })
    expectRefusal(response, 422, "job_description_too_short", PD_COPY.descriptionShort, [fe("description", "too_short"), fe("title", "required"), fe("company", "required")])
    await expectNothingStored()
  })

  it("PD:211 title and company are cleaned like stored posting names", async () => {
    feedEvaluations()
    const response = await s.paste(s.ada, { description: descPaystack("QA-PD211"), title: "  Senior\tFrontend\n Engineer  ", company: "Pay\u0007stack  Ltd" })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(pasteJobLinkResponseSchema.parse(response.body).posting).toMatchObject({ title: "Senior Frontend Engineer", company: "Pay stack Ltd" })
    const [row] = await allPostings(s.database.db)
    expect(row).toMatchObject({ title: "Senior Frontend Engineer", company: "Pay stack Ltd" })
  })

  it("PD:217 a 200-character title is stored whole", async () => {
    feedEvaluations()
    const title = `Senior ${"F".repeat(193)}`
    expect(title).toHaveLength(200)
    const response = await s.paste(s.ada, { description: descPaystack("QA-PD217"), title, company: COMPANY })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const [row] = await allPostings(s.database.db)
    expect(row!.title).toBe(title)
  })

  it("PD:222 a 201-character title and a 250-character company → 422 job_title_too_long with both too_long; nothing stored, never cut", async () => {
    const response = await s.paste(s.ada, { description: descPaystack(), title: "T".repeat(201), company: "C".repeat(250) })
    expectRefusal(response, 422, "job_title_too_long", PD_COPY.titleTooLong, [fe("title", "too_long"), fe("company", "too_long")])
    await expectNothingStored()
  })

  it("PD:222 a 201-character company alone → 422 company_too_long", async () => {
    const response = await s.paste(s.ada, { description: descPaystack(), title: TITLE, company: "C".repeat(201) })
    expectRefusal(response, 422, "company_too_long", PD_COPY.companyTooLong, [fe("company", "too_long")])
    await expectNothingStored()
  })

  it("contract step 5: a too-long name is refused even with an ATS link (names not required)", async () => {
    const response = await s.paste(s.ada, { url: LINKS.greenhouse, description: descPaystack(), title: "T".repeat(201) })
    expectRefusal(response, 422, "job_title_too_long", PD_COPY.titleTooLong, [fe("title", "too_long")])
    await expectNothingStored()
    expect(s.outbound.urls).toEqual([])
  })

  it("PD:227 the stored names are what she typed, not what the text says", async () => {
    feedEvaluations()
    const description = `Company: Andela. Role: Staff Engineer.\n${descPaystack("QA-PD227")}`
    const response = await s.paste(s.ada, { description, title: TITLE, company: COMPANY })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(pasteJobLinkResponseSchema.parse(response.body).posting).toMatchObject({ title: TITLE, company: COMPANY })
    const [row] = await allPostings(s.database.db)
    expect(row).toMatchObject({ title: TITLE, company: COMPANY })
  })

  it("C-33 a refusal body never echoes a submitted value", async () => {
    const marker = "ZX-ECHO-MARKER-5521"
    const response = await s.paste(s.ada, { description: `${descPaystack()} ${marker}`, title: `${marker} title` })
    expect(response.status).toBe(422)
    expect(JSON.stringify(response.body)).not.toContain(marker)
    const long = await s.paste(s.ada, { description: descriptionOfLength(30_001, marker), title: TITLE, company: COMPANY })
    expect(JSON.stringify(long.body)).not.toContain(marker)
  })
})

describe("PD-1.5 a link sent with a description is validated first (contract step 4)", () => {
  it.each(["not a url", "javascript:alert(1)", "ftp://example.com/job/1", "https://user:pw@example.com/job/1"])("PD:238 %s with a description → 422 job_link_invalid alone, nothing stored", async (url) => {
    const response = await s.paste(s.ada, { url, description: descPaystack(), title: TITLE, company: COMPANY })
    expectRefusal(response, 422, "job_link_invalid", PD_COPY.linkInvalid)
    await expectNothingStored()
  })

  it("PD-1.5 an invalid link wins over field errors: job_link_invalid with no fieldErrors", async () => {
    const response = await s.paste(s.ada, { url: "not a url", description: descriptionOfLength(10) })
    expectRefusal(response, 422, "job_link_invalid", PD_COPY.linkInvalid)
    await expectNothingStored()
  })
})

describe("PD-1.2 link-only is unchanged (contract steps 2 and 3)", () => {
  it("PD:91 (api part) a link-only Greenhouse paste: today's result plus descriptionOutcome, applicationId and waitingReason null", async () => {
    feedEvaluations()
    s.google.server.use(atsStubs.greenhouseOk())
    const response = await s.paste(s.ada, { url: LINKS.greenhouse })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const pasted = pasteJobLinkResponseSchema.parse(response.body)
    expect(pasted).toMatchObject({ created: true, descriptionOutcome: null, applicationId: null, posting: { origin: "pasted_link" } })
    expect(s.outbound.urls.some((url) => url.includes("boards-api.greenhouse.io/v1/boards/acme/jobs/4012345"))).toBe(true)
  })

  it("PD:99 a blank description (spaces and line breaks) with a link is a link-only paste; names are not asked for", async () => {
    s.google.server.use(atsStubs.leverOk())
    feedEvaluations()
    const response = await s.paste(s.ada, { url: LINKS.lever, description: "   \n\n   " })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(pasteJobLinkResponseSchema.parse(response.body)).toMatchObject({ descriptionOutcome: null, posting: { origin: "pasted_link" } })
  })

  it("contract step 2: on a link-only paste title and company are ignored and not validated", async () => {
    const response = await s.paste(s.ada, { url: LINKS.flutterwave, title: "T".repeat(500), company: "" })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const pasted = pasteJobLinkResponseSchema.parse(response.body)
    expect(pasted).toMatchObject({ descriptionOutcome: null, posting: { origin: "pasted_link" } })
    expect(pasted.posting.title).not.toBe("T".repeat(500))
  })

  it("PD:105 / EV:115 a link-only non-ATS paste: pasted_link, empty text, skipped unsupported, hidden undated, no AI call, no fetch", async () => {
    const response = await s.paste(s.ada, { url: LINKS.flutterwave })
    expect(response.status).toBe(201)
    expect(pasteJobLinkResponseSchema.parse(response.body)).toMatchObject({
      created: true,
      descriptionOutcome: null,
      applicationId: null,
      waitingReason: null,
      posting: { origin: "pasted_link", status: "skipped", skipReason: "unsupported_application_system", postedAt: null, hiddenReason: "undated" },
    })
    const [row] = await allPostings(s.database.db)
    expect(row!.posting_text).toBe("")
    expect(s.anthropic.requests).toHaveLength(0)
    expect(s.outbound.urls).toEqual([])
  })

  it.each([
    ["", "job_link_empty", "Paste a job link."],
    ["not a url", "job_link_invalid", PD_COPY.linkInvalid],
    ["ftp://example.com/1", "job_link_invalid", PD_COPY.linkInvalid],
  ])("PD:112 link-only %j → 422 %s with today's message, nothing stored", async (url, code, message) => {
    const response = await s.paste(s.ada, { url })
    expectRefusal(response, 422, code, message)
    await expectNothingStored()
  })

  it("contract step 3: a description key holding only whitespace and no link → 422 job_description_too_short (not job_link_empty)", async () => {
    const response = await s.paste(s.ada, { url: "  ", description: " \n " })
    expectRefusal(response, 422, "job_description_too_short", PD_COPY.descriptionShort, [fe("description", "too_short")])
    await expectNothingStored()
  })
})

describe("C-29 normalisation of stored text and names", () => {
  it("removes C0/C1 and bidi controls and turns \\r\\n into \\n; a bidi override in the title becomes a space", async () => {
    feedEvaluations()
    const body = descPaystack("QA-C29")
    const dirty = `‮${body.slice(0, 100)}\r\n⁦${body.slice(100, 400)}\u0000\u0085${body.slice(400)}\r`
    const response = await s.paste(s.ada, { description: dirty, title: "A‮evil", company: COMPANY })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const [row] = await allPostings(s.database.db)
    expect(row!.posting_text).toBe(`${body.slice(0, 100)}\n${body.slice(100, 400)}${body.slice(400)}`)
    for (const ch of ["‮", "⁦", "\u0000", "\u0085", "\r"]) expect(row!.posting_text.includes(ch)).toBe(false)
    expect(row!.title).toBe("A evil")
  })
})
