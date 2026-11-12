import { fileURLToPath } from "node:url"

import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * EPIC-0002 A2 (architecture r1/r4 Tenancy mechanism 3 and Worker job scoping;
 * gap G3): Candidate code cannot import the raw database or the shared queue
 * (pg-boss), and only JobQueue and CandidateJobRunner touch pg-boss's raw
 * instance, so CandidateJobRunner is the only way to register a Candidate
 * handler. Each probe is linted as if it were the named source file.
 */
const API_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const eslint = new ESLint({ cwd: API_ROOT })
const RAW_DATABASE = `import { DATABASE } from "../db/database.module.js"\nexport const handle = DATABASE\n`
const PG_BOSS = `import { PgBoss } from "pg-boss"\nexport const make = () => new PgBoss("postgres://x")\n`
const RAW_BOSS = `import type { JobQueue } from "./job-queue.js"\nexport const register = (queue: JobQueue) => queue.rawBoss.work("q", async () => undefined)\n`

/** F-SEC-02: syntax variants that reached the queue or the raw database past the static rules. */
const BYPASSES: Record<string, string> = {
  "rawBoss destructuring": `import type { JobQueue } from "./job-queue.js"\nexport const f = (q: JobQueue) => { const { rawBoss } = q; return rawBoss }\n`,
  "rawBoss bracket access": `import type { JobQueue } from "./job-queue.js"\nexport const f = (q: JobQueue) => q["rawBoss"]\n`,
  "rawBoss template bracket access": "import type { JobQueue } from \"./job-queue.js\"\nexport const f = (q: JobQueue) => q[`rawBoss`]\n",
  "dynamic import of pg-boss": `export const f = async () => import("pg-boss")\n`,
  "dynamic import of the raw database": `export const f = async () => import("../db/database.module.js")\n`,
  "dynamic import of create-database": `export const f = async () => import("../db/create-database.js")\n`,
  "dynamic import with a computed source": `const name = "pg-" + "boss"\nexport const f = async () => import(name)\n`,
}

/**
 * F-SEC-02 recheck (probes g, k) and F-SEC-05: module loaders that reach pg-boss
 * or the raw database without an import statement. `Reflect.get(q, "rawBoss")`
 * and `q[k]` (probes e, f) are closed structurally: pg-boss is a #private field
 * (job-queue.spec.ts, "no property access reaches it").
 */
const LOADER_BYPASSES: Record<string, string> = {
  "createRequire of pg-boss (g)": `import { createRequire } from "node:module"\nexport const f = () => createRequire(import.meta.url)("pg-boss")\n`,
  "createRequire of the raw database (k)": `import { createRequire } from "node:module"\nexport const f = () => createRequire(import.meta.url)("../db/database.module.js")\n`,
  "createRequire from bare module": `import { createRequire } from "module"\nexport const f = () => createRequire(import.meta.url)("pg-boss")\n`,
  "default import of node:module": `import Module from "node:module"\nexport const f = () => Module.createRequire(import.meta.url)("pg-boss")\n`,
  "namespace import of node:module": `import * as Module from "node:module"\nexport const f = () => Module.createRequire(import.meta.url)("pg-boss")\n`,
  "re-export of node:module": `export { createRequire } from "node:module"\n`,
  "process.getBuiltinModule": `export const f = () => (process.getBuiltinModule("node:module") as typeof import("node:module")).createRequire(import.meta.url)("pg-boss")\n`,
  "global require": `declare const require: (id: string) => unknown\nexport const f = () => require("pg-boss")\n`,
  "claimCandidateWorker import": `import { claimCandidateWorker } from "./job-queue.js"\nexport const steal = claimCandidateWorker()\n`,
  "claimCandidateWorker import by path": `import { claimCandidateWorker } from "../worker/job-queue.js"\nexport const steal = claimCandidateWorker()\n`,
}
const LOADER_MESSAGE = /module loader|CandidateJobRunner claims|static import/

async function messages(code: string, file: string, pattern: RegExp): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${API_ROOT}${file}` })
  return result!.messages.filter((message) => pattern.test(message.message)).map((message) => message.message)
}

describe("job queue and raw database lint rules (A2, gap G3)", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await eslint.lintText("export const warmUp = 1\n", { filePath: `${API_ROOT}src/db/warm-up.ts` })
  }, 120_000)

  it.each(["src/discovery/posting-evaluator.ts", "src/worker/discovery-jobs.ts", "src/stack-posts/stack-posts.repository.ts", "src/me/me.controller.ts"])("raw database import fails in %s", async (file) => {
    expect(await messages(RAW_DATABASE, file, /must not use the raw database/)).toHaveLength(1)
  })

  it.each(["src/discovery/posting-evaluator.ts", "src/worker/discovery-jobs.ts", "src/worker/submission-jobs.ts", "src/stack-posts/stack-posts.reader.ts", "src/records/records.service.ts"])("pg-boss import fails in %s", async (file) => {
    expect(await messages(PG_BOSS, file, /shared queue/)).toHaveLength(1)
  })

  it.each(["src/worker/job-queue.ts", "src/worker/candidate-job-runner.ts", "src/submission/sample-submission-queue.ts", "src/discovery/evaluation-queue.ts", "src/db/job-queue-schema.ts"])("pg-boss import passes in %s", async (file) => {
    expect(await messages(PG_BOSS, file, /shared queue/)).toEqual([])
  })

  it.each(["src/worker/discovery-jobs.ts", "src/worker/submission-jobs.ts", "src/worker/notification-jobs.ts", "src/stack-posts/stack-posts.reader.ts", "src/discovery/discovery.service.ts", "src/discovery/evaluation-queue.ts"])("rawBoss use fails in %s", async (file) => {
    expect(await messages(RAW_BOSS, file, /CandidateJobRunner/)).toHaveLength(1)
  })

  it.each(["src/worker/job-queue.ts", "src/worker/candidate-job-runner.ts"])("rawBoss use passes in %s", async (file) => {
    expect(await messages(RAW_BOSS, file, /CandidateJobRunner/)).toEqual([])
  })

  it.each(Object.keys(BYPASSES).flatMap((probe) => ["src/worker/discovery-jobs.ts", "src/stack-posts/stack-posts.reader.ts", "src/access-request/access-request.service.ts"].map((file) => [probe, file] as const)))("%s fails in %s (F-SEC-02)", async (probe, file) => {
    expect(await messages(BYPASSES[probe]!, file, /CandidateJobRunner|static import/)).toHaveLength(1)
  })

  it.each(["src/worker/job-queue.ts", "src/worker/candidate-job-runner.ts"])("rawBoss destructuring and bracket access pass in %s", async (file) => {
    expect(await messages(BYPASSES["rawBoss destructuring"]!, file, /CandidateJobRunner/)).toEqual([])
    expect(await messages(BYPASSES["rawBoss bracket access"]!, file, /CandidateJobRunner/)).toEqual([])
  })

  it.each(
    Object.keys(LOADER_BYPASSES).flatMap((probe) =>
      ["src/worker/discovery-jobs.ts", "src/discovery/posting-evaluator.ts", "src/stack-posts/stack-posts.reader.ts", "src/access-request/access-request.service.ts", "src/auth/auth.service.ts", "src/submission/sample-submission-queue.ts", "src/main.worker.ts", "src/worker/worker.module.ts"].map((file) => [probe, file] as const)
    )
  )("%s fails in %s (F-SEC-02 recheck)", async (probe, file) => {
    expect((await messages(LOADER_BYPASSES[probe]!, file, LOADER_MESSAGE)).length).toBeGreaterThanOrEqual(1)
  })

  it("node:module and claimCandidateWorker pass where they belong", async () => {
    expect(await messages(LOADER_BYPASSES["claimCandidateWorker import"]!, "src/worker/candidate-job-runner.ts", LOADER_MESSAGE)).toEqual([])
    expect(await messages(LOADER_BYPASSES["createRequire of pg-boss (g)"]!, "src/db/job-queue-schema.ts", LOADER_MESSAGE)).toEqual([])
  })
})

/**
 * F-SEC-02 round 2 (recheck-F-SEC-02.r2.md) and F-SEC-07 (security-review.r2.md):
 * string execution, computed loader keys on the global objects, and every way to
 * alias `claimCandidateWorker` that the reports named, plus their near variants.
 * Each must produce a lint error, not a parse error.
 */
const STRING_EXECUTION: Record<string, string> = {
  "new Function returning import('pg-boss')": `export const f = () => new Function("return import('pg-boss')")()\n`,
  "Function call": `export const f = () => Function("return import('pg-boss')")()\n`,
  "Function alias": `const F = Function\nexport const f = () => F("return import('pg-boss')")()\n`,
  eval: `export const f = () => eval("import('pg-boss')")\n`,
  "indirect eval": `export const f = () => (0, eval)("import('pg-boss')")\n`,
  "globalThis.eval": `export const f = () => globalThis.eval("import('pg-boss')")\n`,
  "setTimeout with a string": `export const f = () => setTimeout("import('pg-boss')", 1)\n`,
  "node:vm runInThisContext": `import vm from "node:vm"\nexport const f = () => vm.runInThisContext("import('pg-boss')")\n`,
  "vm named import": `import { runInThisContext } from "vm"\nexport const f = () => runInThisContext("import('pg-boss')")\n`,
  "vm re-export": `export { Script } from "node:vm"\n`,
  "AsyncFunction constructor call": `export const f = () => (async () => undefined).constructor("return import('pg-boss')")()\n`,
  "AsyncFunction constructor alias": `const AsyncFn = (async () => undefined).constructor\nexport const f = () => new AsyncFn("return import('pg-boss')")\n`,
  "constructor by literal bracket": `export const f = () => (async () => undefined)["constructor"]("return import('pg-boss')")()\n`,
  "constructor destructuring": `const { constructor: AsyncFn } = async () => undefined\nexport const f = () => AsyncFn("return 1")\n`,
  "dynamic import with a template expression": "const part = \"boss\"\nexport const f = () => import(`pg-${part}`)\n",
  "import-equals require": `import jq = require("./job-queue.js")\nexport const f = () => jq\n`,
}
const COMPUTED_GLOBALS: Record<string, string> = {
  "process computed key (F-SEC-07)": `export const f = () => process["getBuiltin" + "Module"]("module")\n`,
  "globalThis computed key (F-SEC-07)": `export const f = () => globalThis["req" + "uire"]\n`,
  "global computed key": `declare const global: Record<string, unknown>\nexport const f = (k: string) => global[k]\n`,
  "module computed key": `declare const module: Record<string, unknown>\nexport const f = (k: string) => module[k]\n`,
  "process template key": "const part = \"Module\"\nexport const f = () => process[`getBuiltin${part}`]\n",
  "process key in a variable": `const key = "getBuiltinModule"\nexport const f = () => process[key]\n`,
  "globalThis.process computed key": `export const f = () => globalThis.process["getBuiltin" + "Module"]\n`,
  "cast process computed key": `export const f = (k: string) => (process as unknown as Record<string, unknown>)[k]\n`,
  "process alias": `const p = process\nexport const f = (k: string) => (p as unknown as Record<string, unknown>)[k]\n`,
  "globalThis alias by assignment": `let g: unknown\ng = globalThis\nexport const f = () => g\n`,
  "process destructuring": `const { getBuiltinModule: load } = process\nexport const f = () => load("module")\n`,
  "Reflect.get on process": `export const f = () => Reflect.get(process, "getBuiltin" + "Module")\n`,
  "property descriptor of globalThis": `export const f = (k: string) => Object.getOwnPropertyDescriptor(globalThis, k)\n`,
  "process spread": `export const f = () => ({ ...process })\n`,
}
const CLAIM_ALIASES: Record<string, string> = {
  "namespace destructuring (F-SEC-07)": `import * as jq from "./job-queue.js"\nexport const { claimCandidateWorker: c } = jq\n`,
  "namespace Reflect.get": `import * as jq from "./job-queue.js"\nexport const c = Reflect.get(jq, "claimCandidateWorker")\n`,
  "namespace computed key": `import * as jq from "./job-queue.js"\nexport const c = (jq as Record<string, unknown>)["claim" + "CandidateWorker"]\n`,
  "namespace Object.values": `import * as jq from "../worker/job-queue.js"\nexport const all = Object.values(jq)\n`,
  "renamed import": `import { claimCandidateWorker as c } from "./job-queue.js"\nexport const steal = c()\n`,
  "string-named import": `import { "claimCandidateWorker" as c } from "./job-queue.js"\nexport const steal = c()\n`,
  "export star": `export * from "./job-queue.js"\n`,
  "export star as namespace": `export * as jq from "../worker/job-queue.js"\n`,
  "string-named re-export": `export { "claimCandidateWorker" as c } from "./job-queue.js"\n`,
}
const BYPASS_RULES = new Set(["no-restricted-syntax", "no-restricted-globals", "no-eval", "no-implied-eval", "no-new-func"])
const SOURCE_FILES = ["src/worker/discovery-jobs.ts", "src/discovery/posting-evaluator.ts", "src/stack-posts/stack-posts.reader.ts", "src/access-request/access-request.service.ts", "src/auth/auth.service.ts", "src/submission/sample-submission-queue.ts", "src/discovery/evaluation-queue.ts", "src/main.worker.ts", "src/worker/worker.module.ts", "src/db/job-queue-schema.ts"]

async function ruleErrors(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${API_ROOT}${file}` })
  const fatal = result!.messages.filter((message) => message.fatal)
  if (fatal.length > 0) throw new Error(`Probe does not parse: ${fatal[0]!.message}`)
  return result!.messages.filter((message) => message.severity === 2 && BYPASS_RULES.has(message.ruleId ?? "")).map((message) => `${message.ruleId}: ${message.message}`)
}

const cases = (probes: Record<string, string>, files: string[]) => Object.keys(probes).flatMap((probe) => files.map((file) => [probe, file] as const))

describe("string execution, computed global keys and claim aliasing fail lint (F-SEC-02 r2, F-SEC-07)", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await eslint.lintText("export const warmUp = 1\n", { filePath: `${API_ROOT}src/db/warm-up.ts` })
  }, 120_000)

  it.each(cases(STRING_EXECUTION, [...SOURCE_FILES, "src/worker/job-queue.ts", "src/worker/candidate-job-runner.ts"]))("%s fails in %s", async (probe, file) => {
    expect((await ruleErrors(STRING_EXECUTION[probe]!, file)).length).toBeGreaterThanOrEqual(1)
  })

  it.each(cases(COMPUTED_GLOBALS, [...SOURCE_FILES, "src/worker/job-queue.ts", "src/worker/candidate-job-runner.ts"]))("%s fails in %s", async (probe, file) => {
    expect((await ruleErrors(COMPUTED_GLOBALS[probe]!, file)).length).toBeGreaterThanOrEqual(1)
  })

  it.each(cases(CLAIM_ALIASES, SOURCE_FILES))("claimCandidateWorker %s fails in %s", async (probe, file) => {
    expect((await ruleErrors(CLAIM_ALIASES[probe]!, file)).length).toBeGreaterThanOrEqual(1)
  })

  it("dot access on process and the claim's one legitimate import still pass", async () => {
    expect(await ruleErrors(`export const url = process.env.DATABASE_URL\nexport const out = () => process.stdout.write("x")\n`, "src/worker/discovery-jobs.ts")).toEqual([])
    expect(await ruleErrors(`export const name = (error: Error) => error.constructor.name\n`, "src/stack-posts/stack-posts-reader.ts")).toEqual([])
    expect(await ruleErrors(`import { claimCandidateWorker } from "./job-queue.js"\nexport const registration = claimCandidateWorker()\n`, "src/worker/candidate-job-runner.ts")).toEqual([])
    expect(await ruleErrors(`export const f = () => import("./migrations/index.js")\n`, "src/db/migrator.ts")).toEqual([])
  })
})

/**
 * F-SEC-09 (security-review.md, run epic-0002-a2b): routes that passed lint on
 * 2844c15 and ran under Node 26, plus their near variants. Each must give a
 * lint error in every src file outside specs, src/db included.
 */
const MEMBER_ROUTES: Record<string, string> = {
  "new globalThis.Function": `export const f = () => new globalThis.Function("return import('pg-boss')")()\n`,
  "indirect globalThis.Function": `export const f = () => (0, globalThis.Function)("return import('pg-boss')")()\n`,
  "global.Function": `export const f = () => new global.Function("return import('pg-boss')")()\n`,
  "globalThis.globalThis.Function": `export const f = () => new globalThis.globalThis.Function("return 1")()\n`,
  "globalThis Function by literal key": `export const f = () => new (globalThis as { Function: FunctionConstructor })["Function"]("return 1")()\n`,
  "Function destructured from a member": `const { Function: F } = globalThis.globalThis\nexport const f = () => F("return 1")\n`,
  "AsyncFunction member": `declare const lib: { AsyncFunction: FunctionConstructor }\nexport const f = () => new lib.AsyncFunction("return 1")\n`,
  "Reflect.get on globalThis.process": `export const f = () => Reflect.get(globalThis.process, "getBuiltin" + "Module")\n`,
  "Reflect.apply": `export const f = (g: () => unknown) => Reflect.apply(g, undefined, [])\n`,
  "Reflect.getOwnPropertyDescriptor": `export const f = () => Reflect.getOwnPropertyDescriptor(globalThis.process, "getBuiltin" + "Module")\n`,
  "Reflect alias": `const R = Reflect\nexport const f = () => R\n`,
  "globalThis.Reflect": `export const f = () => globalThis.Reflect.get(globalThis.process, "x")\n`,
  "descriptor route to AsyncFunction": `export const f = () => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(async function () {}), "constru" + "ctor")!.value("return 1")\n`,
  "getOwnPropertyDescriptors": `export const f = () => Object.getOwnPropertyDescriptors(Object.getPrototypeOf(async () => undefined))\n`,
  "getOwnPropertyNames of a prototype": `export const f = () => Object.getOwnPropertyNames(Object.getPrototypeOf(async () => undefined))\n`,
  "__proto__ route": `export const f = () => (async () => undefined).__proto__\n`,
  "concatenated computed key": `export const f = (fn: () => void) => (fn as unknown as Record<string, () => unknown>)["constru" + "ctor"]\n`,
  "template computed key": "const part = \"ructor\"\nexport const f = (fn: () => void) => (fn as unknown as Record<string, unknown>)[`const${part}`]\n",
  "computed key on a function literal": `const key = "constructor"\nexport const f = () => (async () => undefined)[key as "name"]\n`,
  "Object member by variable key": `const k = "getPrototype" + "Of"\nexport const f = () => (Object as unknown as Record<string, (x: unknown) => unknown>)[k as "name"]\n`,
  "Object member by identifier key": `declare const k: "keys"\nexport const f = () => Object[k]\n`,
  "Object alias": `const O = Object\nexport const f = (k: "keys") => O[k]\n`,
  "computed destructuring key": `const { ["constru" + "ctor"]: AsyncFn } = async () => undefined\nexport const f = () => AsyncFn\n`,
}
const TENANT_KEY_ROUTES: Record<string, string> = {
  "set_config of eve.candidate_id": "import { sql } from \"kysely\"\nexport const q = (other: string) => sql`select set_config('eve.candidate_id', ${other}, true)`\n",
  "set_config of eve.scope": "import { sql } from \"kysely\"\nexport const q = sql`select set_config('eve.scope', 'installation', true)`\n",
  "SET LOCAL eve.candidate_id": `import { sql } from "kysely"\nexport const q = sql.raw("set local eve.candidate_id = 'x'")\n`,
  "eve.candidate_id in a string": `export const key = "eve.candidate_id"\n`,
  "set_config in a string": `export const fn = 'set_config'\n`,
}
const NON_DB_FILES = SOURCE_FILES.filter((file) => !file.startsWith("src/db/"))

describe("Function members, Reflect, the descriptor route and the tenant key fail lint (F-SEC-09)", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await eslint.lintText("export const warmUp = 1\n", { filePath: `${API_ROOT}src/db/warm-up.ts` })
  }, 120_000)

  it.each(cases(MEMBER_ROUTES, [...SOURCE_FILES, "src/worker/job-queue.ts", "src/worker/candidate-job-runner.ts"]))("%s fails in %s", async (probe, file) => {
    expect((await ruleErrors(MEMBER_ROUTES[probe]!, file)).length).toBeGreaterThanOrEqual(1)
  })

  it.each(cases(TENANT_KEY_ROUTES, [...NON_DB_FILES, "src/worker/job-queue.ts", "src/worker/candidate-job-runner.ts", "src/stack-posts/stack-posts.repository.ts"]))("%s fails in %s", async (probe, file) => {
    expect((await ruleErrors(TENANT_KEY_ROUTES[probe]!, file)).length).toBeGreaterThanOrEqual(1)
  })

  it("TenantDatabase still sets the key, and ordinary computed access, dot access and prototype-free code still pass", async () => {
    expect(await ruleErrors("import { sql } from \"kysely\"\nexport const q = (id: string) => sql`select set_config('eve.candidate_id', ${id}, true)`\n", "src/db/tenant-database.ts")).toEqual([])
    const ordinary = `export const f = (rows: Record<string, number>, key: string, list: number[], i: number) => rows[key]! + list[i]! + rows["count"]!\nexport const g = (error: Error) => error.constructor.name\nexport const h = () => Object.keys({ a: 1 })\n`
    expect(await ruleErrors(ordinary, "src/discovery/posting-evaluator.ts")).toEqual([])
  })
})
