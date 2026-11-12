import type { INestApplication } from "@nestjs/common"
import { jobPostingDetailSchema, roleFamilySchema } from "@eve/contracts"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { TenantDatabase } from "../src/db/tenant-database.js"
import { DiscoveryPipeline } from "../src/discovery/discovery-pipeline.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { ALL_FAMILIES, clearPostings, factsOf, list, resetCriteria, setCriteria } from "./support/epic-0006.js"
import { greenhouseJob } from "./fixtures/epic-0006-sources.js"

/**
 * EPIC-0006 QA test authoring (step [5e]): the store-time classifier (AC-1.3,
 * AC-1.4) and the seniority marker (AC-2.2 to AC-2.4), black-box. Each title
 * is discovered from a recorded Greenhouse board response dated 2026-10-20,
 * then read back through GET /v1/job-postings/{id} (roleFamily, hiddenReason)
 * and the stored shared facts. No implementation function is imported, so the
 * tests hold whatever the classifier's internal names are.
 * Source: role-family-catalog.feature, seniority-floor.feature.
 * Expected to fail until the EPIC-0006 backend lands.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let ada: SignedInCandidate
const clock = new TestClock("2026-10-24T08:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
})

beforeEach(async () => {
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  await clearPostings(database.db)
  await resetCriteria(database.db)
  await database.db.updateTable("employer_board").set({ last_read_at: null }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

/** Discovers each title once from the canonical Greenhouse board; returns id by title. */
async function discoverTitles(titles: readonly string[]): Promise<Map<string, string>> {
  const jobs = titles.map((title, i) => ({ ...greenhouseJob(7000 + i, title, { first_published: "2026-10-20T10:00:00Z" }), content: "Remote, open to candidates in Nigeria." }))
  google.server.use(
    http.get("https://boards-api.greenhouse.io/v1/boards/:token/jobs", ({ params }) => HttpResponse.json(params.token === "canonical" ? { jobs } : { jobs: [] })),
    http.get("https://api.lever.co/v0/postings/:token", () => HttpResponse.json([])),
    http.get("https://api.ashbyhq.com/posting-api/job-board/:token", () => HttpResponse.json({ jobs: [] }))
  )
  await app.get(TenantDatabase).asOperator(() => app.get(DiscoveryPipeline).runDaily({ ignoreApproval: true }))
  const rows = await database.db.selectFrom("job_posting").select(["id", "requisition_id"]).execute()
  return new Map(rows.map((r) => [titles[Number(r.requisition_id.slice(3)) - 7000]!, r.id]))
}

async function familyOf(title: string): Promise<string | null> {
  const id = (await discoverTitles([title])).get(title)!
  return (await factsOf(database.db, id)).role_family
}

describe("AC-1.1 @AC-1.1 the contract catalog has exactly thirteen keys in AC-1.2 order", () => {
  it("roleFamilySchema options", () => {
    expect(roleFamilySchema.options).toEqual([...ALL_FAMILIES])
  })
})

describe("AC-1.3 @AC-1.3 @AC-1.4 the classifier, read back after discovery (role-family-catalog:84-247)", () => {
  const fixture: [string, string][] = [
    ["Solutions Architect", "solutions_customer"],
    ["TAM Architect", "solutions_customer"],
    ["Customer Architect", "solutions_customer"],
    ["Senior Data Engineer", "data_ml"],
    ["Lead Machine Learning Engineer", "data_ml"],
    ["Senior Platform Engineer", "platform_engineering"],
    ["Site Reliability Engineer", "devops_platform"],
    ["DevOps Engineer", "devops_platform"],
    ["Senior Software Engineer", "software_engineering"],
    ["Staff Engineer", "software_engineering"],
    ["Principal Software Engineer", "software_engineering"],
    ["Staff Frontend Engineer", "senior_frontend"],
    ["Senior Backend Engineer", "backend"],
    ["Lead Engineer", "technical_lead"],
    ["Engineering Manager", "people_management"],
    ["Senior iOS Engineer", "mobile"],
    ["Product Engineer", "product_engineering"],
    ["Full Stack Developer", "fullstack"],
    ["QA Automation Engineer", "other"],
    ["Hardware Engineer", "other"],
    // Boundary rows
    ["Software Engineer", "software_engineering"],
    ["Senior Software Developer", "software_engineering"],
    ["Principal Engineer", "software_engineering"],
    ["Développeur", "software_engineering"],
    ["Softwareentwickler", "software_engineering"],
    ["Platform Engineer", "platform_engineering"],
    ["Machine Learning Engineer", "data_ml"],
    ["ML Engineer", "data_ml"],
    ["AI Engineer", "data_ml"],
    ["Analytics Engineer", "data_ml"],
    ["MLOps Engineer", "data_ml"],
    ["Solution Architect", "solutions_customer"],
    // Precedence
    ["Data Engineering Lead", "data_ml"],
    ["Lead Data Engineer", "data_ml"],
    ["Machine Learning Engineering Manager", "data_ml"],
    ["Head of Data Engineering", "data_ml"],
    ["Solutions Architect Lead", "solutions_customer"],
    ["Solutions Architect Manager", "solutions_customer"],
    ["Engineering Manager, Platform", "people_management"],
    ["Lead Engineer, Platform", "technical_lead"],
    ["Fullstack Platform Engineer", "fullstack"],
    ["Frontend Platform Engineer", "senior_frontend"],
    ["Backend Platform Engineer", "backend"],
    ["Mobile Platform Engineer", "mobile"],
    ["Staff Software Engineer, Frontend", "senior_frontend"],
    ["Senior Software Engineer, Backend", "backend"],
    ["Platform Engineer (DevOps)", "platform_engineering"],
    ["Platform Reliability Engineer", "platform_engineering"],
    ["DevOps Software Engineer", "devops_platform"],
    ["Software Engineer, SRE", "devops_platform"],
    ["Platform Engineering Specialist", "platform_engineering"],
    ["SRE", "devops_platform"],
    ["Infrastructure Engineer", "devops_platform"],
    ["Cloud Engineer", "devops_platform"],
    // Folding
    ["SENIOR DATA ENGINEER", "data_ml"],
    ["solutions architect", "solutions_customer"],
    ["DÉVELOPPEUR", "software_engineering"],
    ["Senior   Platform   Engineer", "platform_engineering"],
  ]

  it("every fixture title is stored with its expected family at first insert (one discovery run)", async () => {
    const titles = [...new Set(fixture.map(([t]) => t))]
    const byTitle = await discoverTitles(titles)
    const mismatches: string[] = []
    for (const [title, family] of fixture) {
      const id = byTitle.get(title)
      const got = id ? (await factsOf(database.db, id)).role_family : "(not stored)"
      if (got !== family) mismatches.push(`${title}: expected ${family}, got ${got}`)
    }
    expect(mismatches).toEqual([])
    expect(anthropic.requests).toHaveLength(0)
  })

  it.each([
    ["Metadata Platform Engineer", "data_ml"],
    ["Taming Chaos Engineer", "solutions_customer"],
    ["Datadog Integrations Engineer", "data_ml"],
  ])("role-family-catalog:209 %s is not %s (no match inside a longer word)", async (title, notFamily) => {
    expect(await familyOf(title)).not.toBe(notFamily)
  })

  it("the detail's roleFamily equals the stored family, and an off-target family is hidden with reason off_target", async () => {
    const id = (await discoverTitles(["Solutions Architect"])).get("Solutions Architect")!
    const detail = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${id}`).expect(200)).body)
    expect(detail).toMatchObject({ roleFamily: "solutions_customer", hiddenReason: "off_target", status: "not_checked" })
  })

  it.each([
    "Data Scientist",
    "Lead Data Scientist",
    "Head of Data Science",
    "Technical Account Manager",
    "Technical Account Manager, Enterprise",
    "Manager, Technical Account Management",
    "TAM",
    "Sales Architect",
    "Solutions Engineer",
    "Member of Technical Staff",
  ])("role-family-catalog:136 (r5, P17) %s is stored skipped not_software_role with a null family and no AI call", async (title) => {
    const id = (await discoverTitles([title])).get(title)!
    expect((await factsOf(database.db, id)).role_family).toBeNull()
    const row = await database.db.selectFrom("candidate_posting").select(["status", "skip_reason"]).where("job_posting_id", "=", id).executeTakeFirstOrThrow()
    expect(row).toEqual({ status: "skipped", skip_reason: "not_software_role" })
    expect(anthropic.requests).toHaveLength(0)
  })

  it("role-family-catalog: a pre-filter skip keeps a null family", async () => {
    const id = (await discoverTitles(["Hotline Paralegal"])).get("Hotline Paralegal")!
    expect((await factsOf(database.db, id)).role_family).toBeNull()
  })
})

describe("AC-2.2 @AC-2.2 @AC-2.3 @AC-2.4 seniority floor, read back after discovery (seniority-floor.feature)", () => {
  const below = [
    "Junior Frontend Developer",
    "Jr. Software Engineer",
    "Software Engineering Intern",
    "Graduate Software Engineer",
    "Entry-Level Developer",
    "Apprentice Developer",
    "Frontend Intern",
    "Frontend Engineering Internship",
    "Junior Backend Engineer",
    "Jr Backend Engineer",
    "Graduate Developer",
    "Grad Software Engineer",
    "New Grad Software Engineer",
    "Entry Level Software Engineer",
    "Entry-level Frontend Engineer",
    "Apprentice Software Engineer",
    "Software Engineering Apprenticeship",
    "Trainee Developer",
    "Stagiaire Développeur Web",
    "Alternance Développeur Full Stack",
    "Becario Desarrollo Frontend",
    "Becaria Desarrollo Backend",
    "Pasante de Desarrollo",
    "Praktikant Softwareentwicklung",
    "Praktikantin Frontend",
    "Werkstudent Softwareentwicklung",
    "Werkstudentin Frontend",
    "JUNIOR FRONTEND DEVELOPER",
    "junior frontend developer",
    "Jr. Developer",
    "(Junior) Developer",
    "Junior-Developer",
    "ENTRY LEVEL ENGINEER",
    "Stagiaire Développeur",
    "STAGIAIRE DÉVELOPPEUR",
    "Leadership Development Intern",
    "Midwest Junior Developer",
    "Seniority Systems Junior Developer",
    "Staffing Platform Intern",
    "Leader Junior Developer",
  ]
  const notBelow = [
    "Internal Tools Engineer",
    "International Payments Engineer",
    "Senior/Junior Developer",
    "Mid-level Engineer",
    "Software Engineer",
    "Associate Software Engineer",
    "Software Engineer I",
    "Junior to Mid Frontend Developer",
    "Junior/Mid-level Engineer",
    "Intermediate or Junior Developer",
    "Senior Engineer, Graduate Program",
    "Sr. Engineer (Intern Mentor)",
    "Staff Engineer, Apprenticeship Platform",
    "Principal Engineer, Graduate Hiring",
    "Lead Engineer, Intern Program",
    "Frontend Engineer",
    "Software Engineer II",
    "Intermediate Developer",
    "Senior Frontend Engineer",
    "Staff Engineer",
    "Engineering Manager",
    "Junior Developer (SENIOR team)",
    "Junior Developer - Sr. track",
    "Interned Systems Engineer",
    "Gradle Build Engineer",
    "Upgrade Engineer",
    "Juniper Network Engineer",
    "Associate Frontend Developer",
    "Frontend Engineer 1",
  ]

  it("seniority-floor:26-180 entry-marked titles are stored 'entry'; the others are not", async () => {
    const byTitle = await discoverTitles([...below, ...notBelow])
    const wrong: string[] = []
    for (const title of below) {
      const id = byTitle.get(title)
      const marker = id ? (await factsOf(database.db, id)).seniority_marker : "(not stored)"
      if (marker !== "entry") wrong.push(`${title}: expected entry, got ${marker}`)
    }
    for (const title of notBelow) {
      const id = byTitle.get(title)
      const marker = id ? (await factsOf(database.db, id)).seniority_marker : "(not stored)"
      if (marker === "entry" || marker === null) wrong.push(`${title}: expected mid_plus or none, got ${marker}`)
    }
    expect(wrong).toEqual([])
  })

  it("seniority-floor:180 with all target families, entry titles are hidden as below_seniority_floor, and Show all levels shows them", async () => {
    await setCriteria(database.db, database.operatorId, { targets: ALL_FAMILIES })
    const id = (await discoverTitles(["Werkstudent Frontend"])).get("Werkstudent Frontend")!
    expect(jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${id}`).expect(200)).body).hiddenReason).toBe("below_seniority_floor")
    await setCriteria(database.db, database.operatorId, { floor: "all_levels" })
    expect((await list(ada, "tab=all")).postings.map((p) => p.id)).toContain(id)
  })

  it("seniority-floor:202 @AC-2.4 an untitled pasted posting gets no marker and is never below the floor", async () => {
    google.server.use(
      http.get("https://api.lever.co/v0/postings/globex/untitled-1", () =>
        HttpResponse.json({ id: "untitled-1", text: "   ", hostedUrl: "https://jobs.lever.co/globex/untitled-1", descriptionPlain: "Junior developer internship", createdAt: 1792497600000 })
      )
    )
    const response = await ada.post("/v1/job-postings/links").send({ url: "https://jobs.lever.co/globex/untitled-1" })
    expect([200, 201]).toContain(response.status)
    const id = response.body.posting.id as string
    expect((await factsOf(database.db, id)).seniority_marker).toBeNull()
    expect(response.body.posting.hiddenReason).not.toBe("below_seniority_floor")
  })

  it("seniority-floor:215 the description and company never decide the floor", async () => {
    const jobs = [{ ...greenhouseJob(7999, "Frontend Engineer", { first_published: "2026-10-20T10:00:00Z" }), content: "Junior developer internship for graduates.", company_name: "Junior Achievement" }]
    google.server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/:token/jobs", ({ params }) => HttpResponse.json(params.token === "canonical" ? { jobs } : { jobs: [] })),
      http.get("https://api.lever.co/v0/postings/:token", () => HttpResponse.json([])),
      http.get("https://api.ashbyhq.com/posting-api/job-board/:token", () => HttpResponse.json({ jobs: [] }))
    )
    await app.get(TenantDatabase).asOperator(() => app.get(DiscoveryPipeline).runDaily({ ignoreApproval: true }))
    const row = await database.db.selectFrom("job_posting").select("id").executeTakeFirstOrThrow()
    expect((await factsOf(database.db, row.id)).seniority_marker).not.toBe("entry")
  })
})
