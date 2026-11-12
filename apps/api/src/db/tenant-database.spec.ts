import { AliasNode, CompiledQuery, type DatabaseConnection, type Driver, IdentifierNode, Kysely, type KyselyPlugin, PostgresAdapter, PostgresDialect, PostgresIntrospector, PostgresQueryCompiler, type QueryResult, RawNode, SelectQueryNode, SelectionNode, createQueryId, sql } from "kysely"
import { describe, expect, it } from "vitest"

import type { Database } from "./schema.js"
import { extendedProtocolForScopes } from "./scoped-checkout.js"
import { EXECUTOR_MEMBERS, TX_MEMBERS, TenantDatabase, TenantHandleMemberError, TenantScopeTamperedError, TenantStatementRefusedError } from "./tenant-database.js"

/**
 * Repair wave 3 (F-SEC-10), no database: a fake driver answers the scope check
 * with whatever `eve.candidate_id` the last `set_config` statement named.
 */
const OWN = "00000000-0000-4000-8000-000000000001"
const OTHER = "00000000-0000-4000-8000-000000000002"

function fakeDatabase() {
  const statements: string[] = []
  const streamed: string[] = []
  const events: string[] = []
  let candidate = ""
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      statements.push(query.sql)
      if (query.sql.includes("set_config('eve.candidate_id'")) candidate = String(query.parameters[0])
      if (query.sql.includes("current_setting('eve.candidate_id', true)")) return { rows: [{ candidate, scope: "", xact: "700" }] as R[] }
      if (query.sql.includes("pg_current_xact_id()")) return { rows: [{ xact: "700" }] as R[] }
      return { rows: [] }
    },
    // Repair wave 2 (F-QA-12): a streamed statement is recorded like any other, then yields one row.
    streamQuery: async function* <R>(query: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
      statements.push(query.sql)
      streamed.push(query.sql)
      yield { rows: [{ value: "row" }] as R[] }
    },
  }
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => void events.push("begin"),
    commitTransaction: async () => void events.push("commit"),
    rollbackTransaction: async () => void events.push("rollback"),
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  }
  const db = new Kysely<Database>({
    dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => driver, createIntrospector: (k) => new PostgresIntrospector(k), createQueryCompiler: () => new PostgresQueryCompiler() },
  })
  return { tenant: new TenantDatabase(db), statements, streamed, events }
}

/** A member name the type checker and lint cannot read: built at run time. */
const runtimeKey = (...parts: string[]) => parts.join("")
const member = (target: object, key: string) => (target as Record<string, unknown>)[key]
const callMember = (target: object, key: string) => (member(target, key) as () => unknown)()

describe("TenantDatabase: the scoped transaction refuses members outside its allowlist", () => {
  it.each([
    ["withoutPlugins"], ["withPlugin"], ["withPlugins"], ["withPluginAtFront"], ["withSchema"], ["withTables"],
    ["connection"], ["transaction"], ["startTransaction"], ["fn"], ["schema"], ["dynamic"], ["introspection"], ["case"], ["destroy"], ["constructor"], ["__proto__"],
  ])("a call through a non-literal %s throws", async (name) => {
    const { tenant } = fakeDatabase()
    const key = runtimeKey(...name.split(""))
    await expect(tenant.forCandidate(OWN, async (tx) => callMember(tx, key))).rejects.toBeInstanceOf(TenantHandleMemberError)
  })

  it("a computed key on the executor cannot drop the plugins or reach the connection", async () => {
    const { tenant } = fakeDatabase()
    for (const name of ["withoutPlugins", "withConnectionProvider", "provideConnection", "stream"]) {
      await expect(tenant.forCandidate(OWN, async (tx) => callMember(tx.getExecutor(), runtimeKey(name)))).rejects.toBeInstanceOf(TenantHandleMemberError)
    }
    await expect(tenant.forCandidate(OWN, async (tx) => callMember(tx.getExecutor().withPlugins([]), runtimeKey("without", "Plugins")))).rejects.toBeInstanceOf(TenantHandleMemberError)
  })

  it("a query creator from `with` is guarded the same way", async () => {
    const { tenant } = fakeDatabase()
    await expect(tenant.forCandidate(OWN, async (tx) => callMember(tx.with("x", (db) => db.selectNoFrom(sql`1`.as("n"))), runtimeKey("without", "Plugins")))).rejects.toBeInstanceOf(TenantHandleMemberError)
  })

  it("the handle cannot be patched, and reflection sees no members", async () => {
    const { tenant } = fakeDatabase()
    await expect(tenant.forCandidate(OWN, async (tx) => Object.assign(tx, { selectFrom: () => undefined }))).rejects.toBeInstanceOf(TenantHandleMemberError)
    await expect(tenant.forCandidate(OWN, async (tx) => Object.setPrototypeOf(tx, null))).rejects.toThrow()
    expect(await tenant.forCandidate(OWN, async (tx) => Object.getOwnPropertyDescriptor(tx, "selectFrom"))).toBeUndefined()
  })

  it("query builders, raw sql and the executor still work", async () => {
    const { tenant, statements, events } = fakeDatabase()
    await tenant.forCandidate(OWN, async (tx) => {
      await tx.selectFrom("approved_answer").select("value").execute()
      await sql`select 1`.execute(tx)
      await tx.with("x", (db) => db.selectNoFrom(sql`1`.as("n"))).selectFrom("x").selectAll().execute()
    })
    expect(statements.some((text) => /from "approved_answer"/.test(text))).toBe(true)
    expect(events.at(-1)).toBe("commit")
  })

  it("forCandidate binds the transaction to its Candidate (migration 0022)", async () => {
    const { tenant, statements } = fakeDatabase()
    await tenant.forCandidate(OWN, async () => undefined)
    expect(statements[0]).toMatch(/set_config\('eve\.candidate_id', \$1, true\), public\.bind_candidate\(\$2::uuid\)/)
  })
})

describe("TenantDatabase: after a detected change, every later statement and the commit fail", () => {
  it("a caught tamper error does not let later statements, raw sql or the commit through", async () => {
    const { tenant, statements, events } = fakeDatabase()
    const outcomes: string[] = []
    const attempt = tenant.forCandidate(OWN, async (tx) => {
      await sql`select set_config('eve.candidate_id', ${OTHER}, true)`.execute(tx).catch((error: unknown) => outcomes.push((error as Error).name))
      const before = statements.length
      const raw = { sql: "select 1", parameters: [], query: { kind: "RawNode" }, queryId: { queryId: "q" } } as unknown as CompiledQuery
      for (const next of [async (): Promise<unknown> => tx.selectFrom("approved_answer").select("value").execute(), async (): Promise<unknown> => sql`select 1`.execute(tx), async (): Promise<unknown> => tx.getExecutor().executeQuery(raw), async (): Promise<unknown> => tx.executeQuery(raw)]) {
        await Promise.resolve().then(next).catch((error: unknown) => outcomes.push((error as Error).name))
      }
      outcomes.push(`sent:${statements.length - before}`)
    })
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
    expect(outcomes).toEqual(["TenantScopeTamperedError", "TenantScopeTamperedError", "TenantScopeTamperedError", "TenantScopeTamperedError", "TenantScopeTamperedError", "sent:0"])
    expect(events).toEqual(["begin", "rollback"])
  })

  it("setting the key back after a caught error still fails the commit", async () => {
    const { tenant, events } = fakeDatabase()
    const attempt = tenant.forCandidate(OWN, async (tx) => {
      await sql`select set_config('eve.candidate_id', ${OTHER}, true)`.execute(tx).catch(() => undefined)
      await sql`select set_config('eve.candidate_id', ${OWN}, true)`.execute(tx).catch(() => undefined)
    })
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
    expect(events).toEqual(["begin", "rollback"])
  })
})

/**
 * Run a2c, no database: TenantDatabase over the real PostgresDialect and a fake
 * pg pool wrapped as createDatabase wraps it, so the scope's checkout, its text
 * check and its transaction-id check run exactly as in production.
 */
function fakePgDatabase(options: { xactIds?: string[] } = {}) {
  const sent: Array<{ text: string; mode: unknown }> = []
  // Repair wave 2: the pool's reset after release is logged apart from the transaction's statements.
  const resets: string[] = []
  const xactIds = [...(options.xactIds ?? [])]
  let candidate = ""
  const client = {
    processID: 1,
    query(config: unknown, values?: unknown[]): Promise<unknown> {
      const text = typeof config === "string" ? config : String((config as { text: string }).text)
      const parameters = typeof config === "string" ? values : (config as { values?: unknown[] }).values
      if (text === "discard all") return Promise.resolve(void resets.push(text))
      sent.push({ text, mode: typeof config === "string" ? undefined : (config as { queryMode?: unknown }).queryMode })
      if (text.includes("set_config('eve.candidate_id'")) candidate = String(parameters?.[0])
      const xact = () => (xactIds.length > 1 ? xactIds.shift() : (xactIds[0] ?? "700"))
      if (text.includes("current_setting('eve.candidate_id', true)")) return Promise.resolve({ command: "SELECT", rowCount: 1, rows: [{ candidate, scope: "", ...(text.includes("pg_current_xact_id()") ? { xact: xact() } : {}) }] })
      if (text.includes("pg_current_xact_id()")) return Promise.resolve({ command: "SELECT", rowCount: 1, rows: [{ xact: xact() }] })
      return Promise.resolve({ command: "SELECT", rowCount: 0, rows: [] })
    },
    release(): void {},
  }
  const pool = extendedProtocolForScopes({ connect: async () => client, end: async () => undefined })
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: pool as never }) })
  return { tenant: new TenantDatabase(db), sent, resets, texts: () => sent.map((entry) => entry.text) }
}

describe("TenantDatabase (run a2c): a Candidate scope runs one statement at a time in one transaction", () => {
  it("every statement inside the scope is sent through the extended protocol", async () => {
    const { tenant, sent } = fakePgDatabase()
    await tenant.forCandidate(OWN, async (tx) => {
      await sql`select 1`.execute(tx)
      await tx.selectFrom("approved_answer").select("value").execute()
    })
    const inside = sent.filter((entry) => !/^(begin|commit|rollback)$/.test(entry.text))
    expect(inside.length).toBeGreaterThan(0)
    expect(inside.every((entry) => entry.mode === "extended")).toBe(true)
  })

  it.each([["commit"], ["rollback"], ["begin"], ["start transaction"], ["end"], ["savepoint s1"], ["release savepoint s1"], ["prepare transaction 'x'"], ["set transaction read write"], ["set session authorization default"], ["reset all"]])(
    "a scoped raw %j is refused before it is sent, and the scope fails even when the error is caught",
    async (text) => {
      const { tenant, texts } = fakePgDatabase()
      const outcomes: string[] = []
      const attempt = tenant.forCandidate(OWN, async (tx) => {
        await sql`${sql.raw(text)}`.execute(tx).catch((error: unknown) => outcomes.push((error as Error).name))
      })
      await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
      expect(outcomes).toEqual(["TenantStatementRefusedError"])
      // Only the transaction's own begin and rollback reach the connection, never the refused text.
      expect(texts().slice(1, -1)).not.toContain(text)
      expect(texts()[0]).toBe("begin")
      expect(texts().at(-1)).toBe("rollback")
    }
  )

  it("a scoped call containing two statements is refused before it is sent", async () => {
    const { tenant, texts } = fakePgDatabase()
    const attempt = tenant.forCandidate(OWN, (tx) => sql`select 1; select 2`.execute(tx))
    await expect(attempt).rejects.toBeInstanceOf(TenantStatementRefusedError)
    expect(texts()).not.toContain("select 1; select 2")
    expect(texts().at(-1)).toBe("rollback")
  })

  it("an executeQuery with a compiled transaction-control statement (the pg-boss route) is refused too", async () => {
    const { tenant, texts } = fakePgDatabase()
    const compiled = { sql: "commit", parameters: [], query: { kind: "RawNode" }, queryId: { queryId: "pgboss" } } as unknown as CompiledQuery
    await expect(tenant.forCandidate(OWN, (tx) => tx.executeQuery(compiled))).rejects.toBeInstanceOf(TenantStatementRefusedError)
    expect(texts().filter((text) => text === "commit")).toEqual([])
  })

  it("a savepoint through TenantDatabase.savepoint still works and rolls back on a handled error", async () => {
    const { tenant, texts } = fakePgDatabase()
    const kept = await tenant.forCandidate(OWN, (tx) => tenant.savepoint(tx, async () => { throw Object.assign(new Error("fk"), { code: "23503" }) }, (error) => (error as { code?: string }).code === "23503"))
    expect(kept).toBe("rolled_back")
    expect(texts()).toEqual(expect.arrayContaining([expect.stringMatching(/^savepoint /), expect.stringMatching(/^rollback to savepoint /)]))
    expect(texts().at(-1)).toBe("commit")
  })

  it("records pg_current_xact_id() at open; a different id after a statement fails the scope", async () => {
    const { tenant, texts } = fakePgDatabase({ xactIds: ["700", "701"] })
    const attempt = tenant.forCandidate(OWN, async (tx) => {
      await sql`select 1`.execute(tx)
      await sql`select 2`.execute(tx)
    })
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
    expect(texts()).not.toContain("select 2")
    expect(texts().at(-1)).toBe("rollback")
  })

  it("an unchanged transaction id commits", async () => {
    const { tenant, texts } = fakePgDatabase({ xactIds: ["700"] })
    await tenant.forCandidate(OWN, (tx) => sql`select 1`.execute(tx))
    expect(texts().filter((text) => text.includes("pg_current_xact_id()")).length).toBeGreaterThanOrEqual(3)
    expect(texts().at(-1)).toBe("commit")
  })
})

/**
 * Run a2c repair wave 1 (F-SEC-12): nothing reachable from a scoped
 * transaction or its executor is the unchecked transaction or a way to build
 * one. "Unchecked" means an object that hands out a member able to drop the
 * guard or reach the connection.
 */
const ESCAPE_MEMBERS = ["withoutPlugins", "withConnectionProvider", "provideConnection", "connection", "transaction", "startTransaction"]

/** Getters on Kysely's executor, transaction and builder prototypes, which reflection on the instance does not list. */
const PROTOTYPE_GETTERS = ["plugins", "adapter", "isTransaction"]

function exposesUnchecked(value: object): string | undefined {
  for (const name of ESCAPE_MEMBERS) {
    try {
      if (typeof (value as Record<string, unknown>)[name] === "function") return name
    } catch {
      // a guarded handle refuses the read: nothing exposed
    }
  }
  return undefined
}

/** Walks every value reachable by reflection from `start`; returns the paths that expose an unchecked handle. */
function uncheckedPaths(start: unknown, path: string): string[] {
  const found: string[] = []
  const seen = new Set<unknown>()
  const walk = (value: unknown, at: string, depth: number) => {
    if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value) || depth > 6) return
    seen.add(value)
    const escape = exposesUnchecked(value)
    if (escape !== undefined) found.push(`${at}.${escape}`)
    // Own keys, plus the getters Kysely's classes expose on their prototypes.
    let keys: (string | symbol)[] = [...PROTOTYPE_GETTERS]
    try {
      keys = [...Reflect.ownKeys(value), ...keys]
    } catch {
      // keep the getters
    }
    for (const key of keys) {
      let child: unknown
      try {
        child = (value as Record<string | symbol, unknown>)[key]
      } catch {
        continue
      }
      walk(child, `${at}.${String(key)}`, depth + 1)
    }
  }
  walk(start, path, 0)
  return found
}

const noopPlugin: KyselyPlugin = { transformQuery: (args) => args.node, transformResult: async (args) => args.result }
type Tx = Parameters<Parameters<TenantDatabase["forCandidate"]>[1]>[0]
type Executor = ReturnType<Tx["getExecutor"]>
const oneRow = () => sql<{ n: number }>`1`.as("n")

/** How the probe reaches each allowlisted member: the value it reads, or the call it makes. */
const TX_PROBES: Record<string, (tx: Tx) => unknown> = {
  selectFrom: (tx) => tx.selectFrom("approved_answer"),
  selectNoFrom: (tx) => tx.selectNoFrom(oneRow()),
  insertInto: (tx) => tx.insertInto("approved_answer"),
  replaceInto: (tx) => tx.replaceInto("approved_answer"),
  deleteFrom: (tx) => tx.deleteFrom("approved_answer"),
  updateTable: (tx) => tx.updateTable("approved_answer"),
  mergeInto: (tx) => tx.mergeInto("approved_answer"),
  with: (tx) => tx.with("x", (db) => db.selectNoFrom(oneRow())),
  withRecursive: (tx) => tx.withRecursive("x", (db) => db.selectNoFrom(oneRow())),
  getExecutor: (tx) => tx.getExecutor(),
  executeQuery: (tx) => tx.executeQuery(CompiledQuery.raw("select 1")),
  isTransaction: (tx) => tx.isTransaction,
}
const EXECUTOR_PROBES: Record<string, (executor: Executor) => unknown> = {
  adapter: (executor) => executor.adapter,
  transformQuery: (executor) => executor.transformQuery(RawNode.createWithSql("select 1"), createQueryId()),
  compileQuery: (executor) => executor.compileQuery(RawNode.createWithSql("select 1"), createQueryId()),
  executeQuery: (executor) => executor.executeQuery(CompiledQuery.raw("select 1")),
  withPlugins: (executor) => executor.withPlugins([noopPlugin]),
  withPlugin: (executor) => executor.withPlugin(noopPlugin),
  withPluginAtFront: (executor) => executor.withPluginAtFront(noopPlugin),
}

describe("TenantDatabase (repair wave 1, F-SEC-12): no allowlisted member gives back the unchecked transaction", () => {
  it("the probes cover exactly the allowlists", () => {
    expect(Object.keys(TX_PROBES).sort()).toEqual([...TX_MEMBERS].sort())
    expect(Object.keys(EXECUTOR_PROBES).sort()).toEqual([...EXECUTOR_MEMBERS].sort())
  })

  it.each(Object.keys(TX_PROBES))("the transaction's %s exposes nothing unchecked", async (name) => {
    const { tenant } = fakePgDatabase()
    const paths = await tenant.forCandidate(OWN, async (tx) => uncheckedPaths(await TX_PROBES[name]!(tx), `tx.${name}`))
    expect(paths).toEqual([])
  })

  it.each(Object.keys(EXECUTOR_PROBES))("the executor's %s exposes nothing unchecked", async (name) => {
    const { tenant } = fakePgDatabase()
    const paths = await tenant.forCandidate(OWN, async (tx) => uncheckedPaths(await EXECUTOR_PROBES[name]!(tx.getExecutor()), `executor.${name}`))
    expect(paths).toEqual([])
  })

  it("the executor's plugins member is refused", async () => {
    const { tenant } = fakePgDatabase()
    await expect(tenant.forCandidate(OWN, async (tx) => member(tx.getExecutor(), runtimeKey("plug", "ins")))).rejects.toBeInstanceOf(TenantHandleMemberError)
  })
})

/** A plugin that turns every statement into transaction control after the guard's own transformQuery ran. */
const rewriter: KyselyPlugin = {
  transformQuery: (args) => {
    if (RawNode.is(args.node)) return RawNode.createWithSql("commit") as never
    if (SelectQueryNode.is(args.node)) return SelectQueryNode.cloneWithSelections(args.node, [SelectionNode.create(AliasNode.create(RawNode.createWithSql("1; commit; select 1"), IdentifierNode.create("x")))]) as never
    return args.node
  },
  transformResult: async (args) => args.result,
}

describe("TenantDatabase (repair wave 1, F-SEC-12): a plugin-built statement passes the same text check", () => {
  const routes: Array<[string, (tx: Tx) => Promise<unknown>]> = [
    ["raw builder withPlugin", (tx) => sql`select 1`.withPlugin(rewriter).execute(tx)],
    ["query builder withPlugin", (tx) => tx.selectFrom("approved_answer").select("value").withPlugin(rewriter).execute()],
    ["executor withPlugin", (tx) => sql`select 1`.execute({ getExecutor: () => tx.getExecutor().withPlugin(rewriter) })],
    ["executor withPlugins", (tx) => sql`select 1`.execute({ getExecutor: () => tx.getExecutor().withPlugins([rewriter]) })],
    ["executor withPluginAtFront", (tx) => sql`select 1`.execute({ getExecutor: () => tx.getExecutor().withPluginAtFront(rewriter) })],
  ]

  it.each(routes)("%s: refused before it is sent, and the scope fails even when the error is caught", async (_name, route) => {
    const { tenant, texts } = fakePgDatabase()
    const outcomes: string[] = []
    const attempt = tenant.forCandidate(OWN, async (tx) => {
      await route(tx).catch((error: unknown) => outcomes.push((error as Error).name))
    })
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
    expect(outcomes).toEqual(["TenantStatementRefusedError"])
    expect(texts().filter((text) => /commit/.test(text))).toEqual([])
    expect(texts().at(-1)).toBe("rollback")
  })
})

/** A compiled statement as a caller could hand executeQuery (pg-boss's fromKysely route), with any `sql` value. */
const compiledWith = (text: unknown) => ({ sql: text, parameters: [], query: { kind: "RawNode" }, queryId: { queryId: "wave2" } }) as unknown as CompiledQuery

describe("TenantDatabase (repair wave 2, F-SEC-13): a scoped statement's text must be a non-empty string", () => {
  it.each([[undefined], [null], [7], [{ toString: () => "select 1" }], [""]])("sql %j is refused before it is sent, and the scope fails even when the error is caught", async (text) => {
    const { tenant, texts } = fakePgDatabase()
    const outcomes: string[] = []
    const attempt = tenant.forCandidate(OWN, async (tx) => {
      await tx.executeQuery(compiledWith(text)).catch((error: unknown) => outcomes.push((error as Error).name))
      await sql`select 1`.execute(tx).catch((error: unknown) => outcomes.push((error as Error).name))
    })
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
    expect(outcomes).toEqual(["TenantStatementRefusedError", "TenantScopeTamperedError"])
    expect(texts().at(-1)).toBe("rollback")
    expect(texts()).not.toContain("select 1")
  })

  it("the text is read once: a getter that turns into transaction control after the check is never sent", async () => {
    const { tenant, texts } = fakePgDatabase()
    let reads = 0
    const shifty = { parameters: [], query: { kind: "RawNode" }, queryId: { queryId: "shifty" }, get sql() { return reads++ === 0 ? "select 1" : "commit" } } as unknown as CompiledQuery
    await tenant.forCandidate(OWN, (tx) => tx.executeQuery(shifty))
    expect(texts().filter((text) => text === "commit")).toEqual(["commit"])
    expect(texts().at(-1)).toBe("commit")
    expect(texts()).toContain("select 1")
  })
})

describe("TenantDatabase (repair wave 2, F-SEC-14): a Candidate scope sends data statements only", () => {
  it.each([
    ["set statement_timeout = 0"], ["set search_path = public"], ["create temp table t (x int)"], ["prepare p as select 1"], ["listen channel"], ["do $$ begin end $$"],
    ["copy approved_answer to stdout"], ["lock table approved_answer"], ["select pg_advisory_lock(1)"], ["select pg_try_advisory_lock(1)"], ["select set_config('eve.leak', 'x', false)"],
    ["select 1 into temp t"], ["declare c cursor with hold for select 1"], ["discard all"],
  ])("%j is refused before it is sent, and the scope fails even when the error is caught", async (text) => {
    const { tenant, texts } = fakePgDatabase()
    const outcomes: string[] = []
    const attempt = tenant.forCandidate(OWN, async (tx) => {
      await sql`${sql.raw(text)}`.execute(tx).catch((error: unknown) => outcomes.push((error as Error).name))
    })
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
    expect(outcomes).toEqual(["TenantStatementRefusedError"])
    expect(texts()).not.toContain(text)
    expect(texts().at(-1)).toBe("rollback")
  })

  it("data statements, SET LOCAL, transaction advisory locks and TenantDatabase.savepoint still run and commit", async () => {
    const { tenant, texts } = fakePgDatabase()
    await tenant.forCandidate(OWN, async (tx) => {
      await tx.selectFrom("approved_answer").select("value").execute()
      await tx.insertInto("approved_answer").values({ value: "v" } as never).execute()
      await tx.updateTable("approved_answer").set({ value: "w" } as never).execute()
      await tx.deleteFrom("approved_answer").execute()
      await tx.with("x", (db) => db.selectNoFrom(sql`1`.as("n"))).selectFrom("x").selectAll().execute()
      await sql`set local lock_timeout = 1000`.execute(tx)
      await sql`select pg_advisory_xact_lock(1)`.execute(tx)
      await tenant.savepoint(tx, () => sql`select 2`.execute(tx), () => false)
    })
    expect(texts()).toEqual(expect.arrayContaining(["set local lock_timeout = 1000", "select pg_advisory_xact_lock(1)", "select 2"]))
    expect(texts().at(-1)).toBe("commit")
  })

  it("the scope's connection is reset with DISCARD ALL after it goes back to the pool", async () => {
    const { tenant, resets } = fakePgDatabase()
    await tenant.forCandidate(OWN, (tx) => sql`select 1`.execute(tx))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resets).toEqual(["discard all"])
  })
})

describe("TenantDatabase (repair wave 2, F-QA-12): a streamed statement passes the same text check", () => {
  it("a plugin-built multi-statement stream is refused before it is sent, and the scope fails", async () => {
    const { tenant, streamed, events } = fakeDatabase()
    const outcomes: string[] = []
    const attempt = tenant.forCandidate(OWN, async (tx) => {
      try {
        for await (const row of tx.selectFrom("approved_answer").select("value").withPlugin(rewriter).stream()) outcomes.push(String(row))
      } catch (error) {
        outcomes.push((error as Error).name)
      }
    })
    await expect(attempt).rejects.toBeInstanceOf(TenantScopeTamperedError)
    expect(outcomes).toEqual(["TenantStatementRefusedError"])
    expect(streamed).toEqual([])
    expect(events).toEqual(["begin", "rollback"])
  })
})
