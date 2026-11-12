import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { FORWARD_STATEMENTS_MARKER } from "../src/db/migrations/0034-forward-statements.js"
import { SCHEMA_MARKERS } from "../src/db/migrations/schema-markers.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"

/** Migration 0034: `job_posting.forward_statements`, a nullable JSON array, and its marker. */
let database: TestDatabase

beforeAll(async () => {
  database = await startMigratedDatabase()
})

afterAll(async () => {
  await database?.stop()
})

describe("migration 0034: forward statements", () => {
  it("records its marker, and the marker is required at boot", async () => {
    expect(FORWARD_STATEMENTS_MARKER).toBe("0034-forward-statements")
    expect(SCHEMA_MARKERS).toContain(FORWARD_STATEMENTS_MARKER)
    const marker = await sql<{ name: string }>`select name from migration_marker where name = ${FORWARD_STATEMENTS_MARKER}`.execute(database.db)
    expect(marker.rows).toHaveLength(1)
  })

  it("adds a nullable forward_statements column that accepts only a JSON array", async () => {
    const column = await sql<{ is_nullable: string; data_type: string }>`select is_nullable, data_type from information_schema.columns where table_name = 'job_posting' and column_name = 'forward_statements'`.execute(database.db)
    expect(column.rows).toEqual([{ is_nullable: "YES", data_type: "jsonb" }])
    const check = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'job_posting_forward_statements_check'`.execute(database.db)
    expect(check.rows[0]?.def).toMatch(/jsonb_typeof\(forward_statements\) = 'array'/)
  })

  it("leaves the job_posting RLS policy and grants unchanged", async () => {
    const flags = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'job_posting'`.execute(database.db)
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
    const policies = await sql<{ policyname: string }>`select policyname from pg_policies where tablename = 'job_posting'`.execute(database.db)
    expect(policies.rows.map((policy) => policy.policyname)).toEqual(["job_posting_owner"])
    const grants = await sql<{ privilege_type: string }>`select privilege_type from information_schema.role_table_grants where table_name = 'job_posting' and grantee = ${database.roles.runtime.name} order by privilege_type`.execute(database.db)
    expect(grants.rows.map((grant) => grant.privilege_type)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"])
  })
})
