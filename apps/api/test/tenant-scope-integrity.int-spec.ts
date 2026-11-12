import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase, TenantHandleMemberError, TenantScopeTamperedError } from "../src/db/tenant-database.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"

/**
 * EPIC-0002 A2 repair wave 2 (tenant scope integrity): TenantDatabase checks
 * after every statement and before commit that the RLS key still holds the
 * Candidate it set. A repository that points its transaction at another
 * Candidate gets an aborted transaction and none of that Candidate's rows.
 */
let database: TestDatabase
let runtime: Kysely<Database>
let tenant: TenantDatabase
let otherId: string

const OTHER_KEY = "k-tenant-integrity-other"
const OWN_KEY = "k-tenant-integrity-own"

const answer = (candidateId: string, key: string) => ({
  id: randomUUID(), candidate_id: candidateId, answer_key: key, answer_group: "custom" as const, topic: null, skill: null, question: "q", value: "SECRET-" + key, created_at: new Date(), updated_at: new Date(),
})

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  tenant = new TenantDatabase(runtime)
  otherId = await insertSecondCandidate(database.db)
  await database.db.insertInto("approved_answer").values(answer(otherId, OTHER_KEY)).execute()
})

afterAll(async () => {
  await runtime?.destroy()
  await database?.stop()
})

const pointAt = (id: string) => sql`select set_config('eve.candidate_id', ${id}, true)`

describe("TenantDatabase: a Candidate scope checks its own RLS key", () => {
  it("aborts at the statement that changes eve.candidate_id, before any read of the other Candidate's rows", async () => {
    const seen: unknown[] = []
    const attempt = tenant.forCandidate(database.operatorId, async (tx) => {
      await pointAt(otherId).execute(tx)
      seen.push(...(await tx.selectFrom("approved_answer").select("value").execute()))
    })
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
    expect(seen).toEqual([])
  })

  it("returns no row from a single statement that changes the key and reads in one go", async () => {
    const attempt = tenant.forCandidate(database.operatorId, (tx) =>
      sql<{ value: string }>`select set_config('eve.candidate_id', ${otherId}, true) as switched, (select string_agg(value, ',') from approved_answer) as value`.execute(tx)
    )
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
  })

  it("aborts the transaction: a write made before the switch is rolled back", async () => {
    const attempt = tenant.forCandidate(database.operatorId, async (tx) => {
      await tx.insertInto("approved_answer").values(answer(database.operatorId, OWN_KEY)).execute()
      await pointAt(otherId).execute(tx)
    })
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
    expect(await database.db.selectFrom("approved_answer").select("id").where("answer_key", "=", OWN_KEY).execute()).toEqual([])
  })

  it("aborts when the key is cleared, reset or set by SET LOCAL", async () => {
    for (const statement of [sql`select set_config('eve.candidate_id', '', true)`, sql`reset eve.candidate_id`, sql`set local eve.candidate_id = ${sql.lit(otherId)}`]) {
      await expect(tenant.forCandidate(database.operatorId, (tx) => statement.execute(tx))).rejects.toBeInstanceOf(TenantScopeTamperedError)
    }
  })

  it("aborts when the Candidate scope opens the shared scope", async () => {
    await expect(tenant.forCandidate(database.operatorId, (tx) => sql`select set_config('eve.scope', 'shared', true)`.execute(tx))).rejects.toBeInstanceOf(TenantScopeTamperedError)
  })

  it("checks before commit too: a caught switch rolls back even after the key is set back", async () => {
    const attempt = tenant.forCandidate(database.operatorId, async (tx) => {
      await tx.insertInto("approved_answer").values(answer(database.operatorId, OWN_KEY)).execute()
      await pointAt(otherId).execute(tx).catch(() => undefined)
      await pointAt(database.operatorId).execute(tx).catch(() => undefined)
    })
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
    expect(await database.db.selectFrom("approved_answer").select("id").where("answer_key", "=", OWN_KEY).execute()).toEqual([])
  })

  it("repair wave 3: the scoped handle refuses a member named at run time, so the guard cannot be dropped", async () => {
    const key = ["without", "Plugins"].join("")
    const attempt = tenant.forCandidate(database.operatorId, async (tx) => (tx as unknown as Record<string, () => unknown>)[key]!())
    await expect(attempt).rejects.toBeInstanceOf(TenantHandleMemberError)
  })

  it("leaves the pooled connection unscoped after an aborted transaction", async () => {
    await expect(tenant.forCandidate(database.operatorId, (tx) => pointAt(otherId).execute(tx))).rejects.toBeInstanceOf(TenantScopeTamperedError)
    const rows = await runtime.transaction().execute((trx) => trx.selectFrom("approved_answer").select("id").execute())
    expect(rows).toEqual([])
  })

  it("an honest Candidate transaction still reads and commits its own rows", async () => {
    await tenant.forCandidate(database.operatorId, (tx) => tx.insertInto("approved_answer").values(answer(database.operatorId, "k-tenant-integrity-honest")).execute())
    const rows = await tenant.forCandidate(database.operatorId, (tx) => tx.selectFrom("approved_answer").select("answer_key").execute())
    expect(rows.map((row) => row.answer_key)).toEqual(["k-tenant-integrity-honest"])
  })
})

describe("TenantDatabase: shared and installation scopes check theirs before commit", () => {
  it("a shared transaction that sets a Candidate rolls back", async () => {
    await expect(tenant.forShared((tx) => pointAt(otherId).execute(tx))).rejects.toBeInstanceOf(TenantScopeTamperedError)
  })

  it("an installation transaction that switches to the shared scope rolls back", async () => {
    await expect(tenant.forInstallation((tx) => sql`select set_config('eve.scope', 'shared', true)`.execute(tx))).rejects.toBeInstanceOf(TenantScopeTamperedError)
  })

  it("operatorStepWithin: the Operator step is checked, and the shared transaction after it", async () => {
    await expect(tenant.forShared((tx) => tenant.operatorStepWithin(tx, (step) => pointAt(otherId).execute(step)))).rejects.toBeInstanceOf(TenantScopeTamperedError)
    const after = await tenant.forShared((tx) => tenant.operatorStepWithin(tx, async (_step, id) => id))
    expect(after).toBe(database.operatorId)
  })
})
