import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"

let database: TestDatabase

beforeAll(async () => {
  database = await startMigratedDatabase()
})

afterAll(async () => {
  await database?.stop()
})

function posting(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    application_url: "https://boards.greenhouse.io/acme/jobs/1042",
    requisition_id: "R-1042",
    apply_url: "https://boards.greenhouse.io/acme/jobs/1042",
    application_system: "Greenhouse",
    apply_mode: "automatic" as const,
    origin: "employer_board" as const,
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title: "Senior Frontend Engineer",
    company: "Acme",
    status: "checking" as const,
    skip_reason: null,
    skip_detail: null,
    evaluation_failure: null,
    role_family: null,
    discovered_at: new Date(),
    evaluated_at: null,
    ...overrides,
  }
}

describe("migration 0004 (slice 3)", () => {
  it("seeds the 28-company employer list as an unapproved draft, in researched order, with crypto flagged", async () => {
    const rows = await database.db.selectFrom("employer_board").selectAll().orderBy("position").execute()
    expect(rows).toHaveLength(28)
    expect(rows[0]).toMatchObject({ company: "Railway", application_system: "ashby", board_token: "railway" })
    expect(rows[27]).toMatchObject({ company: "Coinbase", flag: "crypto" })
    expect(rows.filter((row) => row.flag === "crypto").map((row) => row.company)).toEqual(["Phantom", "Consensys", "Coinbase"])
    expect(rows.some((row) => row.company === "Discord")).toBe(false)
    const state = await database.db.selectFrom("employer_list_state").selectAll().executeTakeFirstOrThrow()
    expect(state.approved_at).toBeNull()
  })

  it("seeds four remote boards in the AC 1.9 order, all off, Remotive unavailable", async () => {
    const boards = await database.db.selectFrom("remote_board").selectAll().orderBy("position").execute()
    expect(boards.map((board) => board.key)).toEqual(["himalayas", "remoteok", "remotive", "weworkremotely"])
    expect(boards.every((board) => !board.enabled)).toBe(true)
    expect(boards.find((board) => board.key === "remotive")).toMatchObject({ available: false, verified_on: null })
  })

  it("refuses to enable an unavailable or unverified board at the database", async () => {
    await expect(
      database.db.updateTable("remote_board").set({ enabled: true }).where("key", "=", "remotive").execute()
    ).rejects.toThrow(/remote_board_enabled_requires_verified/)
  })

  it("defaults the backend settings: cutoff 23:00 Africa/Lagos; the Match line is job_criteria 70 (EPIC-0004 0011)", async () => {
    const settings = await database.db.selectFrom("evaluation_setting").selectAll().executeTakeFirstOrThrow()
    expect(settings).toMatchObject({ hours_cutoff: "23:00", hours_time_zone: "Africa/Lagos" })
    const criteria = await database.db.selectFrom("job_criteria").selectAll().executeTakeFirstOrThrow()
    expect(criteria).toMatchObject({ min_core_match_percent: 70, frameworks: [], technologies: [], version: 1 })
    const control = await database.db.selectFrom("control_state").selectAll().executeTakeFirstOrThrow()
    expect(control).toMatchObject({ global_paused: false, cost_paused: false })
  })

  it("stores a posting once per application URL and requisition ID (AC 3.2)", async () => {
    await database.db.insertInto("job_posting").values(posting()).execute()
    await expect(database.db.insertInto("job_posting").values(posting()).execute()).rejects.toThrow(/job_posting_requisition_key_idx/)
    await database.db.insertInto("job_posting").values(posting({ requisition_id: "R-2000" })).execute()
  })

  it("the runtime role can read and write the new tables", async () => {
    const runtime = createDatabase(database.url)
    try {
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from employer_board`.execute(runtime)
      expect(rows[0]?.n).toBe(28)
      await runtime.updateTable("employer_list_state").set({ approved_at: new Date() }).execute()
    } finally {
      await runtime.destroy()
    }
  })
})
