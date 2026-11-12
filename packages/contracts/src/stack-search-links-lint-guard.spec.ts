import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * EPIC-0007 threat model P1-3 (ADR 0012): the contracts lint config refuses a
 * network request in `src/stack-search-links.ts`. Each probe is linted as if it
 * were that file, so this test is the committed negative probe.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url))
const BUILDER = `${ROOT}src/stack-search-links.ts`
const OTHER = `${ROOT}src/probe.ts`
const eslint = new ESLint({ cwd: ROOT })

async function guardRules(code: string, filePath = BUILDER): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return result!.messages.filter((message) => message.message.includes("ADR 0012")).map((message) => message.ruleId!)
}

describe("stack-search-links.ts outbound guard (P1-3)", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await eslint.lintText("export const warmUp = 1\n", { filePath: BUILDER })
  }, 120_000)

  it.each([
    ["fetch", `export const run = () => fetch("https://www.linkedin.com/")`, "no-restricted-globals"],
    ["XMLHttpRequest", `export const run = () => new XMLHttpRequest()`, "no-restricted-globals"],
    ["WebSocket", `export const run = () => new WebSocket("wss://example.com")`, "no-restricted-globals"],
    ["EventSource", `export const run = () => new EventSource("https://example.com")`, "no-restricted-globals"],
    ["node:http", `import http from "node:http"\nexport const run = () => http`, "no-restricted-imports"],
    ["node:https", `import https from "node:https"\nexport const run = () => https`, "no-restricted-imports"],
    ["undici", `import { request } from "undici"\nexport const run = () => request`, "no-restricted-imports"],
    ["an undici subpath", `import { fetch } from "undici/lib/fetch/index.js"\nexport const run = () => fetch`, "no-restricted-imports"],
  ])("refuses %s", async (_name, code, rule) => {
    expect(await guardRules(code)).toContain(rule)
  })

  // SEC-P1-01: member access on a global object bypasses no-restricted-globals.
  it.each(
    ["globalThis", "window", "self"].flatMap((object) =>
      ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"].map((property) => [`${object}.${property}`, object, property]),
    ),
  )("refuses %s", async (_name, object, property) => {
    const code = `export const run = () => ${object}.${property}("https://www.linkedin.com/")`
    expect(await guardRules(code)).toContain("no-restricted-properties")
  })

  it("the committed builder lints clean", async () => {
    const [result] = await eslint.lintText(readFileSync(BUILDER, "utf8"), { filePath: BUILDER })
    expect(result!.messages.filter((message) => message.severity === 2)).toEqual([])
  })

  it("applies only to the builder file", async () => {
    expect(await guardRules(`export const run = () => fetch("https://example.com")`, OTHER)).toEqual([])
  })
})
