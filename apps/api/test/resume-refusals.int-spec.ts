import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { apiErrorResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CareerProfileService } from "../src/career-profile/career-profile.service.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { flateBombPdf, manyPagesPdf, textPdf } from "./support/hostile-resumes.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { buildDocx, buildPdf, buildRawDocx } from "./support/resume-fixtures.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

const PDF = "application/pdf"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const MESSAGE = "Couldn't draft a Career Profile from this file."

let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
let storageDir: string

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "ja-refusals-"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock: new TestClock(new Date()), config: { candidateStorageDir: markStorageMigratedSync(storageDir) } })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
  await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
})

beforeEach(async () => {
  await app.get(CareerProfileService).settled()
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  outbound.reset()
  for (const table of ["career_profile_version", "ai_call", "resume_upload"] as const) await database.db.deleteFrom(table).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storageDir, { recursive: true, force: true })
})

function upload(bytes: Buffer, filename: string, contentType: string) {
  return candidate.post("/v1/career-profile/resume").attach("resume", bytes, { filename, contentType })
}

/** Text that is exactly `length` characters once extracted (one DOCX paragraph, varied words). */
function textOfLength(length: number): string {
  const words = "Led frontend teams shipping payments dashboards in React and TypeScript across Lagos "
  return words.repeat(Math.ceil(length / words.length)).slice(0, length).replace(/\s+$/, (tail) => "x".repeat(tail.length))
}

/**
 * Three pages whose extracted text totals over `length` characters. pdf.js keeps only
 * text inside the page box, so each page carries many columns of short lines.
 */
function threePagePdfOfLength(length: number): Buffer {
  const line = "Led frontend teams in Lagos, 2021-2024"
  const perPage = Math.ceil(length / 3 / (line.length + 1)) + 20
  return textPdf(Array.from({ length: 3 }, () => Array.from({ length: perPage }, () => line)))
}

/**
 * A DOCX inside every zip limit whose parse needs more than the extraction child's
 * 128 MB heap: 150,000 short runs in one paragraph (4 MB of XML, under the 8 MB entry
 * limit, at a ratio below 100:1 thanks to varied text). Measured: heap abort in about 3 s.
 */
function heavyParseDocx(): Buffer {
  const runs = Array.from({ length: 150_000 }, (_, i) => `<w:r><w:t>${(i * 7919).toString(36)}</w:t></w:r>`).join("")
  return buildRawDocx(`<w:p>${runs}</w:p>`)
}

/** A 2 MB document part that deflates far beyond 100:1 (the ratio rule applies above 1 MB). */
function highRatioDocx(): Buffer {
  return buildDocx(["a".repeat(2 * 1024 * 1024)])
}

// career-profile.feature @r4 "A resume that breaches a resume limit is refused with its reason and sent nowhere".
describe("resume refusals name their reason (@r4, decision 2026-10-18)", () => {
  it.each([
    ["a PDF of 21 pages", () => manyPagesPdf(21), PDF, "pages"],
    ["a DOCX whose extracted text is 60,001 characters", () => buildDocx([textOfLength(60_001)]), DOCX, "characters"],
    ["a 3-page PDF whose extracted text is over 60,000 characters", () => threePagePdfOfLength(60_001), PDF, "characters"],
    ["a scanned PDF with no extractable text", () => buildPdf(["Hi"]), PDF, "no_text"],
    ["a DOCX with 201 zip entries", () => buildDocx(undefined, Array.from({ length: 201 }, (_, i) => [`word/media/x${i}.xml`, "<a/>"] as const)), DOCX, "docx_limits"],
    ["a DOCX whose entries total more than 20 MB uncompressed", () => buildDocx(undefined, Array.from({ length: 3 }, (_, i) => [`word/media/big${i}.xml`, "b".repeat(7 * 1024 * 1024)] as const)), DOCX, "docx_limits"],
    ["a DOCX with one entry over 8 MB uncompressed", () => buildDocx(undefined, [["word/media/huge.xml", "c".repeat(9 * 1024 * 1024)]]), DOCX, "docx_limits"],
    ["a DOCX with a 2 MB entry compressed more than 100:1", highRatioDocx, DOCX, "docx_limits"],
    ["a DOCX within the zip limits whose extraction passes the parse limits", heavyParseDocx, DOCX, "parse_limits"],
    ["a PDF whose extraction uses more than 384 MB", () => flateBombPdf(512), PDF, "parse_limits"],
  ])("refuses $0 with resume_unreadable reason $3, stores nothing, sends nothing", { timeout: 60_000 }, async (_label, build, type, reason) => {
    const response = await upload(build(), "resume", type).expect(422)
    expect(apiErrorResponseSchema.parse(response.body)).toEqual({ error: { code: "resume_unreadable", message: MESSAGE, reason } })
    expect(outbound.urls).toEqual([])
    expect(await database.db.selectFrom("resume_upload").selectAll().execute()).toEqual([])
    expect(await database.db.selectFrom("career_profile_version").selectAll().execute()).toEqual([])
  })

  it.each([
    ["a PDF of exactly 20 pages", () => manyPagesPdf(20), PDF],
    ["a DOCX whose extracted text is exactly 60,000 characters", () => buildDocx([textOfLength(60_000)]), DOCX],
    ["a PDF of exactly 5,242,880 bytes", () => buildPdf(undefined, { padToBytes: 5_242_880 }), PDF],
  ])("accepts $0 for drafting with exactly one Anthropic request", { timeout: 60_000 }, async (_label, build, type) => {
    const bytes = build()
    anthropic.replyWithObject({ sections: [] })
    await upload(bytes, "resume", type).expect(202)
    await app.get(CareerProfileService).settled()
    expect(anthropic.requests).toHaveLength(1)
  })

  it("other error bodies carry no reason", async () => {
    const response = await upload(Buffer.from("not a resume"), "resume.pdf", PDF).expect(422)
    expect(response.body).toEqual({ error: { code: "resume_file_invalid", message: "Upload a PDF or DOCX resume up to 5 MB." } })
  })
})
