import { Inject, Injectable } from "@nestjs/common"
import type { Kysely } from "kysely"

import { DATABASE } from "../db/database.module.js"
import type { Database } from "../db/schema.js"

export type StoredSession = Readonly<{
  csrfToken: string
  googleSub: string
  candidateId: string
}>

@Injectable()
export class SessionRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async insert(session: {
    idHash: string
    csrfToken: string
    candidateId: string
    googleSub: string
    lastActiveAt: Date
  }): Promise<void> {
    await this.db
      .insertInto("dashboard_session")
      .values({
        id_hash: session.idHash,
        csrf_token: session.csrfToken,
        candidate_id: session.candidateId,
        google_sub: session.googleSub,
        last_active_at: session.lastActiveAt,
      })
      .execute()
  }

  /**
   * Records activity on a session still active after `cutoff`, in one statement,
   * so a concurrent request cannot revive a session that has already expired.
   * A session also stops resolving once its Candidate is no longer `active`
   * (revoked or deleting): revoking someone ends their access on the next request.
   */
  async touchIfActive(idHash: string, now: Date, cutoff: Date): Promise<StoredSession | undefined> {
    const row = await this.db
      .updateTable("dashboard_session")
      .from("candidate")
      .set({ last_active_at: now })
      .whereRef("candidate.id", "=", "dashboard_session.candidate_id")
      .where("candidate.state", "=", "active")
      .where("dashboard_session.id_hash", "=", idHash)
      .where("dashboard_session.last_active_at", ">", cutoff)
      .returning(["dashboard_session.csrf_token", "dashboard_session.google_sub", "dashboard_session.candidate_id"])
      .executeTakeFirst()
    return row && { csrfToken: row.csrf_token, googleSub: row.google_sub, candidateId: row.candidate_id }
  }

  /** Returns true when a row was deleted. */
  async delete(idHash: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("dashboard_session")
      .where("id_hash", "=", idHash)
      .executeTakeFirst()
    return result.numDeletedRows > 0n
  }
}
