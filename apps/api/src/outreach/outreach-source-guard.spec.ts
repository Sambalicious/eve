import { readdirSync, readFileSync } from "node:fs"
import { join, sep } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Architecture r1 D11 item 1 and D13 (code review CR-4): the first failed
 * sentence is detailed record text, so it must not be reachable from a module
 * that could put it in a prompt, a log, an email, the daily summary or analytics
 * (PRD AC 2.2, AC 12.5). These scans keep that structural, so a later edit fails
 * here instead of drifting quietly:
 *
 * - only `OutreachRepository` and the two allowed deletion paths touch the table;
 * - only the repository writes the sentence, and only `finishBlocked` sets it
 *   non-null, in the same update as `last_failure = 'blocked'`;
 * - the two writers that must leave the text alone write no text column;
 * - outside the repository the sentence is read in exactly one place, the
 *   response mapper the contract returns it from.
 */
const SRC = join(import.meta.dirname, "..")

const TABLE = "outreach_message"
const SENTENCE = "first_failed_sentence"

/** The table's definition, not a use of it: the migration and the generated schema type. */
const DEFINITION = ["db/migrations/", "db/schema.ts"]

const REPOSITORY = "outreach/outreach.repository.ts"
/** The two deletion paths allowed to reference the table (D3): the shared delete and the expiry select. */
const DELETION = ["records/details-deletion.ts", "records/retention-runner.ts"]
const SERVICE = "outreach/outreach.service.ts"

type SourceFile = Readonly<{ path: string; source: string }>

/** Every non-test module under `apps/api/src`, outside the table's own definition. */
function sources(): readonly SourceFile[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => entry.split(sep).join("/"))
    .filter((path) => !path.endsWith(".spec.ts") && !path.endsWith(".int-spec.ts"))
    .filter((path) => !DEFINITION.some((part) => (part.endsWith("/") ? path.startsWith(part) : path === part)))
    .map((path) => ({ path, source: readFileSync(join(SRC, path), "utf8") }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

/** One class method's text, from its declaration to the line that closes it at class indentation. */
function method(source: string, name: string): string {
  const start = source.search(new RegExp(`^  (?:async )?${name}\\(`, "m"))
  if (start < 0) throw new Error(`${name} is not a method of this file`)
  const end = source.indexOf("\n  }\n", start)
  return source.slice(start, end < 0 ? undefined : end)
}

/**
 * Every assignment to the sentence column in a source, with the method that holds
 * it (NEW-4). Per occurrence, not per value: a second writer storing the same
 * value name would pass a set comparison. The row type names the column as a
 * type, not an assignment, so it is removed first.
 */
function assignments(source: string): readonly { owner: string; value: string }[] {
  const values = source.replace(`${SENTENCE}: string | null`, "")
  const declarations = [...values.matchAll(/^ {2}(?:async )?(\w+)\(/gm)].map((match) => ({ name: match[1]!, at: match.index! }))
  return [...values.matchAll(new RegExp(`${SENTENCE}:\\s*([\\w.]+)`, "g"))].map((match) => {
    const owner = declarations.filter((declaration) => declaration.at < match.index!).at(-1)?.name ?? "<module>"
    return { owner, value: match[1]! }
  })
}

describe("the Outreach table is reachable only from the repository and the two deletion paths (D3, D13)", () => {
  it("only the repository reads or writes the table", () => {
    const access = new RegExp(`(selectFrom|insertInto|updateTable|deleteFrom)\\(\\s*"${TABLE}\\b|\\b(from|into|join|update)\\s+${TABLE}\\b`)
    expect(sources().filter((file) => access.test(file.source)).map((file) => file.path)).toEqual([REPOSITORY, ...DELETION].sort())
  })

  it("no other module names the table, apart from the ledger purpose string the write call records", () => {
    const naming = sources().filter((file) => file.source.includes(TABLE)).map((file) => file.path)
    expect(naming).toEqual([REPOSITORY, ...DELETION, SERVICE].sort())
    // The service's one occurrence is a purpose label, never a query (D7).
    const labelled = sources()
      .find((file) => file.path === SERVICE)!
      .source.split("\n")
      .filter((line) => line.includes(TABLE))
    expect(labelled).toHaveLength(1)
    expect(labelled[0]).toMatch(/OUTREACH_WRITE_PURPOSE/)
  })
})

describe("only finishBlocked stores the sentence, and always with the blocked cause (D11, D13)", () => {
  it("every writer names the column, and none but finishBlocked stores a value", () => {
    const repository = sources().find((file) => file.path === REPOSITORY)!.source
    for (const writer of ["claimRun", "resetInterrupted", "finishReady", "finishWithoutText", "finishBlocked"]) {
      expect(method(repository, writer)).toContain(SENTENCE)
    }
    // NEW-4: assignment by assignment. Every non-null value sits in finishBlocked;
    // `first_failed_sentence: stored` added to any other writer fails here.
    expect(assignments(repository).filter((entry) => entry.value !== "null")).toEqual([{ owner: "finishBlocked", value: "stored" }])
  })

  it("no module outside the repository assigns the column (NEW-4)", () => {
    const assigners = sources()
      .filter((file) => file.path !== REPOSITORY && assignments(file.source).length > 0)
      .map((file) => file.path)
    expect(assigners).toEqual([])
  })

  it("finishBlocked writes the cause and the sentence together, so a notice and its quote cannot come from different Runs", () => {
    const blocked = method(sources().find((file) => file.path === REPOSITORY)!.source, "finishBlocked")
    expect(blocked).toContain(`${SENTENCE}: stored`)
    expect(blocked).toContain(`last_failure: "blocked"`)
  })

  it("the two writers that end a Run without a blocked sentence clear it", () => {
    const repository = sources().find((file) => file.path === REPOSITORY)!.source
    expect(method(repository, "finishWithoutText")).toContain(`${SENTENCE}: null`)
    expect(method(repository, "finishReady")).toContain(`${SENTENCE}: null`)
  })

  it("finishWithoutText and finishBlocked write no text column (D11 item 1)", () => {
    const repository = sources().find((file) => file.path === REPOSITORY)!.source
    for (const writer of ["finishWithoutText", "finishBlocked"]) {
      const body = method(repository, writer)
      for (const column of ["body:", "sentences:", "profile_version:", "written_at:"]) expect(body).not.toContain(column)
    }
  })

  it("the column is set in the repository only, and read outside it only by the response mapper", () => {
    const all = sources()
    expect(all.filter((file) => new RegExp(`${SENTENCE}\\s*:`).test(file.source)).map((file) => file.path)).toEqual([REPOSITORY])
    const readers = all.filter((file) => file.path !== REPOSITORY && file.source.includes(SENTENCE)).map((file) => file.path)
    expect(readers).toEqual([SERVICE])
    // Contract 5.2: the item carries `firstFailedSentence`, so the mapper must read it.
    const read = all
      .find((file) => file.path === SERVICE)!
      .source.split("\n")
      .filter((line) => line.includes(SENTENCE))
    expect(read).toHaveLength(1)
    expect(read[0]).toMatch(/row\?\.first_failed_sentence/)
  })
})
