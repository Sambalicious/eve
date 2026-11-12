import { type Kysely, sql } from "kysely"

/**
 * Slice 5 repair (FE5-B1): dates for "marked not submitted" and same-company
 * decline, the Missing Approved Answer question as its own column, and the
 * form a sample will be submitted to, read by the worker without filling it,
 * so the sample review can show every planned answer (AC 2.1).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table application
    add column declined_at timestamptz,
    add column marked_not_submitted_at timestamptz,
    add column blocked_question text`.execute(db)
  await sql`create index application_sample_state_idx on application (sample_state) where sample_state is not null`.execute(db)

  // Controls only (label, kind, required, options): values are never read or stored. Replaced on each read.
  await db.schema
    .createTable("application_form_read")
    .addColumn("application_id", "uuid", (c) => c.primaryKey().references("application.id").onDelete("cascade"))
    .addColumn("host", "text", (c) => c.notNull())
    .addColumn("controls", "jsonb", (c) => c.notNull())
    .addColumn("read_at", "timestamptz", (c) => c.notNull())
    .execute()
}
