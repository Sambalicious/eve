import { randomUUID } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Logger } from "@nestjs/common"
import type { INestApplication } from "@nestjs/common"
import { ME_PREFERENCES_PATH, type PreferencesValues } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { FX_RATES } from "../src/discovery/fx-rates.js"
import { evaluateEligibility, eligibilityPreferencesOf } from "../src/discovery/rules/eligibility.js"
import { PreferencesSaveLimiter } from "../src/preferences/preferences-save-limit.guard.js"
import { PreferencesRepository } from "../src/preferences/preferences.repository.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 B1 unit 8: the threat-model proofs the earlier specs did not
 * cover (threat-model.md TM-B1-09, -10, -11, -14, -16, -18). Each `describe`
 * names its threat.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
const clock = new TestClock("2026-10-23T09:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
})

beforeEach(async () => {
  clock.set("2026-10-23T09:00:00.000Z")
  ada = await signInCandidate(new Browser(app, google))
  app.get(PreferencesSaveLimiter).reset()
  vi.restoreAllMocks()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

async function current(): Promise<{ version: number; values: PreferencesValues }> {
  const row = await database.db.selectFrom("job_preferences").select(["version", "values"]).where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()
  return { version: row.version, values: row.values as PreferencesValues }
}
async function save(change: Partial<PreferencesValues>, baseVersion?: number) {
  const { version, values } = await current()
  return ada.put(ME_PREFERENCES_PATH).send({ baseVersion: baseVersion ?? version, values: { ...values, ...change } })
}
const count = async (table: "spend_entry" | "ai_call") => Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)}`.execute(database.db)).rows[0]!.n)

describe("TM-B1-09: keyword toggling queues no paid work at save", () => {
  it("200 postings toggled out and back: the two saves write no spend_entry or ai_call; they return to waiting for the bounded tick", async () => {
    expect((await save({ titleKeyword: null })).status).toBe(200)
    const ids: string[] = []
    for (let i = 0; i < 200; i += 1) {
      const id = randomUUID()
      const url = `https://boards.greenhouse.io/globex/jobs/${id}`
      await insertPostingFor(database.db, database.operatorId, {
        id, application_url: url, requisition_id: id.slice(0, 8), apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board",
        employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: `Senior Vue Engineer ${i}`, company: "Globex", posting_text: "Remote.",
        status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date(), evaluated_at: new Date(),
      } as never)
      ids.push(id)
    }
    const before = { spend: await count("spend_entry"), calls: await count("ai_call") }
    expect((await save({ titleKeyword: "react" })).status).toBe(200)
    expect((await save({ titleKeyword: null })).status).toBe(200)
    expect({ spend: await count("spend_entry"), calls: await count("ai_call") }).toEqual(before)
    const waiting = await sql<{ n: number }>`select count(*)::int as n from candidate_posting where candidate_id = ${database.operatorId}::uuid and status = 'waiting_to_be_checked' and job_posting_id = any(${ids}::uuid[])`.execute(database.db)
    expect(waiting.rows[0]!.n).toBe(200)
  })
})

describe("TM-B1-10: the D41 lookup stays one bounded query over a long history", () => {
  it("10,000 versions: GET computes timeZoneLockedUntil in one statement under 250 ms", async () => {
    const { version, values } = await current()
    await sql`
      insert into job_preferences_version (candidate_id, version, values, saved_at)
      select ${database.operatorId}::uuid, ${version} + g, ${JSON.stringify(values)}::jsonb, ${clock.now()}::timestamptz - (10001 - g) * interval '1 minute'
      from generate_series(1, 10000) g`.execute(database.db)
    await database.db.updateTable("job_preferences").set({ version: version + 10000 }).where("candidate_id", "=", database.operatorId).execute()
    const started = performance.now()
    const record = await CandidateScope.run(database.operatorId, () => app.get(PreferencesRepository).read())
    expect(performance.now() - started).toBeLessThan(250)
    expect(record?.version).toBe(version + 10000)
  })
})

describe("TM-B1-11: refused saves never start the D41 lock", () => {
  it("a 409 stale save with a new zone, then a valid change a minute later, is accepted", async () => {
    clock.set("2026-11-10T09:00:00.000Z")
    ada = await signInCandidate(new Browser(app, google))
    const { version } = await current()
    expect((await save({ timeZone: "Europe/Berlin" }, version - 1)).status).toBe(409)
    clock.set("2026-11-10T09:01:00.000Z")
    const accepted = await save({ timeZone: "Europe/Berlin" })
    expect(accepted.status).toBe(200)
    expect(accepted.body.timeZoneLockedUntil).toBe("2026-11-11T09:01:00.000Z")
  })
})

describe("TM-B1-14: a corrupt stored value fails closed with no value in the log", () => {
  it("GET is 500 internal_error and the captured logs hold none of the stored values", async () => {
    const logs: string[] = []
    for (const level of ["log", "error", "warn", "debug", "verbose"] as const) vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")))
    await sql`update job_preferences set values = values || '{"dailyCap": "SECRET-CAP-VALUE"}'::jsonb where candidate_id = ${database.operatorId}::uuid`.execute(database.db)
    try {
      const response = await ada.get(ME_PREFERENCES_PATH)
      expect(response.status).toBe(500)
      expect(response.body.error.code).toBe("internal_error")
      expect(JSON.stringify(response.body)).not.toContain("SECRET-CAP-VALUE")
      expect(logs.join("\n")).not.toContain("SECRET-CAP-VALUE")
    } finally {
      await sql`update job_preferences set values = values || '{"dailyCap": 3}'::jsonb where candidate_id = ${database.operatorId}::uuid`.execute(database.db)
    }
  })
})

describe("TM-B1-16: hours come from each Candidate's preferences, never the installation row", () => {
  it("two Candidates' latest work hours (18:00 and 23:00) give opposite verdicts on one posting", () => {
    const text = "Core hours 10:00–19:00 WAT."
    const base = { homeCountry: "NG", workAuthorizedCountries: ["NG"], remoteAccepted: true, relocationAccepted: true, sponsorshipNeededForRelocation: true, excludedRelocationCountries: [], excludedIndustries: [], payFloor: null, timeZone: "Africa/Lagos", seniorityLevels: ["junior", "mid", "senior", "staff", "principal"], employmentTypes: ["direct", "employer_of_record", "contract"] }
    const run = (latestWorkHour: string) =>
      evaluateEligibility({
        title: null, postingText: text,
        facts: { workArrangement: "remote", locationQuote: null, relocationCountry: null, relocationQuote: null, sponsorshipQuote: null, payQuote: null, hoursQuote: text, employerBusiness: null, businessQuote: null, employmentType: null },
        structured: { workplace: null, locationRestrictions: null, pay: null, employmentType: null },
        preferences: eligibilityPreferencesOf({ ...base, latestWorkHour }), rates: FX_RATES, evaluatedOn: clock.now(),
      }).rules.hours.result
    expect([run("18:00"), run("23:00")]).toEqual(["violated", "met"])
  })

  it("source test: no src code outside the GET read path reads evaluation_setting", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (path.endsWith(".ts") && !path.endsWith(".spec.ts") && !path.includes("/migrations/") && !path.includes("__golden__")) files.push(path)
      }
    }
    walk(root)
    const readers = files.filter((file) => /selectFrom\("evaluation_setting"\)|from evaluation_setting\b/.test(readFileSync(file, "utf8"))).map((file) => file.replace(root, "src"))
    expect(readers).toEqual(["src/discovery/discovery.repository.ts"])
    // The one reader is readSettings, used only by the GET handler.
    const callers = files.filter((file) => /\.readSettings\(\)/.test(readFileSync(file, "utf8"))).map((file) => file.replace(root, "src"))
    expect(callers).toEqual(["src/discovery/discovery.service.ts"])
    const service = readFileSync(join(root, "discovery/discovery.service.ts"), "utf8")
    expect((service.match(/\.readSettings\(\)/g) ?? []).length).toBe(1)
    expect(service).toMatch(/async eligibilitySettings\(\)[\s\S]{0,200}\.readSettings\(\)/)
  })
})

describe("TM-B1-18: a save logs counts and versions only", () => {
  it("a save with keyword react, zone Africa/Lagos and pay 5000.00 logs none of those values", async () => {
    clock.set("2026-12-20T09:00:00.000Z")
    ada = await signInCandidate(new Browser(app, google))
    const logs: string[] = []
    for (const level of ["log", "error", "warn", "debug", "verbose"] as const) vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")))
    const response = await save({ titleKeyword: "react", timeZone: "Africa/Lagos", preferredPay: { amount: "5000.00", currency: "USD", period: "month", basis: "net" } })
    expect(response.status).toBe(200)
    const text = logs.join("\n")
    expect(text).toContain("preferences.saved")
    for (const value of ["react", "Africa/Lagos", "5000.00"]) expect(text).not.toContain(value)
  })
})
