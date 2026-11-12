import { fileURLToPath } from "node:url"

import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * Repair wave 2 (module boundary rule): outside src/db, a computed key that is
 * not a literal is refused on a function or class value (rule
 * tenant/no-computed-function-member, type-aware). The probes are linted as the
 * text of a real src file, since the rule needs the TypeScript program.
 */
const API_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const eslint = new ESLint({ cwd: API_ROOT })
const OUTSIDE = "src/discovery/discovery.repository.ts"
const RULE = "tenant/no-computed-function-member"

async function ruleMessages(code: string, file = OUTSIDE): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${API_ROOT}${file}` })
  const fatal = result!.messages.filter((message) => message.fatal)
  if (fatal.length > 0) throw new Error(fatal.map((message) => message.message).join("; "))
  return result!.messages.filter((message) => message.ruleId === RULE).map((message) => message.message)
}

const REFUSED: Record<string, string> = {
  "a function cast to never": `function f() { return 1 }\nexport const g = (k: string) => (f as never)[k]\n`,
  "a class cast through unknown": `class C { static x = 1 }\nexport const g = (k: string) => (C as unknown as Record<string, unknown>)[k]\n`,
  "a non-null class": `class C { static x = 1 }\nexport const g = (k: keyof typeof C) => C![k]\n`,
  "a function with a variable key": `function f() { return 1 }\nexport const g = (k: keyof typeof f) => f[k]\n`,
  "an arrow function value": `const f = () => 1\nexport const g = (k: keyof typeof f) => f[k]\n`,
  "a class value": `class C { static x = 1 }\nexport const g = (k: keyof typeof C) => C[k]\n`,
  "an imported class": `import { TenantDatabase } from "../db/tenant-database.js"\nexport const g = (k: keyof typeof TenantDatabase) => TenantDatabase[k]\n`,
  "a parameter typed Function": `export const g = (f: Function, k: "call") => f[k]\n`,
  "a parameter typed as a constructor": `export const g = (f: new () => object, k: "prototype") => f[k]\n`,
  "an any value": `export const g = (f: any, k: string) => f[k]\n`,
  "a union with a function": `export const g = (f: (() => void) | { a: 1 }, k: "a") => (f as never as { a: 1 })[k] && (f as (() => void) | { a: 1 } & Record<string, unknown>)[k]\n`,
  "a computed expression key": `class C { static x = 1 }\nexport const g = () => C["x" + "" as "x"]\n`,
  "a template key with a hole": "class C { static x = 1 }\nconst n = \"x\" as const\nexport const g = () => C[`${n}`]\n",
  "computed destructuring": `class C { static x = 1 }\nexport const g = (k: "x") => { const { [k]: v } = C; return v }\n`,
}

const ACCEPTED: Record<string, string> = {
  "a literal key on a class": `class C { static x = 1 }\nexport const g = () => C["x"]\n`,
  "dot access on a function": `function f() { return 1 }\nexport const g = () => f.name\n`,
  "a variable key on a record": `export const g = (r: Record<string, number>, k: string) => r[k]\n`,
  "a variable key on an array": `export const g = (a: number[], i: number) => a[i]\n`,
  "a variable key on a Map-like object": `export const g = (o: { a: number; b: number }, k: "a" | "b") => o[k]\n`,
  "a variable key on unknown": `export const g = (u: unknown, k: string) => (u as Record<string, unknown>)[k]\n`,
}

describe("tenant/no-computed-function-member (repair wave 2)", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await eslint.lintText("export const warmUp = 1\n", { filePath: `${API_ROOT}${OUTSIDE}` })
  }, 180_000)

  it.each(Object.entries(REFUSED))("refuses a computed key on %s outside src/db", async (_name, code) => {
    expect((await ruleMessages(code)).length).toBeGreaterThan(0)
  })

  it.each(Object.entries(ACCEPTED))("accepts %s outside src/db", async (_name, code) => {
    expect(await ruleMessages(code)).toEqual([])
  })

  it("does not apply in src/db", async () => {
    expect(await ruleMessages(REFUSED["a class value"]!, "src/db/tenant-database.ts")).toEqual([])
  })
})
