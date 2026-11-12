import type { Kysely } from "kysely"

import type { Database } from "../../src/db/schema.js"

/**
 * EPIC-0002 A1 isolation tests: a second synthetic Candidate (not the Operator)
 * that owns rows the signed-in owner must never see or change.
 */
export async function insertSecondCandidate(db: Kysely<Database>, email = "kenya.invitee@example.test"): Promise<string> {
  const existing = await db.selectFrom("candidate").select("id").where("email", "=", email).executeTakeFirst()
  if (existing) return existing.id
  const row = await db
    .insertInto("candidate")
    .values({ email, google_sub: `synthetic-${email}`, role: "candidate" } as never)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id
}
