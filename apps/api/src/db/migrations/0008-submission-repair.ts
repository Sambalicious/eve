import { type Kysely, sql } from "kysely"

import { normaliseApplicationUrl } from "../../discovery/application-url.js"

/**
 * Slice 5 repair wave 3.
 * CR5-04: the Candidate's approval of a same-company hold, per Application.
 * The claim skips the same-company check for an approved Application.
 * CR5-05: existing applications are matched on the normalised application URL,
 * the same normalisation postings use, so rows typed before this migration
 * are rewritten. Where two spellings of one link collapse to the same key,
 * the earliest record is kept.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table application add column same_company_approved_at timestamptz`.execute(db)
  await normaliseExistingApplicationUrls(db)
}

type Row = { id: string; application_url: string; requisition_id: string | null }

/**
 * Rewrites every existing application URL to its normalised form (SEC-511:
 * collision-safe). The final key of every row is computed first; where rows
 * collapse onto one key the earliest is kept and the rest deleted. Changed
 * rows are then moved to a unique temporary value before the final write, so
 * no update can meet another row's current value on the unique index.
 */
export async function normaliseExistingApplicationUrls(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<Row>`select id, application_url, requisition_id from existing_application order by created_at, id`.execute(db)
  const keptByKey = new Map<string, Readonly<{ id: string; raw: string; url: string }>>()
  const collapsed: string[] = []
  for (const row of rows) {
    const url = normaliseApplicationUrl(row.application_url)
    const key = JSON.stringify([url, row.requisition_id ?? ""])
    if (keptByKey.has(key)) collapsed.push(row.id)
    else keptByKey.set(key, { id: row.id, raw: row.application_url, url })
  }
  for (const id of collapsed) await sql`delete from existing_application where id = ${id}`.execute(db)
  const changed = [...keptByKey.values()].filter((row) => row.url !== row.raw)
  for (const { id } of changed) await sql`update existing_application set application_url = ${`migration-0008:${id}`} where id = ${id}`.execute(db)
  for (const { id, url } of changed) await sql`update existing_application set application_url = ${url} where id = ${id}`.execute(db)
}
