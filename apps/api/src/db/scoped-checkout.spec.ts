import { describe, expect, it } from "vitest"

import { extendedProtocolForScopes, scopedCheckout } from "./scoped-checkout.js"

/**
 * Run a2c invariant 1, no database: a fake pg pool records what each query
 * call hands the client, so the test sees whether a scope's checkout forces
 * the extended query protocol.
 */
type Sent = { text: unknown; values: unknown; queryMode: unknown }

function fakePool() {
  const sent: Sent[] = []
  const makeClient = () => ({
    query(config: unknown, values?: unknown): Promise<unknown> {
      const record = typeof config === "string" ? { text: config, values, queryMode: undefined } : { ...(config as Record<string, unknown>) }
      // Repair wave 2: the reset on release is covered by its own tests below.
      if (record.text === "discard all") return Promise.resolve({ rows: [] })
      sent.push({ text: record.text, values: record.values, queryMode: record.queryMode })
      return Promise.resolve({ rows: [] })
    },
    release(): void {},
  })
  const idle = [makeClient(), makeClient()]
  const pool = {
    connect: async () => {
      const client = idle.shift() ?? makeClient()
      // pg-pool installs a fresh release function on every checkout.
      client.release = () => void idle.unshift(client)
      return client
    },
  }
  extendedProtocolForScopes(pool as never)
  return { pool: pool as unknown as { connect(): Promise<{ query(text: string, values?: unknown[]): Promise<unknown>; release(): void }> }, sent }
}

describe("scoped checkout: a scope's pooled connection runs every statement through the extended protocol", () => {
  it("a query on the connection a scope checked out is sent in extended mode, with its parameters", async () => {
    const { pool, sent } = fakePool()
    await scopedCheckout(async () => {
      const client = await pool.connect()
      await client.query("select 1")
      await client.query("select $1::int", [2])
      client.release()
    })
    expect(sent).toEqual([
      { text: "select 1", values: undefined, queryMode: "extended" },
      { text: "select $1::int", values: [2], queryMode: "extended" },
    ])
  })

  it("a checkout outside any scope is sent as given", async () => {
    const { pool, sent } = fakePool()
    const client = await pool.connect()
    await client.query("select 1")
    client.release()
    expect(sent).toEqual([{ text: "select 1", values: undefined, queryMode: undefined }])
  })

  it("only the scope's first checkout is claimed; the same client after release is unmarked", async () => {
    const { pool, sent } = fakePool()
    await scopedCheckout(async () => {
      const first = await pool.connect()
      const second = await pool.connect()
      await second.query("select 2")
      second.release()
      first.release()
    })
    const again = await pool.connect()
    await again.query("select 3")
    again.release()
    expect(sent.map((s) => s.queryMode)).toEqual([undefined, undefined])
  })
})

/** Run a2c repair wave 2 (F-SEC-14): nothing a scope left on its connection reaches the next user of the pool. */
function resettingPool(options: { discardFails?: boolean } = {}) {
  const sent: string[] = []
  const released: unknown[] = []
  const makeClient = () => ({
    query(config: unknown): Promise<unknown> {
      const text = typeof config === "string" ? config : String((config as { text: unknown }).text)
      sent.push(text)
      if (text === "discard all" && options.discardFails) return Promise.reject(new Error("connection lost"))
      return Promise.resolve({ rows: [] })
    },
    // pg-pool installs a fresh release function on every checkout.
    release: (error?: unknown): void => void released.push(error),
  })
  const pool = { connect: async () => makeClient() }
  extendedProtocolForScopes(pool as never)
  return { pool: pool as unknown as { connect(): Promise<{ query(text: string): Promise<unknown>; release(error?: unknown): void }> }, sent, released }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("scoped checkout (repair wave 2): a scope's connection is reset before it goes back to the pool", () => {
  it("runs DISCARD ALL on release, then hands the client back", async () => {
    const { pool, sent, released } = resettingPool()
    await scopedCheckout(async () => {
      const client = await pool.connect()
      await client.query("select 1")
      client.release()
    })
    await settle()
    expect(sent).toEqual(["select 1", "discard all"])
    expect(released).toEqual([undefined])
  })

  it("destroys the client when DISCARD ALL fails", async () => {
    const { pool, released } = resettingPool({ discardFails: true })
    await scopedCheckout(async () => (await pool.connect()).release())
    await settle()
    expect(released).toHaveLength(1)
    expect(released[0]).toBeInstanceOf(Error)
  })

  it("a client released with an error is destroyed without a reset", async () => {
    const { pool, sent, released } = resettingPool()
    const failure = new Error("broken")
    await scopedCheckout(async () => (await pool.connect()).release(failure))
    await settle()
    expect(sent).toEqual([])
    expect(released).toEqual([failure])
  })

  it("a checkout outside a scope, or a scope's second checkout, is released as is", async () => {
    const { pool, sent, released } = resettingPool()
    ;(await pool.connect()).release()
    await scopedCheckout(async () => {
      const first = await pool.connect()
      ;(await pool.connect()).release()
      first.release()
    })
    await settle()
    expect(sent).toEqual(["discard all"])
    expect(released).toEqual([undefined, undefined, undefined])
  })
})
