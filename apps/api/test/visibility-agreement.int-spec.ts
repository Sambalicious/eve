import { randomUUID } from "node:crypto"

import { DEFAULT_TARGET_ROLE_FAMILIES, roleFamilySchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type VisibilityContext, buildVisibilityContext, hiddenReason, hiddenReasonSql, visibleSql } from "../src/discovery/visibility.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"

/**
 * EPIC-0006 (architecture.r1 "Visibility module"): the SQL fragment and the
 * TypeScript twin give the same first hidden reason for every combination of
 * shared facts, under several contexts, on real Postgres. Like TIER and tierSql.
 */
let database: TestDatabase

beforeAll(async () => {
  database = await startMigratedDatabase()
})

afterAll(async () => {
  await database.stop()
})

type Facts = { title: string | null; prefilter: "not_software_role" | null; family: string | null; marker: "entry" | "mid_plus" | "none" | null; postedAt: Date | null }

const NOW = new Date("2026-10-24T08:00:00Z")
const POSTED = [
  null,
  new Date("2026-10-24T07:59:59Z"),
  new Date("2026-09-23T23:00:00Z"),
  new Date("2026-08-24T23:00:00Z"), // age 60: visible
  new Date("2026-08-24T22:59:59.999Z"), // age 61: hidden
  new Date("2001-01-01T00:00:00Z"),
]

function combinations(): Facts[] {
  const out: Facts[] = []
  for (const title of [null, "Senior Frontend Engineer"])
    for (const prefilter of [null, "not_software_role"] as const)
      for (const family of [null, "senior_frontend", "data_ml", "devops_platform", "other"])
        for (const marker of [null, "entry", "mid_plus", "none"] as const)
          for (const postedAt of POSTED) out.push({ title, prefilter, family, marker, postedAt })
  return out
}

const CONTEXTS: Record<string, VisibilityContext> = {
  defaults: buildVisibilityContext({ targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: "hide_entry_level" }, NOW),
  everyFamilyAllLevels: buildVisibilityContext({ targetRoleFamilies: [...roleFamilySchema.options], seniorityFloor: "all_levels" }, NOW),
  dataOnly: buildVisibilityContext({ targetRoleFamilies: ["data_ml"], seniorityFloor: "hide_entry_level" }, NOW),
  justBeforeWatMidnight: buildVisibilityContext({ targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: "all_levels" }, new Date("2026-10-24T22:59:59Z")),
  atWatMidnight: buildVisibilityContext({ targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: "all_levels" }, new Date("2026-10-24T23:00:00Z")),
}

describe("visibility SQL and TypeScript agree", () => {
  it("inserts every combination of shared facts", async () => {
    const rows = combinations()
    expect(rows.length).toBe(480)
    for (const [index, facts] of rows.entries()) {
      const url = `https://boards.greenhouse.io/agree/jobs/${index}`
      await database.db
        .insertInto("job_posting")
        .values({
          id: randomUUID(),
          application_url: url,
          requisition_id: String(index),
          apply_url: url,
          application_system: "greenhouse",
          apply_mode: "automatic",
          origin: "employer_board",
          employer_board_id: null,
          remote_board_key: null,
          attribution_name: null,
          attribution_url: null,
          title: facts.title,
          title_folded: facts.title?.toLowerCase() ?? null,
          company: "Agree Co",
          posting_text: "",
          role_family: facts.family,
          prefilter_skip: facts.prefilter,
          seniority_marker: facts.marker,
          posted_at: facts.postedAt,
          posted_date_kind: facts.postedAt === null ? null : "published",
          discovered_at: NOW,
        })
        .execute()
    }
  })

  it.each(Object.keys(CONTEXTS))("first reason and visibility match under %s", async (name) => {
    const ctx = CONTEXTS[name]!
    const { rows } = await sql<{ title_folded: string | null; prefilter_skip: string | null; role_family: string | null; seniority_marker: string | null; posted_at: Date | null; reason: string | null; visible: boolean }>`
      select p.title_folded, p.prefilter_skip, p.role_family, p.seniority_marker, p.posted_at,
        ${hiddenReasonSql("p", ctx)} as reason, ${visibleSql("p", ctx)} as visible
      from job_posting p where p.company = 'Agree Co'`.execute(database.db)
    expect(rows).toHaveLength(480)
    const disagreements = rows.filter((row) => {
      const expected = hiddenReason(
        { titled: row.title_folded !== null, prefilterSkip: row.prefilter_skip, roleFamily: row.role_family, seniorityMarker: row.seniority_marker, postedAt: row.posted_at, pastedDescription: false },
        ctx
      )
      return row.reason !== expected || row.visible !== (expected === null)
    })
    expect(disagreements).toEqual([])
    // Every reason occurs under the defaults, so the agreement is not vacuous.
    if (name === "defaults") expect(new Set(rows.map((row) => row.reason))).toEqual(new Set([null, "off_target", "below_seniority_floor", "undated", "older_than_60_days"]))
  })
})
