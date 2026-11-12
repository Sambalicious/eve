import { createHash, randomUUID } from "node:crypto"

import type { PasteDescriptionOutcome, PasteFieldError } from "@eve/contracts"

import { sql } from "../db/sql.js"
import type { CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { evaluationAllowed } from "./evaluation-allowed.js"
import { classifyTitle } from "./rules/ranking.js"
import { foldForKeywords } from "./rules/rule-result.js"
import { seniorityMarker } from "./rules/seniority.js"
import { EMPTY_STRUCTURED } from "./sources/discovered-posting.js"

/**
 * EPIC-0010 (api-contract v1.27.0 "Processing order" step 7; architecture "How a
 * pasted-description posting is stored", "Re-paste and duplicate rules"; ADR 0013).
 *
 * A pasted description becomes a Candidate-private `job_posting` row: synthetic
 * requisition `pasted:<id>`, `application_url` the normalised link or
 * `urn:eve:pasted:<id>`, `origin = 'pasted_description'`, `apply_mode = 'manual'`,
 * `owner_candidate_id` the scope Candidate (forced RLS hides it from every other
 * scope). Exactly one `candidate_posting` row holds it. Every find-and-write runs in
 * one transaction under a per-(Candidate, key) advisory lock.
 */

/** The internal link of a description-only posting. Never sent by the API (`publicLink`). */
export const PASTED_URN_PREFIX = "urn:eve:pasted:"

/** The API's view of a stored link: null for the synthetic URN of a description-only posting. */
export function publicLink(stored: string): string | null {
  return stored.startsWith(PASTED_URN_PREFIX) ? null : stored
}

/** PD-5.4, I-3: case kept, no Unicode normalisation, whitespace runs in the text collapsed to one space. */
export function pasteFingerprint(title: string, company: string, normalisedText: string): string {
  return createHash("sha256").update(`${title}\u0000${company}\u0000${normalisedText.replace(/\s+/g, " ")}`).digest("hex")
}

/** A 52-bit advisory lock key for (Candidate, paste key); a collision only serialises two unrelated pastes. */
export function pasteLockKey(candidateId: string, key: string): number {
  return createHash("sha256").update(`eve/paste/${candidateId}/${key}`).digest().readUIntBE(0, 6) % 2 ** 52
}

export type PastedDescriptionInput = Readonly<{
  /** Normalised description (the stored `posting_text`), already within bounds. */
  text: string
  /** Cleaned; "" when missing. */
  title: string
  company: string
  /** Null for a description-only paste. */
  link: Readonly<{
    /** `normaliseApplicationUrl` of the link: the posting's `application_url` and the duplicate key. */
    normalised: string
    /** The checked link as sent: the `apply_url`. */
    raw: string
    applicationSystem: string
    /** A Greenhouse, Lever or Ashby link: a missing name is `employer_page_unreadable` (I-6). */
    ats: boolean
  }> | null
  discoveredAt: Date
}>

export type PastedDescriptionResult =
  | Readonly<{ kind: "stored"; id: string; created: boolean; outcome: PasteDescriptionOutcome; applicationId: string | null; evaluate: boolean }>
  | Readonly<{ kind: "still_checking" }>
  | Readonly<{ kind: "names_missing"; fieldErrors: PasteFieldError[] }>

/** A posting this Candidate holds for the pasted link, with what the re-paste rules read. */
type HeldRow = Readonly<{ id: string; owner_candidate_id: string | null; text_empty: boolean; status: string; application_id: string | null }>

export async function storePastedDescription(tenant: TenantDatabase, tx: CandidateTx, candidateId: string, input: PastedDescriptionInput): Promise<PastedDescriptionResult> {
  const fingerprint = input.link === null ? pasteFingerprint(input.title, input.company, input.text) : null
  await sql`select pg_advisory_xact_lock(${pasteLockKey(candidateId, input.link?.normalised ?? fingerprint!)}::bigint)`.execute(tx)
  const status = await startingStatus(tx, candidateId)

  if (input.link === null) {
    const existing = await tx
      .selectFrom("job_posting")
      .select("id")
      .where("owner_candidate_id", "=", candidateId)
      .where("paste_fingerprint", "=", fingerprint)
      .executeTakeFirst()
    if (existing) return { kind: "stored", id: existing.id, created: false, outcome: "already_pasted", applicationId: null, evaluate: false }
    const id = await insertPrivate(tx, candidateId, input, status, fingerprint)
    return { kind: "stored", id, created: true, outcome: "stored", applicationId: null, evaluate: status === "checking" }
  }

  const held = await heldForLink(tx, candidateId, input.link.normalised)
  const withApplication = held.find((row) => row.application_id !== null)
  if (withApplication) return { kind: "stored", id: withApplication.id, created: false, outcome: "unchanged_has_application", applicationId: withApplication.application_id, evaluate: false }
  // An accepted race can leave one shared and one private row (architecture): the private one decides.
  const row = held.find((candidate) => candidate.owner_candidate_id !== null) ?? held[0]
  if (row === undefined) {
    const missing = missingNames(input)
    if (missing !== null) return missing
    const id = await insertPrivate(tx, candidateId, input, status, null)
    return { kind: "stored", id, created: true, outcome: input.link.ats ? "stored_lookup_failed" : "stored", applicationId: null, evaluate: status === "checking" }
  }
  const shared = row.owner_candidate_id === null
  if (shared && !row.text_empty) return { kind: "stored", id: row.id, created: false, outcome: "employer_page_used", applicationId: null, evaluate: false }
  if (row.status === "checking") return { kind: "still_checking" }
  const missing = missingNames(input)
  if (missing !== null) return missing

  if (shared) {
    // OQ-4 (a): the description attaches as a new private posting; the Candidate's hold on the empty shared row goes.
    const id = await insertPrivate(tx, candidateId, input, status, null)
    await tx.deleteFrom("candidate_posting").where("candidate_id", "=", candidateId).where("job_posting_id", "=", row.id).execute()
    await tenant.savepoint(tx, () => tx.deleteFrom("job_posting").where("id", "=", row.id).execute(), isForeignKeyViolation)
    return { kind: "stored", id, created: false, outcome: "attached", applicationId: null, evaluate: status === "checking" }
  }

  // OQ-4 (b): replace in place. The hold is locked first, then the Application is checked again under it.
  const locked = await tx
    .selectFrom("candidate_posting")
    .select("status")
    .where("candidate_id", "=", candidateId)
    .where("job_posting_id", "=", row.id)
    .forUpdate()
    .executeTakeFirst()
  if (!locked) return { kind: "still_checking" }
  if (locked.status === "checking") return { kind: "still_checking" }
  const application = await applicationFor(tx, candidateId, row.id)
  if (application !== undefined) return { kind: "stored", id: row.id, created: false, outcome: "unchanged_has_application", applicationId: application, evaluate: false }
  await tx
    .updateTable("job_posting")
    .set({ ...titleFacts(input.title), company: input.company, posting_text: input.text, technologies: null, ats_skills: null, forward_statements: null })
    .where("id", "=", row.id)
    .where("owner_candidate_id", "=", candidateId)
    .where("origin", "=", "pasted_description")
    .execute()
  await tx.deleteFrom("eligibility_result").where("candidate_id", "=", candidateId).where("job_posting_id", "=", row.id).execute()
  await tx.deleteFrom("match_evidence").where("candidate_id", "=", candidateId).where("job_posting_id", "=", row.id).execute()
  await tx
    .updateTable("candidate_posting")
    // AC-7.12: the replace restarts the 15 minutes; the status was not "checking" (still_checking above).
    .set({ status, skip_reason: null, skip_detail: null, evaluation_failure: null, evaluated_at: null, checking_since: input.discoveredAt })
    .where("candidate_id", "=", candidateId)
    .where("job_posting_id", "=", row.id)
    .execute()
  return { kind: "stored", id: row.id, created: false, outcome: "replaced", applicationId: null, evaluate: status === "checking" }
}

/**
 * The status a new or replaced pasted posting starts in (PD-6.3, PD-6.4): `waiting_to_be_checked`
 * while the Candidate's postings may not be evaluated yet (D13) or the cost pause is on; else `checking`.
 * Never `not_checked` (never hidden) and never a pre-filter or unsupported-system skip (PD-2.3).
 */
async function startingStatus(tx: CandidateTx, candidateId: string): Promise<"checking" | "waiting_to_be_checked"> {
  const identity = await tx.selectFrom("candidate").select(["role", "state"]).where("id", "=", candidateId).executeTakeFirst()
  if (!evaluationAllowed(identity)) return "waiting_to_be_checked"
  const control = await tx.selectFrom("control_state").select("cost_paused").executeTakeFirst()
  return control?.cost_paused ? "waiting_to_be_checked" : "checking"
}

/** I-6: an ATS link whose text can't be used needs both names; nothing is stored without them. */
function missingNames(input: PastedDescriptionInput): Extract<PastedDescriptionResult, { kind: "names_missing" }> | null {
  const fieldErrors: PasteFieldError[] = []
  if (input.title === "") fieldErrors.push({ field: "title", position: null, problem: "required" })
  if (input.company === "") fieldErrors.push({ field: "company", position: null, problem: "required" })
  return fieldErrors.length === 0 ? null : { kind: "names_missing", fieldErrors }
}

/** The title and the facts derived from it, as `insertPostingOnce` derives them (no pre-filter for a pasted posting). */
function titleFacts(title: string) {
  return { title, title_folded: foldForKeywords(title), role_family: classifyTitle(title), seniority_marker: seniorityMarker(title) }
}

async function insertPrivate(
  tx: CandidateTx,
  candidateId: string,
  input: PastedDescriptionInput,
  status: "checking" | "waiting_to_be_checked",
  fingerprint: string | null
): Promise<string> {
  const id = randomUUID()
  const urn = `${PASTED_URN_PREFIX}${id}`
  await tx
    .insertInto("job_posting")
    .values({
      id,
      application_url: input.link?.normalised ?? urn,
      requisition_id: `pasted:${id}`,
      apply_url: input.link?.raw ?? urn,
      application_system: input.link?.applicationSystem ?? "none",
      apply_mode: "manual",
      origin: "pasted_description",
      owner_candidate_id: candidateId,
      paste_fingerprint: fingerprint,
      employer_board_id: null,
      remote_board_key: null,
      attribution_name: null,
      attribution_url: null,
      ...titleFacts(input.title),
      company: input.company,
      posting_text: input.text,
      structured: JSON.stringify(EMPTY_STRUCTURED),
      forward_statements: null,
      discovered_at: input.discoveredAt,
      prefilter_skip: null,
      posted_at: null,
      posted_date_kind: null,
    })
    .execute()
  await tx
    .insertInto("candidate_posting")
    .values({
      candidate_id: candidateId,
      job_posting_id: id,
      origin: "pasted_description",
      status,
      skip_reason: null,
      skip_detail: null,
      evaluation_failure: null,
      discovered_at: input.discoveredAt,
      evaluated_at: null,
      // AC-7.12: a row stored as "checking" starts its 15 minutes now (read only while it is "checking").
      checking_since: input.discoveredAt,
    })
    .execute()
  return id
}

/** Postings this Candidate holds whose application or apply URL is the link (`findByUrl` semantics), with any Application. */
async function heldForLink(tx: CandidateTx, candidateId: string, link: string): Promise<HeldRow[]> {
  const rows = await sql<HeldRow>`
    select p.id::text as id, p.owner_candidate_id::text as owner_candidate_id, (btrim(p.posting_text) = '') as text_empty, cp.status,
      (select a.id::text from application a
        where a.candidate_id = ${candidateId}::uuid and a.application_url = p.application_url and a.requisition_id = p.requisition_id) as application_id
    from job_posting p
    join candidate_posting cp on cp.job_posting_id = p.id and cp.candidate_id = ${candidateId}::uuid
    where p.application_url = ${link} or p.apply_url = ${link}
    order by cp.discovered_at, p.id`.execute(tx)
  return rows.rows
}

async function applicationFor(tx: CandidateTx, candidateId: string, postingId: string): Promise<string | undefined> {
  const row = await tx
    .selectFrom("application")
    .innerJoin("job_posting", (join) =>
      join.onRef("job_posting.application_url", "=", "application.application_url").onRef("job_posting.requisition_id", "=", "application.requisition_id")
    )
    .select("application.id")
    .where("application.candidate_id", "=", candidateId)
    .where("job_posting.id", "=", postingId)
    .executeTakeFirst()
  return row?.id
}

/** Postgres `foreign_key_violation` (23503): another Candidate still holds the shared row, so it stays. */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "23503"
}
