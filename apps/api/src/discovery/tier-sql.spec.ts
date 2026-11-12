import { DEFAULT_ROLE_FAMILY_TIERS, type FamilyTier, type RoleFamilyValue, roleFamilySchema } from "@eve/contracts"
import { CompiledQuery, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql } from "kysely"
import { describe, expect, it } from "vitest"

import { tierSql } from "./job-postings-query.js"
import { rankTiersOf } from "./rules/preference-rules.js"

/** TM-B1-14: `tierSql` emits only catalog family keys and integer literals, for any parsed tier map; an out-of-range key throws. */
const db = new Kysely<unknown>({
  dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => ({ init: async () => {}, acquireConnection: async () => { throw new Error("no db") }, beginTransaction: async () => {}, commitTransaction: async () => {}, rollbackTransaction: async () => {}, releaseConnection: async () => {}, destroy: async () => {} }), createIntrospector: (k) => new PostgresIntrospector(k), createQueryCompiler: () => new PostgresQueryCompiler() },
})
const compile = (tiers: Readonly<Record<string, number>>): CompiledQuery => sql`select ${tierSql(sql.ref("p.role_family"), tiers as never)}`.compile(db)

describe("tierSql (TM-B1-14)", () => {
  const tierValues: FamilyTier[] = [1, 2, 3, "excluded"]
  it.each(Array.from({ length: 25 }, (_, seed) => seed))("random parsed map %i: SQL holds only catalog keys, digits and fixed words, no parameters", (seed) => {
    const tiers = Object.fromEntries(roleFamilySchema.options.map((family, index) => [family, tierValues[(seed * 7 + index * 3) % 4]!])) as Record<RoleFamilyValue, FamilyTier>
    const query = compile(rankTiersOf(tiers))
    expect(query.parameters).toEqual([])
    const stripped = query.sql.replace(/'([a-z_]+)'/g, (_, key: string) => {
      expect(roleFamilySchema.options).toContain(key)
      return ""
    })
    expect(stripped).toMatch(/^select \(case "p"\."role_family" (when {2}then \d )+else \d end\)$/)
  })

  it("the Operator's tiers give the built order of literals", () => {
    expect(compile(rankTiersOf({ ...DEFAULT_ROLE_FAMILY_TIERS })).sql).toContain("when 'senior_frontend' then 0")
  })

  it.each([[-1], [10], [1.5], [Number.NaN]])("a sort key %s (never produced by rankTiersOf) throws instead of reaching SQL", (bad) => {
    expect(() => compile({ ...rankTiersOf({ ...DEFAULT_ROLE_FAMILY_TIERS }), backend: bad })).toThrow(/tier sort key out of range/)
  })
})
