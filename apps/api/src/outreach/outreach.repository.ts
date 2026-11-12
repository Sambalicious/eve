import { randomUUID } from "node:crypto"

import { Injectable } from "@nestjs/common"
import type { OutreachFailureCause, OutreachKind } from "@eve/contracts"

import type { OutreachMessageRunStatus, StoredOutreachSentence } from "../db/schema.js"
import { sql } from "../db/sql.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { OUTREACH_STALE_RUN_MS } from "../records/details-deletion.js"
import { capFailedSentence, mentionsReaderName } from "./failed-sentence.js"

/**
 * One Outreach row as the writers and the GET read it (the columns the api ever needs).
 */
export type OutreachMessageRow = Readonly<{
  kind: OutreachKind
  reader_name: string | null
  body: string | null
  profile_version: number | null
  written_at: Date | null
  last_failure: string | null
  first_failed_sentence: string | null
  run_status: OutreachMessageRunStatus
  run_started_at: Date | null
}>

/**
 * What `claimRun` did (D10). `not_found`: the Application is missing, another
 * Candidate's, or its details are deleted. `running`: a Run under 10 minutes old
 * is already in flight, so nothing started; the current row is returned for the
 * 202. `claimed`: this request owns the new Run.
 */
export type OutreachClaimOutcome =
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "running"; row: OutreachMessageRow }>
  | Readonly<{ outcome: "claimed"; row: OutreachMessageRow }>

/** The Ready result a successful Run writes in one statement (D11). Never holds a dropped sentence. */
export type ReadyOutreachText = Readonly<{
  body: string
  sentences: readonly StoredOutreachSentence[]
  profileVersion: number
}>

/** What `finishBlocked` reports for the log's `quote` field (D7, r1): an enum, never the sentence. */
export type OutreachQuoteLog = "stored" | "withheld_name" | "none"

/**
 * EPIC-0014 Outreach messages (architecture r1 D1, D10, D11, D13).
 *
 * Candidate-scoped through `TenantDatabase`, so every statement runs in the
 * session Candidate's transaction under forced RLS and names its
 * `candidate_id`, as `documents.repository.ts` does. The Run code reaches the
 * row only through the four writers below plus the name writer, so a partial
 * text, a cause without its sentence or a text written by a superseded Run
 * cannot reach the table:
 *
 * - `claimRun` clears the cause and the sentence and takes the run token.
 * - `finishReady` writes the whole text (body, sentences, version, time) in one
 *   update and clears the cause and the sentence.
 * - `finishWithoutText` writes a cause (or null for a pause) and no text column;
 *   its type excludes `blocked`, so the compiler refuses a blocked ending here.
 * - `finishBlocked` writes `blocked` and the sentence together, and withholds the
 *   sentence when it names the Reader.
 *
 * Every finisher also takes the Application row `FOR SHARE` first and returns
 * without writing when the details were deleted (SEC-701, D3 item 3). Every
 * finisher writes `where run_id = $mine`, so a Run superseded by a takeover
 * writes nothing.
 */
@Injectable()
export class OutreachRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  /**
   * The Application's at most three rows (the unique key), for the GET. Order is
   * the service's. CR-7 (contract section 2 step 6): the Application is read
   * `FOR SHARE` in the same transaction as its rows, so a deletion takes the row
   * lock the GET holds and cannot turn a live read into three Not-written items.
   * `undefined` is the route's 404: missing, another Candidate's, or deleted.
   */
  read(applicationId: string): Promise<OutreachMessageRow[] | undefined> {
    return this.tenant.run(async (tx, candidateId) => {
      if (!(await lockLiveApplication(tx, candidateId, applicationId))) return undefined
      return tx
        .selectFrom("outreach_message")
        .select(["kind", "reader_name", "body", "profile_version", "written_at", "last_failure", "first_failed_sentence", "run_status", "run_started_at"])
        .where("candidate_id", "=", candidateId)
        .where("application_id", "=", applicationId)
        .execute()
    })
  }

  /**
   * CR-6 pre-body gate (contract section 2, step 6): is this the Candidate's live
   * Application? Reads it `FOR SHARE`, the lock the contract names, and answers
   * the same as the 404 rule. The writers re-check under their own locks, so this
   * is a check for the order of failures, not the authority.
   */
  liveApplication(applicationId: string): Promise<boolean> {
    return this.tenant.run((tx, candidateId) => lockLiveApplication(tx, candidateId, applicationId))
  }

  /**
   * D10: a Run lives in the api process, so a row still `running` when the api
   * starts was cut off by a restart. It becomes `idle` with `interrupted` and its
   * run token cleared; every text column and the Reader name are left alone, and
   * a row that is already `idle` is not touched at all, as
   * `DocumentsRepository.resetInterrupted` does. The sentence is cleared with the
   * cause (D13), as the failed-sentence check requires whenever the cause is not
   * `blocked`. Returns how many of this Candidate's rows were reset.
   */
  async resetInterrupted(at: Date): Promise<number> {
    const result = await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("outreach_message")
        .set({ run_status: "idle", run_id: null, run_started_at: null, last_failure: "interrupted", first_failed_sentence: null, updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("run_status", "=", "running")
        .executeTakeFirst()
    )
    return Number(result.numUpdatedRows)
  }

  /** The single approved `career_profile_version` row's version (G7); null when none is approved. */
  approvedProfileVersion(): Promise<number | null> {
    return this.tenant.run(async (tx, candidateId) => {
      const row = await tx
        .selectFrom("career_profile_version")
        .select("version")
        .where("candidate_id", "=", candidateId)
        .where("status", "=", "approved")
        .executeTakeFirst()
      return row?.version ?? null
    })
  }

  /**
   * Starts a Run for one Kind, or reports the one already in flight (D10).
   *
   * One atomic statement on `(candidate_id, application_id, kind)`: insert, or
   * update only while the row is not running or its Run is ten minutes old or
   * older. Zero rows returned means a live Run exists and nothing starts,
   * so a second click, a second tab or another tab's Run makes no model call and
   * reserves no spend (AC 7.6). A takeover clears the stale Run's token, cause
   * and sentence; its late finisher then writes nothing.
   *
   * The Application row is read `FOR SHARE` first (404 for missing, foreign and
   * details-deleted) and the ten minutes are measured from `at`, the request's
   * clock, not the database's, so a test clock and the read-time rule agree.
   */
  claimRun(applicationId: string, kind: OutreachKind, runId: string, at: Date): Promise<OutreachClaimOutcome> {
    return this.tenant.run(async (trx, candidateId) => {
      if (!(await lockLiveApplication(trx, candidateId, applicationId))) return { outcome: "not_found" } as const
      const staleBefore = new Date(at.getTime() - OUTREACH_STALE_RUN_MS)
      const { rows } = await sql<OutreachMessageRow>`
        insert into outreach_message (id, candidate_id, application_id, kind, run_status, run_id, run_started_at,
                                      last_failure, first_failed_sentence, created_at, updated_at)
        values (${randomUUID()}::uuid, ${candidateId}::uuid, ${applicationId}::uuid, ${kind}, 'running', ${runId}::uuid, ${at},
                null, null, ${at}, ${at})
        on conflict (candidate_id, application_id, kind) do update
          set run_status = 'running', run_id = excluded.run_id, run_started_at = excluded.run_started_at,
              last_failure = null, first_failed_sentence = null, updated_at = excluded.updated_at
          where outreach_message.run_status <> 'running'
             or outreach_message.run_started_at <= ${staleBefore}
        returning kind, reader_name, body, profile_version, written_at, last_failure, first_failed_sentence, run_status, run_started_at`.execute(trx)
      const claimed = rows[0]
      if (claimed !== undefined) return { outcome: "claimed", row: claimed } as const
      // The conflict's WHERE refused the claim: a Run under ten minutes old is in flight.
      const current = await this.currentRow(trx, candidateId, applicationId, kind)
      // RLS hid the row only if it belongs to another Candidate, which the Application read already refused.
      return current === undefined ? ({ outcome: "not_found" } as const) : ({ outcome: "running", row: current } as const)
    })
  }

  /**
   * Stores a Ready text in one update (D11): body, sentences, version and time
   * together, the cause and the sentence cleared, the run released. Returns false
   * when nothing was written: the details were deleted, or the Run was superseded
   * by a takeover (its token no longer matches).
   */
  finishReady(applicationId: string, kind: OutreachKind, runId: string, ready: ReadyOutreachText, at: Date): Promise<boolean> {
    return this.tenant.run(async (trx, candidateId) => {
      if (!(await lockLiveApplication(trx, candidateId, applicationId))) return false
      const result = await trx
        .updateTable("outreach_message")
        .set({
          body: ready.body,
          sentences: JSON.stringify(ready.sentences),
          profile_version: ready.profileVersion,
          written_at: at,
          last_failure: null,
          first_failed_sentence: null,
          run_status: "idle",
          run_id: null,
          run_started_at: null,
          updated_at: at,
        })
        .where("candidate_id", "=", candidateId)
        .where("application_id", "=", applicationId)
        .where("kind", "=", kind)
        .where("run_id", "=", runId)
        .executeTakeFirst()
      return Number(result.numUpdatedRows) > 0
    })
  }

  /**
   * Ends a Run without a new text (D11): stores the cause, or null when a pause
   * stopped it, and leaves every text column and the Reader name as they were.
   * The type excludes `blocked`, so a sentence-bearing ending cannot come here.
   */
  finishWithoutText(applicationId: string, kind: OutreachKind, runId: string, cause: Exclude<OutreachFailureCause, "blocked"> | null, at: Date): Promise<boolean> {
    return this.tenant.run(async (trx, candidateId) => {
      if (!(await lockLiveApplication(trx, candidateId, applicationId))) return false
      const result = await trx
        .updateTable("outreach_message")
        .set({ last_failure: cause, first_failed_sentence: null, run_status: "idle", run_id: null, run_started_at: null, updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("application_id", "=", applicationId)
        .where("kind", "=", kind)
        .where("run_id", "=", runId)
        .executeTakeFirst()
      return Number(result.numUpdatedRows) > 0
    })
  }

  /**
   * Ends a Run `blocked` and stores its first failed sentence (D13): the cause
   * and the sentence in the same update, with the Run released, so a notice and
   * its quote can never come from different Runs. The sentence is capped at 400
   * code points at a whole word, and withheld (null) when it names the Reader:
   * the comparison runs under the row lock, so a name saved at the same moment
   * and this write serialise and the invariant holds either way. No text column
   * and never `reader_name` is written.
   *
   * Returns what the log reports as `quote` (D7): `stored`, `withheld_name` when
   * the Reader-name comparison withheld it, or `none` when nothing was written or
   * there was no sentence to store. Only this writer can tell the three apart.
   */
  finishBlocked(applicationId: string, kind: OutreachKind, runId: string, sentence: string | null, at: Date): Promise<OutreachQuoteLog> {
    return this.tenant.run(async (trx, candidateId) => {
      if (!(await lockLiveApplication(trx, candidateId, applicationId))) return "none"
      const row = await trx
        .selectFrom("outreach_message")
        .select(["run_id", "reader_name"])
        .where("candidate_id", "=", candidateId)
        .where("application_id", "=", applicationId)
        .where("kind", "=", kind)
        .forUpdate()
        .executeTakeFirst()
      if (row === undefined || row.run_id !== runId) return "none"
      const capped = capFailedSentence(sentence)
      const stored = withheld(capped, row.reader_name)
      const result = await trx
        .updateTable("outreach_message")
        .set({ last_failure: "blocked", first_failed_sentence: stored, run_status: "idle", run_id: null, run_started_at: null, updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("application_id", "=", applicationId)
        .where("kind", "=", kind)
        .where("run_id", "=", runId)
        .executeTakeFirst()
      if (Number(result.numUpdatedRows) === 0) return "none"
      if (stored !== null) return "stored"
      return capped === null ? "none" : "withheld_name"
    })
  }

  /**
   * Saves the Reader name for one Kind (D8): an upsert on the unique key that
   * writes `reader_name` and `updated_at` only, so it can never overwrite a text
   * or a Run in progress, and it is allowed during a pause and while a Run is in
   * flight (AC 5.5). A stored first failed sentence that holds the new name is
   * set to null in the same write (D13); `last_failure` stays `blocked`.
   */
  saveReaderName(applicationId: string, kind: OutreachKind, readerName: string, at: Date): Promise<OutreachMessageRow | undefined> {
    return this.writeReaderName(applicationId, kind, readerName, at)
  }

  /** Clears the Reader name. As in D13, a stored first failed sentence stays as it was. */
  clearReaderName(applicationId: string, kind: OutreachKind, at: Date): Promise<OutreachMessageRow | undefined> {
    return this.writeReaderName(applicationId, kind, null, at)
  }

  /**
   * The one name write. Locking the row before the upsert is what serialises the
   * D13 comparison with `finishBlocked`; the Application is read `FOR SHARE`
   * first (404 for missing, foreign and details-deleted). A clear keeps the
   * sentence; only a saved name that the sentence holds nulls it, because the
   * sentence is model text that would otherwise quote the Reader back.
   */
  private writeReaderName(applicationId: string, kind: OutreachKind, readerName: string | null, at: Date): Promise<OutreachMessageRow | undefined> {
    return this.tenant.run(async (trx, candidateId) => {
      if (!(await lockLiveApplication(trx, candidateId, applicationId))) return undefined
      const stored = await trx
        .selectFrom("outreach_message")
        .select("first_failed_sentence")
        .where("candidate_id", "=", candidateId)
        .where("application_id", "=", applicationId)
        .where("kind", "=", kind)
        .forUpdate()
        .executeTakeFirst()
      const clears = readerName !== null && stored?.first_failed_sentence != null && mentionsReaderName(stored.first_failed_sentence, readerName)
      const rows = await trx
        .insertInto("outreach_message")
        .values({
          id: randomUUID(),
          candidate_id: candidateId,
          application_id: applicationId,
          kind,
          reader_name: readerName,
          body: null,
          sentences: null,
          profile_version: null,
          written_at: null,
          last_failure: null,
          first_failed_sentence: null,
          run_id: null,
          run_started_at: null,
          created_at: at,
          updated_at: at,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["candidate_id", "application_id", "kind"])
            .doUpdateSet({ reader_name: readerName, updated_at: at, ...(clears ? { first_failed_sentence: null } : {}) })
        )
        .returning(["kind", "reader_name", "body", "profile_version", "written_at", "last_failure", "first_failed_sentence", "run_status", "run_started_at"])
        .execute()
      return rows[0]
    })
  }

  /** The row after a refused claim, in the same transaction (RLS keeps it to the Candidate's own). */
  private currentRow(tx: CandidateTx, candidateId: string, applicationId: string, kind: OutreachKind): Promise<OutreachMessageRow | undefined> {
    return tx
      .selectFrom("outreach_message")
      .select(["kind", "reader_name", "body", "profile_version", "written_at", "last_failure", "first_failed_sentence", "run_status", "run_started_at"])
      .where("candidate_id", "=", candidateId)
      .where("application_id", "=", applicationId)
      .where("kind", "=", kind)
      .executeTakeFirst()
  }
}

/** The sentence to store: null as given, null when nothing survived the cap, or null when it names the Reader. */
function withheld(sentence: string | null, readerName: string | null): string | null {
  if (sentence === null) return null
  if (readerName !== null && mentionsReaderName(sentence, readerName)) return null
  return sentence
}

/**
 * Reads the Application row `FOR SHARE` and says whether its details are still
 * there (D3, D4). Deletion takes it `FOR UPDATE`, so the two serialise: a request
 * that arrives during a deletion answers normally when the deletion had not
 * committed, and `not_found` after it had. Missing, another Candidate's and
 * details-deleted are the same answer on every Outreach route.
 */
async function lockLiveApplication(trx: CandidateTx, candidateId: string, applicationId: string): Promise<boolean> {
  const row = await trx
    .selectFrom("application")
    .select("details_deleted_at")
    .where("candidate_id", "=", candidateId)
    .where("id", "=", applicationId)
    .forShare()
    .executeTakeFirst()
  return row !== undefined && row.details_deleted_at === null
}
