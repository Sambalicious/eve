import { type Kysely, sql } from "kysely"

/**
 * Slice 8: Job Postings paging, the Posting filter and three more role families.
 *
 * - `job_posting.title_folded`: the keyword fold of the title, the form the title
 *   keyword matches against (case, accents and whitespace folded exactly as the
 *   classifier folds). Postgres has no `unaccent` here and its folding would
 *   differ from the code's, so the code writes it. Null when untitled.
 * - Indexes for the keyset orders: newest first on All, and per status for
 *   Skipped. The Ranked order is computed over the ranked rows (status index).
 * - Reclassification (8M): rows stored as `other` get the slice 8 classifier's
 *   answer for their stored title, with no duties: the new families are decided
 *   from the title only (8R.4), and a row the classifier put in `other` cannot
 *   reach steps 1 to 5 on its title alone, because steps 1 to 5 are unchanged.
 *   Only `role_family` changes, only from `other`, only to backend, mobile or
 *   devops_platform. No AI call, no network, deterministic, idempotent.
 *
 * Frozen (slice 8d, 8d.18, D8d-7): this migration carries its own copies of
 * the slice 8 fold and of the classifier steps it uses, as they were in main
 * 121802c, and imports no application code. It gives the same result on any
 * installation that applies it later (a restored pre-slice-8 backup), whatever
 * later slices do to the live fold or classifier. Installations that already
 * applied 0011 never run it again (Kysely records it by name). Never edit the
 * frozen copies: a later change to the fold or classifier ships its own
 * migration (the fold's backfill rule is at `foldForKeywords` in @eve/contracts).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table job_posting add column title_folded text`.execute(db)
  await backfillTitleFolded(db)
  await reclassifyOtherPostings(db)
  await sql`create index job_posting_newest_idx on job_posting (discovered_at desc, id)`.execute(db)
  await sql`create index job_posting_status_newest_idx on job_posting (status, discovered_at desc, id)`.execute(db)
  await sql`create index job_posting_role_family_idx on job_posting (role_family) where role_family is not null`.execute(db)
}

type TitleRow = { id: string; title: string | null }

export async function backfillTitleFolded(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<TitleRow>`select id, title from job_posting where title is not null and title_folded is null order by id`.execute(db)
  for (const row of rows) {
    const folded = row.title === null || row.title.trim() === "" ? null : frozenFold(row.title)
    if (folded !== null) await sql`update job_posting set title_folded = ${folded} where id = ${row.id}`.execute(db)
  }
}

/** 8M.1 to 8M.6. Exported so the reclassification can be run and tested on its own. Returns the number of rows changed. */
export async function reclassifyOtherPostings(db: Kysely<unknown>): Promise<number> {
  const { rows } = await sql<TitleRow>`select id, title from job_posting where role_family = 'other' order by id`.execute(db)
  let changed = 0
  for (const row of rows) {
    const family = frozenClassifyTitle(row.title ?? "")
    if (family !== "backend" && family !== "mobile" && family !== "devops_platform") continue
    await sql`update job_posting set role_family = ${family} where id = ${row.id} and role_family = 'other'`.execute(db)
    changed += 1
  }
  return changed
}

// ── Frozen copies, main 121802c. Do not edit (8d.18). ─────────────────────

/** `foldForKeywords` as in 121802c (apps/api/src/discovery/rules/rule-result.ts). */
export function frozenFold(text: string): string {
  return text
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (abbreviation) => abbreviation.replace(/\./g, ""))
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
}

const FROZEN_MANAGEMENT_TITLE = /\b(engineering manager|manager,? engineering|head of engineering|director|vp|vice president|people manager)\b/
const FROZEN_LEAD = /\b(tech(nical)? lead|lead engineer|lead developer|team lead|engineering lead|lead (frontend|front-end|software))\b/
const FROZEN_FRONTEND = /\b(frontend|front-end|front end|ui engineer|web engineer|react)\b/
const FROZEN_FULLSTACK = /\b(full[- ]?stack)\b/
const FROZEN_PRODUCT = /\b(product engineer(ing)?)\b/
const FROZEN_MOBILE = /\b(ios|android|mobile|flutter|swiftui|react native|xamarin|kotlin multiplatform)\b/
const FROZEN_BACKEND = /\b(backend|back-end|back end|server-side|server side)\b/
const FROZEN_DEVOPS_PLATFORM =
  /\b(devops|dev ops|site reliability|sre|reliability engineer|platform engineer(ing)?|infrastructure|infra engineer|cloud engineer|cloud infrastructure)\b/

/**
 * `classifyRoleFamily` with no duties, as in 121802c (apps/api/src/discovery/rules/ranking.ts), the only call this
 * migration makes. With no duties, the duty checks of 121802c are always false, so only the title steps remain,
 * in the same order and precedence.
 */
export function frozenClassifyTitle(title: string): string {
  const folded = frozenFold(title)
  if (FROZEN_MANAGEMENT_TITLE.test(folded) && !FROZEN_LEAD.test(folded)) return "people_management"
  if (FROZEN_LEAD.test(folded)) return "technical_lead"
  if (FROZEN_FULLSTACK.test(folded)) return "fullstack"
  if (FROZEN_PRODUCT.test(folded)) return "product_engineering"
  if (FROZEN_FRONTEND.test(folded)) return "senior_frontend"
  if (FROZEN_MOBILE.test(folded)) return "mobile"
  if (FROZEN_BACKEND.test(folded)) return "backend"
  if (FROZEN_DEVOPS_PLATFORM.test(folded)) return "devops_platform"
  return "other"
}
