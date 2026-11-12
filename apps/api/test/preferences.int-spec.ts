import type { INestApplication } from "@nestjs/common"
import {
  DEFAULT_ROLE_FAMILY_TIERS,
  ME_PREFERENCES_PATH,
  ME_PREFERENCES_VERSIONS_PATH,
  type PreferencesValues,
  STEP3_DEFAULTS,
  apiErrorResponseSchema,
  preferencesResponseSchema,
  preferencesVersionsResponseSchema,
} from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { PreferencesSaveLimiter } from "../src/preferences/preferences-save-limit.guard.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 B1 unit 2: `GET`/`PUT /v1/me/preferences` and
 * `GET /v1/me/preferences/versions` (api-contract-b1 v1.25.0; threat model
 * F-TM-01, F-TM-02, F-TM-05, TM-B1-04, TM-B1-12; D40, D41). Real api, real
 * Postgres under forced RLS; only the clock is moved by hand. Ada is the
 * Operator (migrated version 2 after 0027); Kofi is a non-Operator.
 */
const T0 = "2026-10-23T09:00:00.000Z"
const KOFI = { sub: "google-sub-kofi-b1-prefs", email: "kofi.prefs@example.test" }

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let kofiId: string
const clock = new TestClock(T0)

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  kofiId = (await database.db.insertInto("candidate").values({ email: KOFI.email, google_sub: KOFI.sub, role: "candidate", onboarded_at: new Date("2026-10-20T09:00:00Z") } as never).returning("id").executeTakeFirstOrThrow()).id
})

beforeEach(async () => {
  clock.set(T0)
  app.get(PreferencesSaveLimiter).reset()
  await database.db.deleteFrom("job_preferences").where("candidate_id", "=", kofiId).execute()
  await database.db.deleteFrom("job_preferences_version").where("candidate_id", "=", kofiId).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

async function kofi(): Promise<SignedInCandidate> {
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub: KOFI.sub, email: KOFI.email, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  return new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, KOFI.email)
}

const ada = () => signInCandidate(new Browser(app, google))

function values(over: Partial<PreferencesValues> = {}): PreferencesValues {
  return {
    homeCountry: "KE",
    timeZone: "Africa/Nairobi",
    latestWorkHour: "23:00",
    workAuthorizedCountries: ["KE"],
    remoteAccepted: true,
    relocationAccepted: true,
    sponsorshipNeededForRelocation: true,
    excludedRelocationCountries: [],
    excludedIndustries: [],
    payFloor: { amount: "4000.00", currency: "EUR", period: "month", basis: "gross" },
    preferredPay: { amount: "5500.00", currency: "EUR", period: "month", basis: "net" },
    roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS },
    titleKeyword: null,
    seniorityLevels: ["junior", "mid", "senior", "staff", "principal"],
    employmentTypes: ["direct", "employer_of_record", "contract"],
    dailyCap: 3,
    emphasisThemes: [],
    ...over,
  }
}

const save = (who: SignedInCandidate, baseVersion: unknown, body: unknown = values()) => who.put(ME_PREFERENCES_PATH).send({ baseVersion, values: body })

async function rows(candidateId: string) {
  const current = await database.db.selectFrom("job_preferences").selectAll().where("candidate_id", "=", candidateId).execute()
  const history = await database.db.selectFrom("job_preferences_version").selectAll().where("candidate_id", "=", candidateId).orderBy("version").execute()
  return JSON.stringify({ current, history })
}

describe("GET /v1/me/preferences", () => {
  it("no record: 200 with version null and STEP3_DEFAULTS, no-store, and writes nothing", async () => {
    const me = await kofi()
    const before = await rows(kofiId)
    const response = await me.get(ME_PREFERENCES_PATH).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.body).toEqual({ version: null, savedAt: null, timeZoneLockedUntil: null, matchedRegions: [], values: STEP3_DEFAULTS })
    expect(preferencesResponseSchema.safeParse(response.body).success).toBe(true)
    expect(await rows(kofiId)).toBe(before)
  })

  it("the Operator reads the migrated v1.25.0 record", async () => {
    const response = await (await ada()).get(ME_PREFERENCES_PATH).expect(200)
    expect(preferencesResponseSchema.safeParse(response.body).success, JSON.stringify(response.body)).toBe(true)
    expect(response.body).toMatchObject({ version: 2, timeZoneLockedUntil: null, values: { homeCountry: "NG" } })
    expect(response.body.matchedRegions).toEqual(["africa", "emea"])
  })

  it.each([ME_PREFERENCES_PATH, ME_PREFERENCES_VERSIONS_PATH])("F-TM-05: %s with an unknown query parameter is 400 bad_request", async (path) => {
    const me = await kofi()
    const response = await me.get(`${path}?candidateId=00000000-0000-4000-8000-000000000001`)
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
  })

  it("F-TM-05: any query on GET /v1/me/preferences is refused, even an empty one", async () => {
    const me = await kofi()
    expect((await me.get(`${ME_PREFERENCES_PATH}?x`)).status).toBe(400)
  })

  it("401 without a session", async () => {
    const response = await new Browser(app, google).http().get(ME_PREFERENCES_PATH)
    expect(response.status).toBe(401)
  })
})

describe("PUT /v1/me/preferences: versions", () => {
  it("first save with baseVersion null creates version 1 at the clock time, and a later save keeps both versions", async () => {
    const me = await kofi()
    const first = await save(me, null).expect(200)
    expect(preferencesResponseSchema.safeParse(first.body).success).toBe(true)
    expect(first.body).toMatchObject({ version: 1, savedAt: "2026-10-23T09:00:00.000Z", timeZoneLockedUntil: null, matchedRegions: ["africa", "emea"], values: values() })
    expect(first.headers["cache-control"]).toBe("no-store")
    clock.set("2026-10-23T09:10:00.000Z")
    const second = await save(me, 1, values({ dailyCap: 4 })).expect(200)
    expect(second.body).toMatchObject({ version: 2, savedAt: "2026-10-23T09:10:00.000Z", values: { dailyCap: 4 } })
    const history = await database.db.selectFrom("job_preferences_version").select(["version", "values"]).where("candidate_id", "=", kofiId).orderBy("version").execute()
    expect(history.map((row) => [row.version, (row.values as PreferencesValues).dailyCap])).toEqual([[1, 3], [2, 4]])
    expect((await me.get(ME_PREFERENCES_PATH).expect(200)).body).toEqual(second.body)
  })

  it.each([
    ["missing baseVersion", { values: values() }],
    ["baseVersion 0", { baseVersion: 0, values: values() }],
    ["baseVersion as a string", { baseVersion: "1", values: values() }],
    ["F-TM-01 baseVersion 2147483648", { baseVersion: 2_147_483_648, values: values() }],
    ["F-TM-01 baseVersion 1e300", { baseVersion: 1e300, values: values() }],
    ["an unknown top-level key", { baseVersion: null, values: values(), candidateId: "x" }],
    ["an unknown values key", { baseVersion: null, values: { ...values(), minCoreMatchPercent: 70 } }],
    ["F-TM-02 a 100,000-entry list", { baseVersion: null, values: { ...values(), excludedIndustries: Array.from({ length: 100_000 }, () => 1) } }],
  ])("%s is a plain 400 bad_request and writes nothing", async (_label, body) => {
    const me = await kofi()
    const response = await me.put(ME_PREFERENCES_PATH).send(body)
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
    expect(await rows(kofiId)).toBe(JSON.stringify({ current: [], history: [] }))
  })

  it("F-TM-01: baseVersion 2147483647 is a 409, not a 500", async () => {
    const me = await kofi()
    await save(me, null).expect(200)
    const response = await save(me, 2_147_483_647)
    expect(response.status).toBe(409)
    expect(response.body.error).toMatchObject({ code: "preferences_stale", currentVersion: 1 })
  })

  it("field errors: 400 with fieldErrors in contract order, no value echoed, nothing written", async () => {
    const me = await kofi()
    const response = await save(me, null, values({ dailyCap: 9, timeZone: "Mars/Base", payFloor: { amount: "0", currency: "NGN", period: "month", basis: "gross" } } as unknown as Partial<PreferencesValues>))
    expect(response.status).toBe(400)
    expect(apiErrorResponseSchema.safeParse(response.body).success).toBe(true)
    expect(response.body.error.fieldErrors).toEqual([
      { field: "timeZone", position: null, problem: "invalid" },
      { field: "payFloorAmount", position: null, problem: "invalid" },
      { field: "payFloorCurrency", position: null, problem: "invalid" },
      { field: "dailyCap", position: null, problem: "invalid" },
    ])
    expect(JSON.stringify(response.body)).not.toMatch(/Mars|NGN/)
    expect(await rows(kofiId)).toBe(JSON.stringify({ current: [], history: [] }))
  })

  it("409 preferences_stale: an old baseVersion, a number with no record, and null with a record; nothing written", async () => {
    const me = await kofi()
    const none = await save(me, 1)
    expect(none.status).toBe(409)
    expect(none.body).toEqual({ error: { code: "preferences_stale", message: "Your preferences changed in another tab. Reload to see the latest.", currentVersion: null } })
    await save(me, null).expect(200)
    await save(me, 1, values({ dailyCap: 4 })).expect(200)
    const before = await rows(kofiId)
    const old = await save(me, 1, values({ dailyCap: 1 }))
    expect(old.status).toBe(409)
    expect(old.body.error).toMatchObject({ code: "preferences_stale", currentVersion: 2 })
    const again = await save(me, null, values({ dailyCap: 1 }))
    expect(again.body.error).toMatchObject({ code: "preferences_stale", currentVersion: 2 })
    expect(await rows(kofiId)).toBe(before)
  })

  it("two concurrent saves on the same version: one 200, one 409; two concurrent first saves: one version 1", async () => {
    const [a, b] = [await kofi(), await kofi()]
    const firsts = await Promise.all([save(a, null, values({ dailyCap: 1 })), save(b, null, values({ dailyCap: 2 }))])
    expect(firsts.map((r) => r.status).sort()).toEqual([200, 409])
    expect(firsts.find((r) => r.status === 409)!.body.error).toMatchObject({ code: "preferences_stale", currentVersion: 1 })
    const seconds = await Promise.all([save(a, 1, values({ dailyCap: 4 })), save(b, 1, values({ dailyCap: 5 }))])
    expect(seconds.map((r) => r.status).sort()).toEqual([200, 409])
    expect(seconds.find((r) => r.status === 409)!.body.error).toMatchObject({ code: "preferences_stale", currentVersion: 2 })
    const history = await database.db.selectFrom("job_preferences_version").select("version").where("candidate_id", "=", kofiId).execute()
    expect(history.map((row) => row.version).sort()).toEqual([1, 2])
  })
})

describe("PUT /v1/me/preferences: D41 time zone limit", () => {
  it("the first set is free; a change locks the next change for 24 hours; a save that keeps the zone is never limited", async () => {
    const me = await kofi()
    await save(me, null).expect(200)
    clock.set("2026-10-23T09:05:00.000Z")
    const changed = await save(me, 1, values({ timeZone: "Africa/Lagos" })).expect(200)
    expect(changed.body.timeZoneLockedUntil).toBe("2026-10-24T09:05:00.000Z")

    clock.set("2026-10-23T15:00:00.000Z")
    const kept = await save(me, 2, values({ timeZone: "Africa/Lagos", dailyCap: 2 })).expect(200)
    expect(kept.body.timeZoneLockedUntil).toBe("2026-10-24T09:05:00.000Z")

    const before = await rows(kofiId)
    const refused = await save(me, 3, values({ timeZone: "Europe/Berlin", dailyCap: 1 }))
    expect(refused.status).toBe(409)
    expect(refused.body).toEqual({ error: { code: "timezone_change_rate_limited", message: "You can change your time zone once a day.", timeZoneLockedUntil: "2026-10-24T09:05:00.000Z" } })
    expect(await rows(kofiId)).toBe(before)

    clock.set("2026-10-24T09:05:00.000Z")
    expect((await me.get(ME_PREFERENCES_PATH).expect(200)).body.timeZoneLockedUntil).toBeNull()
    await save(me, 3, values({ timeZone: "Europe/Berlin" })).expect(200)
  })

  it("a stale save is 409 preferences_stale before the time zone check", async () => {
    const me = await kofi()
    await save(me, null).expect(200)
    await save(me, 1, values({ timeZone: "Africa/Lagos" })).expect(200)
    const response = await save(me, 1, values({ timeZone: "Europe/Berlin" }))
    expect(response.body.error.code).toBe("preferences_stale")
  })
})

describe("PreferencesSaveLimiter: 10 per 60 s per session", () => {
  it("the 11th attempt is 429 with Retry-After and writes nothing; 400s count; another session is not limited", async () => {
    const me = await kofi()
    await save(me, null).expect(200)
    for (let i = 0; i < 9; i += 1) await save(me, 99).expect(409)
    const before = await rows(kofiId)
    const refused = await save(me, 1, values({ dailyCap: 1 }))
    expect(refused.status).toBe(429)
    expect(refused.body.error.code).toBe("too_many_requests")
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1)
    expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(60)
    expect(await rows(kofiId)).toBe(before)
    await save(await kofi(), 1, values({ dailyCap: 1 })).expect(200)
    clock.set("2026-10-23T09:01:00.000Z")
    await save(me, 2, values({ dailyCap: 2 })).expect(200)
  })

  it("a CSRF refusal is not counted", async () => {
    const me = await kofi()
    const browser = new Browser(app, google)
    for (let i = 0; i < 12; i += 1) {
      const response = await browser.http().put(ME_PREFERENCES_PATH).set("cookie", me.cookie).send({ baseVersion: null, values: values() })
      expect(response.status).toBe(403)
    }
    await save(me, null).expect(200)
  })
})

describe("F-QA-B1-01: history rows stored in the 0018 shape read as valid v1.25.0 values", () => {
  /** A value in the shape migration 0018 wrote: 18 keys with excludedRoleFamilies, seniorityLevels "all", nine tiers. */
  function shape0018(homeCountry: string, timeZone: string): Record<string, unknown> {
    const added = new Set(["software_engineering", "platform_engineering", "data_ml", "solutions_customer"])
    const nineTiers = Object.fromEntries(Object.entries(DEFAULT_ROLE_FAMILY_TIERS).filter(([family]) => !added.has(family)))
    return { ...values({ homeCountry, timeZone, workAuthorizedCountries: [homeCountry] } as Partial<PreferencesValues>), seniorityLevels: "all", roleFamilyTiers: nineTiers, excludedRoleFamilies: [] }
  }

  it("an invitee whose version 1 is in the 0018 shape: 200, v1 upgraded (all levels, 13 tiers, no excludedRoleFamilies), v2 as saved; the stored row is unchanged", async () => {
    const me = await kofi()
    const old = JSON.stringify(shape0018("KE", "Africa/Nairobi"))
    await database.db.insertInto("job_preferences_version").values({ candidate_id: kofiId, version: 1, values: old, saved_at: new Date("2026-10-01T09:00:00Z") } as never).execute()
    await database.db.insertInto("job_preferences").values({ candidate_id: kofiId, version: 1, values: old } as never).execute()
    await database.db.updateTable("job_preferences").set({ values: JSON.stringify(values()) } as never).where("candidate_id", "=", kofiId).execute()
    await save(me, 1, values({ dailyCap: 4 })).expect(200)
    const response = await me.get(ME_PREFERENCES_VERSIONS_PATH)
    expect(response.status).toBe(200)
    expect(preferencesVersionsResponseSchema.safeParse(response.body).success).toBe(true)
    const [v2, v1] = response.body.versions
    expect(v2).toMatchObject({ version: 2, values: { dailyCap: 4 } })
    expect(v1.version).toBe(1)
    expect(v1.values).not.toHaveProperty("excludedRoleFamilies")
    expect(v1.values.seniorityLevels).toEqual(["junior", "mid", "senior", "staff", "principal"])
    expect(v1.values.roleFamilyTiers).toEqual({ ...DEFAULT_ROLE_FAMILY_TIERS })
    expect(v1.values.homeCountry).toBe("KE")
    // Read twice: the upgrade is in memory only, so the stored row (jsonb, key order normalised) never changes.
    const stored = async () => (await database.db.selectFrom("job_preferences_version").select("values").where("candidate_id", "=", kofiId).where("version", "=", 1).executeTakeFirstOrThrow()).values
    const before = await stored()
    expect(before).toEqual(JSON.parse(old))
    await me.get(ME_PREFERENCES_VERSIONS_PATH).expect(200)
    expect(await stored()).toEqual(before)
  })

  it("the Operator's migrated history (v1 in the 0018 shape, v2 from 0027) reads 200 with both versions valid", async () => {
    const response = await (await ada()).get(ME_PREFERENCES_VERSIONS_PATH)
    expect(response.status).toBe(200)
    expect(preferencesVersionsResponseSchema.safeParse(response.body).success).toBe(true)
    const v1 = response.body.versions.find((row: { version: number }) => row.version === 1)
    expect(v1.values).toMatchObject({ homeCountry: "NG", seniorityLevels: ["junior", "mid", "senior", "staff", "principal"] })
    expect(v1.values).not.toHaveProperty("excludedRoleFamilies")
  })

  it("a history row that is neither shape still fails closed (corrupt data, not an old shape)", async () => {
    const me = await kofi()
    await database.db.insertInto("job_preferences_version").values({ candidate_id: kofiId, version: 1, values: JSON.stringify({ ...shape0018("KE", "Africa/Nairobi"), dailyCap: "nine" }), saved_at: new Date() } as never).execute()
    await database.db.insertInto("job_preferences").values({ candidate_id: kofiId, version: 1, values: JSON.stringify(values()) } as never).execute()
    expect((await me.get(ME_PREFERENCES_VERSIONS_PATH)).status).toBe(500)
  })
})

describe("GET /v1/me/preferences/versions (D40)", () => {
  it("no record: empty; then own versions newest first, paged with limit and before", async () => {
    const me = await kofi()
    expect((await me.get(ME_PREFERENCES_VERSIONS_PATH).expect(200)).body).toEqual({ versions: [], nextBefore: null })
    await save(me, null).expect(200)
    for (let v = 1; v <= 4; v += 1) {
      clock.set(`2026-10-23T09:0${v}:00.000Z`)
      await save(me, v, values({ dailyCap: (v % 5) + 1 })).expect(200)
    }
    const page1 = await me.get(`${ME_PREFERENCES_VERSIONS_PATH}?limit=2`).expect(200)
    expect(page1.headers["cache-control"]).toBe("no-store")
    expect(preferencesVersionsResponseSchema.safeParse(page1.body).success).toBe(true)
    expect(page1.body.versions.map((row: { version: number }) => row.version)).toEqual([5, 4])
    expect(page1.body.nextBefore).toBe(4)
    expect(page1.body.versions[0].savedAt).toBe("2026-10-23T09:04:00.000Z")
    const page2 = await me.get(`${ME_PREFERENCES_VERSIONS_PATH}?limit=2&before=4`).expect(200)
    expect(page2.body.versions.map((row: { version: number }) => row.version)).toEqual([3, 2])
    const page3 = await me.get(`${ME_PREFERENCES_VERSIONS_PATH}?limit=2&before=2`).expect(200)
    expect(page3.body).toMatchObject({ nextBefore: null })
    expect(page3.body.versions.map((row: { version: number }) => row.version)).toEqual([1])
    expect((await me.get(ME_PREFERENCES_VERSIONS_PATH).expect(200)).body.versions).toHaveLength(5)
  })

  it.each(["limit=0", "limit=101", "limit=abc", "before=0", "before=99999999999"])("query %s is 400", async (query) => {
    const me = await kofi()
    expect((await me.get(`${ME_PREFERENCES_VERSIONS_PATH}?${query}`)).status).toBe(400)
  })
})

describe("isolation between Candidates", () => {
  it("Kofi's save changes only Kofi's rows; Kofi never reads Ada's record or versions", async () => {
    const operator = await ada()
    const adaBefore = await rows(database.operatorId)
    const me = await kofi()
    expect((await me.get(ME_PREFERENCES_PATH).expect(200)).body.version).toBeNull()
    await save(me, null).expect(200)
    // Ada is at version 2: a Kofi save with baseVersion 2 is stale for Kofi (version 1), never applied to Ada.
    expect((await save(me, 2, values({ dailyCap: 1 }))).body.error).toMatchObject({ code: "preferences_stale", currentVersion: 1 })
    const versions = await me.get(ME_PREFERENCES_VERSIONS_PATH).expect(200)
    expect(versions.body.versions.map((row: { values: PreferencesValues }) => row.values.homeCountry)).toEqual(["KE"])
    expect(await rows(database.operatorId)).toBe(adaBefore)
    expect((await operator.get(ME_PREFERENCES_PATH).expect(200)).body.values.homeCountry).toBe("NG")
  })
})
