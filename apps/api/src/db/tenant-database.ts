import { Inject, Injectable } from "@nestjs/common"
import { type CompiledQuery, type ConnectionProvider, type DatabaseConnection, type Kysely, type KyselyPlugin, type KyselyProps, type PluginTransformQueryArgs, type PluginTransformResultArgs, type QueryExecutor, type QueryResult, type RootOperationNode, Transaction, type UnknownRow, sql } from "kysely"

import { CandidateScope, assertCandidateId } from "./candidate-scope.js"
import { DATABASE } from "./database-token.js"
import { scopedCheckout } from "./scoped-checkout.js"
import { type RefusedStatement, refusedStatementReason } from "./scoped-statement.js"
import type { Database } from "./schema.js"

declare const candidateTx: unique symbol
declare const sharedTx: unique symbol
declare const installationTx: unique symbol

/**
 * A transaction bound to one Candidate: `eve.candidate_id` set and the
 * transaction recorded by `bind_candidate` (migration 0022), which the RLS
 * policies read. Only `TenantDatabase` makes one.
 */
export type CandidateTx = Transaction<Database> & { readonly [candidateTx]: true }

/** A transaction with `eve.scope = 'shared'` and no Candidate: shared rows only. */
export type SharedTx = Transaction<Database> & { readonly [sharedTx]: true }

/** A transaction with `eve.scope = 'installation'` and no Candidate: installation-only rows (C36) only. */
export type InstallationTx = Transaction<Database> & { readonly [installationTx]: true }

/** A transaction's RLS key no longer holds what TenantDatabase set: the transaction is rolled back and the statement's rows withheld. */
export class TenantScopeTamperedError extends Error {
  constructor() {
    super("Refused: the transaction's tenant scope was changed; the transaction is rolled back")
    this.name = "TenantScopeTamperedError"
  }
}

/**
 * Run a2c invariant 2: a scoped statement that would end, restart, split or
 * re-authorise the scope's transaction, or that holds more than one statement.
 * Repair wave 2: also one whose text is not a non-empty string, or that is not
 * a data statement, or that would leave state on the pooled session.
 * It is never sent, and the scope fails (every later statement and the commit
 * are refused), so a caught refusal cannot be worked around. It is a
 * TenantScopeTamperedError: the scope's failed state, with the reason named.
 */
export class TenantStatementRefusedError extends TenantScopeTamperedError {
  constructor(readonly reason: RefusedStatement) {
    super()
    this.message = `Refused: a scoped statement must be one data statement that leaves nothing on the session (${reason}); the transaction is rolled back`
    this.name = "TenantStatementRefusedError"
  }
}

/**
 * What TenantDatabase set on a transaction: `eve.candidate_id` and `eve.scope`
 * ('' when unset), and for a Candidate scope the transaction's
 * `pg_current_xact_id()` at open (run a2c invariant 3).
 */
type ScopeKey = Readonly<{ candidate: string; scope: string; xact?: string }>

/** The checks a scope runs on its own connection. Text is fixed, so the query plan is cached. */
const READ_KEY = sql<{ candidate: string; scope: string }>`select coalesce(current_setting('eve.candidate_id', true), '') as candidate, coalesce(current_setting('eve.scope', true), '') as scope`
const READ_KEY_AND_XACT = sql<{ candidate: string; scope: string; xact: string }>`select coalesce(current_setting('eve.candidate_id', true), '') as candidate, coalesce(current_setting('eve.scope', true), '') as scope, pg_current_xact_id()::text as xact`
const READ_XACT = sql<{ xact: string }>`select pg_current_xact_id()::text as xact`

/** The transaction's id now: a Candidate scope's transaction already has one, assigned when bind_candidate wrote its row. */
async function currentXact(raw: Transaction<Database>): Promise<string> {
  const { rows } = await READ_XACT.execute(raw)
  const xact = rows[0]?.xact
  if (!xact) throw new TenantScopeTamperedError()
  return xact
}

/**
 * Repair wave 2 (tenant scope integrity): one transaction's guard. After every
 * statement run through the scoped transaction, and once more before commit,
 * it reads both settings on the same connection and compares them with what
 * TenantDatabase set. On a mismatch it throws, so the statement's rows never
 * reach the caller and the transaction rolls back. A caught mismatch still
 * fails the commit (`tampered` stays set).
 *
 * Run a2c: the scope's connection checks the text of every statement before
 * it is sent (invariant 2, `checkedConnection`), and for a Candidate scope
 * the guard also compares the transaction id with the one read at open
 * (invariant 3): a different id means the statement ran in another
 * transaction than the scope's.
 *
 * Repair wave 1 (F-SEC-12): the unchecked transaction is a private field, so
 * nothing reachable from the guard (a plugin in the executor's list) hands it out.
 */
class ScopeGuard implements KyselyPlugin {
  #tampered = false
  readonly #raw: Transaction<Database>
  #expected: ScopeKey

  constructor(raw: Transaction<Database>, expected: ScopeKey) {
    this.#raw = raw
    this.#expected = expected
  }

  /** operatorStepWithin moves the expectation to the Operator and back. */
  expect(key: ScopeKey): void {
    this.#expected = key
  }

  /** Once a change was seen, every later statement is refused before it is compiled (repair wave 3). */
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    this.refuseIfTampered()
    return args.node
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    await this.verify()
    return args.result
  }

  refuseIfTampered(): void {
    if (this.#tampered) throw new TenantScopeTamperedError()
  }

  /** Run a2c invariant 2: refuses, and fails the scope on, a statement text a scope may not send. */
  checkText(text: unknown): void {
    const reason = refusedStatementReason(text)
    if (reason === undefined) return
    this.#tampered = true
    throw new TenantStatementRefusedError(reason)
  }

  async verify(): Promise<void> {
    if (!this.#tampered) {
      const expected = this.#expected
      const { rows } = await (expected.xact === undefined ? READ_KEY : READ_KEY_AND_XACT).execute(this.#raw)
      const actual = rows[0] as { candidate: string; scope: string; xact?: string } | undefined
      if (actual?.candidate === expected.candidate && actual.scope === expected.scope && actual.xact === expected.xact) return
      this.#tampered = true
    }
    throw new TenantScopeTamperedError()
  }
}

/** A scoped transaction was asked for a member outside the guarded handle's allowlist. */
export class TenantHandleMemberError extends Error {
  constructor(member: string) {
    super(`Refused: ${member} is not available on a scoped transaction`)
    this.name = "TenantHandleMemberError"
  }
}

/**
 * Repair wave 3 (F-SEC-10): members a scoped transaction hands out. Anything
 * else (withoutPlugins, withPlugin, withSchema, connection, fn, ...) throws,
 * however its name was spelled, so a key built at run time cannot drop the guard.
 * `with`/`withRecursive` return a query creator, wrapped the same way.
 */
const QUERY_CREATOR_MEMBERS: ReadonlySet<string> = new Set(["selectFrom", "selectNoFrom", "insertInto", "replaceInto", "deleteFrom", "updateTable", "mergeInto", "with", "withRecursive"])
/** `executeQuery` runs a compiled query through the checked executor (pg-boss's `fromKysely` adapter needs it). */
export const TX_MEMBERS: ReadonlySet<string> = new Set([...QUERY_CREATOR_MEMBERS, "getExecutor", "executeQuery", "isTransaction"])
/**
 * What the executor behind `getExecutor` hands out (raw `sql` runs through it).
 * Repair wave 1 (F-SEC-12): not `plugins`, whose list holds the guard; the
 * plugin factories return an executor over the same checked connection.
 */
export const EXECUTOR_MEMBERS: ReadonlySet<string> = new Set(["adapter", "transformQuery", "compileQuery", "executeQuery", "withPlugins", "withPlugin", "withPluginAtFront"])
/** Executor members that return another executor: wrapped the same way. */
const EXECUTOR_FACTORIES: ReadonlySet<string> = new Set(["withPlugins", "withPlugin", "withPluginAtFront"])

type Wrap = (key: string, value: unknown) => unknown

function guardedHandle<T extends object>(target: T, allowed: ReadonlySet<string>, wrap: Wrap): T {
  return new Proxy(target, {
    get(object, key) {
      // Symbols (inspection) and `then` (a thenable check) read as absent, never as a member.
      if (typeof key === "symbol" || key === "then") return undefined
      if (!allowed.has(key)) throw new TenantHandleMemberError(key)
      const value = (object as Record<string, unknown>)[key]
      if (typeof value !== "function") return value
      return (...args: unknown[]) => wrap(key, (value as (...a: unknown[]) => unknown).apply(object, args))
    },
    set(_object, key) {
      throw new TenantHandleMemberError(String(key))
    },
    defineProperty(_object, key) {
      throw new TenantHandleMemberError(String(key))
    },
    deleteProperty(_object, key) {
      throw new TenantHandleMemberError(String(key))
    },
    getOwnPropertyDescriptor() {
      return undefined
    },
    setPrototypeOf() {
      throw new TenantHandleMemberError("prototype")
    },
  })
}

/** Whether the scope already failed, and whether a compiled text may run. */
type Refuser = Readonly<{ refuseIfTampered(): void; checkText(text: unknown): void }>

/**
 * Refuses a compiled statement the scope may not send; a refused text fails
 * the scope. Repair wave 2 (F-SEC-13): `sql` is read once, and anything but a
 * non-empty string is refused. What is sent is a frozen copy holding the text
 * that was checked, so a getter cannot hand the connection different text.
 */
function check(guard: Refuser, compiled: CompiledQuery): CompiledQuery {
  guard.refuseIfTampered()
  const text: unknown = compiled.sql
  guard.checkText(text)
  return Object.freeze({ query: compiled.query, queryId: compiled.queryId, sql: text as string, parameters: Object.freeze([...compiled.parameters]) })
}

/**
 * Repair wave 1 (F-SEC-12): the scope's connection as the checked transaction
 * sees it. Every statement any executor built from the checked transaction
 * sends (its own, a plugin factory's, a builder's or raw builder's
 * `withPlugin`, `executeQuery` with a compiled query) reaches Postgres through
 * here, after every plugin ran, so its final text is what is checked.
 */
function checkedConnection(connection: DatabaseConnection, guard: Refuser): DatabaseConnection {
  return {
    executeQuery: (compiled, options) => connection.executeQuery(check(guard, compiled), options),
    streamQuery: (compiled, chunkSize, options) => connection.streamQuery(check(guard, compiled), chunkSize, options),
    ...(connection.cancelQuery ? { cancelQuery: connection.cancelQuery.bind(connection) } : {}),
    ...(connection.killSession ? { killSession: connection.killSession.bind(connection) } : {}),
    ...(connection.collectSessionInfo ? { collectSessionInfo: connection.collectSessionInfo.bind(connection) } : {}),
  }
}

/** Kysely members a checked transaction never reaches (the allowlist refuses them first); each throws if it ever were. */
const REFUSING = new Proxy(
  {},
  {
    get(_object, key) {
      if (typeof key === "symbol" || key === "then") return undefined
      return () => {
        throw new TenantHandleMemberError(String(key))
      }
    },
  }
)

/**
 * The transaction Candidate code works through: the unchecked transaction's
 * executor over a connection provider that hands out the checked connection,
 * with `guard` as its plugin. It holds no reference to the unchecked
 * transaction, and its driver and dialect refuse every call.
 */
function checkedTransaction(raw: Transaction<Database>, guard: ScopeGuard): Transaction<Database> {
  const rawExecutor = raw.getExecutor()
  const provider: ConnectionProvider = {
    provideConnection: (consumer, options) => rawExecutor.provideConnection((connection) => consumer(checkedConnection(connection, guard)), options),
  }
  const executor: QueryExecutor = rawExecutor.withConnectionProvider(provider).withPlugin(guard)
  return new Transaction<Database>({ config: REFUSING, driver: REFUSING, dialect: REFUSING, executor } as unknown as KyselyProps)
}

function guardedExecutor(executor: object): object {
  return guardedHandle(executor, EXECUTOR_MEMBERS, (key, value) => (EXECUTOR_FACTORIES.has(key) ? guardedExecutor(value as object) : value))
}

function guardedCreator<T extends object>(creator: T, allowed: ReadonlySet<string>): T {
  return guardedHandle(creator, allowed, (key, value) => {
    if (key === "getExecutor") return guardedExecutor(value as object)
    if (key === "with" || key === "withRecursive") return guardedCreator(value as object, QUERY_CREATOR_MEMBERS)
    return value
  })
}

/** The scoped transaction Candidate code gets: only query builders and a guarded executor, over the checked connection. */
function guardedTransaction(raw: Transaction<Database>, guard: ScopeGuard): Transaction<Database> {
  return guardedCreator(checkedTransaction(raw, guard), TX_MEMBERS)
}

/** Guards by scoped transaction: operatorStepWithin finds the raw transaction and the guard behind a SharedTx. */
const guards = new WeakMap<object, ScopeGuard>()
/** Savepoint names only need to be unique within one transaction. */
let savepointCounter = 0
const raws = new WeakMap<object, Transaction<Database>>()

/**
 * The only door from Candidate code to Postgres (architecture r2, Tenancy
 * mechanism 3). Every transaction it opens sets its scope with
 * `set_config(..., true)`, which lasts until commit or rollback, so a pooled
 * connection never carries one Candidate's setting into another's work. A
 * Candidate scope also binds the transaction to its Candidate (migration 0022):
 * the policies read that binding, which no later setting change can move.
 */
@Injectable()
export class TenantDatabase {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /** Runs `work` in a transaction scoped to `candidateId`. */
  async forCandidate<T>(candidateId: string, work: (tx: CandidateTx) => Promise<T>): Promise<T> {
    const id = assertCandidateId(candidateId)
    return this.scoped(sql`select set_config('eve.candidate_id', ${id}, true), public.bind_candidate(${id}::uuid)`, { candidate: id, scope: "" }, (tx) => CandidateScope.run(id, () => work(tx as CandidateTx)))
  }

  /**
   * Shared work only (architecture r2: shared posting extraction and its
   * `ai_call` rows). Never sets `eve.candidate_id`, so no Candidate row is visible.
   */
  forShared<T>(work: (tx: SharedTx) => Promise<T>): Promise<T> {
    return this.scoped(sql`select set_config('eve.scope', 'shared', true)`, { candidate: "", scope: "shared" }, (tx) => work(tx as SharedTx))
  }

  /**
   * Installation-only work (C36, architecture r4 Tenancy 2a): EPIC-0003's access
   * requests, silent drops and their outbox rows. Sets `eve.scope =
   * 'installation'` and never `eve.candidate_id`, so no Candidate or shared row
   * is visible. A lint rule limits callers to the access-request module, the
   * sender's installation outbox and the access-request retention jobs.
   */
  forInstallation<T>(work: (tx: InstallationTx) => Promise<T>): Promise<T> {
    return this.scoped(sql`select set_config('eve.scope', 'installation', true)`, { candidate: "", scope: "installation" }, (tx) => work(tx as InstallationTx))
  }

  /**
   * One Operator-scoped step inside a shared transaction (A1 unit 3: the E4
   * cost-pause email must commit with the pause itself). Sets `eve.candidate_id`
   * to the Operator for `work`, then clears it again, so the rest of the shared
   * transaction still sees no Candidate row. Reads the Operator from the
   * identity table; never takes an ID from the caller.
   */
  async operatorStepWithin<T>(shared: SharedTx, work: (tx: CandidateTx, operatorId: string) => Promise<T>): Promise<T> {
    const operator = await shared.selectFrom("candidate").select("id").where("role", "=", "operator").executeTakeFirst()
    if (!operator) throw new Error("No Operator: the multi-candidate migration has not run")
    const id = assertCandidateId(operator.id)
    const raw = raws.get(shared)
    const guard = guards.get(shared)
    if (!raw || !guard) throw new Error("operatorStepWithin needs a transaction from TenantDatabase.forShared")
    await sql`select set_config('eve.candidate_id', ${id}, true), public.bind_candidate(${id}::uuid)`.execute(raw)
    const step = new ScopeGuard(raw, { candidate: id, scope: "shared", xact: await currentXact(raw) })
    guard.expect({ candidate: id, scope: "shared" })
    // On failure the transaction rolls back and the setting with it; resetting
    // first would fail on an aborted transaction and hide the real error.
    const result = await work(guardedTransaction(raw, step) as CandidateTx, id)
    await step.verify()
    await sql`select set_config('eve.candidate_id', '', true)`.execute(raw)
    guard.expect({ candidate: "", scope: "shared" })
    return result
  }

  /**
   * Opens a transaction, sets its scope with `setScope`, and hands `work` the
   * guarded transaction. The guard checks the scope after every statement and
   * before commit (repair wave 2).
   */
  private scoped<T>(setScope: { execute(db: Transaction<Database>): Promise<unknown> }, key: ScopeKey, work: (tx: Transaction<Database>) => Promise<T>): Promise<T> {
    // The transaction's connection is the scope's first checkout, so every statement on it uses the extended protocol (run a2c).
    return scopedCheckout(() =>
      this.db.transaction().execute(async (raw) => {
        await setScope.execute(raw)
        // Run a2c invariant 3: a Candidate scope records its transaction id once bound; every check compares it.
        const guard = new ScopeGuard(raw, key.candidate === "" ? key : { ...key, xact: await currentXact(raw) })
        const tx = guardedTransaction(raw, guard)
        guards.set(tx, guard)
        raws.set(tx, raw)
        const result = await work(tx)
        await guard.verify()
        return result
      })
    )
  }

  /**
   * Runs `work` inside a savepoint of `tx`'s transaction (run a2c: a scoped
   * statement may not name a savepoint itself). When `work` throws an error
   * `handled` accepts, its changes are rolled back to the savepoint and the
   * scope carries on ("rolled_back"); any other error rolls back to the
   * savepoint and is rethrown. The transaction, and so its id, stays the same.
   */
  async savepoint<T>(tx: CandidateTx | SharedTx | InstallationTx, work: () => Promise<T>, handled: (error: unknown) => boolean): Promise<T | "rolled_back"> {
    const raw = raws.get(tx)
    const guard = guards.get(tx)
    if (!raw || !guard) throw new Error("savepoint needs a transaction from TenantDatabase")
    guard.refuseIfTampered()
    const name = sql.id(`eve_sp_${(savepointCounter = (savepointCounter + 1) % 1_000_000)}`)
    await sql`savepoint ${name}`.execute(raw)
    try {
      const result = await work()
      await sql`release savepoint ${name}`.execute(raw)
      return result
    } catch (error) {
      guard.refuseIfTampered()
      await sql`rollback to savepoint ${name}`.execute(raw)
      await guard.verify()
      if (handled(error)) return "rolled_back"
      throw error
    }
  }

  /**
   * A transaction for the ambient scope's Candidate; throws before any query
   * outside a scope. `work` also gets the ID, so queries name `candidate_id`
   * explicitly (app scoping, which RLS backs up).
   */
  async run<T>(work: (tx: CandidateTx, candidateId: string) => Promise<T>): Promise<T> {
    const candidateId = CandidateScope.require()
    return this.forCandidate(candidateId, (tx) => work(tx, candidateId))
  }

  /**
   * Every Candidate's ID, from the identity table (architecture r2, Tenancy
   * mechanism 5). Cross-Candidate system work (boot recovery, sweeps) reads the
   * IDs here, then does each Candidate's work in its own scope.
   */
  async candidateIds(): Promise<string[]> {
    const rows = await this.db.selectFrom("candidate").select("id").orderBy("id").execute()
    return rows.map((row) => row.id)
  }

  /** Runs `work` once per Candidate, each in that Candidate's scope, one after another. */
  async eachCandidate<T>(work: (candidateId: string) => Promise<T>): Promise<T[]> {
    const results: T[] = []
    for (const id of await this.candidateIds()) results.push(await CandidateScope.run(id, () => work(id)))
    return results
  }

  /**
   * Runs `work` while this process holds the session advisory lock `key`, or
   * returns "locked" at once when another holder has it. The lock is on its own
   * pooled connection and carries no scope, so `work` opens its own scoped
   * transactions. Used by system sweeps that must run one at a time (E4.4).
   */
  async tryWithSessionLock<T>(key: number, work: () => Promise<T>): Promise<T | "locked"> {
    return this.db.connection().execute(async (connection) => {
      const lock = await sql<{ locked: boolean }>`select pg_try_advisory_lock(${key}) as locked`.execute(connection)
      if (!lock.rows[0]?.locked) return "locked" as const
      try {
        return await work()
      } finally {
        await sql`select pg_advisory_unlock(${key})`.execute(connection)
      }
    })
  }

  /** One Candidate's role and state from the identity table (EPIC-0002 A2: CandidateJobRunner's checks). */
  async candidateIdentity(candidateId: string): Promise<{ role: "operator" | "candidate"; state: "active" | "revoked" | "deleting" } | undefined> {
    return this.db.selectFrom("candidate").select(["role", "state"]).where("id", "=", assertCandidateId(candidateId)).executeTakeFirst()
  }

  /** The Operator's ID, from the identity table (Operator-only worker jobs, A1). */
  async operatorId(): Promise<string> {
    const row = await this.db.selectFrom("candidate").select("id").where("role", "=", "operator").executeTakeFirst()
    if (!row) throw new Error("No Operator: the multi-candidate migration has not run")
    return row.id
  }

  /** Runs `work` in the Operator's scope. */
  async asOperator<T>(work: () => Promise<T>): Promise<T> {
    return CandidateScope.run(await this.operatorId(), work)
  }
}
