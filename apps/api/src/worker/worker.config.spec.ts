import { describe, expect, it } from "vitest"

import { parseWorkerConfig } from "./worker.config.js"

const BASE = { DATABASE_URL: "postgres://u:p@db:5432/x" }

describe("parseWorkerConfig browser settings (ADR 0008)", () => {
  it("leaves the browser off by default", () => {
    expect(parseWorkerConfig(BASE).browser).toBeNull()
  })

  it.each(["0", "false", "", "no"])("SUBMISSION_BROWSER_ENABLED=%j keeps it off", (value) => {
    expect(parseWorkerConfig({ ...BASE, SUBMISSION_BROWSER_ENABLED: value }).browser).toBeNull()
  })

  it("enables it only with SUBMISSION_BROWSER_ENABLED=1, with the compose defaults", () => {
    expect(parseWorkerConfig({ ...BASE, SUBMISSION_BROWSER_ENABLED: "1" }).browser).toEqual({
      mcpUrl: "http://browser:8931/mcp",
      uploadDir: "/data/uploads",
      uploadDirInBrowser: "/home/node/uploads",
      allowlistFile: "/data/egress/allowlist.txt",
      reviewedHostsFile: null,
    })
  })

  it.each([[undefined], ["0"], [""], ["true"]])("SUBMISSION_FORM_AGENT_ENABLED=%j leaves the form agent off (repair wave 3)", (value) => {
    expect(parseWorkerConfig({ ...BASE, ...(value === undefined ? {} : { SUBMISSION_FORM_AGENT_ENABLED: value }) }).formAgentEnabled).toBe(false)
  })

  it("SUBMISSION_FORM_AGENT_ENABLED=1 turns the form agent on", () => {
    expect(parseWorkerConfig({ ...BASE, SUBMISSION_FORM_AGENT_ENABLED: "1" }).formAgentEnabled).toBe(true)
  })

  it.each([[undefined], ["0"], [""], ["true"]])("DOCUMENT_BRIDGES_ENABLED=%j leaves bridging off (EPIC-0012)", (value) => {
    expect(parseWorkerConfig({ ...BASE, ...(value === undefined ? {} : { DOCUMENT_BRIDGES_ENABLED: value }) }).documentBridgesEnabled).toBe(false)
  })
  it.each([[undefined], ["0"], [""], ["true"]])("DOCUMENT_DIRECTION_ENABLED=%j leaves company direction off (EPIC-0012)", (value) => {
    expect(parseWorkerConfig({ ...BASE, ...(value === undefined ? {} : { DOCUMENT_DIRECTION_ENABLED: value }) }).documentDirectionEnabled).toBe(false)
  })
  it("the two document flags turn on only for 1 and are independent", () => {
    const bridges = parseWorkerConfig({ ...BASE, DOCUMENT_BRIDGES_ENABLED: "1" })
    expect([bridges.documentBridgesEnabled, bridges.documentDirectionEnabled]).toEqual([true, false])
    const direction = parseWorkerConfig({ ...BASE, DOCUMENT_DIRECTION_ENABLED: "1" })
    expect([direction.documentBridgesEnabled, direction.documentDirectionEnabled]).toEqual([false, true])
  })

  it("refuses a browser URL other than an http URL", () => {
    expect(() => parseWorkerConfig({ ...BASE, SUBMISSION_BROWSER_ENABLED: "1", SUBMISSION_BROWSER_MCP_URL: "file:///etc/passwd" })).toThrow(/SUBMISSION_BROWSER_MCP_URL/)
  })

  it.each(["", "  "])("treats ANTHROPIC_API_KEY=%j as unset (F-QA5-02)", (value) => {
    expect(parseWorkerConfig({ ...BASE, ANTHROPIC_API_KEY: value }).anthropic.apiKeyConfigured).toBe(false)
  })

  it("defaults tailored documents to Sonnet and lets ANTHROPIC_DOCUMENTS_MODEL change it", () => {
    expect(parseWorkerConfig(BASE).anthropic.documentsModel).toBe("claude-sonnet-5-5")
    expect(parseWorkerConfig({ ...BASE, ANTHROPIC_DOCUMENTS_MODEL: "claude-haiku-5-5" }).anthropic.documentsModel).toBe("claude-haiku-5-5")
  })
})

describe("parseWorkerConfig notifications (slice 6, AC 7.5, 7.6)", () => {
  const GMAIL = { GMAIL_SMTP_USER: "ada.okafor@gmail.com", GMAIL_SMTP_APP_PASSWORD: "abcd efgh ijkl mnop", NOTIFY_TO: "ada.okafor@gmail.com", PUBLIC_ORIGIN: "https://jobs.example.com" }

  it("leaves the sender and the daily summary off by default", () => {
    const config = parseWorkerConfig(BASE)
    expect(config.mailer).toBeNull()
    expect(config.mailerMissing).toEqual([])
    expect(config.dailySummaryEnabled).toBe(false)
  })

  it.each(["0", "", "true"])("NOTIFY_DAILY_SUMMARY_ENABLED=%j keeps the daily summary off", (value) => {
    expect(parseWorkerConfig({ ...BASE, NOTIFY_DAILY_SUMMARY_ENABLED: value }).dailySummaryEnabled).toBe(false)
  })

  it("NOTIFY_DAILY_SUMMARY_ENABLED=1 turns it on", () => {
    expect(parseWorkerConfig({ ...BASE, NOTIFY_DAILY_SUMMARY_ENABLED: "1" }).dailySummaryEnabled).toBe(true)
  })

  it("configures the sender with every Gmail key, and a partial set names the missing key without failing the worker", () => {
    expect(parseWorkerConfig({ ...BASE, ...GMAIL }).mailer?.user).toBe("ada.okafor@gmail.com")
    const partial = parseWorkerConfig({ ...BASE, ...GMAIL, NOTIFY_TO: "" })
    expect(partial.mailer).toBeNull()
    expect(partial.mailerMissing).toEqual(["NOTIFY_TO"])
  })

  it("serialising the worker config never shows the app password", () => {
    expect(JSON.stringify(parseWorkerConfig({ ...BASE, ...GMAIL }))).not.toMatch(/abcd ?efgh/)
  })
})

describe("parseWorkerConfig retired CANDIDATE_GOOGLE_SUB (migration-and-operator-bootstrap.feature:891, worker row)", () => {
  it("refuses to start while CANDIDATE_GOOGLE_SUB is still set, naming the key and never the value", () => {
    let message = ""
    try {
      parseWorkerConfig({ ...BASE, CANDIDATE_GOOGLE_SUB: "google-sub-ada-0001" })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("CANDIDATE_GOOGLE_SUB must be removed after the multi-candidate migration")
    expect(message).toContain("CANDIDATE_GOOGLE_SUB")
    expect(message).not.toContain("google-sub-ada-0001")
  })

  it.each(["", "  "])("treats CANDIDATE_GOOGLE_SUB=%j (compose `${X:-}`) as unset", (value) => {
    expect(() => parseWorkerConfig({ ...BASE, CANDIDATE_GOOGLE_SUB: value })).not.toThrow()
  })
})

describe("parseWorkerConfig RETENTION_JOB_DISABLED (automatic-expiry.feature E3.8, D-E8)", () => {
  it("RETENTION_JOB_DISABLED=1 is the only value that turns automatic expiry off", () => {
    expect(parseWorkerConfig({ ...BASE, RETENTION_JOB_DISABLED: "1" }).retentionJobDisabled).toBe(true)
  })

  it.each([[undefined], ["0"], ["true"], [""], ["yes"]])("RETENTION_JOB_DISABLED=%j keeps it scheduled", (value) => {
    expect(parseWorkerConfig({ ...BASE, ...(value === undefined ? {} : { RETENTION_JOB_DISABLED: value }) }).retentionJobDisabled).toBe(false)
  })
})

describe("retired storage keys in the worker (A2 env removals)", () => {
  it("refuses DOCUMENT_STORAGE_DIR and RESUME_STORAGE_DIR without echoing the value; reads CANDIDATE_STORAGE_DIR", () => {
    for (const key of ["DOCUMENT_STORAGE_DIR", "RESUME_STORAGE_DIR"]) {
      expect(() => parseWorkerConfig({ ...BASE, [key]: "/data/secret-path" })).toThrow(`${key} must be removed after storage:migrate`)
      expect(() => parseWorkerConfig({ ...BASE, [key]: "/data/secret-path" })).not.toThrow(/secret-path/)
    }
    expect(parseWorkerConfig(BASE).candidateStorageDir).toBe("/data/candidates")
    expect(parseWorkerConfig({ ...BASE, CANDIDATE_STORAGE_DIR: "/srv/c" }).candidateStorageDir).toBe("/srv/c")
  })
})
