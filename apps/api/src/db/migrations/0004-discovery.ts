import { type Kysely, sql } from "kysely"

import { EMPLOYER_LIST_SEED, REMOTE_BOARD_SEED } from "./0004-discovery.seed.js"

/**
 * Slice 3: Job Sources (employer list with approval state, remote boards),
 * Job Postings stored once by requisition key, Eligibility and Match results,
 * evaluation settings and the pause flags discovery honours.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Pause flags. Slice 7 adds the controls; discovery and evaluation read them now.
  await db.schema
    .createTable("control_state")
    .addColumn("singleton", "boolean", (c) => c.primaryKey().defaultTo(true).check(sql`singleton`))
    .addColumn("global_paused", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("cost_paused", "boolean", (c) => c.notNull().defaultTo(false))
    .execute()
  await sql`insert into control_state (singleton) values (true)`.execute(db)

  // Backend settings. The Match threshold has no endpoint (AC 4.11): change it in SQL.
  await db.schema
    .createTable("evaluation_setting")
    .addColumn("singleton", "boolean", (c) => c.primaryKey().defaultTo(true).check(sql`singleton`))
    .addColumn("match_threshold", sql`numeric(4, 3)`, (c) =>
      c.notNull().defaultTo("0.700").check(sql`match_threshold > 0 and match_threshold <= 1`)
    )
    .addColumn("hours_cutoff", "text", (c) => c.notNull().defaultTo("23:00").check(sql`hours_cutoff ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`))
    .addColumn("hours_time_zone", "text", (c) => c.notNull().defaultTo("Africa/Lagos"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute()
  await sql`insert into evaluation_setting (singleton) values (true)`.execute(db)

  // One row: the employer list's approval. Approving turns on the 08:00 run (AC 3.2).
  await db.schema
    .createTable("employer_list_state")
    .addColumn("singleton", "boolean", (c) => c.primaryKey().defaultTo(true).check(sql`singleton`))
    .addColumn("approved_at", "timestamptz")
    .execute()
  await sql`insert into employer_list_state (singleton) values (true)`.execute(db)

  await db.schema
    .createTable("employer_board")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("position", "integer", (c) => c.notNull().unique().check(sql`position > 0`))
    .addColumn("company", "text", (c) => c.notNull())
    .addColumn("application_system", "text", (c) => c.notNull().check(sql`application_system in ('greenhouse', 'lever', 'ashby')`))
    .addColumn("board_token", "text", (c) => c.notNull().check(sql`board_token ~ '^[a-z0-9][a-z0-9-]{0,63}$'`))
    .addColumn("flag", "text", (c) => c.check(sql`flag in ('crypto')`))
    .addColumn("note", "text")
    .addColumn("last_read_at", "timestamptz")
    .addUniqueConstraint("employer_board_system_token_unique", ["application_system", "board_token"])
    .execute()
  for (const company of EMPLOYER_LIST_SEED) {
    await sql`insert into employer_board (id, position, company, application_system, board_token, flag, note)
      values (gen_random_uuid(), ${company.position}, ${company.company}, ${company.applicationSystem},
              ${company.boardToken}, ${company.flag}, ${company.note})`.execute(db)
  }

  await db.schema
    .createTable("remote_board")
    .addColumn("key", "text", (c) => c.primaryKey().check(sql`key in ('himalayas', 'remoteok', 'remotive', 'weworkremotely')`))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("position", "integer", (c) => c.notNull().unique())
    .addColumn("verified_on", "date")
    .addColumn("verification_basis", "text")
    .addColumn("enabled", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("available", "boolean", (c) => c.notNull())
    .addColumn("unavailable_reason", "text")
    .addColumn("attribution_name", "text", (c) => c.notNull())
    .addColumn("attribution_url", "text", (c) => c.notNull())
    .addColumn("last_read_at", "timestamptz")
    .addCheckConstraint("remote_board_verified_pair", sql`(verified_on is null) = (verification_basis is null)`)
    // A board can't be on unless verified and available (AC 1.8; Remotive needs written permission).
    .addCheckConstraint("remote_board_enabled_requires_verified", sql`not enabled or (verified_on is not null and available)`)
    .execute()
  for (const board of REMOTE_BOARD_SEED) {
    await sql`insert into remote_board (key, name, position, verified_on, verification_basis, available, unavailable_reason, attribution_name, attribution_url)
      values (${board.key}, ${board.name}, ${board.position}, ${board.verifiedOn}, ${board.verificationBasis},
              ${board.available}, ${board.unavailableReason}, ${board.attributionName}, ${board.attributionUrl})`.execute(db)
  }

  await db.schema
    .createTable("job_posting")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    /** Normalised employer application URL: half of the requisition key (architecture r1). */
    .addColumn("application_url", "text", (c) => c.notNull())
    /** The posting's requisition ID, or the Application System's posting ID as the fallback. */
    .addColumn("requisition_id", "text", (c) => c.notNull())
    .addColumn("apply_url", "text", (c) => c.notNull())
    .addColumn("application_system", "text", (c) => c.notNull())
    .addColumn("apply_mode", "text", (c) => c.notNull().check(sql`apply_mode in ('automatic', 'manual')`))
    .addColumn("origin", "text", (c) => c.notNull().check(sql`origin in ('employer_board', 'remote_board', 'pasted_link')`))
    .addColumn("employer_board_id", "uuid", (c) => c.references("employer_board.id").onDelete("set null"))
    .addColumn("remote_board_key", "text", (c) => c.references("remote_board.key"))
    .addColumn("attribution_name", "text")
    .addColumn("attribution_url", "text")
    .addColumn("title", "text")
    .addColumn("company", "text")
    .addColumn("posting_text", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("structured", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("status", "text", (c) =>
      c.notNull().check(sql`status in ('checking', 'waiting_to_be_checked', 'ranked', 'excluded', 'skipped', 'evaluation_failed')`)
    )
    .addColumn("skip_reason", "text")
    .addColumn("skip_detail", "text")
    .addColumn("evaluation_failure", "text")
    .addColumn("role_family", "text")
    .addColumn("discovered_at", "timestamptz", (c) => c.notNull())
    .addColumn("evaluated_at", "timestamptz")
    .addCheckConstraint("job_posting_attribution_pair", sql`(attribution_name is null) = (attribution_url is null)`)
    .execute()
  // AC 3.2: a posting that resolves to the same URL and requisition ID is stored once.
  await sql`create unique index job_posting_requisition_key_idx on job_posting (application_url, requisition_id)`.execute(db)
  await db.schema.createIndex("job_posting_status_idx").on("job_posting").columns(["status", "discovered_at"]).execute()

  await db.schema
    .createTable("eligibility_result")
    .addColumn("job_posting_id", "uuid", (c) => c.primaryKey().references("job_posting.id").onDelete("cascade"))
    .addColumn("arrangement", "text", (c) => c.notNull().check(sql`arrangement in ('remote', 'relocation', 'onsite')`))
    .addColumn("relocation_country", "text")
    .addColumn("employment_type", "text", (c) => c.check(sql`employment_type in ('direct', 'employer_of_record', 'contract')`))
    .addColumn("rules", "jsonb", (c) => c.notNull())
    .addColumn("eligible", "boolean", (c) => c.notNull())
    .addColumn("normalized_monthly_max_usd", sql`numeric(14, 2)`)
    .addColumn("fx_rate_date", "date")
    .addColumn("evaluated_at", "timestamptz", (c) => c.notNull())
    .execute()

  await db.schema
    .createTable("match_evidence")
    .addColumn("job_posting_id", "uuid", (c) => c.primaryKey().references("job_posting.id").onDelete("cascade"))
    .addColumn("career_profile_version", "integer", (c) => c.notNull())
    .addColumn("verdict", "text", (c) => c.notNull().check(sql`verdict in ('strong', 'weak')`))
    .addColumn("weak_reason", "text", (c) =>
      c.check(sql`weak_reason in ('unmet_mandatory', 'coverage_below_threshold', 'no_core_responsibilities')`)
    )
    .addColumn("covered_count", "integer", (c) => c.notNull())
    .addColumn("total_count", "integer", (c) => c.notNull())
    .addColumn("threshold", sql`numeric(4, 3)`, (c) => c.notNull())
    .addColumn("items", "jsonb", (c) => c.notNull())
    .addColumn("evaluated_at", "timestamptz", (c) => c.notNull())
    .addCheckConstraint("match_evidence_verdict_reason", sql`(verdict = 'strong') = (weak_reason is null)`)
    .execute()

  // Metering rows can point at the posting they evaluated (no career data in ai_call).
  await sql`alter table ai_call add column job_posting_id uuid references job_posting(id) on delete set null`.execute(db)
}
