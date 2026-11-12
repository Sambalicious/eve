import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

/**
 * EPIC-0003 AC 11.22, 11.23 (architecture.r1 7.7, 7.13). Static checks:
 * - NOTIFY_TO and GMAIL_SMTP_* are set only on the compose `worker` service, so
 *   the api process (and every response it builds) can't hold the Operator address.
 * - No Candidate code path reads the access-request tables.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const SRC = fileURLToPath(new URL("../src/", import.meta.url))

/** Service name -> raw lines of its block, from the top-level `services:` map (2-space indent). */
function composeServices(text: string): Map<string, string[]> {
  const services = new Map<string, string[]>()
  let inServices = false
  let current: string | null = null
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith("services:")
      current = null
      continue
    }
    if (!inServices) continue
    const name = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (name) {
      current = name[1]!
      services.set(current, [])
    } else if (current) {
      services.get(current)!.push(line)
    }
  }
  return services
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : []
  })
}

describe("compose env isolation (AC 11.22)", () => {
  const services = composeServices(readFileSync(join(ROOT, "docker-compose.yml"), "utf8"))
  const holders = (key: string) => [...services].filter(([, lines]) => lines.some((line) => new RegExp(`^\\s+${key}\\b`).test(line))).map(([name]) => name)

  it("parses the services", () => {
    expect([...services.keys()]).toEqual(expect.arrayContaining(["api", "worker", "postgres"]))
  })

  it.each(["NOTIFY_TO", "GMAIL_SMTP_USER", "GMAIL_SMTP_APP_PASSWORD"])("%s is set on the worker only", (key) => {
    expect(holders(key)).toEqual(["worker"])
  })

  it("the api gets ACCESS_REQUEST_SECRET and TRUST_PROXY; the worker doesn't need them", () => {
    expect(holders("ACCESS_REQUEST_SECRET")).toEqual(["api"])
    expect(holders("TRUST_PROXY")).toEqual(["api"])
  })
})

/**
 * EPIC-0006 AC-7.2. The worker evaluates Job Postings, so it must receive the
 * Anthropic key and model from the same sources and defaults as the api. Without
 * this every evaluation fails as not_configured (929 live postings did).
 */
describe("compose worker Anthropic env (EPIC-0006 AC-7.2)", () => {
  const services = composeServices(readFileSync(join(ROOT, "docker-compose.yml"), "utf8"))
  const value = (service: string, key: string) =>
    services
      .get(service)
      ?.map((line) => new RegExp(`^\\s+${key}:\\s*(.*?)\\s*$`).exec(line)?.[1])
      .find((match) => match !== undefined)

  it.each([
    ["ANTHROPIC_API_KEY", "${ANTHROPIC_API_KEY:-}"],
    ["ANTHROPIC_MODEL", "${ANTHROPIC_MODEL:-claude-haiku-5-5}"],
  ])("%s is set on the worker with the same expression as the api", (key, expression) => {
    expect(value("worker", key)).toBe(expression)
    expect(value("api", key)).toBe(expression)
  })
})

describe("access-request table isolation (AC 11.23)", () => {
  const allowed = (path: string) =>
    path.startsWith("access-request/") || path.startsWith("notification/") || path.startsWith("db/") || path === "worker/access-request-jobs.ts" || path === "config/env.ts"

  it("no Candidate module names the access_request tables", () => {
    const offenders = files(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => !path.endsWith(".spec.ts") && !allowed(path))
      .filter((path) => /\baccess_request(?:_drop)?\b(?!_invalid)/.test(readFileSync(join(SRC, path), "utf8")))
    expect(offenders).toEqual([])
  })
})
