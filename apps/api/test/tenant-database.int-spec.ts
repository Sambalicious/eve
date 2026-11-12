import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { CandidateScope, MissingCandidateScopeError } from "../src/db/candidate-scope.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"

let database: TestDatabase
let runtime: Kysely<Database>
let tenant: TenantDatabase
let operatorId: string

const setting = (name: string) => sql<{ value: string | null }>`select current_setting(${name}, true) as value`

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  tenant = new TenantDatabase(runtime)
  operatorId = (await database.db.selectFrom("candidate").select("id").where("role", "=", "operator").executeTakeFirstOrThrow()).id
})

afterAll(async () => {
  await runtime?.destroy()
  await database?.stop()
})

describe("TenantDatabase.forCandidate (architecture r2, Tenancy mechanism 3)", () => {
  it("sets eve.candidate_id for the transaction only", async () => {
    const inside = await tenant.forCandidate(operatorId, async (tx) => (await setting("eve.candidate_id").execute(tx)).rows[0]?.value)
    expect(inside).toBe(operatorId)
    const after = await runtime.connection().execute(async (c) => (await setting("eve.candidate_id").execute(c)).rows[0]?.value)
    expect(after ?? "").toBe("")
  })

  it("never sets eve.scope", async () => {
    const scope = await tenant.forCandidate(operatorId, async (tx) => (await setting("eve.scope").execute(tx)).rows[0]?.value)
    expect(scope ?? "").toBe("")
  })

  it("refuses an ID that is not a UUID before any query", async () => {
    await expect(tenant.forCandidate("x' or true --", async () => 1)).rejects.toThrow(/not a Candidate ID/)
  })

  it("rolls back the work when the callback throws", async () => {
    await expect(
      tenant.forCandidate(operatorId, async (tx) => {
        await tx.insertInto("approved_answer").values({ id: "00000000-0000-4000-8000-0000000000a1", candidate_id: operatorId, answer_key: "k-rollback", answer_group: "custom", topic: null, skill: null, question: "q", value: "v", created_at: new Date(), updated_at: new Date() }).execute()
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    const rows = await database.db.selectFrom("approved_answer").select("id").where("answer_key", "=", "k-rollback").execute()
    expect(rows).toEqual([])
  })
})

describe("TenantDatabase.forShared (architecture r2, Tenancy mechanism 2)", () => {
  it("sets eve.scope = 'shared' and leaves eve.candidate_id unset", async () => {
    const values = await tenant.forShared(async (tx) => ({
      scope: (await setting("eve.scope").execute(tx)).rows[0]?.value,
      candidate: (await setting("eve.candidate_id").execute(tx)).rows[0]?.value,
    }))
    expect(values.scope).toBe("shared")
    expect(values.candidate ?? "").toBe("")
  })

  it("operatorStepWithin scopes one step to the Operator, then the shared transaction sees no Candidate again", async () => {
    const values = await tenant.forShared(async (tx) => {
      const inside = await tenant.operatorStepWithin(tx, async (step, id) => ({ id, setting: (await setting("eve.candidate_id").execute(step)).rows[0]?.value }))
      return { inside, after: (await setting("eve.candidate_id").execute(tx)).rows[0]?.value }
    })
    expect(values.inside).toEqual({ id: operatorId, setting: operatorId })
    expect(values.after ?? "").toBe("")
  })
})

describe("TenantDatabase.run: the ambient Candidate scope", () => {
  it("throws without a scope and sends no query", async () => {
    await expect(tenant.run(async () => 1)).rejects.toBeInstanceOf(MissingCandidateScopeError)
  })

  it("opens a transaction for the scope's Candidate", async () => {
    const value = await CandidateScope.run(operatorId, () => tenant.run(async (tx) => (await setting("eve.candidate_id").execute(tx)).rows[0]?.value))
    expect(value).toBe(operatorId)
  })

  it("resolves the Operator for worker jobs from the identity table", async () => {
    expect(await tenant.operatorId()).toBe(operatorId)
    const value = await tenant.asOperator(() => tenant.run(async (tx) => (await setting("eve.candidate_id").execute(tx)).rows[0]?.value))
    expect(value).toBe(operatorId)
  })
})
