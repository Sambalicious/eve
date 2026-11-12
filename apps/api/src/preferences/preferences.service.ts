import { Inject, Injectable, Logger } from "@nestjs/common"
import { type PreferencesResponse, type PreferencesValues, type PreferencesVersionsResponse, STEP3_DEFAULTS } from "@eve/contracts"

import { ApiException } from "../http/api-exception.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { matchedRegions, timeZoneLockedUntil } from "./preferences-rules.js"
import { PreferencesRepository, type StoredPreferences } from "./preferences.repository.js"

/**
 * The session Candidate's Job Preferences (EPIC-0002 B1, contract v1.25.0).
 * No ModelGateway, SpendLedger or fetch: reads and saves make no model call
 * and write no spend entry.
 */
@Injectable()
export class PreferencesService {
  private readonly logger = new Logger(PreferencesService.name)

  constructor(
    private readonly repository: PreferencesRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async read(): Promise<PreferencesResponse> {
    const record = await this.repository.read()
    if (!record) return { version: null, savedAt: null, timeZoneLockedUntil: null, matchedRegions: [], values: STEP3_DEFAULTS }
    return this.toResponse(record)
  }

  /** Version check, D41, write, effects: one transaction. A refusal writes nothing. */
  async save(baseVersion: number | null, values: PreferencesValues): Promise<PreferencesResponse> {
    const now = this.clock.now()
    const outcome = await this.repository.save({ baseVersion, values, now }, (lastChangeAt) => timeZoneLockedUntil(lastChangeAt, now) !== null)
    if (outcome.kind === "stale") throw ApiException.preferencesStale(outcome.currentVersion)
    if (outcome.kind === "time_zone_locked") throw ApiException.timeZoneChangeRateLimited(timeZoneLockedUntil(outcome.lastTimeZoneChangeAt, now)!)
    // Counts and versions only: never a stored value (TM-B1 logging rule).
    this.logger.log(JSON.stringify({ event: "preferences.saved", version: outcome.record.version }))
    return this.toResponse(outcome.record)
  }

  async versions(limit: number, before: number | null): Promise<PreferencesVersionsResponse> {
    const rows = await this.repository.versions(limit, before)
    const page = rows.slice(0, limit)
    return {
      versions: page.map((row) => ({ version: row.version, savedAt: row.savedAt.toISOString(), values: row.values })),
      nextBefore: rows.length > limit ? page.at(-1)!.version : null,
    }
  }

  private toResponse(record: StoredPreferences): PreferencesResponse {
    return {
      version: record.version,
      savedAt: record.savedAt.toISOString(),
      timeZoneLockedUntil: timeZoneLockedUntil(record.lastTimeZoneChangeAt, this.clock.now())?.toISOString() ?? null,
      matchedRegions: matchedRegions(record.values),
      values: record.values,
    }
  }
}
