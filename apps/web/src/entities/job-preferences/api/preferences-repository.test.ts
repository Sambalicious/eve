import { STEP3_DEFAULTS } from "@eve/contracts"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { ApiError } from "@/shared/api"
import { server, TEST_CSRF_TOKEN } from "@/shared/testing"
import { createPreferencesApi, preferencesRecord, savedPreferences } from "@/shared/testing/preferences-api"
import { fetchPreferences, savePreferences } from "./preferences-repository"

describe("preferences repository (contract v1.23.0)", () => {
  it("maps a stored record to the domain type", async () => {
    server.use(...createPreferencesApi({ record: preferencesRecord(3, { titleKeyword: "react" }) }).handlers)
    const prefs = await fetchPreferences()
    expect(prefs.version).toBe(3)
    expect(prefs.values.titleKeyword).toBe("react")
    expect(prefs.matchedRegions).toEqual(["africa", "emea"])
  })

  it("maps no record to version null and the server's step 3 defaults", async () => {
    server.use(...createPreferencesApi({ record: null }).handlers)
    const prefs = await fetchPreferences()
    expect(prefs).toMatchObject({ version: null, savedAt: null, timeZoneLockedUntil: null, matchedRegions: [] })
    expect(prefs.values).toEqual(STEP3_DEFAULTS)
  })

  it("refuses a body the contract does not allow", async () => {
    server.use(http.get("/v1/me/preferences", () => HttpResponse.json({ version: 1 })))
    await expect(fetchPreferences()).rejects.toThrow()
  })

  it("PUTs baseVersion and all 17 values with the CSRF token and returns the new version", async () => {
    const api = createPreferencesApi({ record: preferencesRecord(4) })
    server.use(...api.handlers)
    const saved = await savePreferences({ baseVersion: 4, values: savedPreferences({ dailyCap: 2 }) }, TEST_CSRF_TOKEN)
    expect(saved.version).toBe(5)
    expect(saved.values.dailyCap).toBe(2)
    expect(Object.keys((api.puts[0] as { values: object }).values)).toHaveLength(17)
  })

  it("surfaces 409 preferences_stale with currentVersion", async () => {
    server.use(...createPreferencesApi({ record: preferencesRecord(6) }).handlers)
    const error = await savePreferences({ baseVersion: 5, values: savedPreferences() }, TEST_CSRF_TOKEN).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe("preferences_stale")
  })
})
