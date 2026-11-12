import { randomUUID } from "node:crypto"

import type { Kysely } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { OperatorRebindError, rebindOperatorSub } from "../src/db/operator-rebind.js"
import type { Database } from "../src/db/schema.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { CANDIDATE_SUB } from "./support/test-app.js"

/**
 * EPIC-0002 A1 unit 4 (architecture r2 "CANDIDATE_GOOGLE_SUB retirement"): the
 * host-only `operator:rebind-sub` replaces the ADR 0007 recovery. It runs as the
 * owner DB role; no HTTP route exists.
 */
let database: TestDatabase
let owner: Kysely<Database>

beforeAll(async () => {
  database = await startMigratedDatabase()
  owner = createDatabase(database.ownerUrl)
})

afterAll(async () => {
  await owner?.destroy()
  await database?.stop()
})

beforeEach(async () => {
  await database.db.updateTable("candidate").set({ google_sub: CANDIDATE_SUB }).where("id", "=", database.operatorId).execute()
  await database.db.deleteFrom("dashboard_session").execute()
  await database.db.deleteFrom("candidate").where("role", "=", "candidate").execute()
})

async function operatorSub(): Promise<string | null> {
  return (await database.db.selectFrom("candidate").select("google_sub").where("id", "=", database.operatorId).executeTakeFirstOrThrow()).google_sub
}

async function session(candidateId: string): Promise<void> {
  await database.db.insertInto("dashboard_session").values({ id_hash: randomUUID(), csrf_token: "c", google_sub: "s", last_active_at: new Date(), candidate_id: candidateId }).execute()
}

describe("operator:rebind-sub", () => {
  it("binds the Operator row to the new sub and ends every Operator session", async () => {
    const other = await insertSecondCandidate(database.db)
    await session(database.operatorId)
    await session(other)
    const result = await rebindOperatorSub(owner, " 200000000000000000002 ")
    expect(result).toEqual({ operatorId: database.operatorId, sessionsEnded: 1 })
    expect(await operatorSub()).toBe("200000000000000000002")
    const left = await database.db.selectFrom("dashboard_session").select("candidate_id").execute()
    expect(left).toEqual([{ candidate_id: other }])
  })

  it("refuses a blank or malformed sub and changes nothing", async () => {
    for (const bad of ["", "   ", "a b", "x".repeat(256)]) {
      await expect(rebindOperatorSub(owner, bad)).rejects.toBeInstanceOf(OperatorRebindError)
    }
    expect(await operatorSub()).toBe(CANDIDATE_SUB)
  })

  it("refuses a sub already bound to another Candidate and changes nothing", async () => {
    await insertSecondCandidate(database.db, "taken@example.test")
    await session(database.operatorId)
    await expect(rebindOperatorSub(owner, "synthetic-taken@example.test")).rejects.toThrow(/already bound to another Candidate/)
    expect(await operatorSub()).toBe(CANDIDATE_SUB)
    expect(await database.db.selectFrom("dashboard_session").select("id_hash").execute()).toHaveLength(1)
  })

  it("is a host CLI only: no api source file imports it", async () => {
    const { readFileSync, readdirSync } = await import("node:fs")
    const files = readdirSync("src", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"))
    const hits = files.filter((f) => readFileSync(`src/${f}`, "utf8").includes("operator-rebind")).map((f) => `src/${f}`).sort()
    expect(hits).toEqual(["src/db/operator-rebind.cli.ts", "src/db/operator-rebind.ts"])
  })
})
