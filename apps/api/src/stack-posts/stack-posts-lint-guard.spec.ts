import { fileURLToPath } from "node:url"

import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * SEC-E5-02 / SEC-E5-07 (ADR 0012): the lint guard must fail every way of
 * making an HTTP request from the Stack posts module, except in
 * `alert-feed-http.ts`. Each probe is linted as if it were a file in
 * `src/stack-posts/`, so this test is the committed negative probe. SEC-E5F-01 /
 * CR-E5F-04: every entry of the ADR 0012 target rule set has a probe that
 * names the rule it expects.
 */
const API_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const MODULE_FILE = `${API_ROOT}src/stack-posts/probe.ts`
const ALLOWED_FILE = `${API_ROOT}src/stack-posts/alert-feed-http.ts`

const eslint = new ESLint({ cwd: API_ROOT })

/** The rules that make up the ADR 0012 guard. Core eval rules carry their own message; the restricted-* rules carry the ADR text. */
const GUARD_RULES = new Set(["no-restricted-globals", "no-restricted-properties", "no-restricted-imports", "no-restricted-syntax", "no-eval", "no-implied-eval", "no-new-func"])
const CORE_GUARD_RULES = new Set(["no-eval", "no-implied-eval", "no-new-func"])

async function guardMessages(code: string, filePath = MODULE_FILE): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return result!.messages
    .filter((message) => GUARD_RULES.has(message.ruleId ?? "") && (CORE_GUARD_RULES.has(message.ruleId!) || message.message.includes("ADR 0012")))
    .map((message) => message.ruleId!)
}

/**
 * CR-E5F-03: the first `lintText` loads the typed config and the
 * typescript-eslint parser, which takes seconds on a loaded host. It runs
 * once in `beforeAll` with its own timeout, and each probe gets an explicit
 * timeout instead of vitest's default 5 s.
 */
const WARM_UP_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 30_000

describe("ADR 0012 lint guard (SEC-E5-02, SEC-E5-07, SEC-E5F-01)", { timeout: PROBE_TIMEOUT_MS }, () => {
  beforeAll(async () => {
    await eslint.lintText("export const warmUp = 1\n", { filePath: MODULE_FILE })
  }, WARM_UP_TIMEOUT_MS)

  it.each([
    ["global fetch", `export const run = () => fetch("https://example.com")`, "no-restricted-globals"],
    ["globalThis.fetch", `export const run = () => globalThis.fetch("https://example.com")`, "no-restricted-properties"],
    ["static import of node:https", `import https from "node:https"\nexport const run = () => https`, "no-restricted-imports"],
    ["static import of undici", `import { request } from "undici"\nexport const run = () => request`, "no-restricted-imports"],
    ["dynamic import of node:https", `export const run = () => import("node:https")`, "no-restricted-syntax"],
    ["dynamic import of undici", `export const run = () => import("undici")`, "no-restricted-syntax"],
    ["dynamic import of an undici subpath", `export const run = () => import("undici/lib/fetch/index.js")`, "no-restricted-syntax"],
    ["dynamic import with a template literal", "export const run = () => import(`node:http`)", "no-restricted-syntax"],
    ["dynamic import with a computed source", `const name = "node:" + "https"\nexport const run = () => import(name)`, "no-restricted-syntax"],
    ["static import of an undici subpath", `import { fetch } from "undici/lib/fetch/index.js"\nexport const run = () => fetch`, "no-restricted-imports"],
    ["export from an undici subpath", `export { fetch } from "undici/lib/fetch/index.js"`, "no-restricted-imports"],
    ["window.fetch", `declare const window: { fetch: typeof fetch }\nexport const run = () => window.fetch("https://example.com")`, "no-restricted-properties"],
    ["self.fetch", `declare const self: { fetch: typeof fetch }\nexport const run = () => self.fetch("https://example.com")`, "no-restricted-properties"],
    ["require of node:https", `declare const require: (name: string) => unknown\nexport const run = () => require("node:https")`, "no-restricted-syntax"],
    ["createRequire", `import { createRequire } from "node:module"\nexport const run = () => createRequire(import.meta.url)("node:https")`, "no-restricted-imports"],
    // SEC-E5F-01 / CR-E5F-04 (architecture r4, ADR 0012 target rule set)
    ["process.getBuiltinModule", `export const run = () => process.getBuiltinModule("node:https")`, "no-restricted-properties"],
    ["destructured process.getBuiltinModule", `const { getBuiltinModule } = process\nexport const run = () => getBuiltinModule("node:https")`, "no-restricted-properties"],
    ["process.binding", `export const run = () => process.binding("tcp_wrap")`, "no-restricted-properties"],
    ["process.dlopen", `export const run = (m: { exports: unknown }) => process.dlopen(m, "x.node")`, "no-restricted-properties"],
    ["EventSource global", `export const run = () => new EventSource("https://example.com")`, "no-restricted-globals"],
    ["eval", `export const run = () => eval("1")`, "no-eval"],
    ["new Function", `export const run = () => new Function("return 1")`, "no-new-func"],
    ["Function call", `export const run = () => Function("return 1")`, "no-new-func"],
    ["setTimeout with a string", `export const run = () => setTimeout("run()", 1)`, "no-implied-eval"],
    ["static import of node:child_process", `import { exec } from "node:child_process"\nexport const run = () => exec`, "no-restricted-imports"],
    ["static import of child_process", `import { exec } from "child_process"\nexport const run = () => exec`, "no-restricted-imports"],
    ["static import of node:worker_threads", `import { Worker } from "node:worker_threads"\nexport const run = () => Worker`, "no-restricted-imports"],
    ["static import of worker_threads", `import { Worker } from "worker_threads"\nexport const run = () => Worker`, "no-restricted-imports"],
    ["static import of node:dns", `import dns from "node:dns"\nexport const run = () => dns`, "no-restricted-imports"],
    ["static import of dns/promises", `import dns from "dns/promises"\nexport const run = () => dns`, "no-restricted-imports"],
    ["static import of node:dgram", `import dgram from "node:dgram"\nexport const run = () => dgram`, "no-restricted-imports"],
    ["static import of dgram", `import dgram from "dgram"\nexport const run = () => dgram`, "no-restricted-imports"],
    ["relative static import into node_modules", `import { request } from "../../node_modules/undici/index.js"\nexport const run = () => request`, "no-restricted-imports"],
    ["export from a relative node_modules path", `export * from "../../../node_modules/undici/index.js"`, "no-restricted-imports"],
    ["relative dynamic import into node_modules", `export const run = () => import("../../node_modules/undici/index.js")`, "no-restricted-syntax"],
    ["another module's HTTP client", `import { createBoardHttp } from "../discovery/sources/board-http.js"\nexport const run = () => createBoardHttp`, "no-restricted-imports"],
    ["the alert feed client through a path outside the module", `import { createAlertFeedHttp } from "../stack-posts/alert-feed-http.js"\nexport const run = () => createAlertFeedHttp`, "no-restricted-imports"],
    ["aliasing globalThis", `const g = globalThis\nexport const run = () => g.fetch("https://example.com")`, "no-restricted-syntax"],
    ["aliasing global", `const g = global\nexport const run = () => g.fetch("https://example.com")`, "no-restricted-syntax"],
    ["destructuring fetch from globalThis", `const { fetch: get } = globalThis\nexport const run = () => get("https://example.com")`, "no-restricted-syntax"],
    ["a parameter defaulting to globalThis", `export const run = (g = globalThis) => g.fetch("https://example.com")`, "no-restricted-syntax"],
    ["assigning globalThis", `let g: typeof globalThis | undefined\ng = globalThis\nexport const run = () => g?.fetch("https://example.com")`, "no-restricted-syntax"],
    ["Reflect.get", `export const run = () => (Reflect.get(globalThis, "fetch") as typeof fetch)("https://example.com")`, "no-restricted-syntax"],
    ["Reflect.apply", `export const run = (f: () => void) => Reflect.apply(f, undefined, [])`, "no-restricted-syntax"],
    ["Reflect.construct", `export const run = (C: new () => object) => Reflect.construct(C, [])`, "no-restricted-syntax"],
  ])("fails %s in src/stack-posts/", async (_name, code, rule) => {
    expect(await guardMessages(code)).toContain(rule)
  })

  it.each([
    ["a static import of a local module", `import { parseAlertFeed } from "./alert-feed-parser.js"\nexport const run = () => parseAlertFeed`],
    ["a dynamic import of a local module", `export const run = () => import("./alert-feed-parser.js")`],
    ["a URL object", `export const run = () => new URL("https://www.linkedin.com/posts/x").pathname`],
    ["the module's own client", `import { createAlertFeedHttp } from "./alert-feed-http.js"\nexport const run = () => createAlertFeedHttp`],
    ["the module's own client provider", `import { ALERT_FEED_HTTP } from "./alert-feed-http.provider.js"\nexport const run = () => ALERT_FEED_HTTP`],
    ["reading process.env", `export const run = () => process.env["NODE_ENV"]`],
    ["a property named like a Reflect method on another object", `const store = { get: (key: string) => key }\nexport const run = () => store.get("x")`],
  ])("allows %s", async (_name, code) => {
    expect(await guardMessages(code)).toEqual([])
  })

  it("the current src/stack-posts sources lint clean", async () => {
    const results = await eslint.lintFiles(["src/stack-posts/**/*.ts"])
    const errors = results.flatMap((result) => result.messages.filter((message) => message.severity === 2).map((message) => `${result.filePath}:${message.line} ${message.ruleId}`))
    expect(results.length).toBeGreaterThan(10)
    expect(errors).toEqual([])
  }, WARM_UP_TIMEOUT_MS)

  // EPIC-0007 Phase 1 (threat model P1-3): the hiring hint reader sits in the module, so the guard covers it.
  it.each([
    ["global fetch", `export const run = () => fetch("https://www.linkedin.com/")`, "no-restricted-globals"],
    ["dynamic import of node:https", `export const run = () => import("node:https")`, "no-restricted-syntax"],
    ["another module's HTTP client", `import { createBoardHttp } from "../discovery/sources/board-http.js"\nexport const run = () => createBoardHttp`, "no-restricted-imports"],
  ])("fails %s in src/stack-posts/hiring-hints.ts", async (_name, code, rule) => {
    expect(await guardMessages(code, `${API_ROOT}src/stack-posts/hiring-hints.ts`)).toContain(rule)
  })

  // EPIC-0007 Phase 3 (threat model P3-1b): the Hiring reader, service, repository and controller sit in the module.
  const HIRING_FILES = ["hiring-posts-reader.ts", "hiring-posts.service.ts", "hiring-posts.repository.ts", "hiring-posts.controller.ts"]
  const HIRING_PROBES = [
    ["global fetch", `export const run = () => fetch("https://www.linkedin.com/posts/x")`, "no-restricted-globals"],
    ["dynamic import of node:https", `export const run = () => import("node:https")`, "no-restricted-syntax"],
    ["another module's HTTP client", `import { createBoardHttp } from "../discovery/sources/board-http.js"\nexport const run = () => createBoardHttp`, "no-restricted-imports"],
  ] as const
  it.each(HIRING_FILES.flatMap((file) => HIRING_PROBES.map(([name, code, rule]) => [name, file, code, rule] as const)))("fails %s in src/stack-posts/%s", async (_name, file, code, rule) => {
    expect(await guardMessages(code, `${API_ROOT}src/stack-posts/${file}`)).toContain(rule)
  })

  it("does not apply to alert-feed-http.ts, the one allowed client", async () => {
    expect(await guardMessages(`export const run = () => fetch("https://www.google.com/alerts/feeds/1/2")`, ALLOWED_FILE)).toEqual([])
  })
})
