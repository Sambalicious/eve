import { lstat } from "node:fs/promises"

import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common"
import { TenantDatabase } from "../db/tenant-database.js"
import { CandidateFiles } from "../files/candidate-files.js"
import { STORAGE_NAME } from "./document-storage.js"

/** E4.4 (D-E4): first sweep 60 s after api start, then every hour. */
export const SWEEP_FIRST_DELAY_MS = 60_000
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000
/** A file younger than this is never removed: a generation writes its files before it commits its rows. */
export const SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000
/** pg_try_advisory_lock key: one sweep at a time across api instances. */
export const SWEEP_LOCK_KEY = 72_000_914

/**
 * `skippedCandidates`: Candidates whose `documents` directory could not be read this run (F-SEC-42).
 * `skipped`: "locked" (another sweep holds the lock, nothing done), "unreadable" (the Candidate list, or at least one Candidate's directory, could not be read).
 */
export type SweepResult = Readonly<{ scanned: number; removed: number; failed: number; ignored: number; skippedCandidates: number; skipped?: "locked" | "unreadable" }>

/**
 * The api's orphan document file sweep (PRD E4.4, D-E4, D-E13; architecture
 * "Files and orphan sweep"). The worker mounts the document volume read-only,
 * so automatic expiry only releases file names; this sweep, in the only
 * process that can write the volume, removes every file that:
 * - matches the storage name pattern `<uuid>.pdf|docx` (any other name is left alone),
 * - is a regular file (lstat: a symlink is never followed or removed),
 * - was last modified more than 24 hours ago,
 * - and no `tailored_document` row references, re-checked just before the unlink.
 * It never writes the database. A Candidate whose `documents` path cannot be
 * listed (not a real directory, unreadable) is skipped with a warning and the
 * sweep goes on to the next (F-CR-11); the result then carries
 * `skipped: "unreadable"` and counts them in `skippedCandidates`, with the
 * counts of the rest. It logs one counts line when it removed, failed to
 * remove a file or skipped a Candidate (F-SEC-42), so a Candidate skipped
 * every hour shows in every run's summary. No log line holds a file name or
 * path (E6.3): only counts, error codes and Candidate IDs.
 *
 * EPIC-0002 A1 (merge 11): `tailored_document` is Candidate data, so "no row
 * references it" means no row of ANY Candidate: the sweep reads the Candidate
 * IDs from the identity table and checks each Candidate's rows in that
 * Candidate's `CandidateTx`. A2: files are per Candidate (`CandidateFiles`), so
 * each Candidate's `documents` directory is compared with that Candidate's rows.
 */
@Injectable()
export class DocumentSweep implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DocumentSweep.name)
  private first: NodeJS.Timeout | null = null
  private interval: NodeJS.Timeout | null = null

  constructor(
    private readonly tenant: TenantDatabase,
    @Inject(CandidateFiles) private readonly files: CandidateFiles
  ) {}

  onApplicationBootstrap(): void {
    this.first = setTimeout(() => {
      void this.runLogged()
      this.interval = setInterval(() => void this.runLogged(), SWEEP_INTERVAL_MS)
      this.interval.unref()
    }, SWEEP_FIRST_DELAY_MS)
    this.first.unref()
  }

  onApplicationShutdown(): void {
    if (this.first) clearTimeout(this.first)
    if (this.interval) clearInterval(this.interval)
  }

  async sweep(): Promise<SweepResult> {
    const result = await this.tenant.tryWithSessionLock(SWEEP_LOCK_KEY, () => this.sweepUnlocked())
    return result === "locked" ? { scanned: 0, removed: 0, failed: 0, ignored: 0, skippedCandidates: 0, skipped: "locked" } : result
  }

  private async sweepUnlocked(): Promise<SweepResult> {
    const total = { scanned: 0, removed: 0, failed: 0, ignored: 0, skippedCandidates: 0 }
    let candidateIds: string[]
    try {
      candidateIds = await this.tenant.candidateIds()
    } catch (error) {
      this.logger.warn(`Document sweep: could not read the Candidate list (${errorCode(error)}); removed 0, not removed 0`)
      return { ...total, skipped: "unreadable" }
    }
    for (const candidateId of candidateIds) {
      let names: string[]
      try {
        names = await this.files.list(candidateId, "documents")
      } catch (error) {
        // F-CR-11: skip only this Candidate; the others are still swept. Error code and ID only, never a path.
        this.logger.warn(`Document sweep: skipped a Candidate whose document directory could not be read (${errorCode(error)}, Candidate ${candidateId}); nothing removed for them`)
        total.skippedCandidates++
        continue
      }
      const result = await this.sweepCandidate(candidateId, names)
      total.scanned += result.scanned
      total.removed += result.removed
      total.failed += result.failed
      total.ignored += result.ignored
    }
    if (total.removed + total.failed + total.skippedCandidates > 0) {
      this.logger.log(`Document sweep: scanned ${total.scanned}, removed ${total.removed}, not removed ${total.failed}, ignored ${total.ignored}, skipped Candidates ${total.skippedCandidates}`)
    }
    return total.skippedCandidates > 0 ? { ...total, skipped: "unreadable" } : total
  }

  private async sweepCandidate(candidateId: string, names: readonly string[]): Promise<Omit<SweepResult, "skipped" | "skippedCandidates">> {
    // Wall time, not the injected business clock: mtimes are filesystem time.
    const cutoff = Date.now() - SWEEP_MIN_AGE_MS
    let ignored = 0
    const old: string[] = []
    for (const name of names) {
      if (!STORAGE_NAME.test(name)) {
        ignored++
        continue
      }
      try {
        const info = await lstat(this.files.path(candidateId, "documents", name))
        if (!info.isFile()) ignored++
        else if (info.mtime.getTime() < cutoff) old.push(name)
      } catch {
        ignored++
      }
    }
    const referenced = await this.referenced(candidateId, old)
    let removed = 0
    let failed = 0
    for (const name of old.filter((candidate) => !referenced.has(candidate))) {
      // Closes the race with a generation that committed rows for this name after the first read.
      if ((await this.referenced(candidateId, [name])).size > 0) continue
      try {
        await this.removeFile(candidateId, name)
        removed++
      } catch {
        failed++
      }
    }
    return { scanned: names.length, removed, failed, ignored }
  }

  /** The unlink, through the storage name and root checks (SEC-705). A seam for the failed-removal test. */
  protected removeFile(candidateId: string, name: string): Promise<void> {
    return this.files.remove(candidateId, "documents", name)
  }

  /** The names among `names` that this Candidate's Tailored Documents reference, read in their own scope. */
  private async referenced(candidateId: string, names: readonly string[]): Promise<Set<string>> {
    if (names.length === 0) return new Set()
    const found = new Set<string>()
    const rows = await this.tenant.forCandidate(candidateId, (tx) =>
      tx
        .selectFrom("tailored_document")
        .select(["pdf_storage_name", "docx_storage_name"])
        .where("candidate_id", "=", candidateId)
        .where((eb) => eb.or([eb("pdf_storage_name", "in", names), eb("docx_storage_name", "in", names)]))
        .execute()
    )
    for (const row of rows) for (const name of [row.pdf_storage_name, row.docx_storage_name]) found.add(name)
    return found
  }

  private async runLogged(): Promise<void> {
    try {
      await this.sweep()
    } catch (error) {
      this.logger.warn(`Document sweep failed: ${errorCode(error)}`)
    }
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code
  return error instanceof Error ? error.name : "unknown"
}
