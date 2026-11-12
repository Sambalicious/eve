import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ATS_SKILLS_MARKER } from "../src/db/migrations/0028-ats-skills.js"
import { SCHEMA_MARKERS } from "../src/db/migrations/schema-markers.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"

/** Migration 0028: `job_posting.ats_skills`, a nullable JSON array, and its marker. */
let database: TestDatabase

beforeAll(async () => {
  database = await startMigratedDatabase()
})

afterAll(async () => {
  await database?.stop()
})

describe("migration 0028: ATS skills", () => {
  it("records its marker, and the marker is required at boot", async () => {
    expect(ATS_SKILLS_MARKER).toBe("0028-ats-skills")
    expect(SCHEMA_MARKERS).toContain(ATS_SKILLS_MARKER)
    const marker = await sql<{ name: string }>`select name from migration_marker where name = ${ATS_SKILLS_MARKER}`.execute(database.db)
    expect(marker.rows).toHaveLength(1)
  })

  it("adds a nullable ats_skills column that accepts only a JSON array", async () => {
    const column = await sql<{ is_nullable: string; data_type: string }>`select is_nullable, data_type from information_schema.columns where table_name = 'job_posting' and column_name = 'ats_skills'`.execute(database.db)
    expect(column.rows).toEqual([{ is_nullable: "YES", data_type: "jsonb" }])
    const check = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'job_posting_ats_skills_check'`.execute(database.db)
    expect(check.rows[0]?.def).toMatch(/jsonb_typeof\(ats_skills\) = 'array'/)
  })
})

describe("migration 0029: ATS fit", () => {
  it("adds a nullable match_evidence.ats_fit limited to 0 to 100, and its marker", async () => {
    expect(SCHEMA_MARKERS).toContain("0029-ats-fit")
    const column = await sql<{ is_nullable: string; data_type: string }>`select is_nullable, data_type from information_schema.columns where table_name = 'match_evidence' and column_name = 'ats_fit'`.execute(database.db)
    expect(column.rows).toEqual([{ is_nullable: "YES", data_type: "smallint" }])
    const check = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'match_evidence_ats_fit_check'`.execute(database.db)
    expect(check.rows[0]?.def).toMatch(/ats_fit >= 0/)
  })
})

describe("migration 0030: ATS minimum", () => {
  it("adds candidate_setting.min_ats_percent (default 40, 0 to 100) and allows the ats_below_minimum reason", async () => {
    expect(SCHEMA_MARKERS).toContain("0030-ats-minimum")
    const column = await sql<{ column_default: string; is_nullable: string }>`select column_default, is_nullable from information_schema.columns where table_name = 'candidate_setting' and column_name = 'min_ats_percent'`.execute(database.db)
    expect(column.rows).toEqual([{ column_default: "40", is_nullable: "NO" }])
    const reasons = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'application_blocked_reason_check'`.execute(database.db)
    expect(reasons.rows[0]?.def).toContain("'ats_below_minimum'::text")
    expect(reasons.rows[0]?.def).toContain("'automation_incomplete'::text")
  })
})
