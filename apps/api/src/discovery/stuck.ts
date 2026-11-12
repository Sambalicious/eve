import type { RawBuilder } from "kysely"

import { sql } from "../db/sql.js"

/**
 * EPIC-0006 PRD r4 (architecture-stuck-checking.md; AC-7.11): a Candidate's
 * posting is stuck when its status is `checking`, it moved into `checking`
 * more than 15 minutes before `now` (`checking_since`, strict), and no
 * evaluation of that (Candidate, posting) pair holds the evaluator's session
 * advisory lock. Derived on read; never stored.
 *
 * "No evaluation running" is a `pg_locks` lookup, not a try-lock probe: a
 * probe would hold the lock for a moment and make a starting evaluation give
 * up. `evaluationLockKeySql` is the SQL twin of `evaluationLockKey`
 * (discovery.repository.ts): the first 6 bytes of
 * sha256("eve/evaluate/{candidate}/{posting}"), big-endian. A bigint advisory
 * lock shows in `pg_locks` as classid = high 32 bits, objid = low 32 bits,
 * objsubid = 1. `test/stuck-checking.int-spec.ts` checks that both forms agree.
 */
export const STUCK_AFTER_MS = 15 * 60_000

/** The evaluator's advisory lock key for the row `alias` (a `candidate_posting`), as a bigint. */
export function evaluationLockKeySql(alias: string): RawBuilder<string> {
  const candidate = sql.ref(`${alias}.candidate_id`)
  const posting = sql.ref(`${alias}.job_posting_id`)
  return sql<string>`(('x' || left(encode(sha256(convert_to('eve/evaluate/' || ${candidate}::text || '/' || ${posting}::text, 'UTF8')), 'hex'), 12))::bit(48)::bigint)`
}

/** Every advisory lock key held in this database right now. */
const HELD_LOCKS = sql`(select (l.classid::bigint << 32) | l.objid::bigint from pg_locks l
  where l.locktype = 'advisory' and l.objsubid = 1 and l.granted and l.database = (select oid from pg_database where datname = current_database()))`

/** True when the `candidate_posting` row `alias` is stuck at `now`. */
export function stuckSql(alias: string, now: Date): RawBuilder<boolean> {
  const since = new Date(now.getTime() - STUCK_AFTER_MS)
  return sql<boolean>`(${sql.ref(`${alias}.status`)} = 'checking' and ${sql.ref(`${alias}.checking_since`)} < ${since}
    and ${evaluationLockKeySql(alias)} not in ${HELD_LOCKS})`
}
