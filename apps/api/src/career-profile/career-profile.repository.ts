import { Injectable } from "@nestjs/common"
import { type Selectable } from "kysely"
import { sql } from "../db/sql.js"

import { CandidateScope } from "../db/candidate-scope.js"
import type { CareerProfileVersionTable, ResumeUploadTable, StoredSection } from "../db/schema.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"

export type VersionRow = Selectable<CareerProfileVersionTable>
export type ResumeUploadRow = Selectable<ResumeUploadTable>

const UNIQUE_VIOLATION = "23505"

/**
 * Serialises every version change of one Candidate: one draft, one approved
 * version, no lost update. The second key is the Candidate, so two Candidates
 * never wait on each other.
 */
const VERSION_LOCK_KEY = 72_000_002

/** The Candidate whose `CandidateTx` a method was handed (`forCandidate` sets the scope with the setting). */
const scoped = (): string => CandidateScope.require()

/**
 * The scope's Candidate's Career Profile versions and resume uploads only.
 * Methods that take a `trx` run inside `inVersionLock`'s `CandidateTx`; every
 * statement names its `candidate_id` (EPIC-0002 A1).
 */
@Injectable()
export class CareerProfileRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  listVersions(): Promise<VersionRow[]> {
    return this.tenant.run((tx, candidateId) =>
      tx.selectFrom("career_profile_version").selectAll().where("candidate_id", "=", candidateId).orderBy("version", "desc").execute()
    )
  }

  findVersion(version: number): Promise<VersionRow | undefined> {
    return this.tenant.run((tx, candidateId) =>
      tx.selectFrom("career_profile_version").selectAll().where("candidate_id", "=", candidateId).where("version", "=", version).executeTakeFirst()
    )
  }

  /**
   * Inside `inVersionLock`, pass its `trx`: a query on the pool from there waits
   * for a second connection while holding the lock, and with the pool busy with
   * other lock waiters that never comes (CR2-01).
   */
  latestUpload(trx?: CandidateTx): Promise<ResumeUploadRow | undefined> {
    const read = (tx: CandidateTx, candidateId: string) =>
      tx.selectFrom("resume_upload").selectAll().where("candidate_id", "=", candidateId).orderBy("started_at", "desc").orderBy("id", "desc").limit(1).executeTakeFirst()
    return trx ? read(trx, scoped()) : this.tenant.run(read)
  }

  /** Runs `work` holding the Candidate's version lock, so their concurrent saves and approvals queue. */
  inVersionLock<T>(work: (trx: CandidateTx) => Promise<T>): Promise<T> {
    return this.tenant.run(async (trx, candidateId) => {
      await sql`select pg_advisory_xact_lock(${VERSION_LOCK_KEY}::int, hashtext(${candidateId}))`.execute(trx)
      return work(trx)
    })
  }

  findDraft(trx: CandidateTx): Promise<VersionRow | undefined> {
    return trx.selectFrom("career_profile_version").selectAll().where("candidate_id", "=", scoped()).where("status", "=", "draft").executeTakeFirst()
  }

  findApproved(trx?: CandidateTx): Promise<VersionRow | undefined> {
    const read = (tx: CandidateTx, candidateId: string) =>
      tx.selectFrom("career_profile_version").selectAll().where("candidate_id", "=", candidateId).where("status", "=", "approved").executeTakeFirst()
    return trx ? read(trx, scoped()) : this.tenant.run(read)
  }

  async nextVersion(trx: CandidateTx): Promise<number> {
    const row = await trx
      .selectFrom("career_profile_version")
      .select((eb) => eb.fn.coalesce(eb.fn.max("version"), sql<number>`0`).as("max"))
      .where("candidate_id", "=", scoped())
      .executeTakeFirstOrThrow()
    return Number(row.max) + 1
  }

  async insertDraft(
    trx: CandidateTx,
    draft: { version: number; source: "resume" | "edit"; resumeUploadId: string | null; sections: StoredSection[]; rejectedFacts: number; createdAt: Date }
  ): Promise<VersionRow> {
    return trx
      .insertInto("career_profile_version")
      .values({
        candidate_id: scoped(),
        version: draft.version,
        status: "draft",
        source: draft.source,
        resume_upload_id: draft.resumeUploadId,
        sections: JSON.stringify(draft.sections),
        rejected_fact_count: draft.rejectedFacts,
        created_at: draft.createdAt,
        approved_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async replaceDraftSections(trx: CandidateTx, version: number, sections: StoredSection[]): Promise<VersionRow> {
    return trx
      .updateTable("career_profile_version")
      .set({ sections: JSON.stringify(sections) })
      .where("candidate_id", "=", scoped())
      .where("version", "=", version)
      .where("status", "=", "draft")
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  /** Approves `version` and replaces the version in use, in the caller's transaction. */
  async approve(trx: CandidateTx, version: number, approvedAt: Date): Promise<void> {
    const candidateId = scoped()
    await trx.updateTable("career_profile_version").set({ status: "replaced" }).where("candidate_id", "=", candidateId).where("status", "=", "approved").execute()
    await trx
      .updateTable("career_profile_version")
      .set({ status: "approved", approved_at: approvedAt })
      .where("candidate_id", "=", candidateId)
      .where("version", "=", version)
      .where("status", "=", "draft")
      .execute()
  }

  async deleteDraft(trx: CandidateTx, version: number): Promise<void> {
    await trx.deleteFrom("career_profile_version").where("candidate_id", "=", scoped()).where("version", "=", version).where("status", "=", "draft").execute()
  }

  /** Returns false when a resume is already being drafted (partial unique index). */
  async startUpload(row: Omit<ResumeUploadRow, "candidate_id">): Promise<boolean> {
    try {
      await this.tenant.run((tx, candidateId) => tx.insertInto("resume_upload").values({ ...row, candidate_id: candidateId }).execute())
      return true
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return false
      throw error
    }
  }

  async finishUpload(id: string, outcome: { status: "drafted" } | { status: "failed"; reason: string }, finishedAt: Date, trx?: CandidateTx): Promise<void> {
    const write = (tx: CandidateTx, candidateId: string) =>
      tx
        .updateTable("resume_upload")
        .set({ status: outcome.status, failure_reason: outcome.status === "failed" ? outcome.reason : null, finished_at: finishedAt })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
    await (trx ? write(trx, scoped()) : this.tenant.run(write))
  }
}
