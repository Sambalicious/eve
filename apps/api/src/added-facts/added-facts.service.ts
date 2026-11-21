import { randomUUID } from "node:crypto"

import { Inject, Injectable, Logger } from "@nestjs/common"
import {
  type AddedFactFieldError,
  type AddedFactsView,
  type AddedFactRoleOption,
  type ProfileSaveOutcome,
  type Submission,
  addAddedFactsRequestSchema,
  confirmAddedFactsRequestSchema,
  editAddedFactRequestSchema,
} from "@eve/contracts"
import type { Selectable } from "kysely"
import { sql } from "../db/sql.js"

import { APP_CONFIG } from "../config/config.module.js"
import type { SharedRuntimeConfig } from "../config/env.js"
import type { ApplicationTable, StoredSection } from "../db/schema.js"
import type { CandidateTx } from "../db/tenant-database.js"
import { CareerProfileService } from "../career-profile/career-profile.service.js"
import { submissionOf } from "../submission/submission-state.service.js"
import { queuePreconditions } from "../submission/queue-preconditions.js"
import { SubmissionRepository } from "../submission/submission.repository.js"
import { ApiException } from "../http/api-exception.js"
import { parseRequest } from "../http/parse-body.js"
import { overridesFor } from "../documents/override-reader.js"
import { keywordNamed } from "../documents/keyword-match.js"
import type { ContactHeader } from "../documents/document-model.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { addedFactsView } from "./view.js"
import { documentsStale } from "./added-facts-gate.js"
import { type ApplicationMatchResult, readApplicationMatch } from "./match-read.js"
import { type AddedFactRow, AddedFactsRepository, type NewAddedFact, experienceRoles, gapTermsOf } from "./added-facts.repository.js"
import { addedFactsState, issue, limitProblem, liveGapTerm, textProblem, withoutDuplicateFields } from "./added-facts-rules.js"

/** A request item after the rules accepted it. */
type AcceptedItem = Readonly<{
  kind: "skill_only" | "one_liner"
  text: string
  term: string | null
  roleSectionId: string | null
  roleSnapshot: { title: string; employer: string | null; period: string | null } | null
  saveToProfile: boolean
}>

/** What a write reads once, under the lock, to apply the field rules. */
type WriteContext = Readonly<{
  application: Selectable<ApplicationTable>
  facts: AddedFactRow[]
  gaps: { available: boolean; terms: string[] }
  roles: AddedFactRoleOption[]
  profileVersion: number | null
  contact: ContactHeader
}>

/**
 * FEAT-0017: the five routes' behaviour. Every mutation locks the Application row
 * first, so the counter, the caps, the Match audit and the queue drop are one
 * decision. No route triggers an AI call.
 */
@Injectable()
export class AddedFactsService {
  private readonly logger = new Logger(AddedFactsService.name)
  private readonly enabled: boolean

  constructor(
    private readonly repository: AddedFactsRepository,
    private readonly careerProfile: CareerProfileService,
    private readonly submissions: SubmissionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) config: SharedRuntimeConfig
  ) {
    this.enabled = config.addedFactsEnabled === true
  }

  /** The form's read. A minimal record answers 200 with its frozen reason and nothing else. */
  async read(id: string): Promise<AddedFactsView> {
    this.assertAvailable()
    return this.repository.transaction(async (trx, candidateId) => {
      const application = await this.repository.findApplication(trx, candidateId, id)
      if (!application) throw new ApiException("not_found")
      return addedFactsView(trx, candidateId, application, this.clock.now(), true)
    })
  }

  /**
   * One or several facts: tick several terms at once, or one free-entry fact.
   * Order of checks (contract 7 to 14): lock, Frozen, busy, `expectedVersion`,
   * then every field rule at once, then the limits, then the write.
   */
  async add(id: string, body: unknown): Promise<{ view: AddedFactsView; profileSave: Array<{ position: number; factId: string; outcome: ProfileSaveOutcome; draftVersion: number | null }> }> {
    this.assertAvailable()
    const request = parseRequest(addAddedFactsRequestSchema, body)
    const written = await this.repository.transaction(async (trx, candidateId) => {
      const context = await this.lock(trx, candidateId, id, request.expectedVersion)
      const accepted = await this.acceptItems(trx, candidateId, id, request.items, context)
      const problem = limitProblem(countOf(context.facts), countOfAccepted(accepted))
      if (problem !== null) throw limited([issue("items", null, problem)])
      const at = this.clock.now()
      const rows: Array<{ position: number; fact: AddedFactRow }> = []
      for (const item of accepted) {
        const position = rows.length + 1
        try {
          rows.push({ position, fact: await this.repository.insert(trx, candidateId, id, toRow(item, context.profileVersion, at)) })
        } catch (error) {
          throw this.duplicateOr(error, item.kind === "skill_only" ? "term" : "text", position)
        }
      }
      const updated = await this.bump(trx, candidateId, id, at)
      this.logger.log(JSON.stringify({ event: "added_facts.changed", applicationId: id, added: rows.length, kind: "add" }))
      return { rows, view: await addedFactsView(trx, candidateId, updated, at, true) }
    })
    return { view: written.view, profileSave: await this.saveToProfile(written.rows) }
  }

  /** Edit a one-liner, or upgrade a skill-only fact. An edit that changes nothing answers 200 with the counter unchanged. */
  async edit(id: string, factId: string, body: unknown): Promise<AddedFactsView> {
    this.assertAvailable()
    const request = parseRequest(editAddedFactRequestSchema, body)
    return this.repository.transaction(async (trx, candidateId) => {
      const context = await this.lock(trx, candidateId, id, request.expectedVersion)
      const fact = await this.repository.findFact(trx, candidateId, id, factId)
      if (!fact) throw new ApiException("not_found")
      const text = request.text.trim()
      const role = request.roleSectionId === null ? undefined : context.roles.find((candidate) => candidate.sectionId === request.roleSectionId)
      const issues: AddedFactFieldError[] = []
      const problem = textProblem(text, context.contact)
      if (problem !== null) issues.push(issue("text", null, problem))
      if (context.roles.length === 0) issues.push(issue("roleSectionId", null, "no_experience_role"))
      else if (request.roleSectionId === null) issues.push(issue("roleSectionId", null, "role_required"))
      else if (role === undefined) issues.push(issue("roleSectionId", null, "role_unknown"))
      if (fact.term !== null && problem === null && !keywordNamed(text, fact.term)) issues.push(issue("text", null, "term_not_named"))
      if (problem === null) {
        const keys = await this.repository.textKeys(trx, candidateId, id, [text])
        if ((keys.get(text)?.factIds ?? []).some((otherId) => otherId !== factId)) issues.push(issue("text", null, "duplicate"))
      }
      if (issues.length > 0) throw invalid(withoutDuplicateFields(issues))
      // The no-op: the same text and role write nothing, so the set these documents were written from is unchanged.
      if (fact.kind === "one_liner" && fact.text === text && fact.role_section_id === request.roleSectionId && role !== undefined) {
        return addedFactsView(trx, candidateId, context.application, this.clock.now(), true)
      }
      if (fact.kind === "skill_only") {
        const problemLimit = limitProblem(countOf(context.facts), { oneLiner: 1, skillOnly: 0 })
        if (problemLimit !== null) throw limited([issue("items", null, problemLimit)])
      }
      if (role === undefined) throw new ApiException("internal_error")
      const at = this.clock.now()
      try {
        await this.repository.update(trx, candidateId, factId, {
          kind: "one_liner",
          text,
          roleSectionId: role.sectionId,
          roleSnapshot: { title: role.title, employer: role.employer, period: role.period },
          at,
        })
      } catch (error) {
        throw this.duplicateOr(error, "text", null)
      }
      const updated = await this.bump(trx, candidateId, id, at)
      this.logger.log(JSON.stringify({ event: "added_facts.changed", applicationId: id, kind: "edit" }))
      return addedFactsView(trx, candidateId, updated, at, true)
    })
  }

  /** Remove or un-tick one fact; its term returns to the live gap list. */
  async remove(id: string, factId: string, expectedVersion: number): Promise<AddedFactsView> {
    this.assertAvailable()
    return this.repository.transaction(async (trx, candidateId) => {
      await this.lock(trx, candidateId, id, expectedVersion)
      const fact = await this.repository.findFact(trx, candidateId, id, factId)
      if (!fact) throw new ApiException("not_found")
      const at = this.clock.now()
      await this.repository.remove(trx, candidateId, factId)
      const updated = await this.bump(trx, candidateId, id, at)
      this.logger.log(JSON.stringify({ event: "added_facts.changed", applicationId: id, kind: "remove" }))
      return addedFactsView(trx, candidateId, updated, at, true)
    })
  }

  /**
   * "Submit with your added skills" (OD-7, OD-17): the confirmation and the queue
   * in one transaction, by the same rules `queue()` applies. A replay at the same
   * counter on a queued Application answers 200 with no write.
   */
  async confirm(id: string, body: unknown): Promise<Submission> {
    this.assertAvailable()
    const request = parseRequest(confirmAddedFactsRequestSchema, body)
    await this.repository.transaction(async (trx, candidateId) => {
      const application = await this.repository.lockApplication(trx, candidateId, id)
      if (!application) throw new ApiException("not_found")
      const state = addedFactsState(application)
      if (state.frozenReason !== null) throw new ApiException("added_facts_frozen")
      if (state.busyReason !== null) throw new ApiException("added_facts_busy")
      if (request.expectedVersion !== application.added_facts_version) throw new ApiException("added_facts_conflict")
      // SEC-R04: the same preconditions `queue()` applies, at the two points this route's order fixes.
      const preconditions = queuePreconditions(application, await this.submissions.manualOnly(trx, application))
      if (preconditions.manualOnly) throw new ApiException("manual_application_only")
      const now = this.clock.now()
      const match = await readApplicationMatch(trx, candidateId, application, now)
      if (match === null || !match.lifted) throw new ApiException("added_facts_not_lifted")
      if (preconditions.notDocumentsReady) throw new ApiException("application_state_conflict")
      const documents = await this.repository.documents(trx, candidateId, id)
      if (documents.length === 0) throw new ApiException("application_state_conflict")
      if (documentsStale({ flagOn: true, applicationVersion: application.added_facts_version, documents: documents.map((document) => ({ version: document.version, cited: document.cited })) })) {
        throw new ApiException("documents_stale")
      }
      if (application.added_facts_confirmed_version === application.added_facts_version && application.submission_state === "queued") return
      if (preconditions.automationIncomplete) throw new ApiException("automation_incomplete_not_requeueable")
      if (preconditions.notResumable) throw new ApiException("application_state_conflict")
      await trx
        .updateTable("application")
        .set({
          added_facts_confirmed_version: application.added_facts_version,
          added_facts_confirmed_at: now,
          added_facts_match: JSON.stringify(auditOf(match)),
          submission_state: "queued",
          submission_kind: "automatic",
          blocked_reason: null,
          blocked_sub_reason: null,
          blocked_detail: null,
          blocked_question: null,
          blocked_at: null,
          updated_at: now,
        })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
      this.logger.log(JSON.stringify({ event: "added_facts.confirmed", applicationId: id, version: application.added_facts_version }))
    })
    return this.submission(id)
  }

  private assertAvailable(): void {
    if (!this.enabled) throw new ApiException("not_found")
  }

  private async submission(id: string): Promise<Submission> {
    const now = this.clock.now()
    return this.repository.transaction(async (trx, candidateId) => {
      const row = await trx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("id", "=", id).executeTakeFirst()
      if (!row) throw new ApiException("not_found")
      const overrides = await overridesFor(trx, candidateId, [row], now)
      return submissionOf(row, overrides.get(row.id) ?? null)
    })
  }

  /** Locks the Application and applies checks 7 to 10. */
  private async lock(trx: CandidateTx, candidateId: string, id: string, expectedVersion: number): Promise<WriteContext> {
    const application = await this.repository.lockApplication(trx, candidateId, id)
    if (!application) throw new ApiException("not_found")
    const state = addedFactsState(application)
    if (state.frozenReason !== null) throw new ApiException("added_facts_frozen")
    if (state.busyReason !== null) throw new ApiException("added_facts_busy")
    if (expectedVersion !== application.added_facts_version) throw new ApiException("added_facts_conflict")
    const documents = await this.repository.documents(trx, candidateId, id)
    const approved = await this.repository.approvedProfile(trx, candidateId)
    const profileVersion = documents[0]?.careerProfileVersion ?? approved?.version ?? null
    const profile = profileVersion === null || profileVersion === approved?.version ? approved : await this.repository.profileVersion(trx, candidateId, profileVersion)
    const facts = await this.repository.list(trx, candidateId, id)
    const resume = await this.repository.resumeContent(trx, candidateId, id)
    const contact = await this.repository.contact(trx, candidateId)
    const header: ContactHeader = { name: contact.full_name, lines: contact.lines }
    return {
      application,
      facts,
      gaps: gapTermsOf(resume, facts, header),
      roles: experienceRoles((profile?.sections ?? []) as StoredSection[]),
      profileVersion: profile?.version ?? null,
      contact: header,
    }
  }

  /** Every field rule for every item, in the contract's order, every problem at once. Throws 422 when any holds. */
  private async acceptItems(trx: CandidateTx, candidateId: string, id: string, items: readonly unknown[], context: WriteContext): Promise<AcceptedItem[]> {
    const issues: AddedFactFieldError[] = []
    const accepted: AcceptedItem[] = []
    // SEC-R06: one key function. The database computes each text's duplicate key, so the add-time
    // comparison uses the same `lower(btrim(text))` the stored `text_key` and its CHECK use.
    const texts: string[] = []
    for (const raw of items as ReadonlyArray<Record<string, unknown>>) {
      if (raw.kind === "skill_only") {
        const term = typeof raw.term === "string" ? raw.term : ""
        texts.push(context.gaps.available ? liveGapTerm(term, context.gaps.terms) ?? term.trim() : term.trim())
      } else texts.push(typeof raw.text === "string" ? raw.text.trim() : "")
    }
    const keys = await this.repository.textKeys(trx, candidateId, id, texts)
    const known = new Set<string>()
    for (const [index, raw] of (items as ReadonlyArray<Record<string, unknown>>).entries()) {
      const position = index + 1
      const affirmed = raw.affirmed === true
      const key = keys.get(texts[index]!)
      if (raw.kind === "skill_only") {
        const term = typeof raw.term === "string" ? raw.term : ""
        const live = context.gaps.available ? liveGapTerm(term, context.gaps.terms) : null
        const stored = live ?? term.trim()
        if (!affirmed) issues.push(issue("affirmed", position, "affirmation_required"))
        // Duplicate before `term_not_a_gap`: a term already added has left the gap list, and the Candidate's answer is "already added".
        if (key !== undefined && (key.factIds.length > 0 || known.has(key.key))) issues.push(issue("term", position, "duplicate"))
        else if (live === null) issues.push(issue("term", position, "term_not_a_gap"))
        if (key !== undefined) known.add(key.key)
        accepted.push({ kind: "skill_only", text: stored, term: stored, roleSectionId: null, roleSnapshot: null, saveToProfile: raw.saveToProfile === true })
        continue
      }
      const text = typeof raw.text === "string" ? raw.text.trim() : ""
      const problem = textProblem(text, context.contact)
      if (problem !== null) issues.push(issue("text", position, problem))
      const term = typeof raw.term === "string" && raw.term.trim() !== "" ? raw.term.trim() : null
      if (term !== null) {
        if (!context.gaps.available || liveGapTerm(term, context.gaps.terms) === null) issues.push(issue("term", position, "term_not_a_gap"))
        else if (problem === null && !keywordNamed(text, term)) issues.push(issue("text", position, "term_not_named"))
      }
      if (text !== "" && key !== undefined && (key.factIds.length > 0 || known.has(key.key))) issues.push(issue("text", position, "duplicate"))
      if (key !== undefined) known.add(key.key)
      const roleSectionId = typeof raw.roleSectionId === "string" ? raw.roleSectionId : null
      const role = roleSectionId === null ? undefined : context.roles.find((candidate) => candidate.sectionId === roleSectionId)
      if (context.roles.length === 0) issues.push(issue("roleSectionId", position, "no_experience_role"))
      else if (roleSectionId === null) issues.push(issue("roleSectionId", position, "role_required"))
      else if (role === undefined) issues.push(issue("roleSectionId", position, "role_unknown"))
      if (!affirmed) issues.push(issue("affirmed", position, "affirmation_required"))
      accepted.push({
        kind: "one_liner",
        text,
        term,
        roleSectionId,
        roleSnapshot: role === undefined ? null : { title: role.title, employer: role.employer, period: role.period },
        saveToProfile: raw.saveToProfile === true,
      })
    }
    if (issues.length > 0) throw invalid(withoutDuplicateFields(issues))
    return accepted
  }

  /** SEC-R06 backstop: a unique violation on the duplicate key is the same 422 `duplicate` the rule would have given. */
  private duplicateOr(error: unknown, field: "text" | "term", position: number | null): unknown {
    const violation = error as { code?: string; constraint?: string }
    if (violation.code === "23505" && violation.constraint === "application_added_fact_candidate_application_text_key") return invalid([issue(field, position, "duplicate")])
    return error
  }

  /** The mutation's shared tail: the counter, the Match audit, and the queue drop with `documents_stale`. */
  private async bump(trx: CandidateTx, candidateId: string, id: string, at: Date): Promise<Selectable<ApplicationTable>> {
    await trx
      .updateTable("application")
      .set({ added_facts_version: sql<number>`added_facts_version + 1`, updated_at: at })
      .where("candidate_id", "=", candidateId)
      .where("id", "=", id)
      .execute()
    const updated = await trx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("id", "=", id).executeTakeFirstOrThrow()
    const match = await readApplicationMatch(trx, candidateId, updated, at)
    await trx
      .updateTable("application")
      .set({ added_facts_match: match === null ? null : JSON.stringify(auditOf(match)) })
      .where("candidate_id", "=", candidateId)
      .where("id", "=", id)
      .execute()
    // OD-7: any change voids the confirmation (A-6 keeps the columns; validity is equality) and takes the Application out
    // of the queue, so the queue can never send documents from a set other than the confirmed one.
    if (updated.submission_state === "queued") {
      await trx
        .updateTable("application")
        .set({ submission_state: null, submission_kind: null, queued_for_local_day: null, updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
      await trx
        .insertInto("submission_event")
        .values({ id: randomUUID(), candidate_id: candidateId, application_id: id, kind: "queued_posting_dropped", detail: "documents_stale", created_at: at })
        .execute()
    }
    return trx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("id", "=", id).executeTakeFirstOrThrow()
  }

  /** OD-6, after the fact's transaction commits: each requested draft copy, never an approval; the outcome never changes the answer. */
  private async saveToProfile(rows: ReadonlyArray<{ position: number; fact: AddedFactRow }>): Promise<Array<{ position: number; factId: string; outcome: ProfileSaveOutcome; draftVersion: number | null }>> {
    const entries = rows.filter((row) => row.fact.save_to_profile)
    const outcomes = entries.length === 0 ? [] : await this.careerProfile.addFactsToDraft(entries.map((row) => ({ text: row.fact.text, kind: row.fact.kind })))
    const byPosition = new Map(entries.map((row, index) => [row.position, outcomes[index]!] as const))
    const drafted = entries.flatMap((row, index) => {
      const outcome = outcomes[index]!
      return outcome.outcome === "saved_to_draft" && outcome.draftVersion !== null ? [{ factId: row.fact.id, draftVersion: outcome.draftVersion }] : []
    })
    if (drafted.length > 0) {
      await this.repository.transaction(async (trx, candidateId) => {
        await this.repository.markSavedToProfile(trx, candidateId, drafted)
      })
    }
    return rows.map((row) => {
      const outcome = byPosition.get(row.position)
      return {
        position: row.position,
        factId: row.fact.id,
        outcome: outcome?.outcome ?? "not_requested",
        draftVersion: outcome?.outcome === "saved_to_draft" ? outcome.draftVersion ?? null : null,
      }
    })
  }
}

/** 422 `added_facts_invalid`, carrying every problem. */
function invalid(fieldErrors: readonly AddedFactFieldError[]): ApiException {
  return new ApiException("added_facts_invalid", undefined, undefined, undefined, [...fieldErrors])
}

/** 422 `added_facts_limit`: exactly one `items` problem, no values echoed. */
function limited(fieldErrors: readonly AddedFactFieldError[]): ApiException {
  return new ApiException("added_facts_limit", undefined, undefined, undefined, [...fieldErrors])
}

function countOf(facts: readonly AddedFactRow[]): { oneLiner: number; skillOnly: number } {
  return { oneLiner: facts.filter((fact) => fact.kind === "one_liner").length, skillOnly: facts.filter((fact) => fact.kind === "skill_only").length }
}

function countOfAccepted(items: readonly AcceptedItem[]): { oneLiner: number; skillOnly: number } {
  return { oneLiner: items.filter((item) => item.kind === "one_liner").length, skillOnly: items.filter((item) => item.kind === "skill_only").length }
}

function toRow(item: AcceptedItem, profileVersion: number | null, at: Date): NewAddedFact {
  return {
    kind: item.kind,
    text: item.text,
    term: item.term,
    roleSectionId: item.roleSectionId,
    roleSnapshot: item.roleSnapshot,
    roleProfileVersion: item.kind === "one_liner" ? profileVersion : null,
    saveToProfile: item.saveToProfile,
    affirmedAt: at,
  }
}

/** The audit snapshot on the Application (the view computes live; this is for audit and display only). */
export function auditOf(match: ApplicationMatchResult): Record<string, unknown> {
  return {
    profileVersion: match.careerProfileVersion,
    criteriaVersion: match.criteriaVersion,
    addedFactsVersion: match.addedFactsVersion,
    verdict: match.withAdded.verdict,
    covered: match.posting.covered,
    total: match.posting.total,
    coveredWithAdded: match.withAdded.covered,
    totalWithAdded: match.withAdded.total,
    unmetMandatory: match.withAdded.unmetMandatory,
    lifted: match.lifted,
    covers: match.covers,
  }
}
