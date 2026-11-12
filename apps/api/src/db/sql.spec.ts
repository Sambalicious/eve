import { describe, expect, it } from "vitest"

import { TenantKeyInSqlError, sql } from "./sql.js"

/** Repair wave 2: the raw-SQL tag outside src/db cannot name the tenant scope. */
describe("src/db/sql: the raw-SQL tag for code outside src/db", () => {
  it.each([
    ["set_config", () => sql`select set_config('eve.candidate_id', ${"x"}, true)`],
    ["pg_catalog.set_config", () => sql`select pg_catalog.set_config(${"k"}, ${"v"}, true)`],
    ["SET LOCAL eve.candidate_id", () => sql`set local eve.candidate_id = ${"x"}`],
    ["quoted identifiers", () => sql`set local "eve"."scope" = 'shared'`],
    ["RESET eve.candidate_id", () => sql`RESET Eve.Candidate_Id`],
    ["current_setting", () => sql`select current_setting('x', true)`],
    ["a Unicode-escaped identifier", () => sql`set local U&"\\0065ve".scope = 'shared'`],
    ["sql.lit", () => sql.lit("eve.scope")],
    ["sql.id", () => sql.id("pg_catalog", "set_config")],
    ["sql.ref", () => sql.ref("eve.candidate_id")],
    ["sql.table", () => sql.table("eve.scope")],
  ])("refuses %s", (_name, build) => {
    expect(build).toThrow(TenantKeyInSqlError)
  })

  it("has no raw helper", () => {
    expect("raw" in sql).toBe(false)
    expect(Object.isFrozen(sql)).toBe(true)
  })

  it("builds ordinary fragments, parameters stay parameters", () => {
    const leave = "eve.access_request"
    expect(() => sql`select pg_advisory_xact_lock(hashtext(${leave}))`).not.toThrow()
    expect(() => sql`coalesce(published_at, first_seen_at)`).not.toThrow()
    expect(() => sql`set statement_timeout = 0`).not.toThrow()
    expect(() => sql.join([sql.lit("ranked"), sql.ref("p.role_family")])).not.toThrow()
  })
})
