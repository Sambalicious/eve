import { Kysely, PostgresDialect, sql as kyselySql } from "kysely"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { Database } from "../src/db/schema.js"
import { extendedProtocolForScopes, scopedCheckout } from "../src/db/scoped-checkout.js"
import { TenantDatabase, TenantStatementRefusedError } from "../src/db/tenant-database.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"

/**
 * EPIC-0002 A2 run a2c repair wave 2 (F-SEC-14): nothing a Candidate scope does
 * outlives it on the pooled connection. A pool of one connection forces Kofi's
 * scope and Ada's later scope onto the same Postgres session. Ada is the
 * Operator (the owner Candidate); Kofi is a second Candidate.
 */
let database: TestDatabase
let runtime: Kysely<Database>
let tenant: TenantDatabase
let ada: string
let kofi: string

const ADVISORY_KEY = 72_002_014

beforeAll(async () => {
  database = await startMigratedDatabase()
  const pool = new pg.Pool({ connectionString: database.url, max: 1 })
  runtime = new Kysely<Database>({ dialect: new PostgresDialect({ pool: extendedProtocolForScopes(pool) }) })
  tenant = new TenantDatabase(runtime)
  ada = database.operatorId
  kofi = await insertSecondCandidate(database.db, "kofi.wave2@example.test")
})

afterAll(async () => {
  await runtime?.destroy()
  await database?.stop()
})

type SessionView = { pid: number; leak: string; timeout: string; prepared: number; listening: number; advisory: number; temp: number }

/** What Ada's scope sees of the session it runs on. */
const adaView = () =>
  tenant.forCandidate(ada, async (tx) => {
    const { rows } = await kyselySql<SessionView>`select pg_backend_pid() as pid,
      coalesce(current_setting('eve.leak', true), '') as leak,
      current_setting('statement_timeout') as timeout,
      (select count(*)::int from pg_prepared_statements) as prepared,
      (select count(*)::int from pg_listening_channels()) as listening,
      (select count(*)::int from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()) as advisory,
      (select count(*)::int from pg_class where relpersistence = 't') as temp`.execute(tx)
    return rows[0]!
  })

/**
 * Kofi's work on the scope's connection without TenantDatabase's text check:
 * a transaction opened as a scope opens it (claimed checkout, Kofi bound), so
 * the connection reset alone has to clear what it leaves.
 */
const asKofiUnchecked = (work: (trx: Kysely<Database>) => Promise<unknown>) =>
  scopedCheckout(() =>
    runtime.transaction().execute(async (trx) => {
      await kyselySql`select set_config('eve.candidate_id', ${kofi}, true), public.bind_candidate(${kofi}::uuid)`.execute(trx)
      await work(trx)
      return (await kyselySql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid
    })
  )

describe("repair wave 2 (F-SEC-14): Kofi's scope leaves nothing on the pooled connection for Ada's", () => {
  it("each session-level statement is refused inside Kofi's TenantDatabase scope", async () => {
    for (const statement of [
      kyselySql`set statement_timeout = 1`, kyselySql`select set_config('eve.leak', 'kofi', false)`, kyselySql`create temp table kofi_tmp (x int)`,
      kyselySql`prepare kofi_p as select 1`, kyselySql`listen kofi_channel`, kyselySql`select pg_advisory_lock(${ADVISORY_KEY})`,
      kyselySql`do $$ begin perform 1; end $$`, kyselySql`lock table approved_answer`, kyselySql`select 1 into temp kofi_into`,
    ]) {
      await expect(tenant.forCandidate(kofi, (tx) => statement.execute(tx))).rejects.toBeInstanceOf(TenantStatementRefusedError)
    }
    expect(await adaView()).toMatchObject({ leak: "", prepared: 0, listening: 0, advisory: 0, temp: 0 })
  })

  it("session state left on the connection without the text check is gone when Ada's scope runs on the same connection", async () => {
    const before = (await adaView()).timeout
    const kofiPid = await asKofiUnchecked(async (trx) => {
      await kyselySql`select set_config('eve.leak', 'kofi', false)`.execute(trx)
      await kyselySql`select set_config('statement_timeout', '1234', false)`.execute(trx)
      await kyselySql`prepare kofi_p as select 1`.execute(trx)
      await kyselySql`listen kofi_channel`.execute(trx)
      await kyselySql`select pg_advisory_lock(${ADVISORY_KEY})`.execute(trx)
    })
    const view = await adaView()
    expect(view.pid).toBe(kofiPid)
    expect(view).toMatchObject({ leak: "", timeout: before, prepared: 0, listening: 0, advisory: 0, temp: 0 })
  })

  it("the runtime role cannot create a temporary table at all (migration 0023)", async () => {
    await expect(asKofiUnchecked((trx) => kyselySql`create temp table kofi_tmp (x int)`.execute(trx))).rejects.toThrow(/permission denied to create temporary tables/)
    expect((await adaView()).temp).toBe(0)
  })

  it("data statements still work in Kofi's scope on the same pool", async () => {
    const rows = await tenant.forCandidate(kofi, async (tx) => {
      await kyselySql`set local lock_timeout = 1000`.execute(tx)
      await kyselySql`select pg_advisory_xact_lock(${ADVISORY_KEY})`.execute(tx)
      return tx.selectFrom("approved_answer").select("id").execute()
    })
    expect(rows).toEqual([])
  })
})
