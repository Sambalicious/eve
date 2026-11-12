import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { careerProfileResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CareerProfileService } from "../src/career-profile/career-profile.service.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { SYNTHETIC_RESUME_LINES, buildPdf } from "./support/resume-fixtures.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/** career-profile.feature @r4 resume lines; the extra lines carry the Gherkin quotes. */
const RESUME = buildPdf([...SYNTHETIC_RESUME_LINES, "BSc Computer Science, University of Lagos, 2014"])
const HEADING_QUOTE = "Brightwave Ltd, Senior Frontend Engineer, 2021-2024"
const BRIGHTWAVE_QUOTE = "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024"

/** Four facts every scenario keeps, so "5 facts, one dropped" leaves 4. */
const FOUR_KEPT = [
  { text: BRIGHTWAVE_QUOTE, sourceQuote: BRIGHTWAVE_QUOTE },
  { text: "Cut checkout page load time by 38%", sourceQuote: "Cut checkout page load time by 38% by moving to server rendering" },
  { text: "Built the merchant dashboard in React and TypeScript", sourceQuote: "Built the merchant dashboard in React and TypeScript" },
  { text: "Skilled in React, TypeScript, Node.js and GraphQL", sourceQuote: "Skills: React, TypeScript, Node.js, GraphQL" },
]

function experience(facts: { text: string; sourceQuote: string }[], heading: { title?: string; organization?: string; period?: string } = {}) {
  return {
    kind: "experience",
    title: heading.title ?? "Senior Frontend Engineer",
    organization: heading.organization ?? "Brightwave Ltd",
    period: heading.period ?? "2021–2024",
    sourceQuote: HEADING_QUOTE,
    facts,
  }
}

let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
let storageDir: string

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "ja-claims-"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
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
  for (const table of ["career_profile_version", "ai_call", "resume_upload"] as const) await database.db.deleteFrom(table).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storageDir, { recursive: true, force: true })
})

async function draftWith(extraction: unknown) {
  anthropic.replyWithObject(extraction)
  await candidate.post("/v1/career-profile/resume").attach("resume", RESUME, { filename: "ada-okafor-resume.pdf", contentType: "application/pdf" }).expect(202)
  await app.get(CareerProfileService).settled()
  return careerProfileResponseSchema.parse((await candidate.get("/v1/career-profile").expect(200)).body)
}

const factTexts = (profile: Awaited<ReturnType<typeof draftWith>>) => profile.draft?.sections.flatMap((section) => section.facts.map((fact) => fact.text)) ?? []

// career-profile.feature @r4, fact-to-quote consistency (CR2-02, SEC-203).
describe("fact-to-quote consistency over HTTP (@r4)", () => {
  it("keeps a fact that rephrases its quote without adding claims: 0 dropped", async () => {
    const profile = await draftWith({ sections: [experience([{ text: "Led 4 frontend engineers at Brightwave Ltd from 2021 to 2024", sourceQuote: BRIGHTWAVE_QUOTE }])] })
    expect(factTexts(profile)).toEqual(["Led 4 frontend engineers at Brightwave Ltd from 2021 to 2024"])
    expect(profile.draft?.droppedFactCount).toBe(0)
  })

  it("keeps a section whose title, employer and dates match its quote, and returns the section quote", async () => {
    const profile = await draftWith({ sections: [experience([FOUR_KEPT[0]!])] })
    expect(profile.draft?.sections[0]).toMatchObject({ title: "Senior Frontend Engineer", organization: "Brightwave Ltd", period: "2021–2024", sourceQuote: HEADING_QUOTE })
  })

  it.each([
    ["qualification", "Holds a PhD in Computer Science from MIT", "BSc Computer Science, University of Lagos, 2014"],
    ["number", "Led a team of 12 frontend engineers at Brightwave Ltd", BRIGHTWAVE_QUOTE],
    ["employer", "Led a team of 4 frontend engineers at Kora Payments, 2021-2024", BRIGHTWAVE_QUOTE],
    ["dates", "Led a team of 4 frontend engineers at Brightwave Ltd, 2018-2024", BRIGHTWAVE_QUOTE],
    ["title", "Engineering Manager for 4 frontend engineers at Brightwave Ltd", BRIGHTWAVE_QUOTE],
  ])("drops a fact with an unsupported %s: 4 facts kept, 1 dropped", async (_label, fact, quote) => {
    const profile = await draftWith({ sections: [experience([...FOUR_KEPT, { text: fact, sourceQuote: quote }])] })
    expect(factTexts(profile)).not.toContain(fact)
    expect(factTexts(profile)).toHaveLength(4)
    expect(profile.draft?.version).toBe(1)
    expect(profile.draft?.droppedFactCount).toBe(1)
  })

  it.each([
    ["title", { title: "Engineering Manager" }],
    ["employer", { organization: "Brightwave Inc" }],
    ["dates", { period: "2019-2024" }],
  ])("drops a section with an unsupported %s together with its 3 facts, all counted", async (_label, heading) => {
    const bad = experience(FOUR_KEPT.slice(0, 3), heading)
    const good = { kind: "skills", title: "Skills", organization: null, period: null, sourceQuote: "Skills: React, TypeScript, Node.js, GraphQL", facts: [FOUR_KEPT[3]!] }
    const profile = await draftWith({ sections: [bad, good] })
    expect(profile.draft?.sections.map((section) => section.title)).toEqual(["Skills"])
    expect(profile.draft?.droppedFactCount).toBe(3)
  })

  it("counts a quote-not-in-resume drop and a claim drop in the same droppedFactCount", async () => {
    const profile = await draftWith({
      sections: [
        experience([
          ...FOUR_KEPT.slice(0, 3),
          { text: "Managed a budget of USD 2 million", sourceQuote: "Managed a budget of USD 2 million across three product lines" },
          { text: "Holds a PhD in Computer Science from MIT", sourceQuote: "BSc Computer Science, University of Lagos, 2014" },
        ]),
      ],
    })
    expect(factTexts(profile)).toHaveLength(3)
    expect(profile.draft?.droppedFactCount).toBe(2)
  })

  it("a fact the Candidate edits has no source quote and is not checked against one", async () => {
    const drafted = await draftWith({ sections: [experience([FOUR_KEPT[0]!])] })
    await candidate.post("/v1/career-profile/draft/approve").send({ version: 1 }).expect(200)
    const section = drafted.draft!.sections[0]!
    const saved = await candidate
      .put("/v1/career-profile/draft")
      .send({
        sections: [
          {
            id: section.id,
            kind: section.kind,
            title: section.title,
            organization: section.organization,
            period: section.period,
            facts: [{ id: section.facts[0]!.id, text: "Led a team of 5 frontend engineers at Brightwave Ltd, 2021–2024" }],
          },
        ],
      })
      .expect(200)
    expect(saved.body.sections[0].facts[0]).toMatchObject({ text: "Led a team of 5 frontend engineers at Brightwave Ltd, 2021–2024", sourceQuote: null })
    expect(saved.body.version).toBe(2)
  })
})
