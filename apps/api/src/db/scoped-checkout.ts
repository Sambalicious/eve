import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Run a2c invariant 1: every statement inside a TenantDatabase scope goes
 * through Postgres's extended query protocol (Parse/Bind/Execute), which
 * accepts one statement per message. The simple protocol pg uses for a query
 * without parameters runs every statement in the text, so `select 1; commit`
 * would end the scope's transaction mid-scope.
 *
 * TenantDatabase opens each scope inside `scopedCheckout`. The first pool
 * checkout made in that async context is the scope's transaction connection;
 * `extendedProtocolForScopes` marks it, and every query on it is sent in
 * extended mode until it goes back to the pool. Later checkouts in the same
 * context (pg-boss, an unscoped lookup) are not the scope's and stay as they are.
 * When the scope's connection is released it is reset first (repair wave 2).
 */
type Checkout = { claimed: boolean }

const scope = new AsyncLocalStorage<Checkout>()

/** Runs `work` so that the first pool checkout it makes is marked as the scope's. */
export function scopedCheckout<T>(work: (checkout: Readonly<Checkout>) => Promise<T>): Promise<T> {
  const checkout: Checkout = { claimed: false }
  return scope.run(checkout, () => work(checkout))
}

type QueryConfig = { text?: unknown; values?: unknown; submit?: unknown; queryMode?: unknown }
type PoolClient = { query: (...args: unknown[]) => unknown; release: (...args: unknown[]) => unknown; connection?: { parsedStatements?: Record<string, unknown> } }
type Pool = { connect: (...args: unknown[]) => Promise<PoolClient> }

const marked = new WeakSet<object>()
const patched = new WeakSet<object>()

/** The call `query` gets, with the extended protocol forced. A Submittable (cursor) already uses it. */
function extended(args: unknown[]): unknown[] {
  const [config, values, ...rest] = args
  if (typeof config === "string") return [{ text: config, values: Array.isArray(values) ? values : undefined, queryMode: "extended" }, ...(typeof values === "function" ? [values, ...rest] : rest)]
  if (typeof config === "object" && config !== null && typeof (config as QueryConfig).submit !== "function") return [{ ...(config as QueryConfig), queryMode: "extended" }, values, ...rest]
  return args
}

function patchQuery(client: PoolClient): void {
  if (patched.has(client)) return
  patched.add(client)
  const query = client.query
  client.query = function (this: unknown, ...args: unknown[]) {
    return query.apply(this, marked.has(client) ? extended(args) : args)
  }
}

/**
 * Repair wave 2 (F-SEC-14): a scope's connection goes back to the pool only
 * after `DISCARD ALL`, which drops every session setting, temporary object,
 * prepared statement, listener and session advisory lock the scope may have
 * left. Startup-packet settings (statement_timeout) are the session defaults,
 * so they survive it. If the reset fails the client is destroyed instead
 * (`release(error)`), never reused.
 */
async function resetThenRelease(client: PoolClient, release: (...args: unknown[]) => unknown): Promise<void> {
  try {
    await client.query("discard all")
  } catch (error) {
    release.call(client, error instanceof Error ? error : new Error("DISCARD ALL failed"))
    return
  }
  // pg remembers the named statements it parsed; DISCARD ALL removed them from the server.
  if (client.connection?.parsedStatements) client.connection.parsedStatements = {}
  release.call(client)
}

/** Installs the checkout marker on a pg pool (createDatabase calls it on every pool it builds). */
export function extendedProtocolForScopes<P extends object>(pool: P): P {
  const target = pool as unknown as Pool
  const connect = target.connect.bind(target)
  target.connect = async (...args: unknown[]) => {
    const client = await connect(...args)
    const checkout = scope.getStore()
    if (!checkout || checkout.claimed) return client
    checkout.claimed = true
    patchQuery(client)
    marked.add(client)
    const release = client.release
    client.release = (...releaseArgs: unknown[]) => {
      marked.delete(client)
      if (releaseArgs[0] !== undefined) return release.apply(client, releaseArgs)
      void resetThenRelease(client, release)
      return undefined
    }
    return client
  }
  return pool
}
