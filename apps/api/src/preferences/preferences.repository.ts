import { Injectable } from "@nestjs/common"
import { type PreferencesValues, preferencesValuesSchema } from "@eve/contracts"

import { sql } from "../db/sql.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { applyTransactionTimeouts, transactionTimeouts } from "../db/transaction-timeouts.js"
import { readHistoryValues } from "./history-upgrade.js"
import { PreferencesSaveEffects } from "./preferences-save-effects.js"

/** Contract v1.25.0 "Side effects": lock wait 3 s, statement 10 s. A lock wait over 3 s is a 500 and rolls back. */
export const PREFERENCES_SAVE_TIMEOUTS = transactionTimeouts(3_000, 10_000)

const UNIQUE_VIOLATION = "23505"

export type StoredPreferences = Readonly<{
  version: number
  savedAt: Date
  values: PreferencesValues
  /** D41: when the last accepted save that changed the time zone was made; null when only the first set exists. */
  lastTimeZoneChangeAt: Date | null
}>

export type StoredVersion = Readonly<{ version: number; savedAt: Date; values: PreferencesValues }>

export type SaveRequest = Readonly<{ baseVersion: number | null; values: PreferencesValues; now: Date }>

/** What the save did, or why it wrote nothing. The service maps refusals to errors. */
export type SaveOutcome =
  | Readonly<{ kind: "saved"; record: StoredPreferences }>
  | Readonly<{ kind: "stale"; currentVersion: number | null }>
  | Readonly<{ kind: "time_zone_locked"; lastTimeZoneChangeAt: Date }>

/** Decides, inside the save's transaction, whether a time zone change is refused (D41). Injected so the clock rule stays pure. */
export type TimeZoneGate = (lastChangeAt: Date | null) => boolean

type HeadRow = { version: number; values: unknown }

/**
 * The session Candidate's `job_preferences` (current) and
 * `job_preferences_version` (immutable history). Every statement runs in the
 * scope's `CandidateTx` (`TenantDatabase.run`, `bind_candidate`) and names the
 * Candidate's ID; forced RLS admits only that Candidate's rows.
 */
@Injectable()
export class PreferencesRepository {
  constructor(
    private readonly tenant: TenantDatabase,
    private readonly effects: PreferencesSaveEffects
  ) {}

  /** The current record, or null. Writes nothing. */
  read(): Promise<StoredPreferences | null> {
    return this.tenant.run(async (trx, candidateId) => {
      const head = await trx.selectFrom("job_preferences").select(["version", "values"]).where("candidate_id", "=", candidateId).executeTakeFirst()
      return head ? this.recordOf(trx, candidateId, head) : null
    })
  }

  /** Newest first, versions below `before` (all when null), at most `limit` + 1 rows so the caller can tell whether more exist. */
  versions(limit: number, before: number | null): Promise<StoredVersion[]> {
    return this.tenant.run(async (trx, candidateId) => {
      let query = trx.selectFrom("job_preferences_version").select(["version", "saved_at", "values"]).where("candidate_id", "=", candidateId)
      if (before !== null) query = query.where("version", "<", before)
      const rows = await query.orderBy("version", "desc").limit(limit + 1).execute()
      // F-QA-B1-01: history rows are immutable (D40); a row in the 0018 shape reads through 0027's mapping.
      return rows.map((row) => ({ version: row.version, savedAt: row.saved_at, values: historyValues(row.values) }))
    })
  }

  /**
   * One transaction (contract "Order of checks" after field validation): lock
   * the head row FOR UPDATE (or insert it for the first save), check the
   * version, check D41, write version V and the head, then run the save
   * effects (re-decision, unit 5) on the same transaction. A refusal writes
   * nothing. Any failure rolls back the version, the record and every effect.
   */
  save(request: SaveRequest, timeZoneRefused: TimeZoneGate): Promise<SaveOutcome> {
    return this.tenant.run(async (trx, candidateId): Promise<SaveOutcome> => {
      await applyTransactionTimeouts(trx, PREFERENCES_SAVE_TIMEOUTS)
      const text = JSON.stringify(request.values)
      if (request.baseVersion === null) {
        // First save. A concurrent first save waits on the primary key and then inserts nothing: it is the stale one.
        const inserted = await trx
          .insertInto("job_preferences")
          .values({ candidate_id: candidateId, version: 1, values: text, updated_at: request.now } as never)
          .onConflict((oc) => oc.column("candidate_id").doNothing())
          .returning("version")
          .executeTakeFirst()
        if (!inserted) return { kind: "stale", currentVersion: await currentVersion(trx, candidateId) }
        await this.writeVersion(trx, candidateId, 1, text, request.now)
        await this.effects.afterSave(trx, { candidateId, version: 1, previous: null, values: request.values })
        return { kind: "saved", record: { version: 1, savedAt: request.now, values: request.values, lastTimeZoneChangeAt: null } }
      }

      const head = await trx.selectFrom("job_preferences").select(["version", "values"]).where("candidate_id", "=", candidateId).forUpdate().executeTakeFirst()
      if (!head) return { kind: "stale", currentVersion: null }
      if (head.version !== request.baseVersion) return { kind: "stale", currentVersion: head.version }
      const previous = storedValues(head.values)
      const lastChangeAt = await lastTimeZoneChangeAt(trx, candidateId)
      const changesZone = previous.timeZone !== request.values.timeZone
      if (changesZone && timeZoneRefused(lastChangeAt)) return { kind: "time_zone_locked", lastTimeZoneChangeAt: lastChangeAt! }

      const next = head.version + 1
      await this.writeVersion(trx, candidateId, next, text, request.now)
      await trx.updateTable("job_preferences").set({ version: next, values: text, updated_at: request.now } as never).where("candidate_id", "=", candidateId).execute()
      await this.effects.afterSave(trx, { candidateId, version: next, previous, values: request.values })
      return { kind: "saved", record: { version: next, savedAt: request.now, values: request.values, lastTimeZoneChangeAt: changesZone ? request.now : lastChangeAt } }
    }).catch((error: unknown) => {
      // The loser of two first saves on a pooled connection can also see the key violation itself.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION && request.baseVersion === null) return this.staleAfterRace()
      throw error
    })
  }

  private async staleAfterRace(): Promise<SaveOutcome> {
    return { kind: "stale", currentVersion: await this.tenant.run((trx, candidateId) => currentVersion(trx, candidateId)) }
  }

  private async writeVersion(trx: CandidateTx, candidateId: string, version: number, text: string, savedAt: Date): Promise<void> {
    await trx.insertInto("job_preferences_version").values({ candidate_id: candidateId, version, values: text, saved_at: savedAt } as never).execute()
  }

  private async recordOf(trx: CandidateTx, candidateId: string, head: HeadRow): Promise<StoredPreferences> {
    const saved = await trx.selectFrom("job_preferences_version").select("saved_at").where("candidate_id", "=", candidateId).where("version", "=", head.version).executeTakeFirst()
    return { version: head.version, savedAt: saved?.saved_at ?? new Date(0), values: storedValues(head.values), lastTimeZoneChangeAt: await lastTimeZoneChangeAt(trx, candidateId) }
  }
}

async function currentVersion(trx: CandidateTx, candidateId: string): Promise<number | null> {
  const row = await trx.selectFrom("job_preferences").select("version").where("candidate_id", "=", candidateId).executeTakeFirst()
  return row?.version ?? null
}

/** D41: the newest version whose time zone differs from the version before it. Version 1 (the first set) is never a change. */
async function lastTimeZoneChangeAt(trx: CandidateTx, candidateId: string): Promise<Date | null> {
  const { rows } = await sql<{ saved_at: Date }>`
    select saved_at from (
      select version, saved_at, values ->> 'timeZone' as zone,
             lag(values ->> 'timeZone') over (order by version) as previous_zone
      from job_preferences_version where candidate_id = ${candidateId}::uuid
    ) v
    where previous_zone is not null and zone is distinct from previous_zone
    order by version desc limit 1`.execute(trx)
  return rows[0]?.saved_at ?? null
}

/**
 * A stored value read back. It was validated on write, so a failure here is
 * corrupt data: a 500 whose log names no stored value (TM-B1 corrupt-value case).
 */
/** A history row read back: the current shape, or the 0018 shape upgraded in memory; anything else is corrupt (500, no value logged). */
function historyValues(value: unknown): PreferencesValues {
  const values = readHistoryValues(value)
  if (values === null) throw new Error("Stored Job Preferences history row matches neither the v1.25.0 nor the 0018 shape")
  return values
}

function storedValues(value: unknown): PreferencesValues {
  const parsed = preferencesValuesSchema.safeParse(value)
  if (!parsed.success) throw new Error("Stored Job Preferences do not match the v1.25.0 shape")
  return parsed.data
}
