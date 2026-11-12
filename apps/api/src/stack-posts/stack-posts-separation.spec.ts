import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

/**
 * outbound-and-separation.feature @ac-9.1 "Discovery, evaluation, ranking and
 * submission do not read Stack posts" (architecture "Testing", Separation):
 * no source file in those modules imports the Stack posts module or names its
 * tables. Only the daily summary (notification) and the worker wiring may.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url))
const SEPARATED = ["discovery", "submission", "ai", "job-criteria", "documents", "records", "spend"]

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") && !path.endsWith(".spec.ts") ? [path] : []
  })
}

describe("Stack posts stay separate from Job Postings and Applications (AC 9.1)", () => {
  it.each(SEPARATED)("no file under src/%s imports stack-posts or names its tables", (module) => {
    // EPIC-0007 Phase 3 (AC 10.1, architecture.r2.md "Separation"): the pattern also covers the hiring tables.
    const offenders = sources(join(SRC, module)).filter((path) => /stack-posts\/|stack_post|alert_feed|hiring_post|hiring_alert_feed|hiring_feed_verification/.test(readFileSync(path, "utf8")))
    expect(offenders.map((path) => relative(SRC, path))).toEqual([])
  })
})

/**
 * EPIC-0007 Phase 1 (AC 3.9, 10.1, 10.2): the hiring links builder and hint reader
 * are read-only and local. No file that builds or reads them makes a request,
 * calls the AI module or records spend, and no separated module reads them.
 */
describe("hiring links stay local and separate (EPIC-0007 AC 3.9, 10.1, 10.2)", () => {
  const HIRING_FILES = ["stack-posts/hiring-hints.ts", "stack-posts/stack-posts-summary.ts", "notification/email-content.ts", "../../../packages/contracts/src/stack-search-links.ts"]

  it.each(HIRING_FILES)("%s imports no HTTP client, AI or spend code", (file) => {
    // Code only: doc comments name the forbidden APIs on purpose.
    const source = readFileSync(join(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    expect(source).not.toMatch(/\bfetch\(|node:https?|undici|board-http|alert-feed-http|\.\.\/ai\/|\.\.\/spend\/spend-ledger|insertInto\(/)
  })

  it.each(SEPARATED)("no file under src/%s reads the hiring links or hints", (module) => {
    const offenders = sources(join(SRC, module)).filter((path) => /buildHiringSearchGroups|hiringHintTerms|hiring-hints|job_preferences/.test(readFileSync(path, "utf8")))
    expect(offenders.map((path) => relative(SRC, path))).toEqual([])
  })
})

/**
 * EPIC-0007 Phase 3 (AC 10.1, 10.2; threat model P3-5d, P3-10): Hiring code imports no
 * discovery, submission, AI or spend code, never calls ingestPastedLink, never reads the
 * shared EPIC-0005 verification record and never asks for a role.
 */
describe("Hiring posts stay separate and per Candidate (EPIC-0007 Phase 3; OUT:122, OUT:128, OUT:141, OUT:147, OUT:160, OUT:166 by construction)", () => {
  const HIRING = sources(join(SRC, "stack-posts")).filter((path) => /[\\/]hiring-posts[^/\\]*\.ts$/.test(path))
  const code = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("finds the four Phase 3 files", () => {
    expect(HIRING.map((path) => relative(SRC, path)).sort()).toEqual(["stack-posts/hiring-posts-reader.ts", "stack-posts/hiring-posts.controller.ts", "stack-posts/hiring-posts.repository.ts", "stack-posts/hiring-posts.service.ts"])
  })

  it.each(HIRING.map((path) => [relative(SRC, path), path]))("%s imports no discovery, submission, AI or spend code", (_name, path) => {
    expect(code(path)).not.toMatch(/\.\.\/discovery\/|\.\.\/submission\/(?!wat-day)|\.\.\/ai\/|\.\.\/spend\/|ingestPastedLink/)
  })

  it.each(HIRING.map((path) => [relative(SRC, path), path]))("%s never names the shared verification record or a role check", (_name, path) => {
    expect(readFileSync(path, "utf8")).not.toMatch(/alert_feed_verification|isOperator|verificationIn\(/)
  })

  it("only the hiring repository and the summary reader name hiring_feed_verification (P3-13d: the repository is its only writer)", () => {
    const files = sources(SRC).filter((path) => !path.includes(`${join("db", "migrations")}`) && readFileSync(path, "utf8").includes("hiring_feed_verification"))
    expect(files.map((path) => relative(SRC, path)).sort()).toEqual(["db/schema.ts", "stack-posts/hiring-posts.repository.ts", "stack-posts/stack-posts-summary.ts"])
    const writers = files.filter((path) => /insertInto\("hiring_feed_verification"\)|updateTable\("hiring_feed_verification"\)|deleteFrom\("hiring_feed_verification"\)/.test(readFileSync(path, "utf8")))
    expect(writers.map((path) => relative(SRC, path))).toEqual(["stack-posts/hiring-posts.repository.ts"])
  })
})

/**
 * EPIC-0008 (api-contract.md v1.22.0 "Tenancy and source guards", AR-3, AR-5;
 * stack-feed-migration.feature:217 "No application request or job reads or
 * writes the legacy shared record"). The Stack posts record is per Candidate
 * and no Stack posts code asks for a role.
 */
describe("Stack posts feed verification is per Candidate (EPIC-0008)", () => {
  const appSources = sources(SRC).filter((path) => !path.includes(join("db", "migrations")))

  it("(a) no file under src/ outside db/migrations names the legacy shared table", () => {
    const offenders = appSources.filter((path) => readFileSync(path, "utf8").includes("alert_feed_verification"))
    expect(offenders.map((path) => relative(SRC, path))).toEqual([])
  })

  it("(b) no stack-posts source file names isOperator", () => {
    const offenders = sources(join(SRC, "stack-posts")).filter((path) => readFileSync(path, "utf8").includes("isOperator"))
    expect(offenders.map((path) => relative(SRC, path))).toEqual([])
  })

  it("(c) only the schema, the repository and the summary name alert_feed_candidate_verification, and only the repository writes it", () => {
    const files = appSources.filter((path) => readFileSync(path, "utf8").includes("alert_feed_candidate_verification"))
    expect(files.map((path) => relative(SRC, path)).sort()).toEqual(["db/schema.ts", "stack-posts/stack-posts-summary.ts", "stack-posts/stack-posts.repository.ts"])
    const writers = files.filter((path) =>
      /insertInto\("alert_feed_candidate_verification"\)|updateTable\("alert_feed_candidate_verification"\)|deleteFrom\("alert_feed_candidate_verification"\)/.test(readFileSync(path, "utf8"))
    )
    expect(writers.map((path) => relative(SRC, path))).toEqual(["stack-posts/stack-posts.repository.ts"])
  })

  it("(d) the Hiring files name neither Stack posts verification table", () => {
    const hiring = sources(join(SRC, "stack-posts")).filter((path) => /[\\/]hiring-posts[^/\\]*\.ts$/.test(path))
    expect(hiring).toHaveLength(4)
    for (const path of hiring) expect(readFileSync(path, "utf8")).not.toMatch(/alert_feed_verification|alert_feed_candidate_verification/)
  })
})
