import pg from "pg"

import { stackState } from "./db.ts"

/**
 * EPIC-0009 fixtures for the installation-wide `remote_board` table (migration
 * 0004; no candidate_id, no RLS, architecture "PRD Q2"). Written as the
 * bootstrap superuser, like every other e2e fixture. Every spec that changes a
 * row snapshots the table first and restores it after, because the rows are
 * shared by the whole run.
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

export type BoardKey = "himalayas" | "remoteok" | "remotive" | "weworkremotely"

export type BoardRow = Readonly<{
  key: BoardKey
  verifiedOn: string | null
  verificationBasis: string | null
  enabled: boolean
  available: boolean
  unavailableReason: string | null
}>

export async function snapshotRemoteBoards(): Promise<BoardRow[]> {
  return withDb(async (client) => {
    const { rows } = await client.query<BoardRow>(
      `select key, verified_on::text as "verifiedOn", verification_basis as "verificationBasis", enabled, available,
              unavailable_reason as "unavailableReason"
         from remote_board order by position`
    )
    return rows
  })
}

export async function restoreRemoteBoards(saved: readonly BoardRow[]): Promise<void> {
  await withDb(async (client) => {
    for (const row of saved) {
      // enabled last: the table refuses an enabled row that is not verified (remote_board_enabled_requires_verified).
      await client.query("update remote_board set enabled = false where key = $1", [row.key])
      await client.query(
        "update remote_board set verified_on = $2, verification_basis = $3, available = $4, unavailable_reason = $5 where key = $1",
        [row.key, row.verifiedOn, row.verificationBasis, row.available, row.unavailableReason]
      )
      await client.query("update remote_board set enabled = $2 where key = $1", [row.key, row.enabled])
    }
  })
}

/** Sets one board's verification (null clears it) and turns the board off. */
export async function setBoardVerification(key: BoardKey, verification: { on: string; basis: string } | null): Promise<void> {
  await withDb(async (client) => {
    await client.query("update remote_board set enabled = false where key = $1", [key])
    await client.query("update remote_board set verified_on = $2, verification_basis = $3 where key = $1", [key, verification?.on ?? null, verification?.basis ?? null])
  })
}

/**
 * The Gherkin "draftSources" fixture (job-sources-help.feature, mark-verified-help.feature headers):
 * Himalayas and Remote OK verified 2026-10-19, Remotive unavailable, We Work Remotely not verified,
 * every board off.
 */
export const DRAFT_SOURCES = {
  himalayasBasis: "Terms clauses 30A and 113 allow API use with credit.",
  remoteOkBasis: "API terms allow use with a link back.",
  remotiveReason: "Remotive's terms (section 8) require written permission for automated access. The Candidate must obtain it first.",
} as const

export async function setDraftSources(): Promise<void> {
  await setBoardVerification("himalayas", { on: "2026-10-19", basis: DRAFT_SOURCES.himalayasBasis })
  await setBoardVerification("remoteok", { on: "2026-10-19", basis: DRAFT_SOURCES.remoteOkBasis })
  await setBoardVerification("weworkremotely", null)
  await withDb((client) =>
    client.query("update remote_board set enabled = false, verified_on = null, verification_basis = null, available = false, unavailable_reason = $1 where key = 'remotive'", [
      DRAFT_SOURCES.remotiveReason,
    ])
  )
}

export async function boardRow(key: BoardKey): Promise<BoardRow> {
  const row = (await snapshotRemoteBoards()).find((r) => r.key === key)
  if (!row) throw new Error(`No remote_board ${key}`)
  return row
}
