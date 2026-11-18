import { Inject, Injectable } from "@nestjs/common"
import type { Kysely } from "kysely"

import { DATABASE } from "../db/database.module.js"
import type { Database } from "../db/schema.js"

export type SignInAttempt = Readonly<{
  state: string
  nonce: string
  codeVerifier: string
  returnPath: string
  createdAt: Date
}>

@Injectable()
export class SignInAttemptRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async insert(idHash: string, attempt: SignInAttempt): Promise<void> {
    await this.db
      .insertInto("sign_in_attempt")
      .values({
        id_hash: idHash,
        state: attempt.state,
        nonce: attempt.nonce,
        code_verifier: attempt.codeVerifier,
        return_path: attempt.returnPath,
        created_at: attempt.createdAt,
      })
      .execute()
  }

  /** Deletes and returns the attempt in one statement, so it can complete at most once. */
  async take(idHash: string): Promise<SignInAttempt | undefined> {
    const row = await this.db
      .deleteFrom("sign_in_attempt")
      .where("id_hash", "=", idHash)
      .returningAll()
      .executeTakeFirst()
    return (
      row && {
        state: row.state,
        nonce: row.nonce,
        codeVerifier: row.code_verifier,
        returnPath: row.return_path,
        createdAt: row.created_at,
      }
    )
  }

  /**
   * Hourly housekeeping (the worker's `auth.cleanup` job): removes the attempts
   * the TTL has taken. `take` still refuses a presented attempt at use time, so
   * this only stops abandoned rows accumulating. Returns how many rows went.
   */
  async deleteCreatedBefore(cutoff: Date): Promise<number> {
    const result = await this.db.deleteFrom("sign_in_attempt").where("created_at", "<", cutoff).executeTakeFirst()
    return Number(result.numDeletedRows)
  }
}
