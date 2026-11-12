import { type Kysely, type Transaction, sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { Database } from "../src/db/schema.js"
import { backendPid, untilLockWait } from "./support/lock-wait.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"

// The helper behind the "still waiting" assertions (QA-H2-1): it must match only waiters the given holder blocks.
let database: TestDatabase

beforeAll(async () => {
  database = await startMigratedDatabase()
  await database.db.schema.createTable("lock_wait_probe").addColumn("id", "integer", (column) => column.primaryKey()).execute()
  await database.db.insertInto("lock_wait_probe" as never).values([{ id: 1 }, { id: 2 }] as never).execute()
})

afterAll(async () => {
  await database?.stop()
})

/** A transaction holding row `id` FOR UPDATE until `release()`. */
async function holdRow(db: Kysely<Database>, id: number) {
  let release!: () => void
  let done!: Promise<void>
  let pid!: number
  await new Promise<void>((resolve) => {
    done = db.transaction().execute(async (trx) => {
      pid = await backendPid(trx)
      await lockRow(trx, id)
      resolve()
      await new Promise<void>((released) => (release = released))
    })
  })
  return { pid, release: async () => (release(), await done) }
}

const lockRow = (trx: Transaction<Database>, id: number) => sql`select id from lock_wait_probe where id = ${id} for update`.execute(trx)

/** Starts a transaction that blocks on row `id`; resolves when it gets the lock and commits. */
const waitOnRow = (db: Kysely<Database>, id: number) => db.transaction().execute((trx) => lockRow(trx, id).then(() => undefined))

describe("untilLockWait", () => {
  it("resolves once a backend waits on a row lock the holder holds", async () => {
    const holder = await holdRow(database.db, 1)
    let waiter: Promise<void> | undefined
    try {
      waiter = waitOnRow(database.db, 1)
      await expect(untilLockWait(database.db, "the waiter", "row", holder.pid, 5_000)).resolves.toBeUndefined()
    } finally {
      await holder.release()
      await waiter
    }
  })

  it("ignores a waiter blocked by a different holder, and throws when nothing waits on this holder", async () => {
    const unrelated = await holdRow(database.db, 2)
    const holder = await holdRow(database.db, 1)
    let stray: Promise<void> | undefined
    try {
      stray = waitOnRow(database.db, 2)
      // The stray really is waiting: the helper sees it against its own holder.
      await untilLockWait(database.db, "the stray", "row", unrelated.pid, 5_000)
      await expect(untilLockWait(database.db, "the waiter", "row", holder.pid, 500)).rejects.toThrow(`the waiter never waited on a lock (row) held by pid ${holder.pid} within 500 ms`)
    } finally {
      await Promise.all([unrelated.release(), holder.release()])
      await stray
    }
  })

  it("ignores a wait of the other kind on the same holder", async () => {
    const holder = await holdRow(database.db, 1)
    let waiter: Promise<void> | undefined
    try {
      waiter = waitOnRow(database.db, 1)
      await untilLockWait(database.db, "the waiter", "row", holder.pid, 5_000)
      await expect(untilLockWait(database.db, "the waiter", "advisory", holder.pid, 300)).rejects.toThrow(/never waited on a lock \(advisory\)/)
    } finally {
      await holder.release()
      await waiter
    }
  })
})
