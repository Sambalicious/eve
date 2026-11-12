import { randomUUID } from "node:crypto"

import { type Kysely, type KyselyPlugin, RawNode, sql as kyselySql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { scopedCheckout } from "../src/db/scoped-checkout.js"
import { sql } from "../src/db/sql.js"
import { TenantDatabase, TenantScopeTamperedError, TenantStatementRefusedError } from "../src/db/tenant-database.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"

/**
 * EPIC-0002 A2 run a2c: a Candidate scope is one transaction from open to
 * commit, and every statement inside it runs in that transaction, one at a
 * time. Ada is the Operator (the owner Candidate); Kofi is a second Candidate.
 */
let database: TestDatabase
let runtime: Kysely<Database>
let tenant: TenantDatabase
let ada: string
let kofi: string

const ADA_KEY = "k-a2c-ada"
const KOFI_KEY = "k-a2c-kofi"

const answer = (candidateId: string, key: string) => ({
  id: randomUUID(), candidate_id: candidateId, answer_key: key, answer_group: "custom" as const, topic: null, skill: null, question: "q", value: "SECRET-" + key, created_at: new Date(), updated_at: new Date(),
})

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  tenant = new TenantDatabase(runtime)
  ada = database.operatorId
  kofi = await insertSecondCandidate(database.db, "kofi.a2c@example.test")
  await database.db.insertInto("approved_answer").values([answer(ada, ADA_KEY), answer(kofi, KOFI_KEY)]).execute()
})

afterAll(async () => {
  await runtime?.destroy()
  await database?.stop()
})

/** Turns any raw statement into `commit`. */
const COMMIT_REWRITER: KyselyPlugin = {
  transformQuery: (args) => (RawNode.is(args.node) ? (RawNode.createWithSql("commit") as never) : args.node),
  transformResult: async (args) => args.result,
}

const adaRows = async () => (await database.db.selectFrom("approved_answer").select(["answer_key", "value"]).where("candidate_id", "=", ada).orderBy("answer_key").execute())

describe("run a2c invariant 1: scoped statements use the extended query protocol", () => {
  it("Postgres itself refuses two statements in one call on a scope's checkout, so the first never commits the transaction", async () => {
    // A raw transaction opened as TenantDatabase opens a scope, without its text check, to prove the protocol alone holds.
    const attempt = scopedCheckout(() => runtime.transaction().execute((trx) => kyselySql`select 1; commit`.execute(trx)))
    await expect(attempt).rejects.toThrow(/cannot insert multiple commands into a prepared statement/)
  })

  it("inside TenantDatabase the text check refuses it first and the scope fails", async () => {
    await expect(tenant.forCandidate(kofi, (tx) => kyselySql`select 1; commit`.execute(tx))).rejects.toBeInstanceOf(TenantStatementRefusedError)
  })

  it("after the scope closes its connection goes back unmarked: unscoped work on the pool keeps the simple protocol", async () => {
    await tenant.forCandidate(kofi, (tx) => tx.selectFrom("approved_answer").select("id").execute())
    // Two statements are accepted only by the simple protocol; pg returns one result per statement.
    await expect(kyselySql`select 1; select 2`.execute(runtime)).resolves.toBeDefined()
  })
})

describe("run a2c: no statement inside Kofi's scope can read or write Ada's rows", () => {
  const attacks: Array<[string, (tx: Parameters<Parameters<TenantDatabase["forCandidate"]>[1]>[0]) => Promise<unknown>]> = [
    ["commit then read", (tx) => kyselySql`commit`.execute(tx).then(() => tx.selectFrom("approved_answer").select("value").execute())],
    ["commit; read in one call", (tx) => kyselySql`commit; select value from approved_answer`.execute(tx)],
    ["rollback then insert for Ada", (tx) => kyselySql`rollback`.execute(tx).then(() => tx.insertInto("approved_answer").values(answer(ada, "k-a2c-planted")).execute())],
    ["end; update Ada", (tx) => sql`end; update approved_answer set value = 'OWNED' where answer_key = ${ADA_KEY}`.execute(tx)],
    ["savepoint then rollback to it", (tx) => sql`savepoint s1`.execute(tx).then(() => sql`rollback to savepoint s1`.execute(tx))],
    ["set session authorization", (tx) => sql`set session authorization default`.execute(tx)],
    ["reset all", (tx) => sql`reset all`.execute(tx)],
    ["begin", (tx) => sql`begin`.execute(tx)],
    ["prepare transaction", (tx) => sql`prepare transaction 'a2c'`.execute(tx)],
    // Repair wave 1 (F-SEC-12): a plugin rewrites the statement after the guard's own plugin ran.
    ["plugin-built commit (raw withPlugin)", (tx) => kyselySql`select 1`.withPlugin(COMMIT_REWRITER).execute(tx).then(() => tx.selectFrom("approved_answer").select("value").execute())],
    ["plugin-built commit (executor withPlugin)", (tx) => kyselySql`select 1`.execute({ getExecutor: () => tx.getExecutor().withPlugin(COMMIT_REWRITER) }).then(() => tx.selectFrom("approved_answer").select("value").execute())],
  ]

  it.each(attacks)("%s: refused, the scope fails, and Ada's rows are unchanged and unread", async (_name, attack) => {
    const seen: unknown[] = []
    const result = tenant.forCandidate(kofi, async (tx) => {
      seen.push(await attack(tx))
      seen.push(...(await tx.selectFrom("approved_answer").select("value").execute()))
    })
    await expect(result).rejects.toThrow()
    expect(JSON.stringify(seen)).not.toContain(`SECRET-${ADA_KEY}`)
    expect(await adaRows()).toEqual([{ answer_key: ADA_KEY, value: `SECRET-${ADA_KEY}` }])
  })

  it("a refused statement fails the scope even when the caller catches it: Kofi's earlier write is rolled back", async () => {
    const outcomes: string[] = []
    const attempt = tenant.forCandidate(kofi, async (tx) => {
      await tx.insertInto("approved_answer").values(answer(kofi, "k-a2c-kofi-rolled-back")).execute()
      await sql`commit`.execute(tx).catch((error: unknown) => outcomes.push((error as Error).name))
    })
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
    expect(outcomes).toEqual([TenantStatementRefusedError.name])
    expect(await database.db.selectFrom("approved_answer").select("id").where("answer_key", "=", "k-a2c-kofi-rolled-back").execute()).toEqual([])
  })

  it.each([
    ["raw builder withPlugin", (tx: Parameters<Parameters<TenantDatabase["forCandidate"]>[1]>[0]) => kyselySql`select 1`.withPlugin(COMMIT_REWRITER).execute(tx)],
    ["executor withPlugin", (tx: Parameters<Parameters<TenantDatabase["forCandidate"]>[1]>[0]) => kyselySql`select 1`.execute({ getExecutor: () => tx.getExecutor().withPlugin(COMMIT_REWRITER) })],
  ])("repair wave 1 (F-SEC-12): a plugin-built commit (%s) is never sent, so Kofi's earlier write is rolled back", async (name, attack) => {
    const key = `k-a2c-plugin-${name.replace(/\W+/g, "-")}`
    const outcomes: string[] = []
    const attempt = tenant.forCandidate(kofi, async (tx) => {
      await tx.insertInto("approved_answer").values(answer(kofi, key)).execute()
      await attack(tx).catch((error: unknown) => outcomes.push((error as Error).name))
    })
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
    expect(outcomes).toEqual([TenantStatementRefusedError.name])
    expect(await database.db.selectFrom("approved_answer").select("id").where("answer_key", "=", key).execute()).toEqual([])
  })

  it("a handled error inside TenantDatabase.savepoint rolls back to the savepoint and the scope commits", async () => {
    const kept = await tenant.forCandidate(kofi, (tx) => tenant.savepoint(tx, () => sql`select 1/0`.execute(tx), (error) => (error as { code?: string }).code === "22012"))
    expect(kept).toBe("rolled_back")
  })

  it("an honest Kofi scope sees only Kofi's rows and commits", async () => {
    const values = await tenant.forCandidate(kofi, async (tx) => (await tx.selectFrom("approved_answer").select("value").execute()).map((row) => row.value))
    expect(values).toEqual([`SECRET-${KOFI_KEY}`])
  })
})
