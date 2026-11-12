import { Inject, Injectable, Logger } from "@nestjs/common"

import { cleanPostingName } from "../career-profile/posting-name.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { SPEND_CONFIG } from "../spend/spend-config.js"
import { SpendLedger } from "../spend/spend-ledger.js"
import type { SpendConfig } from "../spend/spend-math.js"
import { applicationSystemName, normaliseApplicationUrl } from "./application-url.js"
import { DiscoveryRepository, type StoredPosting } from "./discovery.repository.js"
import { applyModeFor, preFilter } from "./pre-filters.js"
import { zoneOffsetMinutes } from "./rules/hours.js"
import { readEmployerBoard } from "./sources/ats-readers.js"
import { hasJobBody, lookUpAtsPosting } from "./sources/ats-lookup.js"
import { BOARD_HTTP } from "./sources/board-http.provider.js"
import type { BoardHttp } from "./sources/board-http.js"
import { type DiscoveredPosting, EMPTY_STRUCTURED } from "./sources/discovered-posting.js"
import { resolvePostedDate } from "./sources/posted-date.js"
import { readRemoteBoard, resolveThroughAts } from "./sources/remote-boards.js"

export const DISCOVERY_TIME_ZONE = "Africa/Lagos"

export type DiscoveryRunSummary = Readonly<{
  started: boolean
  reason: "global_paused" | "cost_paused" | "employer_list_not_approved" | null
  sourcesRead: number
  sourcesFailed: number
  stored: number
  alreadyStored: number
  postingIdsToEvaluate: string[]
  /** AC 10.1: the global or cost pause turned on during the run; later sources were not read. */
  stoppedByPause?: boolean
}>

type Origin = Readonly<{
  origin: "employer_board" | "remote_board" | "pasted_link"
  employerBoardId: string | null
  remoteBoardKey: "himalayas" | "remoteok" | "remotive" | "weworkremotely" | null
}>

/**
 * Discovery (AC 3.1 to 3.4). Reads Job Sources, stores each posting once, runs
 * the deterministic pre-filters, and returns the postings that need an
 * evaluation. Pasted links go through `ingestPastedLink`, the same store and
 * pre-filters. Evaluation runs separately (PostingEvaluator).
 */
@Injectable()
export class DiscoveryPipeline {
  private readonly logger = new Logger(DiscoveryPipeline.name)

  constructor(
    private readonly repository: DiscoveryRepository,
    @Inject(BOARD_HTTP) private readonly http: BoardHttp,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ledger: SpendLedger,
    @Inject(SPEND_CONFIG) private readonly spend: SpendConfig
  ) {}

  /**
   * The daily run. It does nothing while the global pause is on or until the
   * employer list is approved, and reads each enabled source at most once per
   * Africa/Lagos day. `ignoreApproval` exists only for development and test runs
   * against the draft list (AC 3.2); the scheduled job never sets it.
   */
  async runDaily(options: { ignoreApproval?: boolean } = {}): Promise<DiscoveryRunSummary> {
    const control = await this.repository.readControl()
    if (control.global_paused) return notStarted("global_paused")
    const list = await this.repository.readEmployerListState()
    if (list.approved_at === null && options.ignoreApproval !== true) return notStarted("employer_list_not_approved")
    // Slice 7: a discovery run is a paid action (`SPEND_DISCOVERY_RUN_USD`, default 0). It reserves first, so the
    // cost pause and the global pause stop it before any Job Source is read (SEC-306: no run without the ceiling).
    const reservation = await this.ledger.reserve({ category: "discovery", purpose: "discovery_run", estimateMicros: this.spend.discoveryRunMicros, action: "discovery run", haltOnGlobalPause: true })
    if (!reservation.ok) return notStarted(reservation.refusal === "paused" ? "global_paused" : "cost_paused")
    try {
      return await this.readAll()
    } finally {
      await this.ledger.settle(reservation.id, this.spend.discoveryRunMicros)
    }
  }

  private async readAll(): Promise<DiscoveryRunSummary> {

    const now = this.clock.now()
    const since = startOfDay(now, DISCOVERY_TIME_ZONE)
    const summary = { started: true, reason: null, sourcesRead: 0, sourcesFailed: 0, stored: 0, alreadyStored: 0, postingIdsToEvaluate: [] as string[] }

    for (const board of await this.repository.listEmployerBoards()) {
      if (await this.pausedMidRun()) return { ...summary, stoppedByPause: true }
      if (!(await this.repository.claimBoardRead("employer_board", board.id, since, now))) continue
      await this.readSource(summary, () =>
        readEmployerBoard(this.http, { company: board.company, applicationSystem: board.application_system, boardToken: board.board_token })
      , { origin: "employer_board", employerBoardId: board.id, remoteBoardKey: null })
    }
    for (const board of await this.repository.listRemoteBoards()) {
      if (!board.enabled || !board.available || board.verified_on === null) continue
      if (await this.pausedMidRun()) return { ...summary, stoppedByPause: true }
      if (!(await this.repository.claimBoardRead("remote_board", board.key, since, now))) continue
      await this.readSource(summary, async () => {
        const postings = await readRemoteBoard(this.http, board.key)
        const resolved: DiscoveredPosting[] = []
        for (const posting of postings) {
          // One ATS lookup per posting: re-check the pause between them so a long board stops within the bound.
          if (await this.pausedMidRun()) break
          resolved.push(await resolveThroughAts(this.http, posting))
        }
        return resolved
      }, { origin: "remote_board", employerBoardId: null, remoteBoardKey: board.key })
    }
    return summary
  }

  /** AC 10.1: checked before each source read; one board read is bounded by the HTTP timeout, well under a minute. */
  private async pausedMidRun(): Promise<boolean> {
    const control = await this.repository.readControl()
    return control.global_paused || control.cost_paused
  }

  /**
   * A pasted link (AC 3.3). An already stored URL is recognised first, with no
   * network read. A Greenhouse, Lever or Ashby URL is resolved through its
   * public API to get the requisition key and text; any other URL is stored as
   * a Manual Application candidate. Job pages are never fetched.
   */
  async ingestPastedLink(url: string): Promise<StoredPosting & { evaluate: boolean }> {
    const normalised = normaliseApplicationUrl(url)
    const known = await this.repository.findByUrl(normalised)
    if (known) return { id: known.id, created: false, evaluate: false }
    const resolved = await lookUpAtsPosting(this.http, url).catch((error: unknown) => {
      this.logger.warn(`Pasted link lookup failed: ${error instanceof Error ? error.name : "unknown"}`)
      return null
    })
    const posting: DiscoveredPosting = resolved ?? {
      applicationUrl: normalised,
      requisitionId: normalised,
      applyUrl: url,
      title: "",
      company: "",
      text: "",
      structured: EMPTY_STRUCTURED,
      attribution: null,
      manualOnly: false,
      // A non-ATS link carries no date (P2: undated, so hidden).
      postedDate: [],
    }
    const stored = await this.store(posting, { origin: "pasted_link", employerBoardId: null, remoteBoardKey: null })
    // FU-4 (AC-5.8 on the paste path, owner decision 2026-10-29): `evaluate` is true for a new checking row and for a
    // not_checked row this paste's backfill claimed to checking; both are evaluated now. The claim is a conditional
    // update, so a repeat paste claims nothing and never starts a second evaluation.
    return { ...stored.result, evaluate: stored.evaluate }
  }

  /**
   * EPIC-0010 (contract step 6, PD-1.6): the public API lookup of a Greenhouse, Lever or Ashby link
   * sent with a description, outside any transaction. Null when the lookup failed (404, timeout, 5xx)
   * or found no job text; a non-ATS link returns null before any I/O.
   */
  async lookUpForDescription(url: string): Promise<DiscoveredPosting | null> {
    const resolved = await lookUpAtsPosting(this.http, url).catch((error: unknown) => {
      this.logger.warn(`Pasted link lookup failed: ${error instanceof Error ? error.name : "unknown"}`)
      return null
    })
    return resolved !== null && hasJobBody(resolved) ? resolved : null
  }

  /** EPIC-0010 (OQ-3): a readable ATS posting found for a link sent with a description is stored as a pasted link; the description is discarded. */
  async storeResolvedLink(posting: DiscoveredPosting): Promise<StoredPosting & { evaluate: boolean }> {
    const stored = await this.store(posting, { origin: "pasted_link", employerBoardId: null, remoteBoardKey: null })
    return { ...stored.result, evaluate: stored.evaluate }
  }

  private async readSource(
    summary: { sourcesRead: number; sourcesFailed: number; stored: number; alreadyStored: number; postingIdsToEvaluate: string[] },
    read: () => Promise<DiscoveredPosting[]>,
    origin: Origin
  ): Promise<void> {
    let postings: DiscoveredPosting[]
    try {
      postings = await read()
    } catch (error) {
      summary.sourcesFailed += 1
      this.logger.warn(`Job Source read failed: ${error instanceof Error ? error.message : "unknown"}`)
      return
    }
    summary.sourcesRead += 1
    for (const posting of postings) {
      const stored = await this.store(posting, origin)
      if (!stored.result.created) {
        summary.alreadyStored += 1
        // EPIC-0006 (AC-5.8): a backfill made this Candidate's not_checked row visible; it was claimed, so queue it.
        if (stored.evaluate) summary.postingIdsToEvaluate.push(stored.result.id)
        continue
      }
      summary.stored += 1
      if (stored.evaluate) summary.postingIdsToEvaluate.push(stored.result.id)
    }
  }

  /**
   * Stores the posting for the scope's Candidate. The pre-filter is handed to
   * the repository unrun: it runs only if this call stores the shared posting
   * first; otherwise the stored skip is copied (AC 5.17, architecture r4).
   * Manual Applications (other systems, and boards whose terms require it) are
   * skipped before any AI cost.
   */
  private async store(posting: DiscoveredPosting, origin: Origin): Promise<{ result: StoredPosting; evaluate: boolean }> {
    const applyMode = applyModeFor(posting.applicationUrl, posting.manualOnly)
    // EPIC-0006 (AC-5.4): the date is bounded against the moment this posting was read.
    const now = this.clock.now()
    // SEC-410: title and company are stored as one clean, bounded line.
    const title = cleanPostingName(posting.title)
    const stored = await this.repository.storeOnce(
      {
        applicationUrl: posting.applicationUrl,
        requisitionId: posting.requisitionId,
        applyUrl: posting.applyUrl,
        applicationSystem: applicationSystemName(posting.applicationUrl),
        applyMode,
        origin: origin.origin,
        employerBoardId: origin.employerBoardId,
        remoteBoardKey: origin.remoteBoardKey,
        attribution: posting.attribution,
        title,
        company: cleanPostingName(posting.company),
        postingText: posting.text,
        structured: posting.structured,
        discoveredAt: now,
        ...resolvePostedDate(posting.postedDate, now),
      },
      () => preFilter({ title })
    )
    return { result: { id: stored.id, created: stored.created }, evaluate: stored.evaluate }
  }
}

function notStarted(reason: "global_paused" | "cost_paused" | "employer_list_not_approved"): DiscoveryRunSummary {
  return { started: false, reason, sourcesRead: 0, sourcesFailed: 0, stored: 0, alreadyStored: 0, postingIdsToEvaluate: [] }
}

/** Midnight at the start of `now`'s calendar day in `timeZone`, as an instant. */
export function startOfDay(now: Date, timeZone: string): Date {
  const offsetMs = zoneOffsetMinutes(timeZone, now) * 60_000
  const local = new Date(now.getTime() + offsetMs)
  local.setUTCHours(0, 0, 0, 0)
  return new Date(local.getTime() - offsetMs)
}
