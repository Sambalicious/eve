import { describe, expect, it } from "vitest"

import { InvalidConfigError, parseConfig } from "./env.js"

const validEnv = {
  DATABASE_URL: "postgres://app:pw@localhost:5432/eve",
  PUBLIC_ORIGIN: "https://jobs.example.com/",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret-value",
  ACCESS_REQUEST_SECRET: "a".repeat(32),
}

describe("parseConfig", () => {
  it("parses a complete environment and normalises the public origin", () => {
    const config = parseConfig(validEnv)
    expect(config.publicOrigin).toBe("https://jobs.example.com")
    expect(config.port).toBe(3000)
    expect(config).not.toHaveProperty("candidateGoogleSub")
  })

  // EPIC-0002 A1 (architecture r2 "CANDIDATE_GOOGLE_SUB retirement"): the api boots
  // only after the multi-candidate marker exists, and then the key must be gone.
  it("refuses CANDIDATE_GOOGLE_SUB, which is retired after the multi-candidate migration", () => {
    expect(() => parseConfig({ ...validEnv, CANDIDATE_GOOGLE_SUB: "100000000000000000001" })).toThrow(
      "CANDIDATE_GOOGLE_SUB must be removed after the multi-candidate migration"
    )
    try {
      parseConfig({ ...validEnv, CANDIDATE_GOOGLE_SUB: "100000000000000000001" })
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConfigError)
      expect((error as InvalidConfigError).invalidKeys).toEqual(["CANDIDATE_GOOGLE_SUB"])
      expect(String((error as Error).message)).not.toContain("100000000000000000001")
    }
  })

  it("treats a blank CANDIDATE_GOOGLE_SUB (compose `${X:-}`) as unset", () => {
    expect(() => parseConfig({ ...validEnv, CANDIDATE_GOOGLE_SUB: "  " })).not.toThrow()
  })

  it("names every missing key", () => {
    expect(() => parseConfig({})).toThrow(InvalidConfigError)
    try {
      parseConfig({})
    } catch (error) {
      expect((error as InvalidConfigError).invalidKeys).toEqual(
        expect.arrayContaining([
          "DATABASE_URL",
          "PUBLIC_ORIGIN",
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "ACCESS_REQUEST_SECRET",
        ])
      )
    }
  })

  it("never includes a secret value in the error message", () => {
    const env = { ...validEnv, DATABASE_URL: "mysql://u:hunter2@db/x" }
    expect(() => parseConfig(env)).toThrow(/DATABASE_URL/)
    expect(() => parseConfig(env)).not.toThrow(/hunter2/)
  })

  it("rejects a non-http public origin", () => {
    expect(() => parseConfig({ ...validEnv, PUBLIC_ORIGIN: "ftp://x" })).toThrow(/PUBLIC_ORIGIN/)
  })

  it("defaults the model to the cheapest current Claude model and works without a key", () => {
    const config = parseConfig(validEnv)
    expect(config.anthropic.model).toBe("claude-haiku-5-5")
    expect(config.anthropic.apiKeyConfigured).toBe(false)
    expect(config.anthropic.readApiKey()).toBeUndefined()
  })

  it("defaults tailored documents to Sonnet and lets ANTHROPIC_DOCUMENTS_MODEL change it", () => {
    expect(parseConfig(validEnv).anthropic.documentsModel).toBe("claude-sonnet-5-5")
    expect(parseConfig({ ...validEnv, ANTHROPIC_DOCUMENTS_MODEL: "claude-haiku-5-5" }).anthropic.documentsModel).toBe("claude-haiku-5-5")
  })

  it.each(["", "   "])("treats ANTHROPIC_API_KEY=%j as unset, as compose passes it when the key is not set (F-QA5-02)", (value) => {
    const config = parseConfig({ ...validEnv, ANTHROPIC_API_KEY: value })
    expect(config.anthropic.apiKeyConfigured).toBe(false)
    expect(config.anthropic.readApiKey()).toBeUndefined()
  })

  it.each([[undefined], ["0"], [""], ["true"], ["yes"]])("SUBMISSION_FORM_AGENT_ENABLED=%j leaves the form agent off (repair wave 3)", (value) => {
    expect(parseConfig({ ...validEnv, ...(value === undefined ? {} : { SUBMISSION_FORM_AGENT_ENABLED: value }) }).formAgentEnabled).toBe(false)
  })

  it("SUBMISSION_FORM_AGENT_ENABLED=1 turns the form agent on", () => {
    expect(parseConfig({ ...validEnv, SUBMISSION_FORM_AGENT_ENABLED: "1" }).formAgentEnabled).toBe(true)
  })

  it.each([[undefined], ["0"], [""], ["true"]])("DOCUMENT_BRIDGES_ENABLED=%j leaves bridging off (EPIC-0012)", (value) => {
    expect(parseConfig({ ...validEnv, ...(value === undefined ? {} : { DOCUMENT_BRIDGES_ENABLED: value }) }).documentBridgesEnabled).toBe(false)
  })
  it.each([[undefined], ["0"], [""], ["true"]])("DOCUMENT_DIRECTION_ENABLED=%j leaves company direction off (EPIC-0012)", (value) => {
    expect(parseConfig({ ...validEnv, ...(value === undefined ? {} : { DOCUMENT_DIRECTION_ENABLED: value }) }).documentDirectionEnabled).toBe(false)
  })
  it("the two document flags turn on only for 1 and are independent", () => {
    const bridges = parseConfig({ ...validEnv, DOCUMENT_BRIDGES_ENABLED: "1" })
    expect([bridges.documentBridgesEnabled, bridges.documentDirectionEnabled]).toEqual([true, false])
    const direction = parseConfig({ ...validEnv, DOCUMENT_DIRECTION_ENABLED: "1" })
    expect([direction.documentBridgesEnabled, direction.documentDirectionEnabled]).toEqual([false, true])
  })

  it("never exposes the Anthropic key when the config is serialised or inspected", async () => {
    const key = "sk-ant-api03-SECRET-SENTINEL-1234567890"
    const config = parseConfig({ ...validEnv, ANTHROPIC_API_KEY: key })
    const { inspect } = await import("node:util")
    expect(config.anthropic.readApiKey()).toBe(key)
    expect(JSON.stringify(config)).not.toContain("SECRET-SENTINEL")
    expect(inspect(config, { depth: 10 })).not.toContain("SECRET-SENTINEL")
    expect(config.anthropic.apiKeyConfigured).toBe(true)
  })

  describe("access requests (EPIC-0003, architecture.r1 7.5)", () => {
    it("defaults TRUST_PROXY to 0 and the limits to 3, 10 and 50", () => {
      const { accessRequest } = parseConfig(validEnv)
      expect(accessRequest.trustProxy).toBe(0)
      expect(accessRequest.limits).toEqual({ perIpHour: 3, perIpDay: 10, globalDay: 50 })
    })

    it("reads TRUST_PROXY and the three limits", () => {
      const { accessRequest } = parseConfig({
        ...validEnv,
        TRUST_PROXY: "1",
        ACCESS_REQUEST_LIMIT_IP_HOUR: "5",
        ACCESS_REQUEST_LIMIT_IP_DAY: "20",
        ACCESS_REQUEST_LIMIT_GLOBAL_DAY: "100",
      })
      expect(accessRequest.trustProxy).toBe(1)
      expect(accessRequest.limits).toEqual({ perIpHour: 5, perIpDay: 20, globalDay: 100 })
    })

    it.each([
      ["ACCESS_REQUEST_SECRET", "a".repeat(31)],
      ["ACCESS_REQUEST_SECRET", ""],
      ["TRUST_PROXY", "-1"],
      ["TRUST_PROXY", "true"],
      ["ACCESS_REQUEST_LIMIT_IP_HOUR", "0"],
      ["ACCESS_REQUEST_LIMIT_IP_DAY", "1.5"],
      ["ACCESS_REQUEST_LIMIT_GLOBAL_DAY", "x"],
    ])("refuses %s=%j and names only the key", (key, value) => {
      expect(() => parseConfig({ ...validEnv, [key]: value })).toThrow(new RegExp(key))
    })

    it("counts the secret in bytes, so 32 bytes of multibyte text is enough", () => {
      expect(() => parseConfig({ ...validEnv, ACCESS_REQUEST_SECRET: "é".repeat(16) })).not.toThrow()
    })

    it("never exposes the secret when the config is serialised or inspected", async () => {
      const secret = "ACCESS-SECRET-SENTINEL-0123456789abcdef"
      const config = parseConfig({ ...validEnv, ACCESS_REQUEST_SECRET: secret })
      const { inspect } = await import("node:util")
      expect(JSON.stringify(config)).not.toContain("SENTINEL")
      expect(inspect(config, { depth: 10 })).not.toContain("SENTINEL")
    })

    it("does not read NOTIFY_TO, so the api never holds the Operator address", () => {
      const config = parseConfig({ ...validEnv, NOTIFY_TO: "operator@eve.example" })
      expect(JSON.stringify(config)).not.toContain("operator@eve.example")
    })
  })
})

// EPIC-0002 A2 (architecture r4 line 527, 575, 691): the flat storage keys are read only by storage:migrate.
describe("retired storage keys (A2 env removals)", () => {
  it.each(["RESUME_STORAGE_DIR", "DOCUMENT_STORAGE_DIR"])("refuses %s with fixed text that never echoes the value", (key) => {
    let error: unknown
    try {
      parseConfig({ ...validEnv, [key]: "/data/secret-path" })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(InvalidConfigError)
    expect((error as InvalidConfigError).invalidKeys).toEqual([key])
    expect((error as Error).message).toContain(`${key} must be removed after storage:migrate`)
    expect((error as Error).message).not.toContain("/data/secret-path")
  })

  it("a blank value counts as unset, and CANDIDATE_STORAGE_DIR defaults to /data/candidates", () => {
    expect(parseConfig({ ...validEnv, RESUME_STORAGE_DIR: "", DOCUMENT_STORAGE_DIR: " " }).candidateStorageDir).toBe("/data/candidates")
    expect(parseConfig({ ...validEnv, CANDIDATE_STORAGE_DIR: "/srv/candidates" }).candidateStorageDir).toBe("/srv/candidates")
  })
})
