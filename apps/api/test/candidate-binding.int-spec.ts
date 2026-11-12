import { randomUUID } from "node:crypto"

import { type Kysely, type Transaction, sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"

/**
 * EPIC-0002 A2 repair wave 3 (F-SEC-10), migration 0022-candidate-binding: the
 * RLS policies read the Candidate from an owner-only binding of the current
 * transaction, which only `bind_candidate` writes and which refuses a second
 * Candidate. Code inside a Candidate transaction that changes
 * `eve.candidate_id`, or binds another Candidate, still sees only its own rows.
 *
 * These run on a raw runtime-role transaction opened as TenantDatabase opens a
 * Candidate scope, so they test the database layer without TenantDatabase's
 * statement guard in the way.
 */
let database: TestDatabase
let runtime: Kysely<Database>
let otherId: string

const answer = (candidateId: string, key: string) => ({
  id: randomUUID(), candidate_id: candidateId, answer_key: key, answer_group: "custom" as const, topic: null, skill: null, question: "q", value: "SECRET-" + key, created_at: new Date(), updated_at: new Date(),
})

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  otherId = await insertSecondCandidate(database.db)
  await database.db.insertInto("approved_answer").values([answer(otherId, "k-binding-other"), answer(database.operatorId, "k-binding-own")]).execute()
})

afterAll(async () => {
  await runtime?.destroy()
  await database?.stop()
})

const pointAt = (id: string) => sql`select set_config('eve.candidate_id', ${id}, true)`
const bind = (id: string) => sql`select public.bind_candidate(${id}::uuid)`
const values = async (tx: Transaction<Database>) => (await tx.selectFrom("approved_answer").select("value").orderBy("value").execute()).map((row) => row.value)

/** A runtime-role transaction scoped to the Operator, as TenantDatabase.forCandidate opens it. */
const asOperator = <T>(work: (tx: Transaction<Database>) => Promise<T>) =>
  runtime.transaction().execute(async (tx) => {
    await pointAt(database.operatorId).execute(tx)
    await bind(database.operatorId).execute(tx)
    return work(tx)
  })

describe("0022-candidate-binding: the binding holds when the setting changes", () => {
  it("an honest scope sees its own rows", async () => {
    expect(await asOperator(values)).toEqual(["SECRET-k-binding-own"])
  })

  it("pointing eve.candidate_id at another Candidate shows none of their rows", async () => {
    expect(await asOperator(async (tx) => (await pointAt(otherId).execute(tx), await values(tx)))).toEqual([])
  })

  it("switching to another Candidate and back still shows only its own rows", async () => {
    const seen = await asOperator(async (tx) => {
      await pointAt(otherId).execute(tx)
      const during = await values(tx)
      await pointAt(database.operatorId).execute(tx)
      return [...during, ...(await values(tx))]
    })
    expect(seen).toEqual(["SECRET-k-binding-own"])
  })

  it("SET LOCAL to another Candidate shows none of their rows, and writes for them are refused", async () => {
    await expect(asOperator(async (tx) => (await sql`set local eve.candidate_id = ${sql.lit(otherId)}`.execute(tx), await values(tx)))).resolves.toEqual([])
    await expect(asOperator(async (tx) => {
      await pointAt(otherId).execute(tx)
      await tx.insertInto("approved_answer").values(answer(otherId, "k-binding-planted")).execute()
    })).rejects.toThrow(/row-level security/)
  })

  it("an unbound transaction with only the setting sees no Candidate row", async () => {
    expect(await runtime.transaction().execute(async (tx) => (await pointAt(otherId).execute(tx), await values(tx)))).toEqual([])
  })
})

describe("0022-candidate-binding: bind_candidate refuses a second Candidate", () => {
  it("binding another Candidate in the same transaction is refused", async () => {
    await expect(asOperator((tx) => bind(otherId).execute(tx))).rejects.toThrow(/bound to another Candidate/)
  })

  it("after a refused bind rolled back to a savepoint, the scope still sees only its own rows", async () => {
    const seen = await asOperator(async (tx) => {
      await sql`savepoint probe`.execute(tx)
      await expect(bind(otherId).execute(tx)).rejects.toThrow(/bound to another Candidate/)
      await sql`rollback to savepoint probe`.execute(tx)
      await pointAt(otherId).execute(tx)
      return values(tx)
    })
    expect(seen).toEqual([])
  })

  it("binding the same Candidate again is a no-op", async () => {
    expect(await asOperator(async (tx) => (await bind(database.operatorId).execute(tx), await values(tx)))).toEqual(["SECRET-k-binding-own"])
  })

  it("refuses an ID that is not a Candidate", async () => {
    await expect(runtime.transaction().execute((tx) => bind(randomUUID()).execute(tx))).rejects.toThrow(/not a Candidate/)
  })

  it("the runtime role can neither read nor write the binding table", async () => {
    await expect(sql`select * from tenant_binding.candidate_binding`.execute(runtime)).rejects.toThrow(/permission denied/)
    await expect(sql`insert into tenant_binding.candidate_binding values (pg_current_xact_id(), ${otherId}::uuid)`.execute(runtime)).rejects.toThrow(/permission denied/)
  })

  it("the binding ends with its transaction", async () => {
    await asOperator(values)
    expect(await runtime.transaction().execute(async (tx) => (await bind(otherId).execute(tx), await pointAt(otherId).execute(tx), await values(tx)))).toEqual(["SECRET-k-binding-other"])
  })
})

describe("0022-candidate-binding through TenantDatabase", () => {
  it("forCandidate binds the transaction: a second bind inside it is refused and no foreign row is returned", async () => {
    const tenant = new TenantDatabase(runtime)
    const seen: string[] = []
    await expect(tenant.forCandidate(database.operatorId, async (tx) => {
      await bind(otherId).execute(tx)
      seen.push(...(await values(tx)))
    })).rejects.toThrow(/bound to another Candidate/)
    expect(seen).toEqual([])
  })
})
