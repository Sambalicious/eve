import { Inject, Injectable } from "@nestjs/common"
import { type Kysely } from "kysely"
import { sql } from "../db/sql.js"

import { DATABASE } from "../db/database.module.js"
import type { Database } from "../db/schema.js"
import type { BoundCandidate } from "./sign-in-decision.js"

/**
 * The `candidate` identity table at sign-in (EPIC-0002 A1). Identity rows carry
 * no RLS: sign-in runs before any Candidate scope exists.
 */
@Injectable()
export class CandidateIdentityRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async findBySub(googleSub: string): Promise<BoundCandidate | undefined> {
    return this.db.selectFrom("candidate").select(["id", "state"]).where("google_sub", "=", googleSub).executeTakeFirst()
  }

  /**
   * Architecture r2 "Owner email capture": the first sign-in after migration
   * records the verified ID-token email when the row has none. Never overwrites
   * a recorded email, and skips an email another Candidate already holds
   * (case-insensitive unique index), so a capture can never fail the sign-in.
   */
  async captureEmailIfMissing(candidateId: string, verifiedEmail: string): Promise<void> {
    await sql`
      update candidate set email = ${verifiedEmail}
      where id = ${candidateId} and email is null
        and not exists (select 1 from candidate other where lower(other.email) = lower(${verifiedEmail}))`.execute(this.db)
  }

  /** Identity facts of a signed-in Candidate (`/v1/me`, ConvertedFeatureGuard). Identity rows carry no RLS. */
  async identity(candidateId: string): Promise<{ id: string; email: string | null; role: "operator" | "candidate" } | undefined> {
    return this.db.selectFrom("candidate").select(["id", "email", "role"]).where("id", "=", candidateId).executeTakeFirst()
  }

  async isOperator(candidateId: string): Promise<boolean> {
    return (await this.identity(candidateId))?.role === "operator"
  }
}
