import { randomUUID } from "node:crypto"

import pg from "pg"

import { stackState } from "./db.ts"

/**
 * FEAT-0017 QA authoring [5e] (api-contract.md v1.32.0, architecture.md migration 0042).
 * Fixtures on the E2E database as the bootstrap superuser (RLS does not bind it).
 * Every row this file owns carries the company prefix "AF-E2E " so `resetAddedSkills` can remove it.
 * The API must run with `ADDED_FACTS_ENABLED=1` (set in support/global-setup.ts).
 */
async function withClient<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: stackState().adminUrl })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

export type Role = Readonly<{ sectionId: string; title: string; employer: string; period: string }>
export type Seeded = Readonly<{ applicationId: string; postingId: string; title: string; company: string; roles: readonly Role[]; profileVersion: number }>

/** The Career Profile background of the added-skills features. */
const PROFILE_SECTIONS = [
  {
    id: "af-exp-1",
    kind: "experience",
    title: "Senior Frontend Engineer",
    organization: "Brightwave Ltd",
    period: "2021 to 2024",
    sourceQuote: null,
    facts: [
      { id: "af-fact-1", text: "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd", sourceQuote: null },
      { id: "af-fact-2", text: "Mentored 6 junior developers", sourceQuote: null },
    ],
  },
  {
    id: "af-exp-2",
    kind: "experience",
    title: "Frontend Engineer",
    organization: "Acme Ltd",
    period: "2018 to 2021",
    sourceQuote: null,
    facts: [{ id: "af-fact-3", text: "Frontend Engineer at Acme Ltd, 2018 to 2021", sourceQuote: null }],
  },
]
export const ROLES: readonly Role[] = [
  { sectionId: "af-exp-1", title: "Senior Frontend Engineer", employer: "Brightwave Ltd", period: "2021 to 2024" },
  { sectionId: "af-exp-2", title: "Frontend Engineer", employer: "Acme Ltd", period: "2018 to 2021" },
]

const DEFAULT_GAPS = ["Figma", "design systems", "CI/CD pipelines", "frontend testing", "component library", "error boundaries"]

const RESUME = (gaps: readonly string[]) => ({
  kind: "resume",
  summary: [{ text: "Senior Frontend Engineer who builds products from scratch to production.", factIds: ["af-fact-1"] }],
  experience: [{ heading: { text: "Senior Frontend Engineer, Brightwave Ltd, 2021 to 2024", factIds: ["af-fact-3"] }, bullets: [{ text: "Built a React and TypeScript merchant dashboard from scratch to production.", factIds: ["af-fact-1"] }] }],
  skills: [{ text: "React, TypeScript", factIds: ["af-fact-1"] }],
  education: [],
  ats: { score: 62, total: 9, matched: ["React", "TypeScript"], missing: [], gaps: [...gaps] },
})
const LETTER = {
  kind: "cover_letter",
  greeting: "Dear Hiring Team at Northwind Labs,",
  opening: null,
  paragraphs: [{ text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["af-fact-1"] }],
  closingLine: null,
  closing: "Kind regards,",
}

/** The match-and-queue background: 3 of 10 core responsibilities backed, MR1 met. */
const MATCH_ITEMS = [
  { group: "core", text: "Build design systems with React", factId: "af-fact-1" },
  { group: "core", text: "Own the CI/CD pipelines", factId: null },
  { group: "core", text: "Own the design process end to end", factId: null },
  { group: "core", text: "Mentor junior engineers", factId: "af-fact-2" },
  { group: "core", text: "Ship weekly with TypeScript", factId: "af-fact-1" },
  { group: "core", text: "Review pull requests", factId: null },
  { group: "core", text: "Write frontend tests", factId: null },
  { group: "core", text: "Work with product", factId: null },
  { group: "core", text: "Maintain a component library", factId: null },
  { group: "core", text: "Run releases", factId: null },
  { group: "mandatory", text: "Experience with React", factId: "af-fact-1" },
]

/** One-liners that lift the Application Match from 3/10 to 7/10 (CR2, CR3, CR6 and CR7). */
export const LIFTING_FACTS = [
  { kind: "one_liner", text: "Owned the CI/CD pipelines at Acme", term: "CI/CD pipelines", roleIndex: 1 },
  { kind: "one_liner", text: "Owned the design process end to end at Acme", term: null, roleIndex: 1 },
  { kind: "one_liner", text: "Reviewed pull requests at Acme", term: null, roleIndex: 1 },
  { kind: "one_liner", text: "Wrote frontend testing notes at Acme", term: null, roleIndex: 1 },
] as const

export type FactInput = Readonly<{ kind: "skill_only" | "one_liner"; text: string; term?: string | null; roleIndex?: number }>

/** Ensures one approved Career Profile with the two experience roles this feature's fixtures name. */
async function ensureProfile(client: pg.Client, candidateId: string): Promise<{ version: number; roles: readonly Role[] }> {
  const approved = (await client.query<{ version: number; sections: unknown }>("select version, sections from career_profile_version where candidate_id = $1 and status = 'approved' order by version limit 1", [candidateId])).rows[0]
  if (!approved) {
    await client.query(
      "insert into career_profile_version (candidate_id, version, status, source, resume_upload_id, sections, created_at, approved_at) values ($1, 1, 'approved', 'edit', null, $2::jsonb, now(), now())",
      [candidateId, JSON.stringify(PROFILE_SECTIONS)]
    )
    return { version: 1, roles: ROLES }
  }
  const sections = Array.isArray(approved.sections) ? (approved.sections as Array<{ id?: string; kind?: string }>) : []
  const ours = sections.filter((section) => section.kind === "experience").map((section) => section.id)
  if (ours.length !== ROLES.length || ours.some((id, index) => id !== ROLES[index]!.sectionId)) {
    await client.query("update career_profile_version set sections = $2::jsonb where candidate_id = $1 and version = $3", [candidateId, JSON.stringify(PROFILE_SECTIONS), approved.version])
  }
  return { version: approved.version, roles: ROLES }
}

/** Replaces the approved Career Profile with a version that has no experience section (AC 2.4). */
export async function setNoExperienceProfile(email: string): Promise<void> {
  await withClient(async (client) => {
    const candidateId = (await client.query<{ id: string }>("select id from candidate where email = $1", [email])).rows[0]!.id
    await client.query("update career_profile_version set sections = $2::jsonb where candidate_id = $1 and status = 'approved'", [
      candidateId,
      JSON.stringify([{ id: "af-summary", kind: "summary", title: "", organization: null, period: null, sourceQuote: null, facts: [{ id: "af-summary-fact", text: "Senior Frontend Engineer", sourceQuote: null }] }]),
    ])
  })
}

/** Deletes every Application, posting and fact the added-skills journeys own (by the "AF-E2E" company prefix). */
export async function resetAddedSkills(): Promise<void> {
  await withClient(async (client) => {
    const ids = "select id from application where company like 'AF-E2E %'"
    for (const table of ["application_added_fact", "notification_outbox", "submission_event", "application_form_read", "tailored_document", "outcome"]) {
      await client.query(`delete from ${table} where application_id in (${ids})`)
    }
    await client.query("delete from application where company like 'AF-E2E %'")
    const postings = "select id from job_posting where company like 'AF-E2E %'"
    for (const table of ["match_evidence", "eligibility_result", "candidate_posting"]) await client.query(`delete from ${table} where job_posting_id in (${postings})`)
    await client.query("delete from job_posting where company like 'AF-E2E %'")
  })
}

export type SeedOptions = Readonly<{
  company: string
  title?: string
  state?: "prepared" | "generating" | "documents_ready" | "documents_blocked" | "documents_failed"
  submissionState?: string | null
  sampleState?: "awaiting_review" | "approved" | "rejected" | null
  manualCompletedAt?: Date | null
  gaps?: readonly string[]
  documents?: boolean
  facts?: readonly FactInput[]
  /** Defaults to the current fact count: fresh documents. Pass an older value to make them stale. */
  storedVersion?: number
  /** The posting's decision, and whether a lift is possible. */
  postingStatus?: "ranked" | "skipped" | "excluded"
  skipReason?: string | null
  blockedCause?: string | null
  blockedClaim?: string | null
  blockedDocument?: "resume" | "cover_letter" | null
  blockedTerms?: readonly string[]
}>

/** One Application for ADA with its documents, added facts, Match evidence and posting decision. */
export async function seedAddedSkillsApplication(email: string, options: SeedOptions): Promise<Seeded> {
  const title = options.title ?? "Senior Frontend Engineer"
  const company = `AF-E2E ${options.company}`
  const postingId = randomUUID()
  const applicationId = randomUUID()
  const state = options.state ?? "documents_ready"
  const gaps = options.gaps ?? DEFAULT_GAPS
  const facts = options.facts ?? []
  const documents = options.documents ?? (state === "documents_ready" || state === "documents_blocked")
  const storedVersion = options.storedVersion ?? facts.length
  let roles: readonly Role[] = ROLES
  let profileVersion = 1

  await withClient(async (client) => {
    const candidateId = (await client.query<{ id: string }>("select id from candidate where email = $1", [email])).rows[0]!.id
    const profile = await ensureProfile(client, candidateId)
    roles = profile.roles
    profileVersion = profile.version
    const url = `https://boards.greenhouse.io/afe2e/jobs/${postingId.slice(0, 8)}`
    await client.query(
      `insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, posting_text,
          technologies, role_family, discovered_at, posted_at, posted_date_kind, seniority_marker)
        values ($1, $2, $3, $2, 'greenhouse', 'automatic', 'employer_board', $4, lower($4), $5, $6, $7::jsonb,
          'senior_frontend', now(), now(), 'published', 'mid_plus')`,
      [postingId, url, `AF-${postingId.slice(0, 6)}`, title, company, "Build design systems with React and TypeScript. You own CI/CD pipelines and Figma handoff.", JSON.stringify([{ name: "React", quote: "React" }])]
    )
    const status = options.postingStatus ?? "ranked"
    await client.query(
      `insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, skip_detail, evaluation_failure, discovered_at, evaluated_at)
        values ($1, $2, 'employer_board', $3, $4, null, null, now(), now())`,
      [candidateId, postingId, status, status === "ranked" ? null : (options.skipReason ?? "weak_core_match")]
    )
    await client.query(
      `insert into eligibility_result (candidate_id, job_posting_id, arrangement, relocation_country, employment_type, rules, eligible, normalized_monthly_max_usd, fx_rate_date, evaluated_at)
        values ($1, $2, 'remote', null, 'direct', $3::jsonb, $4, null, null, now())`,
      [candidateId, postingId, JSON.stringify([{ rule: "location", result: status === "excluded" ? "violated" : "met", quote: "Remote" }]), status !== "excluded"]
    )
    await client.query(
      `insert into match_evidence (candidate_id, job_posting_id, career_profile_version, verdict, weak_reason, covered_count, total_count, threshold, items, evaluated_at, criteria_version)
        values ($1, $2, $3, 'weak', 'coverage_below_threshold', 3, 10, '0.700', $4::jsonb, now(), 1)`,
      [candidateId, postingId, profileVersion, JSON.stringify(MATCH_ITEMS)]
    )
    await client.query(
      `insert into application (candidate_id, id, job_posting_id, application_url, requisition_id, company, role_title, state, career_profile_version, created_at, updated_at, submission_state, sample_state, manual_completed_at, blocked_document, blocked_claim, blocked_claim_cause, blocked_claim_terms, blocked_claim_more_terms)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        candidateId, applicationId, postingId, url, `AF-${postingId.slice(0, 6)}`, company, title, state, profileVersion,
        options.submissionState ?? null, options.sampleState ?? null, options.manualCompletedAt ?? null,
        options.blockedDocument ?? null, options.blockedClaim ?? null, options.blockedCause ?? null,
        options.blockedTerms === undefined ? null : [...options.blockedTerms],
        options.blockedTerms === undefined ? null : 0,
      ]
    )
    if (documents) {
      for (const [kind, content] of [["resume", RESUME(gaps)], ["cover_letter", LETTER]] as const) {
        await client.query(
          `insert into tailored_document (candidate_id, id, application_id, kind, career_profile_version, content, pdf_storage_name, docx_storage_name, pdf_sha256, docx_sha256, created_at, added_facts_version, added_facts)
            values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'x', 'x', now(), $9, $10::jsonb)`,
          [candidateId, randomUUID(), applicationId, kind, profileVersion, JSON.stringify(content), `${randomUUID()}.pdf`, `${randomUUID()}.docx`, storedVersion, JSON.stringify({ available: [], cited: [] })]
        )
      }
    }
    let version = 0
    for (const fact of facts) {
      version += 1
      const role = fact.kind === "one_liner" ? (roles[fact.roleIndex ?? Math.min(1, roles.length - 1)] ?? roles[0]!) : null
      await client.query(
        `insert into application_added_fact (candidate_id, application_id, id, kind, text, text_key, term, role_section_id, role_snapshot, save_to_profile, profile_draft_version, affirmed_at, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, false, null, now(), now(), now())`,
        [
          candidateId, applicationId, randomUUID(), fact.kind, fact.text, fact.text.trim().toLowerCase(),
          fact.term ?? (fact.kind === "skill_only" ? fact.text : null), role?.sectionId ?? null, role === null ? null : JSON.stringify({ title: role.title, employer: role.employer, period: role.period }),
        ]
      )
    }
    await client.query("update application set added_facts_version = $2 where id = $1", [applicationId, version])
  })
  return { applicationId, postingId, title, company, roles, profileVersion }
}

export type AddedFactRow = Readonly<{ id: string; kind: string; text: string; term: string | null; role_snapshot: { title: string; employer: string } | null; save_to_profile: boolean }>

export async function addedFactsOf(applicationId: string): Promise<AddedFactRow[]> {
  return withClient(async (client) => (await client.query<AddedFactRow>("select id, kind, text, term, role_snapshot, save_to_profile from application_added_fact where application_id = $1 order by created_at", [applicationId])).rows)
}

/** Writes the documents' recorded added-fact set (PRD 5.10, AC 7.9): what the sample screen marks "Added skills used". */
export async function setDocumentsSnapshot(applicationId: string, available: readonly unknown[], cited: readonly string[]): Promise<void> {
  await withClient((client) =>
    client.query("update tailored_document set added_facts = $2::jsonb where application_id = $1", [applicationId, JSON.stringify({ available, cited })])
  )
}

export async function applicationRow(applicationId: string): Promise<{
  state: string
  submission_state: string | null
  added_facts_version: number
  added_facts_confirmed_version: number | null
  documents: number
  drops: number
}> {
  return withClient(async (client) => {
    const row = (
      await client.query<{ state: string; submission_state: string | null; added_facts_version: number; added_facts_confirmed_version: number | null; documents: number; drops: number }>(
        `select a.state, a.submission_state, a.added_facts_version, a.added_facts_confirmed_version,
           (select count(*)::int from tailored_document d where d.application_id = a.id) as documents,
           (select count(*)::int from submission_event e where e.application_id = a.id and e.kind = 'queued_posting_dropped' and e.detail = 'documents_stale') as drops
         from application a where a.id = $1`,
        [applicationId]
      )
    ).rows[0]
    if (!row) throw new Error(`no application ${applicationId}`)
    return row
  })
}

/** Confirms through the real route with the session's CSRF token, from the page. */
export async function confirmThroughPage(page: import("@playwright/test").Page, applicationId: string, expectedVersion: number): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ applicationId, expectedVersion }) => {
      const session = await (await fetch("/v1/session", { credentials: "include" })).json()
      const response = await fetch(`/v1/applications/${applicationId}/added-facts/confirm`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ expectedVersion }),
      })
      return { status: response.status, body: await response.json() }
    },
    { applicationId, expectedVersion }
  )
}

/** A forged write, for the "the API decides, whatever the page did" scenarios. */
export async function forged(
  page: import("@playwright/test").Page,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const session = await (await fetch("/v1/session", { credentials: "include" })).json()
      const response = await fetch(path, {
        method,
        credentials: "include",
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "x-csrf-token": session.csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      return { status: response.status, body: text === "" ? null : JSON.parse(text) }
    },
    { method, path, body }
  )
}
