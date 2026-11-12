import { randomUUID } from "node:crypto"

import pg from "pg"

import { stackState } from "./db.ts"

/**
 * Fixtures for the Existing applications journeys (api-contract.md:643-646,
 * migrations 0006 and 0016). Written as the bootstrap superuser (RLS does not
 * bind it). Only Givens use these; every write a journey is about goes through
 * the browser.
 */
async function withDb<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: stackState().adminUrl })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

const candidateId = async (client: pg.Client, email: string) => {
  const id = (await client.query<{ id: string }>("select id from candidate where email = $1", [email])).rows[0]?.id
  if (!id) throw new Error(`No candidate ${email}`)
  return id
}

/** Removes the Candidate's existing applications and clears the step's completion time. */
export async function resetExistingApplications(email: string): Promise<void> {
  await withDb(async (client) => {
    const id = await candidateId(client, email)
    await client.query("delete from existing_application where candidate_id = $1", [id])
    // The Operator's row comes from migrations 0006/0016; make sure it exists for any Candidate used here.
    await client.query("insert into activation_state (candidate_id) values ($1) on conflict (candidate_id) do nothing", [id])
    await client.query("update activation_state set existing_applications_completed_at = null where candidate_id = $1", [id])
  })
}

export type StoredExisting = Readonly<{ company: string; roleTitle: string; applicationUrl: string; requisitionId: string | null; appliedOn: string }>

export async function existingApplications(email: string): Promise<StoredExisting[]> {
  return withDb(async (client) => {
    const { rows } = await client.query<StoredExisting>(
      `select e.company, e.role_title as "roleTitle", e.application_url as "applicationUrl", e.requisition_id as "requisitionId", e.applied_on::text as "appliedOn"
         from existing_application e join candidate c on c.id = e.candidate_id where c.email = $1 order by e.created_at, e.id`,
      [email]
    )
    return rows
  })
}

/** Stores one record as the api would (the URL is already in normalised form). */
export async function insertExistingApplication(email: string, record: StoredExisting): Promise<void> {
  await withDb(async (client) => {
    await client.query(
      `insert into existing_application (id, candidate_id, company, role_title, application_url, requisition_id, applied_on, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())`,
      [randomUUID(), await candidateId(client, email), record.company, record.roleTitle, record.applicationUrl, record.requisitionId, record.appliedOn]
    )
  })
}

export async function setExistingCompletedAt(email: string, at: string | null): Promise<void> {
  await withDb(async (client) => {
    await client.query("update activation_state set existing_applications_completed_at = $2 where candidate_id = $1", [await candidateId(client, email), at])
  })
}

export async function existingCompletedAt(email: string): Promise<Date | null> {
  return withDb(async (client) => {
    const { rows } = await client.query<{ at: Date | null }>(
      "select a.existing_applications_completed_at as at from activation_state a join candidate c on c.id = a.candidate_id where c.email = $1",
      [email]
    )
    return rows[0]?.at ?? null
  })
}
