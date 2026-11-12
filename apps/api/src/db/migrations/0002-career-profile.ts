import { type Kysely, sql } from "kysely"

/**
 * Slice 2: AI provider approval, per-call AI metering, resume uploads, Career
 * Profile versions, Approved Answers, salary answers and Candidate settings.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // One row at most: Anthropic is the only provider (Candidate decision r2).
  await db.schema
    .createTable("ai_provider_approval")
    .addColumn("provider", "text", (c) => c.primaryKey().check(sql`provider = 'anthropic'`))
    .addColumn("approved_at", "timestamptz", (c) => c.notNull())
    .addColumn("terms_checked_on", "date", (c) => c.notNull())
    .addColumn("training_line", "text", (c) => c.notNull())
    .addColumn("retention_line", "text", (c) => c.notNull())
    .addColumn("whats_sent_line", "text", (c) => c.notNull())
    .execute()

  await db.schema
    .createTable("resume_upload")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("original_filename", "text", (c) => c.notNull())
    .addColumn("media_type", "text", (c) => c.notNull())
    .addColumn("byte_size", "integer", (c) => c.notNull().check(sql`byte_size > 0`))
    .addColumn("sha256", "text", (c) => c.notNull())
    .addColumn("storage_name", "text", (c) => c.notNull().unique())
    .addColumn("status", "text", (c) => c.notNull().check(sql`status in ('drafting', 'drafted', 'failed')`))
    .addColumn("failure_reason", "text")
    .addColumn("started_at", "timestamptz", (c) => c.notNull())
    .addColumn("finished_at", "timestamptz")
    .execute()
  // Only one resume is drafted at a time.
  await sql`create unique index resume_upload_one_drafting_idx on resume_upload ((true)) where status = 'drafting'`.execute(db)

  // Token usage of every model call, written before the call leaves the process.
  // Holds no career data. Read later by the cost ceiling.
  await db.schema
    .createTable("ai_call")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("purpose", "text", (c) => c.notNull())
    .addColumn("provider", "text", (c) => c.notNull())
    .addColumn("model", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) =>
      c.notNull().check(sql`status in ('started', 'succeeded', 'invalid_output', 'provider_error', 'timed_out')`)
    )
    .addColumn("input_tokens", "integer")
    .addColumn("output_tokens", "integer")
    .addColumn("cache_read_input_tokens", "integer")
    .addColumn("cache_creation_input_tokens", "integer")
    .addColumn("resume_upload_id", "uuid", (c) => c.references("resume_upload.id").onDelete("set null"))
    .addColumn("started_at", "timestamptz", (c) => c.notNull())
    .addColumn("finished_at", "timestamptz")
    .execute()
  await db.schema.createIndex("ai_call_started_at_idx").on("ai_call").column("started_at").execute()

  await db.schema
    .createTable("career_profile_version")
    .addColumn("version", "integer", (c) => c.primaryKey().check(sql`version > 0`))
    .addColumn("status", "text", (c) => c.notNull().check(sql`status in ('draft', 'approved', 'replaced')`))
    .addColumn("source", "text", (c) => c.notNull().check(sql`source in ('resume', 'edit')`))
    .addColumn("resume_upload_id", "uuid", (c) => c.references("resume_upload.id").onDelete("set null"))
    .addColumn("sections", "jsonb", (c) => c.notNull())
    /** Facts the model proposed whose quotes were not found in the resume, so were dropped. */
    .addColumn("rejected_fact_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .addColumn("approved_at", "timestamptz")
    .addCheckConstraint(
      "career_profile_version_approved_at_check",
      sql`(status = 'draft') = (approved_at is null)`
    )
    .execute()
  // One draft at a time, and one version in use.
  await sql`create unique index career_profile_one_draft_idx on career_profile_version ((true)) where status = 'draft'`.execute(db)
  await sql`create unique index career_profile_one_approved_idx on career_profile_version ((true)) where status = 'approved'`.execute(db)

  await db.schema
    .createTable("approved_answer")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("answer_group", "text", (c) => c.notNull().check(sql`answer_group in ('standard', 'sensitive', 'custom')`))
    .addColumn("topic", "text")
    .addColumn("skill", "text")
    .addColumn("question", "text")
    /** Normalised identity of the question, unique across all answers. */
    .addColumn("answer_key", "text", (c) => c.notNull().unique())
    .addColumn("value", "text", (c) => c.notNull().check(sql`length(btrim(value)) > 0`))
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .addCheckConstraint(
      "approved_answer_shape_check",
      sql`(answer_group = 'custom') = (question is not null and topic is null)
          and (skill is null or topic = 'skill_years')`
    )
    .execute()

  // Gross figures only. The preferred net pay has its own table, so no query
  // for a gross value can ever return it (AC 1.4).
  await db.schema
    .createTable("gross_salary_answer")
    .addColumn("kind", "text", (c) => c.primaryKey().check(sql`kind in ('gross_salary_policy', 'current_salary')`))
    .addColumn("amount", sql`numeric(12, 2)`, (c) => c.notNull().check(sql`amount > 0`))
    .addColumn("currency", "text", (c) => c.notNull().check(sql`currency ~ '^[A-Z]{3}$'`))
    .addColumn("period", "text", (c) => c.notNull().check(sql`period in ('year', 'month')`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .execute()

  await db.schema
    .createTable("preferred_net_pay")
    .addColumn("singleton", "boolean", (c) => c.primaryKey().defaultTo(true).check(sql`singleton`))
    .addColumn("amount", sql`numeric(12, 2)`, (c) => c.notNull().check(sql`amount > 0`))
    .addColumn("currency", "text", (c) => c.notNull().check(sql`currency ~ '^[A-Z]{3}$'`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .execute()

  await db.schema
    .createTable("candidate_setting")
    .addColumn("singleton", "boolean", (c) => c.primaryKey().defaultTo(true).check(sql`singleton`))
    .addColumn("work_authorization", "text", (c) => c.notNull().defaultTo("none outside Nigeria"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute()
  await sql`insert into candidate_setting (singleton) values (true)`.execute(db)
}
