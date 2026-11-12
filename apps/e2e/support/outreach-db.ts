import { randomUUID } from "node:crypto"

import pg from "pg"

import { stackState } from "./db.ts"

/**
 * QA test authoring, step [5e], EPIC-0014 Outreach messages (e2e tier).
 *
 * Declared double (qa.md tier 3): the E2E stack runs the real web app, api and Postgres with
 * `ANTHROPIC_API_KEY` empty and every non-loopback host blocked, so no outreach Run can succeed.
 * `seedOutreach` stands in for the model's reply by writing the rows a finished Run would have
 * written (as `seedGeneratedDocuments` does for Tailored Documents); everything the browser does
 * goes through the real read route.
 *
 * Strings are copied from copy-deck.md byte for byte, not imported from the product, so a wording
 * change fails the journey.
 */

export const OUTREACH = {
  heading: "Outreach", // C-OM-1
  description:
    "Short texts for this Application, written from your approved Career Profile. You copy and send them yourself. Eve sends nothing.", // C-OM-2
  referralLabel: "Referral request", // C-OM-4.label
  referralPurpose: "For an employee of the company. It asks if they would refer you, and is easy to decline.", // C-OM-4.purpose
  introductionLabel: "Introduction", // C-OM-5.label
  introductionPurpose: "For a hiring manager or decision maker. It says what you bring and asks for a short conversation.", // C-OM-5.purpose
  noteLabel: "Application note", // C-OM-6.label
  notePurpose: "For a form field, or the body of an email application. It says what you bring.", // C-OM-6.purpose
  tabsLabel: "Kind of text", // C-OM-52
  nameLabel: "Their name", // C-OM-7
  copy: "Copy", // C-OM-41
  openInEmail: "Open in email", // C-OM-43
  copied: "Copied", // C-OM-42
  blockedCause:
    "The introduction wasn't kept: it failed Eve's checks, so nothing was copied or sent. If a claim is true of you, add that fact to your Career Profile. A new run can differ.", // C-OM-26, {kind} introduction
  blockedQuoteLabel: "The first sentence that failed Eve's checks:", // C-OM-53
  count: (n: number, max: number) => `${n} of ${max} characters`, // C-OM-39
} as const

/** The Referral request's Ready body (gherkin outreach-copy-and-email, "the referral text"). */
export const REFERRAL_BODY =
  "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd. I mentored 6 junior developers. " +
  "Would you be open to referring me for the Senior Frontend Engineer role at Northwind Labs, with no pressure at all if the answer is no?"
export const INTRODUCTION_BODY =
  "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd. I cut our release cycle from 2 weeks to 3 days. " +
  "Could we have a short conversation, or could you point me to the right person?"
export const NOTE_BODY = "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd. I mentored 6 junior developers."

/** A first failed sentence with characters a renderer must not reinterpret (AC 11.4). */
export const QUOTE = 'I said "ship it" & built <b>Q&A</b> tools in 日本語 at Brightwave Ltd, see https://apply.northwind.example/ref.'

export type SeededOutreachApplication = Readonly<{ id: string; company: string; title: string; requisition: string }>

async function withClient<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: stackState().adminUrl })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

/** Location of the row a finished Run writes: greeting + blank line + body is composed by the api at read time. */
async function insertOutreach(
  client: pg.Client,
  candidateId: string,
  applicationId: string,
  kind: "referral_request" | "introduction" | "application_note",
  row: Readonly<{ body?: string | null; readerName?: string | null; profileVersion?: number; lastFailure?: string | null; firstFailedSentence?: string | null }>
): Promise<void> {
  await client.query(
    `insert into outreach_message
       (id, candidate_id, application_id, kind, reader_name, body, sentences, profile_version, written_at, last_failure, first_failed_sentence, run_status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, 'idle', now(), now())`,
    [
      randomUUID(),
      candidateId,
      applicationId,
      kind,
      row.readerName ?? null,
      row.body ?? null,
      row.body == null ? null : JSON.stringify([{ kind: "statement", text: row.body, factIds: ["F1"] }]),
      row.body == null ? null : (row.profileVersion ?? 1),
      row.body == null ? null : new Date(),
      row.lastFailure ?? null,
      row.firstFailedSentence ?? null,
    ]
  )
}

/**
 * A `documents_ready` Application for `email` with the outreach rows a finished Run would have
 * written: all three kinds Ready, `introduction` blocked with a stored quote and no text, or a mix.
 */
export async function seedOutreach(
  email: string,
  seed: Readonly<{
    company?: string
    title?: string
    referral?: string | null
    introduction?: string | null
    note?: string | null
    blockedIntroduction?: string | null
    readerName?: string | null
  }> = {}
): Promise<SeededOutreachApplication> {
  const company = seed.company ?? "Northwind Labs"
  const title = seed.title ?? "Senior Frontend Engineer"
  return withClient(async (client) => {
    const owner = (await client.query<{ id: string }>("select id from candidate where email = $1", [email])).rows[0]
    if (!owner) throw new Error(`No candidate ${email}`)
    const candidateId = owner.id
    const id = randomUUID()
    const postingId = randomUUID()
    const requisition = `OM14-${id.slice(0, 8)}`
    const url = `https://boards.greenhouse.io/northwind/jobs/${requisition}`

    await client.query(
      `insert into career_profile_version (candidate_id, version, status, source, resume_upload_id, sections, created_at, approved_at)
       select $1, 1, 'approved', 'edit', null, '[]', now(), now()
       where not exists (select 1 from career_profile_version where candidate_id = $1 and status = 'approved')`,
      [candidateId]
    )
    await client.query(
      `insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, posting_text, discovered_at, role_family, seniority_marker, posted_at, posted_date_kind)
       values ($1, $2, $3, $2, 'greenhouse', 'automatic', 'employer_board', $4, lower($4), $5, $6, now(), 'senior_frontend', 'mid_plus', now(), 'published')`,
      [postingId, url, requisition, title, company, "Build design systems with React and TypeScript. You will mentor engineers and ship weekly."]
    )
    await client.query(`insert into candidate_posting (candidate_id, job_posting_id, origin, status, discovered_at, evaluated_at) values ($1, $2, 'employer_board', 'ranked', now(), now())`, [candidateId, postingId])
    await client.query(
      `insert into application (id, candidate_id, job_posting_id, application_url, requisition_id, company, role_title, state, career_profile_version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'documents_ready', 1, now(), now())`,
      [id, candidateId, postingId, url, requisition, company, title]
    )

    await insertOutreach(client, candidateId, id, "referral_request", { body: seed.referral === undefined ? REFERRAL_BODY : seed.referral, readerName: seed.readerName ?? "Amara Okafor" })
    if (seed.blockedIntroduction === undefined) {
      await insertOutreach(client, candidateId, id, "introduction", { body: seed.introduction === undefined ? INTRODUCTION_BODY : seed.introduction })
    } else {
      await insertOutreach(client, candidateId, id, "introduction", { body: null, lastFailure: "blocked", firstFailedSentence: seed.blockedIntroduction })
    }
    await insertOutreach(client, candidateId, id, "application_note", { body: seed.note === undefined ? NOTE_BODY : seed.note })
    return { id, company, title, requisition }
  })
}

/** Removes every Application, posting and outreach row these journeys seeded. */
export async function resetOutreach(): Promise<void> {
  await withClient(async (client) => {
    const applications = "select id from application where requisition_id like 'OM14-%'"
    await client.query(`delete from outreach_message where application_id in (${applications})`)
    await client.query(`delete from application where requisition_id like 'OM14-%'`)
    const postings = "select id from job_posting where requisition_id like 'OM14-%'"
    await client.query(`delete from candidate_posting where job_posting_id in (${postings})`)
    await client.query(`delete from job_posting where requisition_id like 'OM14-%'`)
  })
}

/** Every outreach row of an Application, as the database holds it (the quote is never in `body`). */
export async function outreachRows(applicationId: string): Promise<{ kind: string; body: string | null; reader_name: string | null; last_failure: string | null; first_failed_sentence: string | null }[]> {
  return withClient(async (client) =>
    (
      await client.query(
        "select kind, body, reader_name, last_failure, first_failed_sentence from outreach_message where application_id = $1 order by kind",
        [applicationId]
      )
    ).rows
  )
}

/** Code points, as api-contract.md 7.3 counts every figure in this epic. */
export const codePoints = (text: string) => Array.from(text).length
