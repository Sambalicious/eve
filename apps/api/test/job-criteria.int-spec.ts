import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import {
  CSRF_HEADER,
  JOB_CRITERIA_PATH,
  apiErrorResponseSchema,
  jobCriteriaResponseSchema,
  jobPostingDetailSchema,
  jobPostingsResponseSchema,
} from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { foldForKeywords } from "../src/discovery/rules/rule-result.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { DocumentsRepository } from "../src/documents/documents.repository.js"
import { JobCriteriaRepository } from "../src/job-criteria/job-criteria.repository.js"
import { JobCriteriaSaveLimiter } from "../src/job-criteria/job-criteria-save-limit.guard.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { backendPid, untilLockWait } from "./support/lock-wait.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { CANDIDATE_EMAIL, CANDIDATE_SUB, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { holdAllPostings, insertPostingFor, postingsOf, setCandidatePosting } from "./support/candidate-posting.js"
import { ROLE_RELEVANCE_DEFAULTS } from "./support/job-criteria-body.js"

/**
 * EPIC-0004 against the real api and Postgres: the Job criteria endpoint
 * (job-criteria-settings.feature), save-time re-decision
 * (re-decision-on-save.feature) and the Postings read path
 * (postings-page.feature, AC 4.4, 4.5). Postings are seeded with stored Match
 * evidence the way an evaluation leaves them.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
const clock = new TestClock("2026-10-21T09:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

beforeEach(async () => {
  clock.set("2026-10-21T09:00:00.000Z")
  // SEC-006: these tests share one session at a fixed time; the limit has its own spec.
  app.get(JobCriteriaSaveLimiter).reset()
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  outbound.reset()
  await database.db.deleteFrom("application").execute()
  await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
  await database.db.deleteFrom("ai_call").execute()
  await database.db.updateTable("job_criteria").set({ min_core_match_percent: 70, frameworks: [], technologies: [], target_role_families: [...ROLE_RELEVANCE_DEFAULTS.targetRoleFamilies], seniority_floor: ROLE_RELEVANCE_DEFAULTS.seniorityFloor, version: 1 }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

type Seed = {
  name?: string
  status?: "ranked" | "skipped" | "excluded" | "checking" | "waiting_to_be_checked" | "evaluation_failed"
  skipReason?: string | null
  skipDetail?: string | null
  covered?: number
  total?: number
  /** Omit for no Match evidence. */
  evidence?: boolean
  /** null = no technology data (evaluated before EPIC-0004). */
  technologies?: { name: string; quote: string }[] | null
  criteriaVersion?: number
  careerProfileVersion?: number
  /** Stored role family (slice 8 family filter); default senior_frontend. */
  family?: string
}

async function seed(options: Seed = {}): Promise<string> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/acme/jobs/${id}`
  const status = options.status ?? "ranked"
  await insertPostingFor(database.db, database.operatorId, {
      id,
      application_url: url,
      requisition_id: id.slice(0, 8),
      apply_url: url,
      application_system: "Greenhouse",
      apply_mode: "automatic",
      origin: "employer_board",
      employer_board_id: null,
      remote_board_key: null,
      attribution_name: null,
      attribution_url: null,
      title: options.name ?? "Frontend Engineer at Initech",
      title_folded: foldForKeywords(options.name ?? "Frontend Engineer at Initech"),
      company: "Initech",
      posting_text: "Remote. Build React features.",
      status,
      skip_reason: options.skipReason ?? null,
      skip_detail: options.skipDetail ?? null,
      evaluation_failure: null,
      role_family: options.family ?? "senior_frontend",
      discovered_at: clock.now(),
      evaluated_at: clock.now(),
      technologies: options.technologies === undefined || options.technologies === null ? null : JSON.stringify(options.technologies),
    })
  if (options.evidence !== false) {
    const covered = options.covered ?? 7
    const total = options.total ?? 10
    const strong = status === "ranked" || options.skipReason === "technology_mismatch"
    const weakReason = strong ? null : options.skipReason === "uncovered_mandatory_prerequisite" ? "unmet_mandatory" : total === 0 ? "no_core_responsibilities" : "coverage_below_threshold"
    await database.db
      .insertInto("match_evidence")
      .values({
        candidate_id: database.operatorId,
        job_posting_id: id,
        career_profile_version: options.careerProfileVersion ?? 1,
        verdict: strong ? "strong" : "weak",
        weak_reason: weakReason,
        covered_count: covered,
        total_count: total,
        threshold: "0.700",
        items: "[]",
        evaluated_at: clock.now(),
        criteria_version: options.criteriaVersion ?? 1,
      })
      .execute()
  }
  return id
}

const tech = (...names: string[]) => names.map((name) => ({ name, quote: `We use ${name}.` }))

function save(body: Record<string, unknown>) {
  return candidate.put(JOB_CRITERIA_PATH).send({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent: 70, frameworks: [], technologies: [], ...body })
}

async function posting(id: string) {
  return postingsOf(database.db, database.operatorId).select(["status", "skip_reason", "skip_detail", "evaluated_at"]).where("id", "=", id).executeTakeFirstOrThrow()
}

async function evidence(id: string) {
  return database.db.selectFrom("match_evidence").selectAll().where("job_posting_id", "=", id).executeTakeFirstOrThrow()
}

async function stored() {
  return database.db.selectFrom("job_criteria").selectAll().executeTakeFirstOrThrow()
}

async function detail(id: string) {
  return jobPostingDetailSchema.parse((await candidate.get(`/v1/job-postings/${id}`).expect(200)).body)
}

async function list(tab: "ranked" | "skipped" | "all", filter = "") {
  return jobPostingsResponseSchema.parse((await candidate.get(`/v1/job-postings?tab=${tab}${filter}`).expect(200)).body)
}

/** The AC 2.6 dashboard line the web renders from the contract fields (display floor, decision threshold). */
function weakLine(match: { coveredCount: number; totalCount: number; thresholdPercent: number }) {
  return `Skipped: core Match ${Math.floor((match.coveredCount * 100) / match.totalCount)}% is below your ${match.thresholdPercent}%.`
}

function fieldErrorsOf(body: unknown) {
  return apiErrorResponseSchema.parse(body).error.fieldErrors
}

describe("GET and PUT /v1/candidate-settings/job-criteria (job-criteria-settings.feature)", () => {
  it("@ac-1.2 a migrated installation reads 70, no frameworks, no technologies, version 1", async () => {
    const response = await candidate.get(JOB_CRITERIA_PATH).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(jobCriteriaResponseSchema.parse(response.body)).toEqual({ minCoreMatchPercent: 70, frameworks: [], technologies: [], ...ROLE_RELEVANCE_DEFAULTS, version: 1 })
  })

  it("@ac-1.1 @ac-1.2 saves new criteria with the CSRF token and reads them back", async () => {
    const response = await save({ minCoreMatchPercent: 80, frameworks: ["React", "Next.js"], technologies: ["TypeScript"] }).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(jobCriteriaResponseSchema.parse(response.body)).toEqual({ minCoreMatchPercent: 80, frameworks: ["React", "Next.js"], technologies: ["TypeScript"], ...ROLE_RELEVANCE_DEFAULTS, version: 2 })
    expect(jobCriteriaResponseSchema.parse((await candidate.get(JOB_CRITERIA_PATH).expect(200)).body)).toMatchObject({ minCoreMatchPercent: 80, frameworks: ["React", "Next.js"], technologies: ["TypeScript"] })
  })

  it("@ac-1.2 loads stored values 65, Vue and Nuxt, Go and PostgreSQL", async () => {
    await save({ minCoreMatchPercent: 65, frameworks: ["Vue", "Nuxt"], technologies: ["Go", "PostgreSQL"] }).expect(200)
    expect((await candidate.get(JOB_CRITERIA_PATH).expect(200)).body).toMatchObject({ minCoreMatchPercent: 65, frameworks: ["Vue", "Nuxt"], technologies: ["Go", "PostgreSQL"] })
  })

  it("@ac-1.1 saving Job criteria does not touch another section", async () => {
    await candidate.put("/v1/candidate-settings/contact").send({ fullName: "Ada Obi", lines: [] }).expect(200)
    await save({ minCoreMatchPercent: 75 }).expect(200)
    expect((await candidate.get("/v1/candidate-settings/contact").expect(200)).body.fullName).toBe("Ada Obi")
  })

  it("@ac-3.1 removing an entry and saving stores the rest", async () => {
    await save({ frameworks: ["React", "Vue"] }).expect(200)
    await save({ frameworks: ["React"] }).expect(200)
    expect((await stored()).frameworks).toEqual(["React"])
  })

  it("@ac-3.6 both lists can be saved empty", async () => {
    await save({ frameworks: ["React"], technologies: ["TypeScript"] }).expect(200)
    await save({ frameworks: [], technologies: [] }).expect(200)
    expect(await stored()).toMatchObject({ frameworks: [], technologies: [] })
  })

  describe("validation (AC 2.3, 2.7, 3.2, 1.4)", () => {
    it.each([
      ["the string \"70\"", "70"],
      ["the string \"seventy\"", "seventy"],
      ["the number 70.5", 70.5],
      ["the number 0", 0],
      ["the number 101", 101],
      ["the number -1", -1],
      ["null", null],
      ["the boolean true", true],
      ["the array [70]", [70]],
      ["the object {\"value\":70}", { value: 70 }],
      ["an omitted field", undefined],
    ])("refuses the minimum core Match %s with a field error, changing nothing", async (_label, value) => {
      await save({ frameworks: ["React"] }).expect(200)
      const ranked = await seed({ covered: 7, total: 10, technologies: tech("React") })
      const body: Record<string, unknown> = { ...ROLE_RELEVANCE_DEFAULTS, frameworks: ["Vue"], technologies: [] }
      if (value !== undefined) body.minCoreMatchPercent = value
      const response = await candidate.put(JOB_CRITERIA_PATH).send(body).expect(400)
      expect(response.body.error.code).toBe("bad_request")
      expect(fieldErrorsOf(response.body)).toEqual([{ field: "minCoreMatchPercent", position: null, problem: "invalid" }])
      expect(await stored()).toMatchObject({ min_core_match_percent: 70, frameworks: ["React"], technologies: [], version: 2 })
      expect((await posting(ranked)).status).toBe("ranked")
    })

    it.each([
      ["70", 70],
      ["70.0", 70],
      ["1", 1],
      ["100", 100],
      ["100.0", 100],
    ])("accepts the JSON text %s and stores %i", async (text, value) => {
      const response = await candidate
        .put(JOB_CRITERIA_PATH)
        .set("content-type", "application/json")
        .send(`{"minCoreMatchPercent":${text},"frameworks":[],"technologies":[],"targetRoleFamilies":${JSON.stringify(ROLE_RELEVANCE_DEFAULTS.targetRoleFamilies)},"seniorityFloor":"hide_entry_level"}`)
        .expect(200)
      expect(response.body.minCoreMatchPercent).toBe(value)
      expect((await stored()).min_core_match_percent).toBe(value)
    })

    const names = (n: number) => Array.from({ length: n }, (_, i) => `Tool${i}`)
    it.each([
      ["21 entries in frameworks", { frameworks: names(21) }, { field: "frameworks", position: null, problem: "too_many_entries" }],
      ["21 entries in technologies", { technologies: names(21) }, { field: "technologies", position: null, problem: "too_many_entries" }],
      ["the framework entry \"\"", { frameworks: [""] }, { field: "frameworks", position: 1, problem: "entry_empty" }],
      ["the technology entry \"   \"", { technologies: ["   "] }, { field: "technologies", position: 1, problem: "entry_empty" }],
      ["a 41-character technology", { technologies: ["Amazon Web Services Elastic Beanstalk v23"] }, { field: "technologies", position: 1, problem: "entry_too_long" }],
      ["the framework entry \"Rust!\"", { frameworks: ["Rust!"] }, { field: "frameworks", position: 1, problem: "entry_disallowed_characters" }],
      ["the technology entry \".\" (CR-01, O3)", { technologies: ["."] }, { field: "technologies", position: 1, problem: "entry_disallowed_characters" }],
      ["the framework entry \" - \" (CR-01, O3)", { frameworks: [" - "] }, { field: "frameworks", position: 1, problem: "entry_disallowed_characters" }],
      ["the framework entry \"-\" (O3, G2)", { frameworks: ["-"] }, { field: "frameworks", position: 1, problem: "entry_disallowed_characters" }],
      ["the technology entry \"_\" (O3, G2)", { technologies: ["_"] }, { field: "technologies", position: 1, problem: "entry_disallowed_characters" }],
      ["the technology entry \"./-\" (O3, G2)", { technologies: ["./-"] }, { field: "technologies", position: 1, problem: "entry_disallowed_characters" }],
    ])("refuses %s with a field error on that list", async (_label, body, fieldError) => {
      const response = await save(body).expect(400)
      expect(response.body.error.code).toBe("bad_request")
      expect(fieldErrorsOf(response.body)).toEqual([fieldError])
      expect(await stored()).toMatchObject({ min_core_match_percent: 70, frameworks: [], technologies: [], version: 1 })
    })

    it("@ac-1.4 refuses a baseVersion field with no field-level error", async () => {
      const response = await save({ minCoreMatchPercent: 80, baseVersion: 1 }).expect(400)
      expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
      expect((await stored()).min_core_match_percent).toBe(70)
    })

    it("refuses malformed JSON and a non-object body as plain bad_request", async () => {
      const malformed = await candidate.put(JOB_CRITERIA_PATH).set("content-type", "application/json").send("{").expect(400)
      expect(malformed.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
      const array = await candidate.put(JOB_CRITERIA_PATH).send([70]).expect(400)
      expect(array.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
    })

    it.each(["C#", "C++", "Node.js", "CI/CD", "Objective-C", "C", "Amazon Web Services Elastic Beanstalk v2"])("accepts the technology %j", async (entry) => {
      await save({ technologies: [entry] }).expect(200)
      expect((await stored()).technologies).toEqual([entry])
    })

    it.each(["Ruby_on_Rails", "Next.js 14"])("accepts the framework %j", async (entry) => {
      await save({ frameworks: [entry] }).expect(200)
      expect((await stored()).frameworks).toEqual([entry])
    })

    it("@ac-3.1 measures an entry after trimming and stores it trimmed", async () => {
      await save({ technologies: ["   Amazon Web Services Elastic Beanstalk v2   "] }).expect(200)
      expect((await stored()).technologies).toEqual(["Amazon Web Services Elastic Beanstalk v2"])
    })

    it("@ac-3.1 each list holds 20 entries on its own", async () => {
      await save({ frameworks: names(20), technologies: names(20).map((name) => `${name}x`) }).expect(200)
      const row = await stored()
      expect([row.frameworks.length, row.technologies.length]).toEqual([20, 20])
    })
  })

  describe("duplicates (AC 3.3, 3.5, 3.7)", () => {
    it.each([
      [["React", "react"], [], "frameworks", 2],
      [["React", "ReactJS"], [], "frameworks", 2],
      [["React"], ["React.js"], "technologies", 1],
      [[], ["Go", "TypeScript", "Golang"], "technologies", 3],
      [["Next.js", "Vue", "NextJS"], [], "frameworks", 3],
      [["Ruby on Rails"], ["TS", "Ruby-on-Rails"], "technologies", 2],
      [["Tailwind CSS"], ["  tailwindcss  "], "technologies", 1],
    ])("refuses frameworks %j and technologies %j at %s position %i, storing and re-deciding nothing", async (frameworks, technologies, list, position) => {
      await save({ frameworks: ["Vue"] }).expect(200)
      const umbrella = await seed({ name: "Backend Engineer at Umbrella", covered: 8, technologies: tech("Vue") })
      const before = await evidence(umbrella)
      const response = await save({ frameworks, technologies }).expect(400)
      expect(fieldErrorsOf(response.body)).toEqual([{ field: list, position, problem: "duplicate_entry" }])
      expect(await stored()).toMatchObject({ min_core_match_percent: 70, frameworks: ["Vue"], technologies: [], version: 2 })
      expect((await posting(umbrella)).status).toBe("ranked")
      expect((await evidence(umbrella)).criteria_version).toBe(before.criteria_version)
    })

    it("never removes a duplicate silently", async () => {
      await save({ frameworks: ["React", "react"] }).expect(400)
      expect((await stored()).frameworks).toEqual([])
    })

    it("accepts entries that only look alike", async () => {
      await save({ frameworks: ["Angular", "AngularJS", "React Native"], technologies: ["React", "Java", "JavaScript", "C", "C#", "C++"] }).expect(200)
      expect(await stored()).toMatchObject({ frameworks: ["Angular", "AngularJS", "React Native"], technologies: ["React", "Java", "JavaScript", "C", "C#", "C++"] })
    })

    it("saving the same criteria twice gives the same result and statuses", async () => {
      await save({ minCoreMatchPercent: 75, frameworks: ["React"] }).expect(200)
      const globex = await seed({ name: "Frontend Tech Lead at Globex", covered: 8, technologies: tech("React") })
      await save({ minCoreMatchPercent: 75, frameworks: ["React"] }).expect(200)
      await save({ minCoreMatchPercent: 75, frameworks: ["React"] }).expect(200)
      expect(await stored()).toMatchObject({ min_core_match_percent: 75, frameworks: ["React"], technologies: [] })
      expect((await posting(globex)).status).toBe("ranked")
    })
  })

  describe("permission (AC 1.1)", () => {
    it("reading without a session is refused with no values", async () => {
      const response = await browser.http().get(JOB_CRITERIA_PATH).expect(401)
      expect(response.body).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } })
    })

    it("saving without a session is refused and nothing changes", async () => {
      const response = await browser.http().put(JOB_CRITERIA_PATH).send({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent: 50, frameworks: [], technologies: [] }).expect(401)
      expect(response.body.error.message).toBe("Sign in to continue.")
      expect((await stored()).min_core_match_percent).toBe(70)
    })

    it.each([["no CSRF token"], ["a CSRF token from a different session"], ["an altered CSRF token"]])("a save with %s is refused and no posting changes", async (label) => {
      const ranked = await seed({ covered: 6, total: 10, status: "skipped", skipReason: "weak_core_match" })
      let token: string | null = null
      if (label === "a CSRF token from a different session") token = (await signInCandidate(browser)).csrfToken
      if (label === "an altered CSRF token") token = `${candidate.csrfToken}x`
      let call = browser.http().put(JOB_CRITERIA_PATH).set("cookie", candidate.cookie)
      if (token !== null) call = call.set(CSRF_HEADER, token)
      const response = await call.send({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent: 50, frameworks: [], technologies: [] }).expect(403)
      expect(response.body).toEqual({ error: { code: "csrf_invalid", message: "The request is missing a valid CSRF token." } })
      expect((await stored()).min_core_match_percent).toBe(70)
      expect((await posting(ranked)).status).toBe("skipped")
    })

    it("a save after the 14-day idle expiry is refused as session_expired and nothing changes", async () => {
      const { sessionCookie } = await browser.signIn({ sub: CANDIDATE_SUB, email: CANDIDATE_EMAIL, email_verified: true })
      const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
      clock.set("2026-11-04T09:00:01.000Z")
      const response = await browser
        .http()
        .put(JOB_CRITERIA_PATH)
        .set("cookie", `${SESSION_COOKIE}=${sessionCookie}`)
        .set(CSRF_HEADER, csrf)
        .send({ minCoreMatchPercent: 60, frameworks: [], technologies: [] })
        .expect(401)
      expect(response.body.error).toEqual({ code: "session_expired", message: "Your session ended. Sign in with Google again to continue where you left off." })
      expect((await stored()).min_core_match_percent).toBe(70)
    })
  })

  describe("versions and concurrency (AC 1.4, 5.7)", () => {
    it("every successful save increments the version, including an identical one; a refused save does not", async () => {
      await database.db.updateTable("job_criteria").set({ version: 7 }).execute()
      await save({ minCoreMatchPercent: 101 }).expect(400)
      expect((await stored()).version).toBe(7)
      await save({ minCoreMatchPercent: 75 }).expect(200)
      await save({ minCoreMatchPercent: 75 }).expect(200)
      expect((await stored()).version).toBe(9)
    })

    it("two tabs: the last successful save wins without a conflict, and statuses follow it", async () => {
      const initech = await seed({ covered: 7, total: 10 })
      await save({ minCoreMatchPercent: 80 }).expect(200)
      await save({ minCoreMatchPercent: 60 }).expect(200)
      expect((await stored()).min_core_match_percent).toBe(60)
      expect((await posting(initech)).status).toBe("ranked")
      expect((await evidence(initech)).threshold).toBe("0.600")
    })

    it("two saves at the same moment leave one complete set of criteria and matching statuses", async () => {
      const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => seed({ covered: 6 + (i % 4), total: 10, technologies: tech(i % 2 === 0 ? "React" : "Vue") })))
      const [x, y] = await Promise.all([save({ minCoreMatchPercent: 80, frameworks: ["React"] }), save({ minCoreMatchPercent: 60, frameworks: ["Vue"] })])
      expect([x.status, y.status]).toEqual([200, 200])
      const final = await stored()
      expect(final.version).toBe(3)
      const winner = final.frameworks[0] === "React" ? { percent: 80, tech: "React" } : { percent: 60, tech: "Vue" }
      expect(final.min_core_match_percent).toBe(winner.percent)
      for (const [i, id] of ids.entries()) {
        const covered = 6 + (i % 4)
        const mentions = (i % 2 === 0 ? "React" : "Vue") === winner.tech
        const expected = covered * 100 < winner.percent * 10 ? "weak_core_match" : mentions ? null : "technology_mismatch"
        expect((await posting(id)).skip_reason).toBe(expected)
        expect((await evidence(id)).criteria_version).toBe(3)
      }
    })
  })
})

describe("re-decision on save (re-decision-on-save.feature)", () => {
  it("raising the minimum moves a ranked 7 of 10 posting to weak_core_match with the numbered line", async () => {
    const id = await seed({ covered: 7, total: 10 })
    await save({ minCoreMatchPercent: 80 }).expect(200)
    expect(await posting(id)).toMatchObject({ status: "skipped", skip_reason: "weak_core_match" })
    expect(await evidence(id)).toMatchObject({ verdict: "weak", weak_reason: "coverage_below_threshold", threshold: "0.800" })
    const summary = (await list("skipped")).postings.find((row) => row.id === id)!
    expect(weakLine(summary.match!)).toBe("Skipped: core Match 70% is below your 80%.")
  })

  it("lowering the minimum moves a 6 of 10 weak posting to ranked", async () => {
    const id = await seed({ status: "skipped", skipReason: "weak_core_match", covered: 6, total: 10 })
    await save({ minCoreMatchPercent: 60 }).expect(200)
    expect((await posting(id)).status).toBe("ranked")
    expect(await evidence(id)).toMatchObject({ verdict: "strong", weak_reason: null })
  })

  it("adding React skips a PHP/Laravel posting as technology_mismatch and keeps a ReactJS posting ranked", async () => {
    const umbrella = await seed({ name: "Backend Engineer at Umbrella", covered: 8, technologies: tech("PHP", "Laravel") })
    const globex = await seed({ name: "Frontend Tech Lead at Globex", covered: 8, technologies: tech("ReactJS") })
    await save({ frameworks: ["React"] }).expect(200)
    expect(await posting(umbrella)).toMatchObject({ status: "skipped", skip_reason: "technology_mismatch" })
    expect((await evidence(umbrella)).verdict).toBe("strong")
    expect((await posting(globex)).status).toBe("ranked")
  })

  it("emptying both lists moves technology_mismatch postings back to ranked", async () => {
    await save({ frameworks: ["React"] }).expect(200)
    const id = await seed({ status: "skipped", skipReason: "technology_mismatch", covered: 8, technologies: tech("PHP") })
    await save({ frameworks: [] }).expect(200)
    expect((await posting(id)).status).toBe("ranked")
  })

  it("a technology_mismatch posting becomes weak_core_match when the minimum rises above it", async () => {
    await save({ frameworks: ["React"] }).expect(200)
    const id = await seed({ status: "skipped", skipReason: "technology_mismatch", covered: 7, technologies: tech("PHP") })
    await save({ minCoreMatchPercent: 80, frameworks: ["React"] }).expect(200)
    expect((await posting(id)).skip_reason).toBe("weak_core_match")
  })

  it("a weak_core_match posting becomes technology_mismatch when the minimum drops but the stack doesn't match", async () => {
    await save({ minCoreMatchPercent: 80, frameworks: ["React"] }).expect(200)
    const id = await seed({ status: "skipped", skipReason: "weak_core_match", covered: 7, technologies: tech("PHP") })
    await save({ minCoreMatchPercent: 70, frameworks: ["React"] }).expect(200)
    expect((await posting(id)).skip_reason).toBe("technology_mismatch")
  })

  it("makes no model call, no fetch and records no spend", async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => seed({ covered: 5 + (i % 6), total: 10 })))
    const spendBefore = await database.db.selectFrom("spend_entry").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow()
    await save({ minCoreMatchPercent: 85 }).expect(200)
    expect(anthropic.requests).toHaveLength(0)
    expect(outbound.urls).toEqual([])
    expect(await database.db.selectFrom("ai_call").selectAll().execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow()).toEqual(spendBefore)
  })

  it("uses the stored evidence's counts, not a later Career Profile", async () => {
    const id = await seed({ covered: 7, total: 10, careerProfileVersion: 3 })
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: database.operatorId, version: 4, status: "approved", source: "edit", resume_upload_id: null, sections: "[]", created_at: new Date(), approved_at: new Date() })
      .onConflict((oc) => oc.doNothing())
      .execute()
    await save({ minCoreMatchPercent: 80 }).expect(200)
    expect(await posting(id)).toMatchObject({ status: "skipped", skip_reason: "weak_core_match" })
    expect((await evidence(id)).career_profile_version).toBe(3)
    await database.db.deleteFrom("career_profile_version").execute()
  })

  it("the Postings page reflects the save on its next load", async () => {
    const id = await seed({ covered: 7, total: 10 })
    expect((await list("ranked")).postings.map((row) => row.id)).toEqual([id])
    await save({ minCoreMatchPercent: 80 }).expect(200)
    expect((await list("ranked")).postings).toEqual([])
    expect((await list("skipped")).postings.map((row) => row.id)).toEqual([id])
  })

  it("stamps threshold, normalised entries and the new version on each re-decided posting", async () => {
    await database.db.updateTable("job_criteria").set({ version: 4 }).execute()
    const id = await seed({ covered: 8, technologies: tech("Vue"), criteriaVersion: 4 })
    await save({ minCoreMatchPercent: 75, technologies: ["Vue.js", "Go"] }).expect(200)
    expect(await evidence(id)).toMatchObject({ threshold: "0.750", criteria_technologies: ["vue", "go"], criteria_version: 5 })
    expect((await stored()).version).toBe(5)
  })

  it.each([
    ["excluded", "violated_rule"],
    ["evaluation_failed", null],
    ["checking", null],
    ["waiting_to_be_checked", null],
    ["skipped", "uncovered_mandatory_prerequisite"],
    ["skipped", "no_core_responsibilities"],
    ["skipped", "unsupported_application_system"],
    ["skipped", "not_software_role"],
  ] as const)("a %s posting with reason %s keeps its status and reason", async (status, reason) => {
    const hasEvidence = status === "excluded" || reason === "uncovered_mandatory_prerequisite" || reason === "no_core_responsibilities"
    const id = await seed({ status, skipReason: reason, evidence: hasEvidence, covered: reason === "no_core_responsibilities" ? 0 : 10, total: reason === "no_core_responsibilities" ? 0 : 10, technologies: tech("React") })
    await save({ minCoreMatchPercent: 1, frameworks: ["React"] }).expect(200)
    expect(await posting(id)).toMatchObject({ status, skip_reason: reason })
  })

  it("an excluded posting meeting every criterion stays excluded with its rule", async () => {
    const id = await seed({ status: "excluded", skipReason: "violated_rule", skipDetail: "sponsorship", covered: 10, total: 10, technologies: tech("React") })
    await save({ minCoreMatchPercent: 50, frameworks: ["React"] }).expect(200)
    expect(await posting(id)).toMatchObject({ status: "excluded", skip_reason: "violated_rule", skip_detail: "sponsorship" })
  })

  it("a skipped posting without Match evidence is not re-decided", async () => {
    const id = await seed({ status: "skipped", skipReason: "not_software_role", evidence: false })
    await save({ minCoreMatchPercent: 50 }).expect(200)
    expect(await posting(id)).toMatchObject({ status: "skipped", skip_reason: "not_software_role" })
  })

  it("a save with exactly the stored criteria leaves every status unchanged", async () => {
    await save({ frameworks: ["React"] }).expect(200)
    const ranked = await Promise.all([1, 2, 3].map(() => seed({ covered: 8, technologies: tech("React") })))
    const mismatched = await Promise.all([1, 2].map(() => seed({ status: "skipped", skipReason: "technology_mismatch", covered: 8, technologies: tech("PHP") })))
    await save({ frameworks: ["React"] }).expect(200)
    for (const id of ranked) expect((await posting(id)).status).toBe("ranked")
    for (const id of mismatched) expect((await posting(id)).skip_reason).toBe("technology_mismatch")
  })

  // SEC-008, AC 5.11: only code writes stored technology entries, but a malformed one must never fail a save.
  describe("malformed stored technology entries (SEC-008, AC 5.11)", () => {
    const malformed = [
      ["a missing name", { quote: "We use React." }],
      ["a null name", { name: null, quote: "We use React." }],
      ["a number name", { name: 42, quote: "We use React." }],
      ["an object name", { name: { react: true }, quote: "We use React." }],
      ["an array name", { name: ["React"], quote: "We use React." }],
      ["a boolean name", { name: true, quote: "We use React." }],
      ["a bare string entry", "React"],
      ["a null entry", null],
      ["a number entry", 7],
    ] as const

    async function storeRaw(id: string, entries: unknown[]) {
      await sql`update job_posting set technologies = ${JSON.stringify(entries)}::jsonb where id = ${id}`.execute(database.db)
    }

    it.each(malformed)("an entry with %s counts as not mentioned and the save succeeds", async (_label, entry) => {
      const id = await seed({ covered: 8 })
      await storeRaw(id, [entry])
      await save({ frameworks: ["React"] }).expect(200)
      expect(await posting(id)).toMatchObject({ status: "skipped", skip_reason: "technology_mismatch" })
      expect((await stored()).frameworks).toEqual(["React"])
    })

    it.each(malformed)("with %s, the other stored entries are matched as usual", async (_label, entry) => {
      const id = await seed({ status: "skipped", skipReason: "technology_mismatch", covered: 8 })
      await storeRaw(id, [entry, { name: "React", quote: "We use React." }])
      await save({ frameworks: ["React"] }).expect(200)
      expect(await posting(id)).toMatchObject({ status: "ranked", skip_reason: null })
    })

    it("a malformed entry does not touch other postings' re-decision in the same save", async () => {
      const bad = await seed({ covered: 8 })
      await storeRaw(bad, [{ name: null, quote: "x" }])
      const good = await seed({ covered: 8, technologies: tech("React") })
      const php = await seed({ covered: 8, technologies: tech("PHP") })
      const response = await save({ minCoreMatchPercent: 75, frameworks: ["React"] }).expect(200)
      expect(response.body).toMatchObject({ minCoreMatchPercent: 75, frameworks: ["React"], version: 2 })
      expect((await posting(good)).status).toBe("ranked")
      expect((await posting(php)).skip_reason).toBe("technology_mismatch")
      expect((await posting(bad)).skip_reason).toBe("technology_mismatch")
      expect(await evidence(bad)).toMatchObject({ threshold: "0.750", criteria_version: 2, criteria_technologies: ["react"] })
    })

    it("with the criterion off, a posting holding only malformed entries stays ranked", async () => {
      const id = await seed({ covered: 8 })
      await storeRaw(id, [{ name: null, quote: "x" }, 42])
      await save({ minCoreMatchPercent: 70 }).expect(200)
      expect((await posting(id)).status).toBe("ranked")
    })
  })

  it("a save with no stored postings succeeds", async () => {
    const response = await save({ minCoreMatchPercent: 80, frameworks: ["React"] }).expect(200)
    expect(response.body.minCoreMatchPercent).toBe(80)
  })

  it("a re-decision does not move evaluated_at, so a posting doesn't change daily-summary day", async () => {
    const id = await seed({ covered: 7 })
    const before = (await posting(id)).evaluated_at
    await save({ minCoreMatchPercent: 80 }).expect(200)
    expect((await posting(id)).evaluated_at).toEqual(before)
  })

  describe("atomic save (AC 5.5, 1.3)", () => {
    it("a failure during re-decision leaves the old criteria, version and every status", async () => {
      const initech = await seed({ covered: 7 })
      const hooli = await seed({ status: "skipped", skipReason: "weak_core_match", covered: 6 })
      // Fail the stamp step, after both postings' status updates ran inside the transaction.
      await sql`create or replace function fail_stamp() returns trigger language plpgsql as $$ begin raise exception 'injected re-decision failure'; end $$`.execute(database.db)
      await sql`create trigger fail_stamp before update of criteria_version on match_evidence for each statement execute function fail_stamp()`.execute(database.db)
      try {
        const response = await save({ minCoreMatchPercent: 60, frameworks: ["React"] }).expect(500)
        expect(response.body).toEqual({ error: { code: "internal_error", message: "Something went wrong." } })
      } finally {
        await sql`drop trigger fail_stamp on match_evidence`.execute(database.db)
        await sql`drop function fail_stamp()`.execute(database.db)
      }
      expect(await stored()).toMatchObject({ min_core_match_percent: 70, frameworks: [], technologies: [], version: 1 })
      expect((await posting(initech)).status).toBe("ranked")
      expect(await posting(hooli)).toMatchObject({ status: "skipped", skip_reason: "weak_core_match" })
    })
  })

  describe("Applications (AC 5.8)", () => {
    type ApplicationState = "queued" | "confirmed" | "uncertain" | "blocked" | "manual" | "sample_awaiting_review" | "prepared"
    /** Each state seeded the way the submission flow leaves it (columns from migrations 0006 and 0007). */
    const STATE_COLUMNS: Record<ApplicationState, Record<string, unknown>> = {
      queued: { submission_state: "queued", submission_kind: "automatic" },
      confirmed: { submission_state: "confirmed", submission_kind: "automatic", submit_clicked_at: new Date("2026-10-21T08:00:00Z"), submitted_local_day: "2026-10-21", confirmed_at: new Date("2026-10-21T08:00:05Z"), evidence_kind: "confirmation_page", evidence_text: "Thanks for applying" },
      uncertain: { submission_state: "uncertain", submission_kind: "automatic", submit_clicked_at: new Date("2026-10-21T08:00:00Z"), submitted_local_day: "2026-10-21", captcha_after_submit: true },
      blocked: { submission_state: "blocked", submission_kind: "automatic", blocked_reason: "missing_approved_answer", blocked_detail: "Notice period", blocked_at: new Date("2026-10-21T08:00:00Z") },
      manual: { submission_state: "manual", submission_kind: null },
      sample_awaiting_review: { submission_state: null, submission_kind: "sample", sample_state: "awaiting_review" },
      prepared: { submission_state: null, submission_kind: null },
    }

    async function application(postingId: string, state: ApplicationState) {
      const id = randomUUID()
      const row = await database.db.selectFrom("job_posting").select(["application_url", "requisition_id"]).where("id", "=", postingId).executeTakeFirstOrThrow()
      await database.db
        .insertInto("application")
        .values({ id, candidate_id: database.operatorId, job_posting_id: postingId, application_url: row.application_url, requisition_id: row.requisition_id, company: "Initech", role_title: "Frontend Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: clock.now(), updated_at: clock.now(), ...STATE_COLUMNS[state] })
        .execute()
      for (const kind of ["resume", "cover_letter"] as const) {
        await database.db
          .insertInto("tailored_document")
          .values({ id: randomUUID(), candidate_id: database.operatorId, application_id: id, kind, career_profile_version: 1, content: "{}", pdf_storage_name: `${randomUUID()}.pdf`, docx_storage_name: `${randomUUID()}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: clock.now() })
          .execute()
      }
      return id
    }

    const snapshot = async (id: string) => ({
      application: await database.db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow(),
      documents: await database.db.selectFrom("tailored_document").selectAll().where("application_id", "=", id).orderBy("kind").execute(),
    })

    it.each([["queued"], ["confirmed"], ["uncertain"], ["blocked"], ["manual"], ["sample_awaiting_review"], ["prepared"]] as const)(
      "re-decision never edits an Application in state %s or its documents",
      async (state) => {
        const postingId = await seed({ covered: 7 })
        const id = await application(postingId, state)
        const before = await snapshot(id)
        expect(before.documents).toHaveLength(2)
        await save({ minCoreMatchPercent: 80, frameworks: ["Angular"] }).expect(200)
        expect(await snapshot(id)).toEqual(before)
        expect((await posting(postingId)).status).toBe("skipped")
      }
    )
  })
})

describe("SEC-003: a criteria save and creating an Application (AC 5.8)", () => {
  const create = (jobPostingId: string) => candidate.post("/v1/applications").send({ jobPostingId })
  const applications = (postingId: string) => database.db.selectFrom("application").select("id").where("job_posting_id", "=", postingId).execute()

  /** Holds what a save holds mid-transaction: the criteria row FOR UPDATE and the posting already moved to Skipped. */
  async function holdSaveThatSkips(postingId: string) {
    let commit!: () => void
    let done!: Promise<void>
    let pid!: number
    await new Promise<void>((resolve) => {
      done = database.db.transaction().execute(async (trx) => {
        pid = await backendPid(trx)
        await trx.selectFrom("job_criteria").select("version").where("candidate_id", "=", database.operatorId).forUpdate().execute()
        await trx.updateTable("job_criteria").set({ min_core_match_percent: 80, version: sql<number>`version + 1` }).where("candidate_id", "=", database.operatorId).execute()
        await trx
          .updateTable("candidate_posting")
          .set({ status: "skipped", skip_reason: "weak_core_match" })
          .where("candidate_id", "=", database.operatorId)
          .where("job_posting_id", "=", postingId)
          .execute()
        resolve()
        await new Promise<void>((release) => (commit = release))
      })
    })
    return { pid, commit: async () => (commit(), await done) }
  }

  // r-AA (AA-2.1, AA-7.5, apply-anyway.feature:1174 "the save" row): the create reads the committed decision after the
  // save, so a create with no acknowledgement of the new skip is refused and nothing is created (supersedes v1.23.0's
  // automatic override).
  it("a create that starts while a save is skipping the posting waits for it and reads the new decision: 409 override_acknowledgement_missing, no Application", async () => {
    const postingId = await seed({ covered: 7 })
    const held = await holdSaveThatSkips(postingId)
    let settled = false
    let settledWhileHeld: boolean
    let request: Promise<Awaited<ReturnType<typeof create>>>
    try {
      request = create(postingId).then((response) => ((settled = true), response))
      await untilLockWait(database.db, "the create", "row", held.pid)
      settledWhileHeld = settled
    } finally {
      // Released even when the wait throws, so a failure here does not leave the row locked for the next test.
      await held.commit()
    }
    const response = await request
    expect(settledWhileHeld).toBe(false)
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("override_acknowledgement_missing")
    expect(await applications(postingId)).toEqual([])
  })

  /** Holds a save that re-decides a skipped posting from one prerequisite to weak_core_match (R-4604). */
  async function holdSaveThatRedecides(postingId: string) {
    let commit!: () => void
    let done!: Promise<void>
    let pid!: number
    await new Promise<void>((resolve) => {
      done = database.db.transaction().execute(async (trx) => {
        pid = await backendPid(trx)
        await trx.selectFrom("job_criteria").select("version").where("candidate_id", "=", database.operatorId).forUpdate().execute()
        await trx.updateTable("candidate_posting").set({ status: "skipped", skip_reason: "weak_core_match", skip_detail: null }).where("candidate_id", "=", database.operatorId).where("job_posting_id", "=", postingId).execute()
        resolve()
        await new Promise<void>((release) => (commit = release))
      })
    })
    return { pid, commit: async () => (commit(), await done) }
  }

  const PREREQUISITE = { status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Active security clearance", violatedRules: [] } as const
  const createAcknowledged = (jobPostingId: string) => candidate.post("/v1/applications").send({ jobPostingId, acknowledgement: { confirmed: true, decision: PREREQUISITE } })

  it("AA-7.5 (apply-anyway.feature:1174, the save first): the create waits, reads the new decision and answers 409 override_decision_changed with the C-AA-9 message", async () => {
    const postingId = await seed({ status: "skipped", skipReason: "uncovered_mandatory_prerequisite", covered: 8 })
    await setCandidatePosting(database.db, database.operatorId, postingId, { skip_detail: "Active security clearance" })
    const held = await holdSaveThatRedecides(postingId)
    let request: Promise<Awaited<ReturnType<typeof create>>>
    try {
      request = createAcknowledged(postingId).then((response) => response)
      await untilLockWait(database.db, "the create", "row", held.pid)
    } finally {
      await held.commit()
    }
    const response = await request
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "override_decision_changed", message: "This posting's decision changed after you opened the dialog, so your override wasn't recorded. Review its new reason, then try again." })
    expect(await applications(postingId)).toEqual([])
  })

  it("AA-7.5 (apply-anyway.feature:1174, the create first): the override stores the pre-save decision and the save then re-decides the posting", async () => {
    const postingId = await seed({ status: "skipped", skipReason: "uncovered_mandatory_prerequisite", covered: 8 })
    await setCandidatePosting(database.db, database.operatorId, postingId, { skip_detail: "Active security clearance" })
    expect((await createAcknowledged(postingId)).status).toBe(201)
    await (await holdSaveThatRedecides(postingId)).commit()
    const rows = await database.db.selectFrom("application").select(["override_skip_reason", "override_skip_detail"]).where("job_posting_id", "=", postingId).execute()
    expect(rows).toEqual([{ override_skip_reason: "uncovered_mandatory_prerequisite", override_skip_detail: "Active security clearance" }])
    expect((await posting(postingId)).skip_reason).toBe("weak_core_match")
  })

  it("a save that starts while a create is inside its transaction waits for it; the Application stays (AC 5.8)", async () => {
    const postingId = await seed({ covered: 7 })
    const repository = app.get(DocumentsRepository)
    const original = repository.insertOnce.bind(repository)
    let entered!: () => void
    let release!: () => void
    let createPid!: number
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const spy = vi.spyOn(repository, "insertOnce").mockImplementation(async (...args) => {
      createPid = await backendPid(args[0])
      entered()
      await gate
      return original(...args)
    })
    try {
      // supertest sends only once awaited; .then starts the request now.
      const creating = create(postingId).then((response) => response)
      await inside
      let saved = false
      const saving = save({ minCoreMatchPercent: 80 }).then((response) => ((saved = true), response))
      let savedWhileCreating: boolean
      let statusWhileCreating: string
      try {
        await untilLockWait(database.db, "the save", "row", createPid)
        savedWhileCreating = saved
        statusWhileCreating = (await posting(postingId)).status
      } finally {
        // Released even when the wait throws, so the create's transaction does not keep the row locked.
        release()
      }
      expect(savedWhileCreating).toBe(false)
      expect(statusWhileCreating).toBe("ranked")
      expect((await creating).status).toBe(201)
      expect((await saving).status).toBe(200)
    } finally {
      spy.mockRestore()
    }
    expect((await posting(postingId)).skip_reason).toBe("weak_core_match")
    expect(await applications(postingId)).toHaveLength(1)
  })

  it("a create held behind a save past the 5 s lock_timeout ends with 55P03, not 57014, and answers 500 internal_error (g6 r1, QA-G6-1)", async () => {
    const postingId = await seed({ covered: 7 })
    const repository = app.get(DocumentsRepository)
    const original = repository.createIfRanked.bind(repository)
    const codes: string[] = []
    const spy = vi.spyOn(repository, "createIfRanked").mockImplementation((...args) =>
      original(...args).catch((error: { code?: string }) => {
        codes.push(error.code ?? "error")
        throw error
      })
    )
    const held = await holdSaveThatSkips(postingId)
    try {
      const response = await create(postingId)
      expect(codes).toEqual(["55P03"])
      expect(response.status).toBe(500)
      expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("internal_error")
    } finally {
      spy.mockRestore()
      await held.commit()
    }
    expect(await applications(postingId)).toEqual([])
  }, 40_000)

  describe("insertOnce copies only a ranked posting without an override decision (QA-G6-2, r-AA)", () => {
    const insertOnce = (postingId: string) =>
      app.get(TenantDatabase).asOperator(() => app.get(TenantDatabase).run((trx) => app.get(DocumentsRepository).insertOnce(trx, postingId, clock.now())))

    it("a checking posting with no Application gives undefined and inserts no row", async () => {
      const postingId = await seed({ status: "checking", covered: 3 })
      expect(await insertOnce(postingId)).toBeUndefined()
      expect(await applications(postingId)).toEqual([])
    })

    // r-AA (AA-2.1): without an override decision, insertOnce copies only a ranked posting (the ranked path).
    it("a skipped posting with no Application and no override decision gives undefined and inserts no row", async () => {
      const postingId = await seed({ status: "skipped", skipReason: "weak_core_match", covered: 3 })
      expect(await insertOnce(postingId)).toBeUndefined()
      expect(await applications(postingId)).toEqual([])
    })

    it("a skipped posting that already has an Application gives that Application with created: false", async () => {
      const postingId = await seed({ covered: 7 })
      const first = await insertOnce(postingId)
      expect(first).toMatchObject({ created: true })
      await setCandidatePosting(database.db, database.operatorId, postingId, { status: "skipped", skip_reason: "weak_core_match" })
      expect(await insertOnce(postingId)).toEqual({ id: first!.id, created: false })
      expect(await applications(postingId)).toEqual([{ id: first!.id }])
    })
  })

  // r-AA (AA-2.1, AA-7.5): a create that reads the skip without an acknowledgement is refused, not an override.
  it("interleaved real saves and creates never deadlock; a create after the skip is refused, one before it creates the Application", async () => {
    for (let round = 0; round < 10; round += 1) {
      await database.db.deleteFrom("application").execute()
      await database.db.updateTable("job_criteria").set({ min_core_match_percent: 70, frameworks: [], technologies: [] }).where("candidate_id", "=", database.operatorId).execute()
      const postingId = await seed({ covered: 7 })
      const [saved, created] = await Promise.all([save({ minCoreMatchPercent: 80 }), create(postingId)])
      expect(saved.status).toBe(200)
      expect([201, 409]).toContain(created.status)
      if (created.status === 409) expect(apiErrorResponseSchema.parse(created.body).error.code).toBe("override_acknowledgement_missing")
      expect(await applications(postingId)).toHaveLength(created.status === 201 ? 1 : 0)
      expect((await posting(postingId)).skip_reason).toBe("weak_core_match")
    }
  })
})

describe("Postings read path (postings-page.feature, AC 4.4, 4.5, 6.3)", () => {
  it("tabs list postings by status and each criteria skip carries what its reason line needs", async () => {
    await save({ frameworks: ["React"] }).expect(200)
    const globex = await seed({ name: "Frontend Tech Lead at Globex", covered: 8, technologies: tech("React") })
    const initech = await seed({ name: "Frontend Engineer at Initech", status: "skipped", skipReason: "weak_core_match", covered: 6, total: 10 })
    const umbrella = await seed({ name: "Backend Engineer at Umbrella", status: "skipped", skipReason: "technology_mismatch", covered: 8, technologies: tech("PHP") })
    const hooli = await seed({ name: "Mobile Engineer at Hooli", status: "skipped", skipReason: "uncovered_mandatory_prerequisite", covered: 8 })
    const pied = await seed({ name: "Data Engineer at Pied Piper", status: "excluded", skipReason: "violated_rule", skipDetail: "location" })
    await save({ frameworks: ["React"] }).expect(200)
    expect((await list("ranked")).postings.map((row) => row.id)).toEqual([globex])
    expect(new Set((await list("skipped")).postings.map((row) => row.id))).toEqual(new Set([initech, umbrella, hooli, pied]))
    expect((await list("all")).postings).toHaveLength(5)
    const skipped = (await list("skipped")).postings
    const weak = skipped.find((row) => row.id === initech)!
    expect(weak.skipReason).toBe("weak_core_match")
    expect(weakLine(weak.match!)).toBe("Skipped: core Match 60% is below your 70%.")
    expect(skipped.find((row) => row.id === umbrella)!.skipReason).toBe("technology_mismatch")
  })

  it("a posting with no technology data stays ranked when it meets the Match and is marked not checked", async () => {
    await save({ frameworks: ["React"] }).expect(200)
    const id = await seed({ covered: 8, technologies: null })
    await save({ frameworks: ["React"] }).expect(200)
    const row = (await list("ranked")).postings.find((posting) => posting.id === id)!
    expect(row.technologiesNotChecked).toBe(true)
    const body = await detail(id)
    expect(body.technologiesNotChecked).toBe(true)
    expect(body.technologies).toBeNull()
  })

  it("a posting with no technology data that misses the minimum is skipped with the numbered line", async () => {
    const id = await seed({ covered: 8, technologies: null })
    await save({ minCoreMatchPercent: 90, frameworks: ["React"] }).expect(200)
    const row = (await list("skipped")).postings.find((posting) => posting.id === id)!
    expect(weakLine(row.match!)).toBe("Skipped: core Match 80% is below your 90%.")
  })

  it("with both lists empty the not-checked flag is false everywhere", async () => {
    const id = await seed({ covered: 8, technologies: null })
    expect((await list("ranked")).postings[0]!.technologiesNotChecked).toBe(false)
    expect((await detail(id)).technologiesNotChecked).toBe(false)
  })

  it("a posting with an empty technology list is technology data, not 'not checked'", async () => {
    await save({ frameworks: ["React"] }).expect(200)
    const id = await seed({ status: "skipped", skipReason: "technology_mismatch", covered: 8, technologies: [] })
    const body = await detail(id)
    expect(body.technologies).toEqual([])
    expect(body.technologiesNotChecked).toBe(false)
  })

  it("the detail lists technologies with quotes; inCriteria marks matches only while the criterion is on", async () => {
    const technologies = [
      { name: "React", quote: "Build UIs in React" },
      { name: "AWS", quote: "hosted on AWS" },
    ]
    const id = await seed({ covered: 8, technologies })
    expect((await detail(id)).technologies).toEqual([
      { name: "React", quote: "Build UIs in React", inCriteria: false },
      { name: "AWS", quote: "hosted on AWS", inCriteria: false },
    ])
    await save({ frameworks: ["React.js"] }).expect(200)
    expect((await detail(id)).technologies).toEqual([
      { name: "React", quote: "Build UIs in React", inCriteria: true },
      { name: "AWS", quote: "hosted on AWS", inCriteria: false },
    ])
  })

  it("the detail skips malformed stored technology entries instead of failing (CR-02, SEC-011, AC 5.11)", async () => {
    await save({ frameworks: ["React"] }).expect(200)
    const id = await seed({ covered: 8 })
    const entries = [{ name: 42, quote: "q" }, { quote: "no name" }, null, "React", { name: "Vue", quote: 7 }, { name: "React", quote: "We use React." }]
    await sql`update job_posting set technologies = ${JSON.stringify(entries)}::jsonb where id = ${id}`.execute(database.db)
    expect((await detail(id)).technologies).toEqual([{ name: "React", quote: "We use React.", inCriteria: true }])
  })

  it("the detail Match carries the threshold the stored decision used", async () => {
    const id = await seed({ covered: 8 })
    await save({ minCoreMatchPercent: 75 }).expect(200)
    expect((await detail(id)).match).toMatchObject({ thresholdPercent: 75, coveredCount: 8, totalCount: 10 })
  })

  describe("criteriaEmptyState (AC 6.3)", () => {
    it.each([
      [90, [], ["weak_core_match"], true],
      [70, ["React"], ["technology_mismatch"], true],
      [69, [], ["weak_core_match"], true],
      [71, [], ["weak_core_match"], true],
      [70, [], ["weak_core_match"], false],
      [90, [], [], false],
      [90, ["React"], ["uncovered_mandatory_prerequisite"], false],
      [90, ["React"], ["no_core_responsibilities"], false],
      [90, ["React"], ["uncovered_mandatory_prerequisite", "technology_mismatch"], true],
    ] as const)("minimum %i, frameworks %j, skips %j gives %s", async (minimum, frameworks, skips, expected) => {
      await database.db.updateTable("job_criteria").set({ min_core_match_percent: minimum, frameworks: [...frameworks] }).execute()
      for (const reason of skips) await seed({ status: "skipped", skipReason: reason, covered: reason === "no_core_responsibilities" ? 0 : 5, total: reason === "no_core_responsibilities" ? 0 : 10 })
      for (const tab of ["ranked", "skipped", "all"] as const) expect((await list(tab)).criteriaEmptyState).toBe(expected)
    })

    it("technologies alone make the criteria differ from the defaults", async () => {
      await database.db.updateTable("job_criteria").set({ technologies: ["Go"] }).execute()
      await seed({ status: "skipped", skipReason: "technology_mismatch", covered: 8 })
      expect((await list("ranked")).criteriaEmptyState).toBe(true)
    })

    it("no postings: false; a ranked posting: false", async () => {
      expect((await list("ranked")).criteriaEmptyState).toBe(false)
      await database.db.updateTable("job_criteria").set({ min_core_match_percent: 90 }).execute()
      await seed({ covered: 10 })
      await seed({ status: "skipped", skipReason: "weak_core_match", covered: 5 })
      expect((await list("ranked")).criteriaEmptyState).toBe(false)
    })
  })

  /** r7 postings-page.feature, decision D1 (prd.r3 AC 6.1, 6.3): slice 8 filters narrow the criteria-decided tabs. */
  describe("slice 8 Posting filter on criteria-decided tabs (D1)", () => {
    it("@ac-6.1 family and keyword narrow Ranked to criteria-matching postings and change no status", async () => {
      await save({ frameworks: ["React"] }).expect(200)
      const globex = await seed({ name: "Senior React Engineer at Globex", covered: 8, technologies: tech("React") })
      const initech = await seed({ name: "React Tech Lead at Initech", family: "technical_lead", covered: 8, technologies: tech("React") })
      const hooli = await seed({ name: "Senior Frontend Engineer at Hooli", covered: 8, technologies: tech("React") })
      const umbrella = await seed({ name: "Senior React Developer at Umbrella", status: "skipped", skipReason: "technology_mismatch", covered: 8, technologies: tech("Vue") })
      const piper = await seed({ name: "Senior React Engineer at Pied Piper", status: "skipped", skipReason: "weak_core_match", covered: 5, technologies: tech("React") })
      const before = await Promise.all([globex, initech, hooli, umbrella, piper].map(posting))

      const narrowed = await list("ranked", "&families=senior_frontend&keyword=React")
      expect(narrowed.postings.map((row) => row.id)).toEqual([globex])
      expect(narrowed.totalCount).toBe(1)
      const skippedNarrowed = await list("skipped", "&families=senior_frontend&keyword=React")
      expect(skippedNarrowed.postings.map((row) => row.id).sort()).toEqual([umbrella, piper].sort())

      const cleared = await list("ranked")
      expect(cleared.postings.map((row) => row.id).sort()).toEqual([globex, initech, hooli].sort())
      expect(await Promise.all([globex, initech, hooli, umbrella, piper].map(posting))).toEqual(before)
    })

    it("@ac-6.3 criteriaEmptyState ignores the Posting filter: a filter that empties Ranked does not turn it on", async () => {
      await database.db.updateTable("job_criteria").set({ min_core_match_percent: 90 }).execute()
      await seed({ name: "Senior React Engineer at Globex", covered: 10 })
      await seed({ name: "Frontend Engineer at Initech", status: "skipped", skipReason: "weak_core_match", covered: 5 })
      const filtered = await list("ranked", "&keyword=Kotlin")
      expect(filtered.postings).toEqual([])
      expect(filtered.totalCount).toBe(0)
      expect(filtered.criteriaEmptyState).toBe(false)
    })

    it("@ac-6.3 criteriaEmptyState stays on under a filter that would hide every criteria skip", async () => {
      await database.db.updateTable("job_criteria").set({ min_core_match_percent: 90 }).execute()
      await seed({ name: "Frontend Engineer at Initech", status: "skipped", skipReason: "weak_core_match", covered: 5 })
      for (const tab of ["ranked", "skipped", "all"] as const) {
        expect((await list(tab, "&families=mobile")).criteriaEmptyState).toBe(true)
        expect((await list(tab, "&keyword=Kotlin&limit=1")).criteriaEmptyState).toBe(true)
      }
    })

    it("@ac-6.3 criteriaEmptyState is the same on every page of a paged tab", async () => {
      await database.db.updateTable("job_criteria").set({ min_core_match_percent: 90 }).execute()
      for (let index = 0; index < 3; index += 1) await seed({ name: `Frontend Engineer ${index}`, status: "skipped", skipReason: "weak_core_match", covered: 5 })
      const first = await list("skipped", "&limit=2")
      expect(first.nextCursor).not.toBeNull()
      const second = await list("skipped", `&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)
      expect([first.criteriaEmptyState, second.criteriaEmptyState]).toEqual([true, true])
    })
  })

  it("an unauthenticated visitor gets no posting data", async () => {
    await browser.http().get("/v1/job-postings").expect(401)
  })
})

describe("5,000 stored postings (AC 5.5)", () => {
  async function seedMany(count: number) {
    // Ranked 7..10 of 10, half with technology data ("PHP" or "React"), a quarter with none.
    await sql`
      insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, posting_text, structured, status, skip_reason, discovered_at, evaluated_at, technologies)
      select gen_random_uuid(), 'https://x.test/' || g, 'R-' || g, 'https://x.test/' || g, 'Greenhouse', 'automatic', 'employer_board', 'Role ' || g, 'Co', 'Remote.', '{}', 'ranked', null, now(), now(),
             case g % 4 when 0 then null when 1 then '[]'::jsonb when 2 then '[{"name":"PHP","quote":"PHP"}]'::jsonb else '[{"name":"ReactJS","quote":"ReactJS"},{"name":"AWS","quote":"AWS"}]'::jsonb end
      from generate_series(1, ${count}) g`.execute(database.db)
    await holdAllPostings(database.db, database.operatorId)
    await sql`
      insert into match_evidence (candidate_id, job_posting_id, career_profile_version, verdict, weak_reason, covered_count, total_count, threshold, items, evaluated_at, criteria_version)
      select ${database.operatorId}::uuid, p.id, 1, 'strong', null, 7 + (substring(p.requisition_id from 3)::int % 4), 10, 0.700, '[]', now(), 1 from job_posting p`.execute(database.db)
  }

  it("a save re-decides 5,000 postings inside the request in under 5 seconds, and statuses match the criteria", async () => {
    await seedMany(5_000)
    const started = performance.now()
    await save({ minCoreMatchPercent: 80, frameworks: ["React"] }).expect(200)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(5_000)
    const { rows } = await sql<{ g: number; status: string; skip_reason: string | null; version: number }>`
      select substring(p.requisition_id from 3)::int as g, cp.status, cp.skip_reason, m.criteria_version as version
      from job_posting p join candidate_posting cp on cp.job_posting_id = p.id join match_evidence m on m.job_posting_id = p.id`.execute(database.db)
    expect(rows).toHaveLength(5_000)
    for (const row of rows) {
      const covered = 7 + (row.g % 4)
      const kind = row.g % 4 // 0: no data, 1: none, 2: PHP, 3: ReactJS
      const expected = covered < 8 ? "weak_core_match" : kind === 0 || kind === 3 ? null : "technology_mismatch"
      expect(row.skip_reason).toBe(expected)
      expect(row.version).toBe(2)
    }
    console.info(`re-decision of 5,000 postings: ${Math.round(elapsed)} ms`)
  })
})

describe("observability", () => {
  it("logs one job_criteria.saved line with counts and no entries", async () => {
    await seed({ covered: 7 })
    const repository = app.get(JobCriteriaRepository)
    const spy = vi.spyOn(repository, "saveAndRedecide")
    await save({ minCoreMatchPercent: 80, frameworks: ["SecretStack"] }).expect(200)
    expect(spy).toHaveBeenCalledTimes(1)
    const result = await spy.mock.results[0]!.value
    expect(result).toMatchObject({ considered: 1, changed: [{ status: "skipped", previousStatus: "ranked" }] })
    spy.mockRestore()
  })
})
