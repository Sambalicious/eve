import type { Kysely } from "kysely"

import type { Database } from "./schema.js"

/** Google `sub` values are opaque ASCII strings of at most 255 characters (OIDC Core 2). */
const GOOGLE_SUB = /^[\x21-\x7e]{1,255}$/

export class OperatorRebindError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OperatorRebindError"
  }
}

/**
 * Architecture r2 "CANDIDATE_GOOGLE_SUB retirement": binds the Operator row to a
 * new Google account, the host-only replacement for the ADR 0007 recovery. Runs
 * as the owner DB role from `operator-rebind.cli.ts`; there is no HTTP route.
 * Every Operator session ends in the same transaction, so a session from the
 * old account cannot outlive the rebind.
 */
export async function rebindOperatorSub(owner: Kysely<Database>, rawSub: string): Promise<{ operatorId: string; sessionsEnded: number }> {
  const sub = rawSub.trim()
  if (!GOOGLE_SUB.test(sub)) throw new OperatorRebindError("The Google sub must be 1 to 255 printable ASCII characters with no spaces")
  return owner.transaction().execute(async (trx) => {
    const operator = await trx.selectFrom("candidate").select("id").where("role", "=", "operator").forUpdate().executeTakeFirst()
    if (!operator) throw new OperatorRebindError("No Operator: the multi-candidate migration has not run")
    const taken = await trx.selectFrom("candidate").select("id").where("google_sub", "=", sub).where("id", "<>", operator.id).executeTakeFirst()
    if (taken) throw new OperatorRebindError("That Google sub is already bound to another Candidate")
    await trx.updateTable("candidate").set({ google_sub: sub }).where("id", "=", operator.id).execute()
    const ended = await trx.deleteFrom("dashboard_session").where("candidate_id", "=", operator.id).executeTakeFirst()
    return { operatorId: operator.id, sessionsEnded: Number(ended.numDeletedRows) }
  })
}
