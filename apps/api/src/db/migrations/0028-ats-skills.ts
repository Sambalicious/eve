import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * ATS scoring (owner decision 2026-11-01: "ATS scoring must be the heart of everything").
 * `job_posting.ats_skills`: the hard skills and practices the posting's requirements name, each with
 * a verbatim quote, verified like `technologies`. Null until the posting is evaluated again; ATS
 * keywords then fall back to `technologies` alone. A shared table column: no policy or grant of its own.
 *
 * Frozen: imports nothing from the app or `@eve/contracts`.
 */
export const ATS_SKILLS_MARKER = "0028-ats-skills"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table job_posting add column ats_skills jsonb`.execute(db)
  await sql`alter table job_posting add constraint job_posting_ats_skills_check check (ats_skills is null or jsonb_typeof(ats_skills) = 'array')`.execute(db)
  await recordSchemaMarker(db, ATS_SKILLS_MARKER)
}

/** Reverts 0028: drops the column with its check and removes the marker. Stored skills are lost; postings refill them when evaluated again. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${ATS_SKILLS_MARKER}`.execute(db)
  await sql`alter table job_posting drop constraint if exists job_posting_ats_skills_check`.execute(db)
  await sql`alter table job_posting drop column if exists ats_skills`.execute(db)
}
