import { type RawBuilder, sql as kyselySql } from "kysely"

/**
 * Repair wave 2 (tenant scope integrity): the raw-SQL tag for code outside
 * src/db. Lint refuses Kysely's own `sql`, `CompiledQuery` and raw nodes
 * outside src/db, so every raw fragment there is built here. It has no `raw`
 * helper, and it refuses, when the fragment is built, any text that names the
 * RLS key or the functions that read or set it: `set_config`,
 * `current_setting`, `eve.<setting>` (quotes stripped, so `"eve"."scope"` is
 * caught) and Unicode-escaped identifiers (`U&"..."`), which could spell them.
 * TenantDatabase's per-statement check is the control; this is the belt.
 */
export class TenantKeyInSqlError extends Error {
  constructor() {
    super("Refused: raw SQL outside src/db may not name the tenant scope (set_config, current_setting, eve.*)")
    this.name = "TenantKeyInSqlError"
  }
}

const TENANT_KEY = /set_config|current_setting|\beve\s*\.|u&/i

function checked(text: string): string {
  if (TENANT_KEY.test(text.replaceAll('"', ""))) throw new TenantKeyInSqlError()
  return text
}

function tag<T = unknown>(fragments: TemplateStringsArray, ...parameters: unknown[]): RawBuilder<T> {
  fragments.forEach(checked)
  return kyselySql<T>(fragments, ...parameters)
}

export const sql = Object.freeze(
  Object.assign(tag, {
    val: <V>(value: V): RawBuilder<V> => kyselySql.val(value),
    lit: <V>(value: V): RawBuilder<V> => kyselySql.lit(typeof value === "string" ? (checked(value) as V) : value),
    ref: <R = unknown>(column: string): RawBuilder<R> => kyselySql.ref<R>(checked(column)),
    table: <T = unknown>(table: string): RawBuilder<T> => kyselySql.table<T>(checked(table)),
    id: <T = unknown>(...ids: readonly string[]): RawBuilder<T> => kyselySql.id<T>(...ids.map(checked)),
    join: <T = unknown>(array: readonly unknown[], separator?: RawBuilder<unknown>): RawBuilder<T> => kyselySql.join<T>(array, separator),
  })
)
