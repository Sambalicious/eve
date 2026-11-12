import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CareerProfileService } from "../src/career-profile/career-profile.service.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { flateBombPdf, manyPagesPdf, paragraphBombDocx, zipBombDocx } from "./support/hostile-resumes.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { buildPdf } from "./support/resume-fixtures.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const PDF_TYPE = "application/pdf"
/** The extraction kill timeout is 5 s; the refusal must arrive within it plus spawn and HTTP overhead. */
const MAX_REFUSAL_MS = 7_000
/**
 * The api is this test process. Unbounded in-process parsing of these files took
 * 15 s to 20+ min and up to 3.2 GiB (security-review E6/E7, and the probe in the
 * repair report), so both bounds fail without isolation.
 */
/** A health check answers in milliseconds when the event loop is free. */
const MAX_HEALTH_LATENCY_MS = 1_000
/** Growth of the api process (this test process) allowed while one hostile file is handled. */
const MAX_API_RSS_GROWTH_MB = 150

let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
let storageDir: string

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "ja-hostile-"))
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
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storageDir, { recursive: true, force: true })
})

type Probe = { latencies: number[]; failures: string[] }

/** Polls /v1/health every 100 ms until `until` settles, recording each answer's latency. */
async function healthWhile<T>(until: Promise<T>): Promise<Probe> {
  const probe: Probe = { latencies: [], failures: [] }
  let done = false
  void until.finally(() => (done = true)).catch(() => undefined)
  while (!done) {
    const started = Date.now()
    const response = await browser.http().get("/v1/health").then(
      (r) => r.status,
      (error: Error) => error.message
    )
    probe.latencies.push(Date.now() - started)
    if (response !== 200) probe.failures.push(String(response))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return probe
}

async function uploadHostile(bytes: Buffer, filename: string, contentType: string) {
  globalThis.gc?.()
  const rssBefore = process.memoryUsage().rss
  let rssPeak = rssBefore
  const sampler = setInterval(() => (rssPeak = Math.max(rssPeak, process.memoryUsage().rss)), 20)
  const started = Date.now()
  const upload = candidate.post("/v1/career-profile/resume").attach("resume", bytes, { filename, contentType }).then((r) => r)
  const health = await healthWhile(upload)
  const response = await upload
  const elapsedMs = Date.now() - started
  clearInterval(sampler)
  return { response, elapsedMs, health, rssGrowthMb: Math.round((rssPeak - rssBefore) / 1048576) }
}

// SEC-201: a hostile file under the 5 MB limit is refused in bounded time and memory, and the api keeps serving.
describe("hostile resumes (SEC-201)", () => {
  const cases: [string, () => Buffer, string, string, string][] = [
    ["the reviewer's paragraph bomb DOCX (4 million empty paragraphs, 397 KB)", () => paragraphBombDocx(4_000_000), "bomb.docx", DOCX_TYPE, "docx_limits"],
    ["a zip bomb DOCX (1 GB of text, about 1000:1)", () => zipBombDocx(1024), "zip-bomb.docx", DOCX_TYPE, "docx_limits"],
    ["a zip bomb DOCX that lies about its uncompressed size", () => zipBombDocx(1024, { lieAboutSize: true }), "liar.docx", DOCX_TYPE, "docx_limits"],
    ["a PDF whose stream inflates to 2 GB", () => flateBombPdf(2048), "flate.pdf", PDF_TYPE, "parse_limits"],
    ["a 3000-page PDF", () => manyPagesPdf(3000), "pages.pdf", PDF_TYPE, "pages"],
  ]

  it.each(cases)("refuses %s with resume_unreadable while /v1/health keeps answering", async (_label, build, filename, contentType, reason) => {
    // Built before measuring: generating a 1 GB bomb is test cost, not api cost.
    const bytes = build()
    expect(bytes.length).toBeLessThan(5 * 1024 * 1024)
    const result = await uploadHostile(bytes, filename, contentType)

    expect(result.response.status).toBe(422)
    expect(result.response.body).toEqual({ error: { code: "resume_unreadable", message: "Couldn't draft a Career Profile from this file.", reason } })
    expect(result.elapsedMs).toBeLessThan(MAX_REFUSAL_MS)
    expect(result.health.failures).toEqual([])
    expect(result.health.latencies.length).toBeGreaterThan(0)
    expect(Math.max(...result.health.latencies)).toBeLessThan(MAX_HEALTH_LATENCY_MS)
    expect(result.rssGrowthMb).toBeLessThan(MAX_API_RSS_GROWTH_MB)

    await browser.http().get("/v1/health").expect(200)
    await candidate.get("/v1/career-profile").expect(200)
    expect(anthropic.requests).toHaveLength(0)
    expect(await database.db.selectFrom("resume_upload").selectAll().execute()).toEqual([])
  })

  it("still drafts from a valid resume after the hostile ones", async () => {
    anthropic.replyWithObject({ sections: [] })
    await candidate.post("/v1/career-profile/resume").attach("resume", buildPdf(), { filename: "ada.pdf", contentType: PDF_TYPE }).expect(202)
    await app.get(CareerProfileService).settled()
    expect(anthropic.requests).toHaveLength(1)
    await database.db.deleteFrom("resume_upload").execute()
    await database.db.deleteFrom("ai_call").execute()
  })
})
