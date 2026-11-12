import { preferencesVersionsResponseSchema } from "@eve/contracts"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CROSS_CANDIDATE_CASES } from "./cross-candidate.cases.js"
import {
  type B1World,
  PREFS,
  VERSIONS,
  candidateSnapshot,
  clearPostings,
  clearPreferences,
  createRecord,
  kenyaValues,
  preferencesRows,
  read,
  save,
  saveOnTop,
  seedPosting,
  startB1World,
  stateOf,
  versionCount,
} from "./support/qa-b1.js"

/**
 * EPIC-0002 B1 QA (qa-author, qa-tests-1): PreferencesSaveLimiter (R6-AC6),
 * `GET /v1/me/preferences/versions` (D40), the removed
 * `PUT /v1/eligibility-settings`, and cross-Candidate isolation for every new
 * route (api-contract-b1.md "Cross-Candidate 404 registry"; data-isolation.feature:236;
 * job-preferences.feature:563 to :599; operator-console-and-privacy.feature:206).
 */
let w: B1World

beforeAll(async () => {
  w = await startB1World()
})

afterAll(async () => {
  await w?.stop()
})

beforeEach(async () => {
  w.clock.set("2026-10-23T09:00:00.000Z")
  await clearPostings(w.db)
  await clearPreferences(w.db, w.kofi.id)
  await clearPreferences(w.db, w.wanjiru.id)
})

describe("PreferencesSaveLimiter: 10 per session per 60 s (job-criteria-in-preferences.feature:243, :251, :257)", () => {
  it(":251 the 10th save in a minute is accepted", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi)
    for (let i = 0; i < 8; i += 1) await saveOnTop(kofi, {})
    const tenth = await save(kofi, 9, kenyaValues({ dailyCap: 2 }))
    expect(tenth.status, JSON.stringify(tenth.body)).toBe(200)
    expect(tenth.body.version).toBe(10)
  })

  it(":243 the 11th save is 429 too_many_requests with Retry-After 1 to 60, nothing stored and no posting re-decided", async () => {
    const vue = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked" })
    const kofi = await w.session(w.kofi)
    const v1 = await createRecord(kofi)
    // 9 more attempts: 400 and 409 count as well as 200 (contract).
    expect((await save(kofi, v1.version, kenyaValues({ dailyCap: 9 }))).status).toBe(400)
    expect((await save(kofi, 99, kenyaValues())).status).toBe(409)
    for (let i = 0; i < 7; i += 1) expect((await save(kofi, (await read(kofi)).version, kenyaValues())).status).toBe(200)
    const before = await preferencesRows(w.db, w.kofi.id)
    const current = (await read(kofi)).version
    const eleventh = await save(kofi, current, kenyaValues({ titleKeyword: "react" }))
    expect(eleventh.status).toBe(429)
    expect(eleventh.body).toEqual({ error: { code: "too_many_requests", message: "Too many requests. Wait a minute, then try again." } })
    const retryAfter = Number(eleventh.headers["retry-after"])
    expect(Number.isInteger(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)
    expect(await preferencesRows(w.db, w.kofi.id)).toBe(before)
    expect((await stateOf(w.db, w.kofi.id, vue)).status).toBe("ranked")
  })

  it("the limit is checked before the body: an 11th malformed body is 429, not 400", async () => {
    const kofi = await w.session(w.kofi)
    for (let i = 0; i < 10; i += 1) await kofi.put(PREFS).send({ nonsense: true })
    expect((await kofi.put(PREFS).send({ nonsense: true })).status).toBe(429)
  })

  it("CSRF refusals are not counted", async () => {
    const kofi = await w.session(w.kofi)
    for (let i = 0; i < 12; i += 1) {
      const refused = await request(w.app.getHttpServer()).put(PREFS).set("cookie", kofi.cookie).send({ baseVersion: null, values: kenyaValues() })
      expect(refused.status).toBe(403)
    }
    expect((await save(kofi, null, kenyaValues())).status).toBe(200)
  })

  it(":257 Kofi's 429 never limits Wanjiru", async () => {
    const kofi = await w.session(w.kofi)
    for (let i = 0; i < 10; i += 1) await kofi.put(PREFS).send({ nonsense: true })
    expect((await kofi.put(PREFS).send({ nonsense: true })).status).toBe(429)
    const wanjiru = await w.session(w.wanjiru)
    expect((await save(wanjiru, null, kenyaValues())).status).toBe(200)
  })

  it("the job-criteria limiter is a separate counter: 10 criteria saves leave the preferences save open", async () => {
    const kofi = await w.session(w.kofi)
    for (let i = 0; i < 10; i += 1) await kofi.put("/v1/candidate-settings/job-criteria").send({ nonsense: true })
    expect((await save(kofi, null, kenyaValues())).status).toBe(200)
  })
})

describe("GET /v1/me/preferences/versions (D40; job-preferences.feature:584)", () => {
  it("no record: { versions: [], nextBefore: null }, no-store", async () => {
    const kofi = await w.session(w.kofi)
    const response = await kofi.get(VERSIONS).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.body).toEqual({ versions: [], nextBefore: null })
  })

  it(":584 Kofi sees his own versions newest first; Wanjiru's change is not among them and her count is not revealed", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi)
    await saveOnTop(kofi, { payFloor: { amount: "4100.00", currency: "EUR", period: "month", basis: "gross" } })
    await saveOnTop(kofi, { payFloor: { amount: "4200.00", currency: "EUR", period: "month", basis: "gross" } })
    const wanjiru = await w.session(w.wanjiru)
    await createRecord(wanjiru, kenyaValues({ dailyCap: 5, emphasisThemes: ["WANJIRU-SENTINEL"] }))
    await saveOnTop(wanjiru, { dailyCap: 1 })
    const body = (await kofi.get(VERSIONS).expect(200)).body
    expect(preferencesVersionsResponseSchema.safeParse(body).success, JSON.stringify(body)).toBe(true)
    expect(body.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1])
    expect(body.versions.map((v: { values: { payFloor: { amount: string } } }) => v.values.payFloor.amount)).toEqual(["4200.00", "4100.00", "4000.00"])
    expect(body.nextBefore).toBeNull()
    expect(JSON.stringify(body)).not.toContain("WANJIRU-SENTINEL")
    const wBody = (await wanjiru.get(VERSIONS).expect(200)).body
    expect(wBody.versions).toHaveLength(2)
  })

  it("limit and before page the history: limit=2 then before=nextBefore", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi)
    for (let i = 0; i < 4; i += 1) await saveOnTop(kofi, {})
    const first = (await kofi.get(`${VERSIONS}?limit=2`).expect(200)).body
    expect(first.versions.map((v: { version: number }) => v.version)).toEqual([5, 4])
    expect(first.nextBefore).toBe(4)
    const second = (await kofi.get(`${VERSIONS}?limit=2&before=${first.nextBefore}`).expect(200)).body
    expect(second.versions.map((v: { version: number }) => v.version)).toEqual([3, 2])
    const last = (await kofi.get(`${VERSIONS}?limit=2&before=${second.nextBefore}`).expect(200)).body
    expect(last.versions.map((v: { version: number }) => v.version)).toEqual([1])
    expect(last.nextBefore).toBeNull()
  })

  it.each(["limit=0", "limit=101", "limit=025", "before=0", "before=abc", `candidateId=${"00000000-0000-4000-8000-000000000001"}`, "unknown=1"])(
    "query %s is 400 bad_request",
    async (query) => {
      const kofi = await w.session(w.kofi)
      const response = await kofi.get(`${VERSIONS}?${query}`)
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe("bad_request")
    }
  )

  it("versions are immutable: a later save leaves earlier rows byte-equal", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi)
    const before = JSON.stringify((await kofi.get(VERSIONS).expect(200)).body.versions)
    await saveOnTop(kofi, { dailyCap: 1 })
    const after = (await kofi.get(VERSIONS).expect(200)).body.versions
    expect(JSON.stringify(after.slice(1))).toBe(before)
  })
})

describe("the removed PUT /v1/eligibility-settings (job-preferences.feature:717)", () => {
  it(":717 Ada's request is answered as an unknown route and her latest work hour stays 22:30 in Africa/Lagos", async () => {
    const ada = await w.session(w.ada)
    const current = await read(ada)
    const set = await save(ada, current.version, { ...current.values, timeZone: current.values.timeZone, latestWorkHour: "22:30" })
    expect(set.status, JSON.stringify(set.body)).toBe(200)
    const singletonBefore = JSON.stringify(await w.db.selectFrom("evaluation_setting").selectAll().execute())
    const unknown = await ada.put("/v1/no-such-route-qab1").send({})
    const removed = await ada.put("/v1/eligibility-settings").send({ hoursCutoff: "18:00", hoursTimeZone: "Africa/Lagos" })
    expect(removed.status).toBe(404)
    expect(removed.body).toEqual(unknown.body)
    expect((await read(ada)).values.latestWorkHour).toBe("22:30")
    expect(JSON.stringify(await w.db.selectFrom("evaluation_setting").selectAll().execute())).toBe(singletonBefore)
  })

  it(":717 a non-Operator gets the same 404 and nothing changes", async () => {
    const kofi = await w.session(w.kofi)
    const singletonBefore = JSON.stringify(await w.db.selectFrom("evaluation_setting").selectAll().execute())
    const removed = await kofi.put("/v1/eligibility-settings").send({ hoursCutoff: "18:00", hoursTimeZone: "UTC" })
    expect(removed.status).toBe(404)
    expect(removed.body.error.code).toBe("not_found")
    expect(JSON.stringify(await w.db.selectFrom("evaluation_setting").selectAll().execute())).toBe(singletonBefore)
  })

  it(":717 the cross-Candidate registry lists no route that changes the eligibility settings, and lists the three new routes", () => {
    expect(CROSS_CANDIDATE_CASES.filter((c) => c.path === "/v1/eligibility-settings" && c.method !== "GET")).toEqual([])
    expect(CROSS_CANDIDATE_CASES.some((c) => c.path === "/v1/eligibility-settings" && c.method === "GET")).toBe(true)
    for (const [method, path] of [["GET", PREFS], ["PUT", PREFS], ["GET", VERSIONS]] as const) {
      expect(CROSS_CANDIDATE_CASES.some((c) => c.method === method && c.path === path), `${method} ${path} in the registry`).toBe(true)
    }
  })

  it("GET /v1/eligibility-settings stays and still answers { hoursCutoff, hoursTimeZone }", async () => {
    const ada = await w.session(w.ada)
    const body = (await ada.get("/v1/eligibility-settings").expect(200)).body
    expect(Object.keys(body).sort()).toEqual(["hoursCutoff", "hoursTimeZone"])
  })
})

describe("cross-Candidate isolation for every new route (data-isolation.feature:236; job-preferences.feature:563 to :599)", () => {
  const SENTINEL = "KOFI-ONLY-THEME-SENTINEL"

  async function kofiRecord() {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi, kenyaValues({ dailyCap: 3, titleKeyword: "kofisentinelkeyword", emphasisThemes: [SENTINEL] }))
    return kofi
  }

  it(":563 Wanjiru's GET returns her own defaults, none of Kofi's values; a query naming Kofi's ID is 400 and reveals nothing", async () => {
    await kofiRecord()
    const wanjiru = await w.session(w.wanjiru)
    const own = (await wanjiru.get(PREFS).expect(200)).body
    expect(own.version).toBeNull()
    expect(JSON.stringify(own)).not.toMatch(/KOFI-ONLY|kofisentinel/)
    const byId = await wanjiru.get(`${PREFS}?candidateId=${w.kofi.id}`)
    expect(byId.status).toBe(400)
    expect(JSON.stringify(byId.body)).not.toMatch(/KOFI-ONLY|kofisentinel|version/)
  })

  it.each([`${PREFS}/${"KOFI"}`, `/v1/candidates/${"KOFI"}/preferences`, `/v1/me/preferences/${"KOFI"}/versions`])(
    ":563 an ID-bearing path %s is 404, byte-equal to an unknown path",
    async (template) => {
      await kofiRecord()
      const wanjiru = await w.session(w.wanjiru)
      const path = template.replace("KOFI", w.kofi.id)
      const response = await wanjiru.get(path)
      expect(response.status).toBe(404)
      const unknown = await wanjiru.get(template.replace("KOFI", "00000000-0000-4000-8000-00000000dead"))
      expect(response.body).toEqual(unknown.body)
      expect(JSON.stringify(response.body)).not.toMatch(/KOFI-ONLY|kofisentinel/)
    }
  )

  it(":570 Wanjiru setting Kofi's daily cap by ID is refused (400 for candidateId, 404 for a path) and Kofi's cap stays 3", async () => {
    await kofiRecord()
    const before = await preferencesRows(w.db, w.kofi.id)
    const wanjiru = await w.session(w.wanjiru)
    const viaBody = await wanjiru.put(PREFS).send({ baseVersion: 1, values: kenyaValues({ dailyCap: 1 }), candidateId: w.kofi.id })
    expect(viaBody.status).toBe(400)
    const viaPath = await wanjiru.put(`/v1/candidates/${w.kofi.id}/preferences`).send({ baseVersion: 1, values: kenyaValues({ dailyCap: 1 }) })
    expect(viaPath.status).toBe(404)
    expect(await preferencesRows(w.db, w.kofi.id)).toBe(before)
  })

  it(":570/R6-AC12 Wanjiru's own save with baseVersion 1 creates nothing on Kofi's record and is stale for her (no record)", async () => {
    await kofiRecord()
    const before = await preferencesRows(w.db, w.kofi.id)
    const wanjiru = await w.session(w.wanjiru)
    const response = await save(wanjiru, 1, kenyaValues({ dailyCap: 1 }))
    expect(response.status).toBe(409)
    expect(response.body.error.currentVersion).toBeNull()
    expect(await preferencesRows(w.db, w.kofi.id)).toBe(before)
  })

  it(":577 / operator-console :206 the Operator gets no route to Kofi's preferences: own GET returns her own, ID paths 404", async () => {
    await kofiRecord()
    const ada = await w.session(w.ada)
    const own = (await ada.get(PREFS).expect(200)).body
    expect(own.values.homeCountry).toBe("NG")
    expect(JSON.stringify(own)).not.toMatch(/KOFI-ONLY|kofisentinel/)
    expect((await ada.get(`/v1/candidates/${w.kofi.id}/preferences`)).status).toBe(404)
    expect((await ada.get(`${PREFS}?candidateId=${w.kofi.id}`)).status).toBe(400)
    const versions = (await ada.get(VERSIONS).expect(200)).body
    expect(JSON.stringify(versions)).not.toMatch(/KOFI-ONLY|kofisentinel/)
  })

  it(":577 nothing in the Operator console API carries Kofi's preference values", async () => {
    await kofiRecord()
    const ada = await w.session(w.ada)
    for (const path of ["/v1/operator/candidates", "/v1/operator/people", "/v1/me"]) {
      const response = await ada.get(path)
      expect(JSON.stringify(response.body), path).not.toMatch(/KOFI-ONLY|kofisentinel/)
    }
  })

  it("R6-AC12: Wanjiru's save re-decides only her postings; Kofi's record, postings and Applications are byte-equal", async () => {
    const kofi = await kofiRecord()
    void kofi
    const shared = await seedPosting(w.db, w.kofi.id, { title: "Senior Vue Engineer", status: "ranked", holders: [w.kofi.id, w.wanjiru.id] })
    const wanjiru = await w.session(w.wanjiru)
    await createRecord(wanjiru)
    const before = await candidateSnapshot(w.db, w.kofi.id)
    await saveOnTop(wanjiru, { titleKeyword: "react" })
    expect((await stateOf(w.db, w.wanjiru.id, shared)).skip_reason).toBe("keyword_mismatch")
    expect(await candidateSnapshot(w.db, w.kofi.id)).toBe(before)
  })

  it("Wanjiru's versions read never includes Kofi's rows and reveals no count of them", async () => {
    await kofiRecord()
    const wanjiru = await w.session(w.wanjiru)
    const body = (await wanjiru.get(VERSIONS).expect(200)).body
    expect(body).toEqual({ versions: [], nextBefore: null })
    expect(await versionCount(w.db, w.kofi.id)).toBe(1)
  })

  it("a revoked session cannot read or write preferences", async () => {
    const kofi = await kofiRecord()
    await request(w.app.getHttpServer()).post("/v1/auth/logout").set("cookie", kofi.cookie).set("x-csrf-token", kofi.csrfToken)
    expect((await kofi.get(PREFS)).status).toBe(401)
    expect((await save(kofi, 1, kenyaValues({ dailyCap: 1 }))).status).toBe(401)
    expect((await read(await w.session(w.kofi))).values.dailyCap).toBe(3)
  })
})
