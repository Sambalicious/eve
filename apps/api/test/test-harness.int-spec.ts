import { sql } from "kysely"
import { describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { startMigratedDatabase } from "./support/postgres.js"

// The harness itself: per-file databases and orderly teardown (test reliability repair).
describe("test database harness", () => {
  it("gives each caller its own migrated database with production roles", async () => {
    const [a, b] = await Promise.all([startMigratedDatabase(), startMigratedDatabase()])
    try {
      expect(a.roles.database).not.toBe(b.roles.database)
      await a.db.insertInto("candidate_setting").values({ candidate_id: a.operatorId, work_authorization: "x" }).onConflict((oc) => oc.column("candidate_id").doUpdateSet({ work_authorization: "only-in-a" })).execute()
      const inB = await b.db.selectFrom("candidate_setting").select("work_authorization").executeTakeFirstOrThrow()
      expect(inB.work_authorization).toBe("none outside Nigeria")
      const runtime = createDatabase(a.url)
      try {
        const { rows } = await sql<{ rolsuper: boolean; user: string }>`select current_user as user, rolsuper from pg_roles where rolname = current_user`.execute(runtime)
        expect(rows[0]).toEqual({ user: "ja_runtime", rolsuper: false })
      } finally {
        await runtime.destroy()
      }
    } finally {
      await Promise.all([a.stop(), b.stop()])
    }
  })

  it("runs a cluster with room for every parallel file's pools (F-QA-13)", async () => {
    const database = await startMigratedDatabase()
    try {
      const { rows } = await sql<{ max_connections: string }>`show max_connections`.execute(database.db)
      expect(Number(rows[0]!.max_connections)).toBeGreaterThanOrEqual(300)
    } finally {
      await database.stop()
    }
  })

  it("stop() refuses while a pool on the database is still open, so leaks fail loudly", async () => {
    const database = await startMigratedDatabase()
    const leaked = createDatabase(database.url)
    await sql`select 1`.execute(leaked)
    await expect(database.stop()).rejects.toThrow(/being accessed by other users/)
    await leaked.destroy()
    await expect(database.stop()).resolves.toBeUndefined()
  })
})
