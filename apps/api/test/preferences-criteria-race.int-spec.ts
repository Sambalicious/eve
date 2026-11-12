import { randomUUID } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { INestApplication } from "@nestjs/common"
import { DEFAULT_ROLE_FAMILY_TIERS, type JobCriteriaRequest, type PreferencesValues, foldForKeywords } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { DocumentsRepository } from "../src/documents/documents.repository.js"
import { JobCriteriaRepository } from "../src/job-criteria/job-criteria.repository.js"
import { sharePreferences } from "../src/preferences/preferences-lock.js"
import { PreferencesSaveEffects } from "../src/preferences/preferences-save-effects.js"
import { PreferencesRepository } from "../src/preferences/preferences.repository.js"
import { SampleRepository } from "../src/submission/sample.repository.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { FakeGoogle } from "./support/fake-google.js"
import { ROLE_RELEVANCE_DEFAULTS } from "./support/job-criteria-body.js"
import { backendPid, untilLockWait } from "./support/lock-wait.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 B1 unit 7 (architecture.r6 "Lock order and SEC-014", "Job criteria
 * save rule (B1 only)", race tests (a) to (f); job-criteria-in-preferences.feature
 * :611, :625). A Job criteria save and a preferences save of the same
 * Candidate never deadlock, and the criteria save never ranks a posting the
 * current keyword or family skips.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
const clock = new TestClock("2026-10-21T09:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
})

beforeEach(async () => {
  await database.db.deleteFrom("submission_event").execute()
  await database.db.deleteFrom("application").execute()
  await database.db.deleteFrom("match_evidence").execute()
  await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
  await database.db.updateTable("job_criteria").set({ min_core_match_percent: 80, frameworks: [], technologies: [] }).where("candidate_id", "=", database.operatorId).execute()
  await setPreferences({ titleKeyword: null, roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS } })
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const asOperator = <T>(work: () => Promise<T>) => CandidateScope.run(database.operatorId, work)

async function current(): Promise<{ version: number; values: PreferencesValues }> {
  const row = await database.db.selectFrom("job_preferences").select(["version", "values"]).where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()
  return { version: row.version, values: row.values as PreferencesValues }
}

/** Writes a new current version directly (fixture only; no re-decision). */
async function setPreferences(change: Partial<PreferencesValues>): Promise<void> {
  const { version, values } = await current()
  const next = JSON.stringify({ ...values, ...change })
  if (next === JSON.stringify(values)) return
  await database.db.insertInto("job_preferences_version").values({ candidate_id: database.operatorId, version: version + 1, values: next, saved_at: clock.now() } as never).execute()
  await database.db.updateTable("job_preferences").set({ version: version + 1, values: next } as never).where("candidate_id", "=", database.operatorId).execute()
}

/** A posting skipped as weak_core_match with stored core Match `covered` of 10 (or another state). */
async function seed(title: string, family: string, covered = 7, status = "skipped", reason: string | null = "weak_core_match"): Promise<string> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/globex/jobs/${id}`
  await database.db
    .insertInto("job_posting")
    .values({ id, application_url: url, requisition_id: id.slice(0, 8), apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board", title, title_folded: foldForKeywords(title), company: "Globex", structured: "{}", role_family: family, discovered_at: new Date() } as never)
    .execute()
  await database.db.insertInto("candidate_posting").values({ candidate_id: database.operatorId, job_posting_id: id, origin: "employer_board", status, skip_reason: reason, discovered_at: new Date(), evaluated_at: new Date() } as never).execute()
  await database.db
    .insertInto("match_evidence")
    .values({ candidate_id: database.operatorId, job_posting_id: id, career_profile_version: 1, verdict: covered >= 8 ? "strong" : "weak", weak_reason: covered >= 8 ? null : "coverage_below_threshold", covered_count: covered, total_count: 10, threshold: "0.800", items: "[]", evaluated_at: new Date(), criteria_version: 1 })
    .execute()
  return id
}

const state = async (id: string) =>
  (await sql<{ status: string; skip_reason: string | null }>`select status, skip_reason from candidate_posting where candidate_id = ${database.operatorId}::uuid and job_posting_id = ${id}::uuid`.execute(database.db)).rows[0]!

const criteria = (min: number): JobCriteriaRequest => ({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent: min, frameworks: [], technologies: [] }) as JobCriteriaRequest
const saveCriteria = (min: number) => asOperator(() => app.get(JobCriteriaRepository).saveAndRedecide(criteria(min)))

/** A preferences save through the repository, as the route runs it. */
async function savePreferences(change: Partial<PreferencesValues>) {
  const { version, values } = await current()
  return asOperator(() => app.get(PreferencesRepository).save({ baseVersion: version, values: { ...values, ...change }, now: clock.now() }, () => false))
}

/** Holds the next preferences save open after its posting update, until `release()`. */
function holdNextPreferencesSave() {
  const effects = app.get(PreferencesSaveEffects)
  const original = effects.afterSave.bind(effects)
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let reached!: (pid: number) => void
  const holding = new Promise<number>((resolve) => (reached = resolve))
  effects.afterSave = async (trx, saved) => {
    await original(trx, saved)
    reached(await backendPid(trx as never))
    await gate
  }
  return { holding, release: () => { effects.afterSave = original; release() } }
}

const KEYWORD = { titleKeyword: "react" }
const MOBILE_EXCLUDED = { roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, mobile: "excluded" as const } }

describe("(a) to (c), :611: a criteria save racing a preferences save never ranks a posting the preferences skip", () => {
  it.each([
    ["Senior Vue Engineer", "senior_frontend", KEYWORD, "keyword_mismatch"],
    ["Senior Android Engineer", "mobile", MOBILE_EXCLUDED, "excluded_role_family"],
  ] as const)("(a/c) preferences save held first: %s ends %s; the criteria save waited on job_preferences", async (title, family, change, reason) => {
    const x = await seed(title, family)
    const held = holdNextPreferencesSave()
    const prefs = savePreferences(change)
    const pid = await held.holding
    const crit = saveCriteria(60)
    await untilLockWait(database.db, "the criteria save", "row", pid)
    held.release()
    await expect(prefs).resolves.toMatchObject({ kind: "saved" })
    await expect(crit).resolves.toMatchObject({ redecided: true })
    expect(await state(x)).toEqual({ status: "skipped", skip_reason: reason })
  })

  it.each([
    ["Senior Vue Engineer", "senior_frontend", KEYWORD, "keyword_mismatch"],
    ["Senior Android Engineer", "mobile", MOBILE_EXCLUDED, "excluded_role_family"],
  ] as const)("(b) criteria save held first: %s ends %s", async (title, family, change, reason) => {
    const x = await seed(title, family)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let reached!: (pid: number) => void
    const holding = new Promise<number>((resolve) => (reached = resolve))
    // Hold a criteria save open after its writes, in the transaction the route's saveAndRedecide would use.
    const repo = app.get(JobCriteriaRepository)
    const crit = asOperator(() =>
      app.get(TenantDatabase).run(async (trx, candidateId) => {
        await repo.saveIn(trx, candidateId, criteria(60))
        reached(await backendPid(trx as never))
        await gate
      })
    )
    const pid = await holding
    expect(await state(x)).toEqual({ status: "skipped", skip_reason: "weak_core_match" })
    const prefs = savePreferences(change)
    await untilLockWait(database.db, "the preferences save", "row", pid)
    release()
    await crit
    await expect(prefs).resolves.toMatchObject({ kind: "saved" })
    expect(await state(x)).toEqual({ status: "skipped", skip_reason: reason })
  })
})

describe("(e), :625: a criteria save never ranks a posting that fails the saved keyword", () => {
  it("a pre-B1 weak_core_match row the saved keyword fails is written keyword_mismatch, stamped with the current version, never waiting", async () => {
    await setPreferences(KEYWORD)
    const { version } = await current()
    const x = await seed("Senior Vue Engineer", "senior_frontend")
    await saveCriteria(60)
    expect(await state(x)).toEqual({ status: "skipped", skip_reason: "keyword_mismatch" })
    expect((await database.db.selectFrom("candidate_posting").select("preferences_version").where("job_posting_id", "=", x).executeTakeFirstOrThrow()).preferences_version).toBe(version)
  })

  it("a ranked row in an excluded family becomes excluded_role_family; a row that passes both is ranked by the lower minimum", async () => {
    await setPreferences(MOBILE_EXCLUDED)
    const android = await seed("Senior Android Engineer", "mobile", 9, "ranked", null)
    const vue = await seed("Senior Vue Engineer", "senior_frontend")
    await saveCriteria(60)
    expect(await state(android)).toEqual({ status: "skipped", skip_reason: "excluded_role_family" })
    expect(await state(vue)).toEqual({ status: "ranked", skip_reason: null })
  })

  it("rows already skipped by keyword or family are never rewritten or restamped", async () => {
    await setPreferences({ titleKeyword: null })
    const kw = await seed("Senior Vue Engineer", "senior_frontend", 9, "skipped", "keyword_mismatch")
    const fam = await seed("Senior Android Engineer", "mobile", 9, "skipped", "excluded_role_family")
    await database.db.updateTable("candidate_posting").set({ preferences_version: 1 }).where("job_posting_id", "in", [kw, fam]).execute()
    await saveCriteria(60)
    expect(await state(kw)).toEqual({ status: "skipped", skip_reason: "keyword_mismatch" })
    expect(await state(fam)).toEqual({ status: "skipped", skip_reason: "excluded_role_family" })
    const versions = await database.db.selectFrom("candidate_posting").select("preferences_version").where("job_posting_id", "in", [kw, fam]).execute()
    expect(versions.map((row) => row.preferences_version)).toEqual([1, 1])
  })

  it("current preferences that fail to parse: the criteria save writes nothing and fails closed", async () => {
    const x = await seed("Senior Vue Engineer", "senior_frontend")
    const before = await database.db.selectFrom("job_criteria").select(["version", "min_core_match_percent"]).where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()
    await sql`update job_preferences set values = values || '{"dailyCap": 99}'::jsonb where candidate_id = ${database.operatorId}::uuid`.execute(database.db)
    try {
      await expect(saveCriteria(60)).rejects.toThrow()
      expect(await state(x)).toEqual({ status: "skipped", skip_reason: "weak_core_match" })
      expect(await database.db.selectFrom("job_criteria").select(["version", "min_core_match_percent"]).where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).toEqual(before)
    } finally {
      await sql`update job_preferences set values = values || '{"dailyCap": 3}'::jsonb where candidate_id = ${database.operatorId}::uuid`.execute(database.db)
    }
  })
})

describe("(d) 50 random interleavings over 200 postings: no 40P01, no failure, serial result", () => {
  it("every run ends in the state of the two saves applied one after the other", async () => {
    const families = ["senior_frontend", "mobile", "backend", "fullstack"]
    const titles = ["Senior React Engineer", "Senior Vue Engineer", "Senior Android Engineer", "Backend Go Engineer"]
    const ids: string[] = []
    for (let i = 0; i < 200; i += 1) ids.push(await seed(titles[i % 4]!, families[i % 4]!, 5 + (i % 5)))
    const seeded = new Map(await Promise.all(ids.map(async (id) => [id, await state(id)] as const)))
    let deadlocks = 0
    let failures = 0
    for (let run = 0; run < 50; run += 1) {
      // Reset to the seeded state and a known record and minimum.
      for (const [id, row] of seeded) await database.db.updateTable("candidate_posting").set({ status: row.status as never, skip_reason: row.skip_reason }).where("candidate_id", "=", database.operatorId).where("job_posting_id", "=", id).execute()
      await database.db.updateTable("job_criteria").set({ min_core_match_percent: 80 }).where("candidate_id", "=", database.operatorId).execute()
      await setPreferences({ titleKeyword: null, roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS } })
      const change = run % 2 === 0 ? KEYWORD : MOBILE_EXCLUDED
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const order = Math.random() < 0.5
      const results = await Promise.allSettled([
        delay(order ? 0 : Math.floor(Math.random() * 15)).then(() => savePreferences(change)),
        delay(order ? Math.floor(Math.random() * 15) : 0).then(() => saveCriteria(60)),
      ])
      for (const result of results) {
        if (result.status === "rejected") {
          failures += 1
          if (String((result.reason as { code?: string }).code) === "40P01") deadlocks += 1
        }
      }
      // Serial result: every posting's final state is the same whichever save committed first, because the two
      // saves commute under the rule (keyword/family win; criteria never ranks a skipped-by-preferences row).
      const keyword = run % 2 === 0
      for (const [index, id] of ids.entries()) {
        const failsPreferences = keyword ? !titles[index % 4]!.toLowerCase().includes("react") : families[index % 4] === "mobile"
        const covered = 5 + (index % 5)
        const expected = failsPreferences ? { status: "skipped", skip_reason: keyword ? "keyword_mismatch" : "excluded_role_family" } : covered >= 6 ? { status: "ranked", skip_reason: null } : { status: "skipped", skip_reason: "weak_core_match" }
        expect(await state(id), `run ${run} posting ${index}`).toEqual(expected)
      }
    }
    expect({ deadlocks, failures }).toEqual({ deadlocks: 0, failures: 0 })
  }, 600_000)
})

describe(":735 to :760: claim, Application creation and samples wait on a running preferences save and see its result", () => {
  async function queued(postingId: string): Promise<string> {
    const applicationId = randomUUID()
    const url = `https://boards.greenhouse.io/globex/jobs/${postingId}`
    await database.db
      .insertInto("application")
      .values({ candidate_id: database.operatorId, id: applicationId, job_posting_id: postingId, application_url: url, requisition_id: postingId.slice(0, 8), company: `Globex ${postingId.slice(0, 4)}`, role_title: "Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date(), submission_state: "queued", submission_kind: "automatic" } as never)
      .execute()
    return applicationId
  }
  const events = async (applicationId: string) => (await database.db.selectFrom("submission_event").select("kind").where("application_id", "=", applicationId).execute()).map((row) => row.kind)

  it(":735 a claim that starts while a save holds the record waits, then drops with queued_posting_preferences_changed", async () => {
    const vue = await seed("Senior Vue Engineer", "senior_frontend", 9, "ranked", null)
    // Merge with main 0422b14: dated, so the posting is visible (an undated one is hidden, EPIC-0006 AC-3.9, and a
    // hidden posting's drop is detail `hidden`, logged as queued_posting_dropped); the keyword skip is the only cause.
    await database.db.updateTable("job_posting").set({ posted_at: clock.now(), posted_date_kind: "published" }).where("id", "=", vue).execute()
    const applicationId = await queued(vue)
    const held = holdNextPreferencesSave()
    const prefs = savePreferences(KEYWORD)
    const pid = await held.holding
    const claim = asOperator(() => app.get(SubmissionRepository).claim(applicationId, "automatic", "2026-10-21", clock.now()))
    await untilLockWait(database.db, "the claim", "row", pid)
    held.release()
    await prefs
    expect(await claim).toEqual({ refused: "posting_closed" })
    expect(await events(applicationId)).toEqual(["queued_posting_preferences_changed"])
  })

  it(":744 a save that starts while a claim's transaction holds the share lock waits for it", async () => {
    const react = await seed("React Engineer", "senior_frontend", 9, "ranked", null)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let reached!: (pid: number) => void
    const holding = new Promise<number>((resolve) => (reached = resolve))
    const claimTx = asOperator(() =>
      app.get(TenantDatabase).run(async (trx, candidateId) => {
        await sharePreferences(trx, candidateId)
        reached(await backendPid(trx as never))
        await gate
      })
    )
    const pid = await holding
    const prefs = savePreferences(KEYWORD)
    await untilLockWait(database.db, "the preferences save", "row", pid)
    release()
    await claimTx
    await expect(prefs).resolves.toMatchObject({ kind: "saved" })
    expect(await state(react)).toEqual({ status: "ranked", skip_reason: null })
  })

  it(":751 preparing an Application while a save holds the record waits and is refused when the save skipped the posting", async () => {
    const vue = await seed("Senior Vue Engineer", "senior_frontend", 9, "ranked", null)
    const held = holdNextPreferencesSave()
    const prefs = savePreferences(KEYWORD)
    const pid = await held.holding
    const create = asOperator(() => app.get(DocumentsRepository).createIfRanked(vue, null, clock.now()))
    await untilLockWait(database.db, "createIfRanked", "row", pid)
    held.release()
    await prefs
    expect(await create).not.toMatchObject({ kind: "created" })
    expect(await database.db.selectFrom("application").select("id").where("job_posting_id", "=", vue).execute()).toEqual([])
  })

  it(":760 choosing samples while a save holds the record waits and leaves out postings the save skipped", async () => {
    const vue = await seed("Senior Vue Engineer", "senior_frontend", 9, "ranked", null)
    const held = holdNextPreferencesSave()
    const prefs = savePreferences(KEYWORD)
    const pid = await held.holding
    const pick = asOperator(() =>
      app.get(TenantDatabase).run(async (trx) => {
        await app.get(SampleRepository).shareCriteria(trx)
        return state(vue)
      })
    )
    await untilLockWait(database.db, "sample preparation", "row", pid)
    held.release()
    await prefs
    // The sample choice reads after the share lock, so it sees the save's result: the posting is no longer ranked.
    expect(await pick).toEqual({ status: "skipped", skip_reason: "keyword_mismatch" })
  })
})

describe("(f) source test: every job_criteria lock follows sharePreferences", () => {
  it("no file locks job_criteria (FOR SHARE or FOR UPDATE) without sharePreferences earlier in the same function", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (path.endsWith(".ts") && !path.endsWith(".spec.ts") && !path.includes("/migrations/")) files.push(path)
      }
    }
    walk(root)
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      // Every raw lock of the criteria row: a `job_criteria` select chained to forShare/forUpdate (possibly through a
      // `query` variable), or `criteriaRow(...)` chained to forShare/forUpdate. Helpers (visibilityContext, shareCriteria)
      // are covered because their own raw lock is scanned here.
      const raw = /selectFrom\("job_criteria"\)[^;]*?\.for(Share|Update)\(\)|criteriaRow\([^)]*\)\.for(Share|Update)\(\)/g
      const viaVariable = /selectFrom\("job_criteria"\)[\s\S]*?\n[^\n]*query = query\.for(Share|Update)\(\)/g
      for (const match of [...text.matchAll(raw), ...text.matchAll(viaVariable)]) {
        // The enclosing function: from the last function or method start before the match to the lock.
        const before = text.slice(0, match.index + match[0].length)
        const start = Math.max(before.lastIndexOf("async "), before.lastIndexOf("function "), before.lastIndexOf("\n  async "))
        const body = text.slice(start, match.index + match[0].length)
        const share = body.search(/sharePreferences\(/)
        const lockAt = body.search(/\.for(Share|Update)\(\)/)
        if (share === -1 || share > lockAt) offenders.push(`${file.replace(root, "src")}:${text.slice(0, match.index).split("\n").length}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
