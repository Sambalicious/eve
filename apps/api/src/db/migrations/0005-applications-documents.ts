import { type Kysely, sql } from "kysely"

/**
 * Slice 4: Applications in the prepared state, Tailored Documents, and the
 * Candidate's contact header (name and contact lines inserted into documents
 * after generation; never sent to the model).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("candidate_contact")
    .addColumn("singleton", "boolean", (c) => c.primaryKey().defaultTo(true).check(sql`singleton`))
    .addColumn("full_name", "text", (c) => c.notNull().defaultTo(""))
    /** Up to 4 short lines: city and country, email, phone, profile link. */
    .addColumn("lines", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute()
  await sql`insert into candidate_contact (singleton) values (true)`.execute(db)

  await db.schema
    .createTable("application")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("job_posting_id", "uuid", (c) => c.notNull().references("job_posting.id").onDelete("restrict"))
    /** The requisition key, copied so the record outlives a deleted posting (CONTEXT: never apply twice). */
    .addColumn("application_url", "text", (c) => c.notNull())
    .addColumn("requisition_id", "text", (c) => c.notNull())
    .addColumn("company", "text")
    .addColumn("role_title", "text")
    .addColumn("state", "text", (c) =>
      c.notNull().check(sql`state in ('prepared', 'generating', 'documents_ready', 'documents_blocked', 'documents_failed')`)
    )
    /** The approved Career Profile version the documents were generated from (AC 5.1 r2). */
    .addColumn("career_profile_version", "integer")
    .addColumn("blocked_document", "text", (c) => c.check(sql`blocked_document in ('resume', 'cover_letter')`))
    .addColumn("blocked_claim", "text")
    .addColumn("failure", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .addCheckConstraint("application_blocked_pair", sql`(state = 'documents_blocked') = (blocked_document is not null)`)
    .execute()
  // CONTEXT: never apply twice to the same requisition. One Application per requisition key.
  await sql`create unique index application_requisition_key_idx on application (application_url, requisition_id)`.execute(db)

  await db.schema
    .createTable("tailored_document")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("application_id", "uuid", (c) => c.notNull().references("application.id").onDelete("cascade"))
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind in ('resume', 'cover_letter')`))
    .addColumn("career_profile_version", "integer", (c) => c.notNull())
    /** Structured content with fact IDs per line (validated). */
    .addColumn("content", "jsonb", (c) => c.notNull())
    .addColumn("pdf_storage_name", "text", (c) => c.notNull())
    .addColumn("docx_storage_name", "text", (c) => c.notNull())
    .addColumn("pdf_sha256", "text", (c) => c.notNull())
    .addColumn("docx_sha256", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .execute()
  // AC 5.1: each Application has its own resume and its own cover letter; regeneration replaces them.
  await sql`create unique index tailored_document_application_kind_idx on tailored_document (application_id, kind)`.execute(db)

  await sql`alter table ai_call add column application_id uuid references application(id) on delete set null`.execute(db)
}
