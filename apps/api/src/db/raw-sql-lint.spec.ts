import { fileURLToPath } from "node:url"

import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * Repair wave 2 (tenant scope integrity): Kysely's raw-SQL helpers and the
 * executor routes that skip TenantDatabase's scope check are for src/db only
 * (rule tenant/no-raw-sql, eslint.tenant-rules.js). Each probe is linted as if
 * it were the named source file.
 */
const API_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const eslint = new ESLint({ cwd: API_ROOT })
const OUTSIDE = "src/discovery/probe.ts"
const RULE = "tenant/no-raw-sql"

async function ruleMessages(code: string, file = OUTSIDE): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${API_ROOT}${file}` })
  return result!.messages.filter((message) => message.ruleId === RULE).map((message) => message.message)
}

const REFUSED: Record<string, string> = {
  "sql from kysely": `import { sql } from "kysely"\nexport const q = sql\`select 1\`\n`,
  "sql under an alias": `import { sql as s } from "kysely"\nexport const q = s\`select 1\`\n`,
  "sql by string name": `import { "sql" as s } from "kysely"\nexport const q = s\n`,
  "CompiledQuery": `import { CompiledQuery } from "kysely"\nexport const q = CompiledQuery.raw("select 1")\n`,
  "RawNode": `import { RawNode } from "kysely"\nexport const n = RawNode\n`,
  "createRawBuilder": `import { createRawBuilder } from "kysely"\nexport const b = createRawBuilder\n`,
  "a connection provider": `import { SingleConnectionProvider } from "kysely"\nexport const p = SingleConnectionProvider\n`,
  "namespace import": `import * as k from "kysely"\nexport const q = k.sql\n`,
  "default import": `import k from "kysely"\nexport const q = k\n`,
  "re-export of sql": `export { sql } from "kysely"\n`,
  "export * from kysely": `export * from "kysely"\n`,
  "dynamic import of kysely": `export const f = () => import("kysely")\n`,
  "import = require": `import k = require("kysely")\nexport const q = k\n`,
  "withoutPlugins": `import type { CandidateTx } from "../db/tenant-database.js"\nexport const f = (tx: CandidateTx) => tx.withoutPlugins()\n`,
  "withoutPlugins by literal key": `import type { CandidateTx } from "../db/tenant-database.js"\nexport const f = (tx: CandidateTx) => tx["withoutPlugins"]()\n`,
  "getExecutor": `import type { CandidateTx } from "../db/tenant-database.js"\nexport const f = (tx: CandidateTx) => tx.getExecutor()\n`,
  "executeQuery": `import type { CandidateTx } from "../db/tenant-database.js"\nexport const f = (tx: CandidateTx) => tx.executeQuery({} as never)\n`,
  "withPlugin": `import type { CandidateTx } from "../db/tenant-database.js"\nexport const f = (tx: CandidateTx) => tx.withPlugin({} as never)\n`,
  "destructured executeQuery": `import type { CandidateTx } from "../db/tenant-database.js"\nexport const f = (tx: CandidateTx) => { const { executeQuery } = tx; return executeQuery }\n`,
  "stream": `import type { CandidateTx } from "../db/tenant-database.js"\nexport const f = (tx: CandidateTx) => tx.selectFrom("candidate").selectAll().stream()\n`,
  "eb.fn by name": `import type { CandidateTx } from "../db/tenant-database.js"\nexport const f = (tx: CandidateTx) => tx.selectFrom("candidate").select((eb) => eb.fn("set_config", []).as("x"))\n`,
  "fn.agg by name": `import type { CandidateTx } from "../db/tenant-database.js"\nexport const f = (tx: CandidateTx) => tx.selectFrom("candidate").select((eb) => eb.fn.agg("x", []).as("x"))\n`,
}

const ACCEPTED: Record<string, string> = {
  "type imports": `import type { Kysely, Selectable, Transaction } from "kysely"\nexport type A = Kysely<never> | Selectable<never> | Transaction<never>\n`,
  "inline type import": `import { type RawBuilder } from "kysely"\nexport type R = RawBuilder<number>\n`,
  "sql from src/db/sql.js": `import { sql } from "../db/sql.js"\nexport const q = sql\`select 1\`\n`,
  "eb.fn.coalesce": `import type { CandidateTx } from "../db/tenant-database.js"\nexport const f = (tx: CandidateTx) => tx.selectFrom("candidate").select((eb) => eb.fn.coalesce("id", "id").as("x"))\n`,
  "kysely/migration types": `import type { Migration } from "kysely/migration"\nexport type M = Migration\n`,
}

describe("tenant/no-raw-sql: raw SQL and executor routes only in src/db (repair wave 2)", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await eslint.lintText("export const warmUp = 1\n", { filePath: `${API_ROOT}src/db/warm-up.ts` })
  }, 120_000)

  it.each(Object.entries(REFUSED))("refuses %s outside src/db", async (_name, code) => {
    expect((await ruleMessages(code)).length).toBeGreaterThan(0)
  })

  it.each(Object.entries(ACCEPTED))("accepts %s outside src/db", async (_name, code) => {
    expect(await ruleMessages(code)).toEqual([])
  })

  it("does not apply in src/db", async () => {
    expect(await ruleMessages(REFUSED["sql from kysely"]!, "src/db/probe.ts")).toEqual([])
    expect(await ruleMessages(REFUSED["withoutPlugins"]!, "src/db/probe.ts")).toEqual([])
  })
})
