import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/schema.js"
import { BrowserMutex } from "./browser-mutex.js"

/**
 * Slice 8e (8e.10, SEC-8D-07, D8e-4): which error reaches the caller of
 * withLock when the lease wait or the timeout RESET fails. A fake driver
 * records every statement and fails the ones named in `failing`; no database.
 */
function fakeDatabase(failing: Readonly<Record<string, Error>>) {
  const statements: string[] = []
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      statements.push(query.sql)
      for (const [fragment, error] of Object.entries(failing)) if (query.sql.includes(fragment)) throw error
      return { rows: [] }
    },
    // eslint-disable-next-line require-yield -- never streamed
    streamQuery: async function* () {
      throw new Error("not used")
    },
  }
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  }
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
  return { db, statements }
}

const lockError = new Error("simulated lock failure")
const resetError = new Error("simulated RESET failure")
const terminated = (statements: readonly string[]) => statements.some((statement) => statement.includes("pg_terminate_backend"))

describe("BrowserMutex.withLock error precedence (8e.10, SEC-8D-07)", () => {
  it("lock fails and RESET succeeds: the lock error reaches the caller and the session is kept", async () => {
    const { db, statements } = fakeDatabase({ pg_advisory_lock: lockError })
    const work = vi.fn(async () => "never")
    await expect(new BrowserMutex(db).withLock(work)).rejects.toBe(lockError)
    expect(work).not.toHaveBeenCalled()
    expect(statements.some((statement) => statement.includes("reset statement_timeout"))).toBe(true)
    expect(terminated(statements)).toBe(false)
  })

  it("lock fails and RESET fails: the lock error reaches the caller and the session is still ended (CR8D-06)", async () => {
    const { db, statements } = fakeDatabase({ pg_advisory_lock: lockError, "reset statement_timeout": resetError })
    const work = vi.fn(async () => "never")
    await expect(new BrowserMutex(db).withLock(work)).rejects.toBe(lockError)
    expect(work).not.toHaveBeenCalled()
    expect(terminated(statements)).toBe(true)
  })

  it("lock succeeds and RESET fails: the RESET error reaches the caller, the session is ended and work never runs", async () => {
    const { db, statements } = fakeDatabase({ "reset statement_timeout": resetError })
    const work = vi.fn(async () => "never")
    await expect(new BrowserMutex(db).withLock(work)).rejects.toBe(resetError)
    expect(work).not.toHaveBeenCalled()
    expect(terminated(statements)).toBe(true)
  })

  it("lock and RESET succeed: work runs and the lock is released", async () => {
    const { db, statements } = fakeDatabase({})
    expect(await new BrowserMutex(db).withLock(async () => "done")).toBe("done")
    expect(statements.some((statement) => statement.includes("pg_advisory_unlock"))).toBe(true)
  })
})
