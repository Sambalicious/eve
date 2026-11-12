import { randomUUID } from "node:crypto"

import { type Insertable, sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { ApplicationTable, OutreachMessageTable } from "../src/db/schema.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"

/**
 * EPIC-0014 architecture r1 D2, D8, D11, D13 (code review CR-4): the checks on
 * `outreach_message` are the last backstop for the first failed sentence and the
 * text group, so they are tested against the real Postgres rather than read in
 * the migration. Each case names the constraint it expects, so a renamed or
 * dropped check fails here instead of passing quietly.
 */
let database: TestDatabase
let applicationId: string

const NOW = new Date("2026-11-10T09:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
})

afterAll(async () => {
  await database?.stop()
})

beforeEach(async () => {
  await database.truncateAll()
  const postingId = randomUUID()
  applicationId = randomUUID()
  await insertPostingFor(database.db, database.operatorId, {
    id: postingId,
    application_url: "https://boards.greenhouse.io/northwind/jobs/14",
    requisition_id: "R-OM-14",
    apply_url: "https://boards.greenhouse.io/northwind/jobs/14",
    application_system: "Greenhouse",
    apply_mode: "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title: "Senior Frontend Engineer",
    company: "Northwind Labs",
    status: "ranked",
    skip_reason: null,
    skip_detail: null,
    evaluation_failure: null,
    role_family: "senior_frontend",
    discovered_at: NOW,
    evaluated_at: NOW,
  })
  const row: Insertable<ApplicationTable> = {
    id: applicationId,
    candidate_id: database.operatorId,
    job_posting_id: postingId,
    application_url: "https://boards.greenhouse.io/northwind/jobs/14",
    requisition_id: "OM-14",
    company: "Northwind Labs",
    role_title: "Senior Frontend Engineer",
    state: "documents_ready",
    career_profile_version: 1,
    blocked_document: null,
    blocked_claim: null,
    failure: null,
    created_at: NOW,
    updated_at: NOW,
  }
  await database.db.insertInto("application").values(row).execute()
})

/** One row as a writer would leave it: no text, no cause, idle, unless the test says otherwise. */
type RowPatch = Partial<Insertable<OutreachMessageTable>>

async function insertRow(patch: RowPatch = {}): Promise<void> {
  const row: Insertable<OutreachMessageTable> = {
    id: randomUUID(),
    candidate_id: database.operatorId,
    application_id: applicationId,
    kind: "referral_request",
    reader_name: null,
    body: null,
    sentences: null,
    profile_version: null,
    written_at: null,
    last_failure: null,
    first_failed_sentence: null,
    run_id: null,
    run_started_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  }
  await database.db.insertInto("outreach_message").values(row).execute()
}

/** The row a `blocked` Run leaves: the cause and the sentence, no text (AC 7.10). */
const blocked = (sentence: string | null): RowPatch => ({ last_failure: "blocked", first_failed_sentence: sentence })

/** A Run in flight, which the pair check requires in full. */
const running: RowPatch = { run_status: "running", run_id: randomUUID(), run_started_at: NOW }

const sentenceOf = (length: number) => "a".repeat(length)

describe("D2, D13: the first failed sentence column", () => {
  it("is a nullable text column", async () => {
    const column = await sql<{ data_type: string; is_nullable: string }>`
      select data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'outreach_message' and column_name = 'first_failed_sentence'
    `.execute(database.db)

    expect(column.rows).toEqual([{ data_type: "text", is_nullable: "YES" }])
  })
})

describe("D13: a sentence exists only with the blocked cause on an idle row", () => {
  it("accepts a blocked ending on an idle row with no text (the all-or-none group stays satisfied)", async () => {
    await insertRow(blocked("I built the merchant dashboard in Angular."))

    const rows = await database.db.selectFrom("outreach_message").select(["last_failure", "first_failed_sentence", "body", "run_status"]).execute()
    expect(rows).toEqual([
      { last_failure: "blocked", first_failed_sentence: "I built the merchant dashboard in Angular.", body: null, run_status: "idle" },
    ])
  })

  it("rejects a sentence with no cause at all", async () => {
    await expect(insertRow({ first_failed_sentence: "I built the merchant dashboard in Angular." })).rejects.toThrow(/outreach_message_failed_sentence_blocked/)
  })

  it("rejects a sentence with another cause", async () => {
    await expect(insertRow({ last_failure: "provider_error", first_failed_sentence: "I built it in Angular." })).rejects.toThrow(
      /outreach_message_failed_sentence_blocked/
    )
  })

  it("rejects a sentence while a Run is in flight", async () => {
    await expect(insertRow({ ...blocked("I built it in Angular."), ...running })).rejects.toThrow(/outreach_message_failed_sentence_blocked/)
  })

  it("rejects a blocked cause with a sentence on a running row", async () => {
    await expect(insertRow({ last_failure: "blocked", first_failed_sentence: "I built it in Angular.", ...running })).rejects.toThrow(
      /outreach_message_failed_sentence_blocked/
    )
  })

  it("accepts a blocked ending that stores no sentence (the reply had no failed sentence)", async () => {
    await insertRow(blocked(null))

    const rows = await database.db.selectFrom("outreach_message").select(["last_failure", "first_failed_sentence"]).execute()
    expect(rows).toEqual([{ last_failure: "blocked", first_failed_sentence: null }])
  })
})

describe("D13: the stored form is 1 to 400 code points, trimmed, with no control character", () => {
  it("accepts 400 code points of astral characters, which Postgres counts as 400", async () => {
    const sentence = "\u{1F600}".repeat(400)
    await insertRow(blocked(sentence))

    const rows = await database.db.selectFrom("outreach_message").select("first_failed_sentence").execute()
    expect(rows).toEqual([{ first_failed_sentence: sentence }])
  })

  it("accepts one code point", async () => {
    await insertRow(blocked("a"))

    const rows = await database.db.selectFrom("outreach_message").select("first_failed_sentence").execute()
    expect(rows).toEqual([{ first_failed_sentence: "a" }])
  })

  it("rejects 401 code points", async () => {
    await expect(insertRow(blocked(sentenceOf(401)))).rejects.toThrow(/outreach_message_failed_sentence_form/)
  })

  it("rejects an empty sentence", async () => {
    await expect(insertRow(blocked(""))).rejects.toThrow(/outreach_message_failed_sentence_form/)
  })

  it.each([
    ["a leading space", " I built it in Angular."],
    ["a trailing space", "I built it in Angular. "],
    ["a trailing newline", "I built it in Angular.\n"],
    ["a C0 control character", "I built it\u0001in Angular."],
    ["a C1 control character", "I built it\u009Cin Angular."],
  ])("rejects %s", async (_case, sentence) => {
    await expect(insertRow(blocked(sentence))).rejects.toThrow(/outreach_message_failed_sentence_form/)
  })

  it("accepts a tab, a line feed and a carriage return inside the sentence, as the write schema does", async () => {
    const sentence = "I built it\tin Angular.\rI shipped it."
    await insertRow(blocked(sentence))

    const rows = await database.db.selectFrom("outreach_message").select("first_failed_sentence").execute()
    expect(rows).toEqual([{ first_failed_sentence: sentence }])
  })
})

describe("D8: the Reader name is 1 to 40 code points or null", () => {
  it("accepts 40 code points of astral characters", async () => {
    const name = "\u{1F600}".repeat(40)
    await insertRow({ reader_name: name })

    const rows = await database.db.selectFrom("outreach_message").select("reader_name").execute()
    expect(rows).toEqual([{ reader_name: name }])
  })

  it("rejects an empty or over-long name", async () => {
    await expect(insertRow({ reader_name: "" })).rejects.toThrow(/outreach_message_reader_name_check/)
    await expect(insertRow({ reader_name: "a".repeat(41) })).rejects.toThrow(/outreach_message_reader_name_check/)
  })
})

describe("D11: the text group is all four or none", () => {
  const text = { body: "I built the merchant dashboard.", sentences: JSON.stringify([{ kind: "statement", text: "I built the merchant dashboard.", factIds: [] }]), profile_version: 1, written_at: NOW }

  it("accepts a complete text with no cause and no sentence", async () => {
    await insertRow(text)

    const rows = await database.db.selectFrom("outreach_message").select(["body", "profile_version", "last_failure", "first_failed_sentence"]).execute()
    expect(rows).toEqual([{ body: "I built the merchant dashboard.", profile_version: 1, last_failure: null, first_failed_sentence: null }])
  })

  it.each([
    ["a body alone", { body: text.body }],
    ["a body and a version", { body: text.body, profile_version: 1 }],
    ["sentences alone", { sentences: text.sentences }],
    ["a version alone", { profile_version: 1 }],
    ["a written date alone", { written_at: NOW }],
  ])("rejects %s", async (_case, patch) => {
    await expect(insertRow(patch)).rejects.toThrow(/outreach_message_text_all_or_none/)
  })

  it("accepts the state a blocked Run with an earlier text leaves: the text group plus the cause and the sentence", async () => {
    await insertRow({ ...text, ...blocked("I built it in Angular.") })

    const rows = await database.db.selectFrom("outreach_message").select(["body", "last_failure", "first_failed_sentence"]).execute()
    expect(rows).toEqual([{ body: text.body, last_failure: "blocked", first_failed_sentence: "I built it in Angular." }])
  })
})

describe("D2: the table grant is the whole grant, with no column-level exception", () => {
  it("gives the runtime role exactly the table's four privileges on every column", async () => {
    const runtime = database.roles.runtime.name
    const table = await sql<{ privileges: string[] }>`
      select array_agg(privilege_type order by privilege_type)::text[] as privileges
      from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'outreach_message' and grantee = ${runtime}
    `.execute(database.db)
    expect(table.rows[0]?.privileges).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"])

    const columns = await sql<{ column_name: string; privileges: string[] }>`
      select column_name, array_agg(privilege_type order by privilege_type)::text[] as privileges
      from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'outreach_message' and grantee = ${runtime}
      group by column_name
    `.execute(database.db)
    const declared = await sql<{ n: string }>`
      select count(*)::text as n from information_schema.columns where table_schema = 'public' and table_name = 'outreach_message'
    `.execute(database.db)

    // One row per column. Postgres can express INSERT, SELECT, UPDATE and REFERENCES per column but not
    // DELETE, so every column carries exactly the table's other three: nothing narrower and nothing wider.
    expect(columns.rows).toHaveLength(Number(declared.rows[0]?.n))
    for (const column of columns.rows) expect(column.privileges).toEqual(["INSERT", "SELECT", "UPDATE"])

    // And Postgres holds no direct column grant, which is what a bypass of the policy would need.
    const direct = await sql<{ n: string }>`
      select count(*)::text as n from pg_attribute where attrelid = 'public.outreach_message'::regclass and attacl is not null
    `.execute(database.db)
    expect(direct.rows[0]?.n).toBe("0")
  })
})
