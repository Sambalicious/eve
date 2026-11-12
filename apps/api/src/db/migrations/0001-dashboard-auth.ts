import { type Kysely, sql } from "kysely"

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("dashboard_session")
    .addColumn("id_hash", "text", (column) => column.primaryKey())
    .addColumn("csrf_token", "text", (column) => column.notNull())
    .addColumn("google_sub", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`)
    )
    .addColumn("last_active_at", "timestamptz", (column) => column.notNull())
    .execute()

  await db.schema
    .createIndex("dashboard_session_last_active_at_idx")
    .on("dashboard_session")
    .column("last_active_at")
    .execute()

  await db.schema
    .createTable("sign_in_attempt")
    .addColumn("id_hash", "text", (column) => column.primaryKey())
    .addColumn("state", "text", (column) => column.notNull())
    .addColumn("nonce", "text", (column) => column.notNull())
    .addColumn("code_verifier", "text", (column) => column.notNull())
    .addColumn("return_path", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull())
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("sign_in_attempt").execute()
  await db.schema.dropTable("dashboard_session").execute()
}
