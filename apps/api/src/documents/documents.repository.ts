import { randomUUID } from "node:crypto"

import { Injectable } from "@nestjs/common"
import { sql } from "../db/sql.js"

import { CandidateScope } from "../db/candidate-scope.js"
import { type BoardOutcomeType, type OverrideDecision, isOverridableDecision, overrideDecisionsEqual } from "@eve/contracts"

import { type VisibilityContext, visibilityContext, visibleSql } from "../discovery/visibility.js"
import type { ApplicationState, JobPostingStatus } from "../db/schema.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { applyTransactionTimeouts, transactionTimeouts } from "../db/transaction-timeouts.js"
import { describeBlock } from "./blocked-claim.js"
import type { DocumentValidation } from "./document-claims.js"
import type { DocumentContent, DocumentKind } from "./document-model.js"
import { isMarkable } from "./override.js"
import { postingState, postingStates } from "./override-reader.js"

export type StoredDocument = Readonly<{
  kind: DocumentKind
  content: DocumentContent
  pdfStorageName: string
  docxStorageName: string
  pdfSha256: string
  docxSha256: string
}>

/**
 * Bounds a create's wait for a Job criteria save: the evaluator's verdict pair,
 * 5 s lock, 10 s statement. The api pool's statement_timeout is also 5 s, so the
 * local 10 s statement bound lets the wait end with 55P03 (QA-G5-2, g6 r1).
 * A save holds the criteria row well under a second.
 */
export const CREATE_TIMEOUTS = transactionTimeouts(5_000, 10_000)

/** v1.24.0 order-of-checks step 4: statuses that are refused as still being checked or not checkable (AA-1.2, AA-7.3). */
export const NOT_ELIGIBLE_STATUSES = ["checking", "waiting_to_be_checked", "not_checked", "evaluation_failed"] as const satisfies readonly JobPostingStatus[]

export type CreateOutcome = Readonly<
  | { outcome: "not_found" | "hidden" | "not_eligible" | "override_not_allowed" | "override_acknowledgement_missing" | "override_decision_changed" | "override_application_state" }
  | { outcome: "ok"; id: string; created: boolean }
>

/** The existing Application of a requisition, as the create reads it FOR UPDATE. */
type ExistingRow = Readonly<{ id: string; submission_state: string | null; sample_state: string | null; details_deleted_at: Date | null; override_created_at: Date | null; candidate_override_at: Date | null; override_status: string | null; override_skip_reason: string | null; override_skip_detail: string | null; override_violated_rules: string[] | null }>

/**
 * The scope's Candidate's Applications, Tailored Documents, contact details and
 * approved Career Profile. Every Candidate-table statement runs in its
 * `CandidateTx` and names its `candidate_id` (EPIC-0002 A1). A posting's
 * status is the Candidate's own `candidate_posting` row; a posting they do not
 * hold is not found (item 6).
 */
@Injectable()
export class DocumentsRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  /** The ATS minimum (0030); 40, the column default, when the Candidate has no settings row. */
  readAtsMinimum(): Promise<number> {
    return this.tenant.run(async (tx, candidateId) => {
      const row = await tx.selectFrom("candidate_setting").select("min_ats_percent").where("candidate_id", "=", candidateId).executeTakeFirst()
      return row?.min_ats_percent ?? 40
    })
  }

  /** Upserts the ATS minimum; a new settings row keeps every other column's default. */
  writeAtsMinimum(minAtsPercent: number, at: Date): Promise<void> {
    return this.tenant.run(async (tx, candidateId) => {
      await tx
        .insertInto("candidate_setting")
        .values({ candidate_id: candidateId, work_authorization: sql<string>`default`, min_ats_percent: minAtsPercent, updated_at: at })
        .onConflict((oc) => oc.column("candidate_id").doUpdateSet({ min_ats_percent: minAtsPercent, updated_at: at }))
        .execute()
    })
  }

  /**
   * Puts Applications held below the ATS minimum (all, or one) back in the automatic queue when their
   * resume's ATS score now reaches the Candidate's minimum, or the minimum is 0. Returns how many moved.
   */
  requeueAtsHeld(at: Date, applicationId?: string): Promise<number> {
    return this.tenant.run(async (tx, candidateId) => {
      const setting = await tx.selectFrom("candidate_setting").select("min_ats_percent").where("candidate_id", "=", candidateId).executeTakeFirst()
      const minimum = setting?.min_ats_percent ?? 40
      let held = tx
        .selectFrom("application as a")
        .innerJoin("tailored_document as d", (join) => join.onRef("d.application_id", "=", "a.id").on("d.kind", "=", "resume"))
        .select(["a.id", sql<number | null>`(d.content->'ats'->>'score')::int`.as("score")])
        .where("a.candidate_id", "=", candidateId)
        .where("a.submission_state", "=", "blocked")
        .where("a.blocked_reason", "=", "ats_below_minimum")
      if (applicationId !== undefined) held = held.where("a.id", "=", applicationId)
      const release = (await held.execute()).filter((row) => minimum === 0 || (row.score !== null && row.score >= minimum)).map((row) => row.id)
      if (release.length === 0) return 0
      const result = await tx
        .updateTable("application")
        .set({ submission_state: "queued", submission_kind: "automatic", blocked_reason: null, blocked_sub_reason: null, blocked_detail: null, blocked_question: null, blocked_at: null, updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("id", "in", release)
        .where("blocked_reason", "=", "ats_below_minimum")
        .executeTakeFirst()
      return Number(result.numUpdatedRows)
    })
  }

  findPosting(id: string) {
    return this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("job_posting as p")
        .innerJoin("candidate_posting as cp", (join) => join.onRef("cp.job_posting_id", "=", "p.id").on("cp.candidate_id", "=", candidateId))
        .select(["p.id", "cp.status", "p.application_url", "p.requisition_id", "p.company", "p.title", "p.posting_text", "p.apply_mode", "p.technologies", "p.ats_skills", "p.forward_statements"])
        .where("p.id", "=", id)
        .executeTakeFirst()
    )
  }

  /**
   * `POST /v1/applications` (api-contract.md v1.24.0 "Order of checks"). One
   * transaction: the Job criteria row FOR SHARE first (SEC-003 lock order, the
   * save holds it FOR UPDATE), then the posting and its Eligibility rules, then
   * the requisition's Application FOR UPDATE. The first failing check answers
   * and nothing is written. A ranked posting takes the unchanged ranked path; an
   * overridable one needs an acknowledgement equal to the current decision, read
   * under the lock, and the decision is stored (AA-2.2) on a new Application or
   * on an existing markable one (AA-6.1). The slice 4 name is kept (tests and
   * the timeout registry name it); it now also takes overridable postings.
   */
  async createIfRanked(postingId: string, acknowledgement: OverrideDecision | null, at: Date): Promise<CreateOutcome> {
    return this.tenant.run(async (trx, candidateId) => {
      await applyTransactionTimeouts(trx, CREATE_TIMEOUTS)
      // EPIC-0006: the visibility context comes from the same criteria row, FOR SHARE (AC-3.9 serialisation).
      const ctx = await visibilityContext(trx, candidateId, at, "share")
      const state = (await postingStates(trx, candidateId, [postingId], ctx)).get(postingId)
      if (!state) return { outcome: "not_found" } as const
      if (state.hidden) return { outcome: "hidden" } as const
      const decision = state.decision
      if ((NOT_ELIGIBLE_STATUSES as readonly string[]).includes(decision.status)) return { outcome: "not_eligible" } as const
      if (state.pastedDescription) return this.createPasted(trx, candidateId, postingId, acknowledgement, at, ctx)
      if (decision.status === "ranked") {
        const result = await this.insertOnce(trx, postingId, at, ctx)
        return result ? ({ outcome: "ok", ...result } as const) : ({ outcome: "not_eligible" } as const)
      }
      if (!isOverridableDecision(decision)) return { outcome: "override_not_allowed" } as const
      if (acknowledgement === null) return { outcome: "override_acknowledgement_missing" } as const
      if (!overrideDecisionsEqual(acknowledgement, decision)) return { outcome: "override_decision_changed" } as const
      const existing = await this.lockExisting(trx, candidateId, postingId)
      if (existing) return this.markExisting(trx, candidateId, existing, decision, at)
      const inserted = await this.insertOnce(trx, postingId, at, ctx, decision)
      if (inserted?.created) return { outcome: "ok", ...inserted } as const
      // A concurrent create won the unique index: mark the winner like any existing Application.
      const winner = await this.lockExisting(trx, candidateId, postingId)
      return winner ? this.markExisting(trx, candidateId, winner, decision, at) : ({ outcome: "not_eligible" } as const)
    })
  }

  /**
   * v1.27.0 (EPIC-0010 PD-3.1, PD-4.4, OQ-6; contract "POST /v1/applications"): a finished pasted posting
   * (ranked, skipped or excluded) becomes an Application with no override. An acknowledgement is refused,
   * so no override is ever recorded. The hold is read FOR SHARE first, so a concurrent re-paste (which takes
   * it FOR UPDATE and then checks for an Application) and this create serialise: whichever commits first wins.
   */
  private async createPasted(trx: CandidateTx, candidateId: string, postingId: string, acknowledgement: OverrideDecision | null, at: Date, ctx: VisibilityContext): Promise<CreateOutcome> {
    if (acknowledgement !== null) return { outcome: "override_not_allowed" } as const
    const held = await trx
      .selectFrom("candidate_posting")
      .select("status")
      .where("candidate_id", "=", candidateId)
      .where("job_posting_id", "=", postingId)
      .forShare()
      .executeTakeFirst()
    if (!held) return { outcome: "not_found" } as const
    const result = await this.insertOnce(trx, postingId, at, ctx, null, true)
    return result ? ({ outcome: "ok", ...result } as const) : ({ outcome: "not_eligible" } as const)
  }

  /** The requisition's Application for `postingId`, FOR UPDATE. */
  private lockExisting(trx: CandidateTx, candidateId: string, postingId: string): Promise<ExistingRow | undefined> {
    return trx
      .selectFrom("application")
      .innerJoin("job_posting", (join) =>
        join.onRef("job_posting.application_url", "=", "application.application_url").onRef("job_posting.requisition_id", "=", "application.requisition_id")
      )
      .select([
        "application.id",
        "application.submission_state",
        "application.sample_state",
        "application.details_deleted_at",
        "application.override_created_at",
        "application.candidate_override_at",
        "application.override_status",
        "application.override_skip_reason",
        "application.override_skip_detail",
        "application.override_violated_rules",
      ])
      .where("application.candidate_id", "=", candidateId)
      .where("job_posting.id", "=", postingId)
      .forUpdate("application")
      .executeTakeFirst()
  }

  /**
   * Steps 9 and 10 (AA-6.1 to 6.3, AA-2.2): an Application past the queue, a
   * sample or a minimal record is refused; a markable one gets the decision.
   * The same stored decision is kept as it is (second press or tab, R-4505); a
   * different or legacy one is replaced and takes the request time. Only the
   * override columns change; `candidate_override_at` is cleared (never written).
   */
  private async markExisting(trx: CandidateTx, candidateId: string, existing: ExistingRow, decision: OverrideDecision, at: Date): Promise<CreateOutcome> {
    if (!isMarkable(existing)) return { outcome: "override_application_state" } as const
    const same =
      existing.override_created_at !== null &&
      existing.override_status !== null &&
      existing.override_violated_rules !== null &&
      overrideDecisionsEqual({ status: existing.override_status as OverrideDecision["status"], skipReason: existing.override_skip_reason as OverrideDecision["skipReason"], skipDetail: existing.override_skip_detail, violatedRules: existing.override_violated_rules }, decision)
    if (!same) {
      await trx
        .updateTable("application")
        .set({ ...overrideColumns(decision, at), candidate_override_at: null, updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", existing.id)
        .execute()
    }
    return { outcome: "ok", id: existing.id, created: false } as const
  }

  /**
   * One Application per requisition key per Candidate (CONTEXT: never apply
   * twice). Without `override` the insert copies the posting only while the
   * scope's Candidate's `candidate_posting` row is ranked (SEC-003, item 6);
   * with one, only while the row is skipped or excluded, and the decision is
   * stored. A concurrent create of the same key loses on the unique index and
   * reads the winner. Undefined when nothing can be inserted and no Application exists.
   */
  async insertOnce(
    trx: CandidateTx,
    postingId: string,
    at: Date,
    ctx?: VisibilityContext,
    override: OverrideDecision | null = null,
    pasted = false
  ): Promise<{ id: string; created: boolean } | undefined> {
    const candidateId = CandidateScope.require()
    const visible = visibleSql("p", ctx ?? (await visibilityContext(trx, candidateId, at)))
    const columns = override === null ? null : overrideColumns(override, at)
    // v1.27.0: a pasted posting of any finished decision, never with an override (and only a pasted one).
    const statuses = pasted ? sql`('ranked', 'skipped', 'excluded') and p.origin = 'pasted_description'` : override === null ? sql`('ranked')` : sql`('skipped', 'excluded')`
    const { rows } = await sql<{ id: string }>`
      insert into application (id, candidate_id, job_posting_id, application_url, requisition_id, company, role_title, state,
                               career_profile_version, blocked_document, blocked_claim, failure, created_at, updated_at,
                               override_created_at, override_status, override_skip_reason, override_skip_detail, override_violated_rules)
      select ${randomUUID()}::uuid, cp.candidate_id, p.id, p.application_url, p.requisition_id, p.company, p.title, 'prepared',
             null, null, null, null, ${at}, ${at},
             ${columns?.override_created_at ?? null}::timestamptz, ${columns?.override_status ?? null}::text, ${columns?.override_skip_reason ?? null}::text,
             ${columns?.override_skip_detail ?? null}::text, ${columns?.override_violated_rules ?? null}::text[]
      from job_posting p
      join candidate_posting cp on cp.job_posting_id = p.id and cp.candidate_id = ${candidateId}::uuid
      where p.id = ${postingId} and cp.status in ${statuses} and ${visible}
      on conflict (candidate_id, application_url, requisition_id) do nothing
      returning id`.execute(trx)
    if (rows[0]) return { id: rows[0].id, created: true }
    const existing = await trx
      .selectFrom("application")
      .innerJoin("job_posting", (join) =>
        join.onRef("job_posting.application_url", "=", "application.application_url").onRef("job_posting.requisition_id", "=", "application.requisition_id")
      )
      .select("application.id")
      .where("application.candidate_id", "=", candidateId)
      .where("job_posting.id", "=", postingId)
      .executeTakeFirst()
    return existing ? { id: existing.id, created: false } : undefined
  }

  findApplication(id: string) {
    return this.tenant.run((tx, candidateId) => tx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("id", "=", id).executeTakeFirst())
  }

  /**
   * v1.24.0 detail facts: the posting's current decision and visibility, and the
   * latest `queued_posting_dropped` or `queue_removed` event (submission_event_application_idx).
   * EPIC-0002 B1: a drop the Candidate's rules caused is `queued_posting_preferences_changed`, also a drop.
   */
  detailFacts(row: Readonly<{ id: string; job_posting_id: string }>, now: Date) {
    return this.tenant.run(async (tx, candidateId) => ({
      posting: await postingState(tx, candidateId, row.job_posting_id, now),
      latestQueueEvent:
        (await tx
          .selectFrom("submission_event")
          .select(["kind", "detail", "created_at"])
          .where("candidate_id", "=", candidateId)
          .where("application_id", "=", row.id)
          .where("kind", "in", ["queued_posting_dropped", "queued_posting_preferences_changed", "queue_removed"])
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(1)
          .executeTakeFirst()) ?? null,
    }))
  }

  listApplications() {
    return this.tenant.run((tx, candidateId) =>
      tx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).orderBy("created_at", "desc").orderBy("id").limit(500).execute()
    )
  }

  /**
   * EPIC-0011 C4: per Application, the newest Outcome that is not `request_for_action`, and whether the
   * newest Outcome overall is one. Order `(created_at desc, id desc)`. Two bounded queries for all ids (no N+1).
   */
  latestOutcomes(applicationIds: readonly string[]): Promise<Map<string, { latest: { id: string; type: BoardOutcomeType; createdAt: Date } | null; requestForAction: boolean }>> {
    if (applicationIds.length === 0) return Promise.resolve(new Map())
    return this.tenant.run(async (tx, candidateId) => {
      const base = () => tx.selectFrom("outcome").where("candidate_id", "=", candidateId).where("application_id", "in", applicationIds).distinctOn("application_id").orderBy("application_id").orderBy("created_at", "desc").orderBy("id", "desc")
      const newest = await base().select(["application_id", "type"]).execute()
      const placing = await base().select(["application_id", "id", "type", "created_at"]).where("type", "!=", "request_for_action").execute()
      const result = new Map<string, { latest: { id: string; type: BoardOutcomeType; createdAt: Date } | null; requestForAction: boolean }>()
      for (const id of applicationIds) result.set(id, { latest: null, requestForAction: false })
      for (const row of newest) result.get(row.application_id)!.requestForAction = row.type === "request_for_action"
      for (const row of placing) result.get(row.application_id)!.latest = { id: row.id, type: row.type as BoardOutcomeType, createdAt: row.created_at }
      return result
    })
  }

  /** E5.7: every Application whose details exist (application_live_created_idx); the retention filter narrows it in code with the job's date rule. */
  listLiveApplications() {
    return this.tenant.run((tx, candidateId) =>
      tx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("details_deleted_at", "is", null).orderBy("created_at").orderBy("id").execute()
    )
  }

  listDocuments(applicationIds: readonly string[]) {
    if (applicationIds.length === 0) return Promise.resolve([])
    return this.tenant.run((tx, candidateId) =>
      tx.selectFrom("tailored_document").selectAll().where("candidate_id", "=", candidateId).where("application_id", "in", applicationIds).execute()
    )
  }

  findDocument(applicationId: string, kind: DocumentKind) {
    return this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("tailored_document")
        .selectAll()
        .where("candidate_id", "=", candidateId)
        .where("application_id", "=", applicationId)
        .where("kind", "=", kind)
        .executeTakeFirst()
    )
  }

  /** Moves to "generating" from a state that allows it; false when a generation is already running. */
  async startGenerating(id: string, at: Date): Promise<boolean> {
    const result = await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("application")
        // EPIC-0009 OD-2: clearing the block columns here is what lets a blocked Application
        // generate again without violating `application_blocked_pair` (0005).
        .set({ state: "generating", blocked_document: null, blocked_claim: null, blocked_claim_cause: null, blocked_claim_terms: null, blocked_claim_more_terms: null, failure: null, updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .where("details_deleted_at", "is", null)
        .where("state", "in", ["prepared", "documents_ready", "documents_blocked", "documents_failed"] satisfies ApplicationState[])
        // Never once submission has started, or after a sample's approval: what was sent keeps its documents.
        // An automatic submission held below the ATS minimum (0030) may get new documents: nothing was sent.
        .where((eb) => eb.or([eb("submission_state", "is", null), eb.and([eb("submission_state", "=", "blocked"), eb("blocked_reason", "=", "ats_below_minimum")])]))
        .where((eb) => eb.or([eb("sample_state", "is", null), eb("sample_state", "=", "awaiting_review")]))
        .executeTakeFirst()
    )
    return Number(result.numUpdatedRows) > 0
  }

  /**
   * F-QA4-02: generation runs inside the api process, so a row still in
   * "generating" when the api starts was cut off by a restart. It becomes a
   * retryable failure. Returns how many of the scope's Candidate's rows were reset.
   */
  async resetInterrupted(at: Date): Promise<number> {
    const result = await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("application")
        .set({ state: "documents_failed", failure: "interrupted", updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("state", "=", "generating")
        .executeTakeFirst()
    )
    return Number(result.numUpdatedRows)
  }

  /**
   * A generation stopped by a pause: back to `documents_ready` if documents are stored, else `prepared`.
   * SEC-701: every late writer below skips a row whose details were deleted; the UPDATE re-checks the
   * condition after waiting for the delete's row lock.
   */
  async markPaused(id: string, at: Date): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("application")
        .set({
          state: sql<ApplicationState>`case when exists (select 1 from tailored_document where candidate_id = ${candidateId} and application_id = ${id}) then 'documents_ready' else 'prepared' end`,
          failure: null,
          updated_at: at,
        })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .where("state", "=", "generating")
        .where("details_deleted_at", "is", null)
        .execute()
    )
  }

  async markFailed(id: string, failure: string, at: Date): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx.updateTable("application").set({ state: "documents_failed", failure, updated_at: at }).where("candidate_id", "=", candidateId).where("id", "=", id).where("details_deleted_at", "is", null).execute()
    )
  }

  /**
   * A blocked document (AC 5.3): earlier documents are removed so nothing
   * stale can be downloaded, and the Application does not proceed.
   *
   * EPIC-0009 D3: the cause and the flagged terms are written in the same
   * statement as the paragraph, so an alert can never show one block's
   * paragraph with another block's reason (PRD 8.1).
   */
  async markBlocked(id: string, version: number, kind: DocumentKind, validation: Extract<DocumentValidation, { ok: false }>, at: Date): Promise<string[]> {
    const blocked = describeBlock(validation)
    return this.tenant.run(async (trx, candidateId) => {
      if (!(await lockLive(trx, candidateId, id))) return []
      // SEC-408: return the removed rows' storage names so the caller deletes the files.
      const removed = await trx
        .deleteFrom("tailored_document")
        .where("candidate_id", "=", candidateId)
        .where("application_id", "=", id)
        .returning(["pdf_storage_name", "docx_storage_name"])
        .execute()
      await trx
        .updateTable("application")
        .set({
          state: "documents_blocked",
          career_profile_version: version,
          blocked_document: kind,
          blocked_claim: validation.claim,
          blocked_claim_cause: blocked.cause,
          blocked_claim_terms: blocked.terms === null ? null : [...blocked.terms],
          blocked_claim_more_terms: blocked.moreTerms,
          failure: null,
          updated_at: at,
        })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
      return removed.flatMap((row) => [row.pdf_storage_name, row.docx_storage_name])
    })
  }

  /** Every storage name the scope's Candidate's tailored_document rows reference (SEC-408 startup sweep). */
  async referencedStorageNames(): Promise<Set<string>> {
    const rows = await this.tenant.run((tx, candidateId) => tx.selectFrom("tailored_document").select(["pdf_storage_name", "docx_storage_name"]).where("candidate_id", "=", candidateId).execute())
    return new Set(rows.flatMap((row) => [row.pdf_storage_name, row.docx_storage_name]))
  }

  /**
   * Replaces both documents and marks the Application ready, in one transaction.
   * Returns the storage names the caller must remove: the replaced ones, or,
   * when the details were deleted while the documents were generated (SEC-701),
   * the new ones, which are then not recorded.
   */
  async recordDocuments(id: string, version: number, documents: readonly StoredDocument[], at: Date): Promise<{ recorded: boolean; remove: string[] }> {
    return this.tenant.run(async (trx, candidateId) => {
      if (!(await lockLive(trx, candidateId, id))) return { recorded: false, remove: documents.flatMap((document) => [document.pdfStorageName, document.docxStorageName]) }
      const previous = await trx
        .selectFrom("tailored_document")
        .select(["pdf_storage_name", "docx_storage_name"])
        .where("candidate_id", "=", candidateId)
        .where("application_id", "=", id)
        .execute()
      await trx.deleteFrom("tailored_document").where("candidate_id", "=", candidateId).where("application_id", "=", id).execute()
      for (const document of documents) {
        await trx
          .insertInto("tailored_document")
          .values({
            id: randomUUID(),
            candidate_id: candidateId,
            application_id: id,
            kind: document.kind,
            career_profile_version: version,
            content: JSON.stringify(document.content),
            pdf_storage_name: document.pdfStorageName,
            docx_storage_name: document.docxStorageName,
            pdf_sha256: document.pdfSha256,
            docx_sha256: document.docxSha256,
            created_at: at,
          })
          .execute()
      }
      await trx
        .updateTable("application")
        .set({ state: "documents_ready", career_profile_version: version, blocked_document: null, blocked_claim: null, blocked_claim_cause: null, blocked_claim_terms: null, blocked_claim_more_terms: null, failure: null, updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
      return { recorded: true, remove: previous.flatMap((row) => [row.pdf_storage_name, row.docx_storage_name]) }
    })
  }

  approvedProfile() {
    return this.tenant.run((tx, candidateId) =>
      tx.selectFrom("career_profile_version").select(["version", "sections"]).where("candidate_id", "=", candidateId).where("status", "=", "approved").executeTakeFirst()
    )
  }

  /** The Candidate's contact row; a Candidate with none yet (before onboarding, slice C) reads as empty. */
  async readContact(): Promise<{ full_name: string; lines: string[] }> {
    const row = await this.tenant.run((tx, candidateId) => tx.selectFrom("candidate_contact").select(["full_name", "lines"]).where("candidate_id", "=", candidateId).executeTakeFirst())
    return row ?? { full_name: "", lines: [] }
  }

  async updateContact(fullName: string, lines: readonly string[], at: Date): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .insertInto("candidate_contact")
        .values({ candidate_id: candidateId, full_name: fullName, lines: JSON.stringify(lines), updated_at: at })
        .onConflict((oc) => oc.column("candidate_id").doUpdateSet({ full_name: fullName, lines: JSON.stringify(lines), updated_at: at }))
        .execute()
    )
  }
}

/** Locks the Application row (the lock deletion takes) and says whether its details are still there. */
async function lockLive(trx: CandidateTx, candidateId: string, id: string): Promise<boolean> {
  const row = await trx.selectFrom("application").select("details_deleted_at").where("candidate_id", "=", candidateId).where("id", "=", id).forUpdate().executeTakeFirst()
  return row !== undefined && row.details_deleted_at === null
}

/** AA-2.2: the override columns for a decision recorded at `at`. */
function overrideColumns(decision: OverrideDecision, at: Date) {
  return {
    override_created_at: at,
    override_status: decision.status as "skipped" | "excluded",
    override_skip_reason: decision.skipReason,
    override_skip_detail: decision.skipDetail,
    override_violated_rules: [...decision.violatedRules],
  }
}
