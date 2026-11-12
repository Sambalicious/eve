import { type Kysely, sql } from "kysely"

/**
 * CR2-03 and the 2026-10-18 decision: salary amounts are at most 100,000,000.
 * `numeric(12, 2)` already rounds to 2 decimals and the existing checks require
 * amount > 0; this adds the upper bound the api enforces, so no caller can store more.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table gross_salary_answer add constraint gross_salary_answer_amount_max check (amount <= 100000000)`.execute(db)
  await sql`alter table preferred_net_pay add constraint preferred_net_pay_amount_max check (amount <= 100000000)`.execute(db)
}
