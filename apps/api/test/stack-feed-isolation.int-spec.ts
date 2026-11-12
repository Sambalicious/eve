import { readFileSync } from "node:fs"

import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { CROSS_CANDIDATE_CASES } from "./cross-candidate.cases.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { SFEED_A, SFEED_B, clearFeeds, insertCandidate, insertStackFeed, insertStackPosts, ownStackRow, ownStackRows, recordStack, stackPostCount } from "./support/stack-feed-fixtures.js"

/**
 * EPIC-0008 row-level security on `alert_feed_candidate_verification` (stack-feed-isolation.feature
 * :18, :25, :31, :45, :101, :107, :114; api-contract.md v1.22.0 "Tenancy and source guards").
 * Statements run as the runtime role (the api and worker role), inside `TenantDatabase` scopes
 * or with no scope at all. Fixtures and assertions use the bootstrap superuser.
 */
let database: TestDatabase
let runtime: Kysely<Database>
let tenant: TenantDatabase
let bolaId: string
let chidiId: string

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  tenant = new TenantDatabase(runtime)
  bolaId = await insertCandidate(database.db, "bola@example.com")
  chidiId = await insertCandidate(database.db, "chidi@example.com")
})

beforeEach(async () => {
  await clearFeeds(database.db)
})

afterAll(async () => {
  await runtime?.destroy()
  await database?.stop()
})

const ADA = () => database.operatorId
const TABLE = "alert_feed_candidate_verification"

describe("row-level security (ISO:18, :25, :31, :45)", () => {
  it("ISO:18 a session scoped to bola reads exactly one row, hers, and counts 1", async () => {
    for (const id of [ADA(), bolaId, chidiId]) await recordStack(database.db, id)
    const seen = await tenant.forCandidate(bolaId, async (trx) => ({
      rows: (await sql<{ candidate_id: string }>`select candidate_id::text from alert_feed_candidate_verification`.execute(trx)).rows,
      count: (await sql<{ n: number }>`select count(*)::int as n from alert_feed_candidate_verification`.execute(trx)).rows[0]!.n,
    }))
    expect(seen).toEqual({ rows: [{ candidate_id: bolaId }], count: 1 })
  })

  it("ISO:25 the runtime role with no Candidate scope reads no row", async () => {
    await recordStack(database.db, ADA())
    await recordStack(database.db, bolaId)
    expect((await sql`select * from alert_feed_candidate_verification`.execute(runtime)).rows).toEqual([])
  })

  it.each([
    ["insert a row with ada's Candidate id", async (trx: Kysely<Database>) => sql`insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values (${database.operatorId}::uuid, '2026-10-21', 'Forged', now())`.execute(trx)],
    ["update the basis of ada's record", async (trx: Kysely<Database>) => sql`update alert_feed_candidate_verification set verification_basis = 'Forged' where candidate_id = ${database.operatorId}::uuid`.execute(trx)],
    ["delete ada's record", async (trx: Kysely<Database>) => sql`delete from alert_feed_candidate_verification where candidate_id = ${database.operatorId}::uuid`.execute(trx)],
    ["change the Candidate id to hers on ada's record", async (trx: Kysely<Database>) => sql`update alert_feed_candidate_verification set candidate_id = ${bolaId}::uuid where candidate_id = ${database.operatorId}::uuid`.execute(trx)],
  ])("ISO:31 in bola's scope, %s changes no row", async (_name, write) => {
    await recordStack(database.db, ADA(), { basis: "Ada's basis" })
    const before = await ownStackRows(database.db)
    await tenant.forCandidate(bolaId, (trx) => write(trx)).catch((error: unknown) => {
      // The insert is refused by the policy's WITH CHECK; the others match no visible row.
      expect(String(error)).toMatch(/row-level security/)
    })
    expect(await ownStackRows(database.db)).toEqual(before)
    expect((await ownStackRow(database.db, ADA()))?.verification_basis).toBe("Ada's basis")
  })

  it("ISO:45 the runtime role neither owns the table nor bypasses row-level security", async () => {
    const owner = await sql<{ owner: string }>`select pg_get_userbyid(relowner) as owner from pg_class where relname = ${TABLE}`.execute(database.db)
    expect(owner.rows[0]!.owner).not.toBe(database.roles.runtime.name)
    const role = await sql<{ bypass: boolean; superuser: boolean }>`select rolbypassrls as bypass, rolsuper as superuser from pg_roles where rolname = current_user`.execute(runtime)
    expect(role.rows).toEqual([{ bypass: false, superuser: false }])
  })
})

describe("coverage registries (ISO:101, :107)", () => {
  it("ISO:101 the RLS coverage test names STACK_FEED_VERIFICATION_TABLES (it fails the build if a candidate_id table is not covered)", () => {
    const source = readFileSync(new URL("./row-level-security.int-spec.ts", import.meta.url), "utf8")
    expect(source).toMatch(/import \{ STACK_FEED_VERIFICATION_TABLES \} from "..\/src\/db\/migrations\/0024-alert-feed-candidate-verification.js"/)
    // Parse the RLS_TABLES list and assert membership of each spread by name: the list grows by
    // appending entries, so adjacency to any one entry is not part of the claim.
    const declaration = source.match(/const RLS_TABLES: readonly string\[\] = \[([\s\S]*?)\]/)
    expect(declaration).not.toBeNull()
    const entries = declaration![1]!.split(",").map((entry) => entry.trim()).filter(Boolean)
    expect(entries).toEqual(expect.arrayContaining(["...HIRING_TABLES", "...STACK_FEED_VERIFICATION_TABLES", "...SIMPLIFY_EVE_TABLES", "...OUTREACH_TABLES"]))
  })

  it("ISO:107 the cross-Candidate registry has the Stack posts save and list, and the save asserts the other row and gate are unchanged", () => {
    const save = CROSS_CANDIDATE_CASES.find((entry) => entry.method === "PUT" && entry.path === "/v1/stack-posts/alert-feeds/verification")
    const list = CROSS_CANDIDATE_CASES.find((entry) => entry.method === "GET" && entry.path === "/v1/stack-posts/alert-feeds")
    expect(save?.proof).toMatch(/another Candidate's row, their registration gate and their reads are unchanged/)
    expect(list?.proof).toMatch(/B's verification is null/)
    // Merge with A2: the registry now lists every route, and A2's guarded submission routes say "Operator only before E";
    // the claim checked here is that no Stack posts Alert feed entry is Operator-only.
    const alertFeedEntries = CROSS_CANDIDATE_CASES.filter((entry) => entry.path.startsWith("/v1/stack-posts/alert-feeds"))
    expect(alertFeedEntries).toHaveLength(4)
    expect(JSON.stringify(alertFeedEntries)).not.toMatch(/Operator only|operator-only|r5 K6/)
  })
})

describe("Candidate deletion (ISO:114)", () => {
  it("removing bola removes her record, feeds and posts by cascade; ada's are unchanged", async () => {
    // EPIC-0002 Candidate deletion deletes the candidate row; this proves the cascade it relies on for the new table.
    const dele = await insertCandidate(database.db, "dele-delete@example.com")
    await recordStack(database.db, dele)
    await insertStackFeed(database.db, dele, SFEED_A)
    await insertStackFeed(database.db, dele, SFEED_B)
    await insertStackPosts(database.db, dele, 5)
    await recordStack(database.db, ADA())
    await insertStackFeed(database.db, ADA(), SFEED_A)
    await insertStackPosts(database.db, ADA(), 4)
    const adaBefore = await ownStackRow(database.db, ADA())
    await database.db.deleteFrom("job_criteria").where("candidate_id", "=", dele).execute()
    await database.db.deleteFrom("candidate").where("id", "=", dele).execute()
    expect(await ownStackRow(database.db, dele)).toBeUndefined()
    expect(await database.db.selectFrom("alert_feed").select("id").where("candidate_id", "=", dele).execute()).toEqual([])
    expect(await stackPostCount(database.db, dele)).toBe(0)
    expect(await ownStackRow(database.db, ADA())).toEqual(adaBefore)
    expect(await stackPostCount(database.db, ADA())).toBe(4)
  })
})

describe("table rules (MIG:261, :276, :284)", () => {
  const insertAs = (scope: string, values: { candidateId?: string; verifiedOn?: string | null; basis?: string | null }) =>
    tenant.forCandidate(scope, (trx) =>
      sql`insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at)
        values (${values.candidateId ?? scope}::uuid, ${values.verifiedOn === undefined ? "2026-10-21" : values.verifiedOn}::date, ${values.basis === undefined ? "Read terms." : values.basis}, now())`.execute(trx)
    )

  it.each([
    ["no verified_on", { verifiedOn: null }, /null value in column "verified_on"/],
    ["no verification_basis", { basis: null }, /null value in column "verification_basis"/],
    ["a verification_basis of \"\" (BE-7: the API trims first; the table refuses the empty string)", { basis: "" }, /check constraint/],
    ["a verification_basis of 501 code points", { basis: "😀".repeat(501) }, /check constraint/],
  ])("MIG:261 a direct insert in bola's scope with %s is refused and she has no record", async (_name, values, error) => {
    await expect(insertAs(bolaId, values)).rejects.toThrow(error)
    expect(await ownStackRow(database.db, bolaId)).toBeUndefined()
  })

  it("MIG:261 a candidate_id that matches no Candidate is refused (as superuser, past RLS: the foreign key)", async () => {
    await expect(
      sql`insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values (gen_random_uuid(), '2026-10-21', 'x', now())`.execute(database.db)
    ).rejects.toThrow(/foreign key/)
    expect(await ownStackRows(database.db)).toEqual([])
  })

  it("MIG:276 a second row for her is refused by the primary key; she still has one", async () => {
    await recordStack(database.db, bolaId)
    await expect(insertAs(bolaId, {})).rejects.toThrow(/alert_feed_candidate_verification_pkey/)
    expect((await ownStackRows(database.db)).filter((row) => row.candidate_id === bolaId)).toHaveLength(1)
  })

  it("MIG:284 deleting a Candidate deletes her record; ada's is unchanged", async () => {
    const efe = await insertCandidate(database.db, "efe-delete@example.com")
    await recordStack(database.db, efe)
    await recordStack(database.db, ADA())
    const adaBefore = await ownStackRow(database.db, ADA())
    await database.db.deleteFrom("job_criteria").where("candidate_id", "=", efe).execute()
    await database.db.deleteFrom("candidate").where("id", "=", efe).execute()
    expect(await ownStackRow(database.db, efe)).toBeUndefined()
    expect(await ownStackRow(database.db, ADA())).toEqual(adaBefore)
  })
})
