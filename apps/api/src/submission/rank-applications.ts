import { type RoleFamily, TIER, rankPostings } from "../discovery/rules/ranking.js"

/** One Application with its posting's ranking inputs, as the submission and sample queues read them. */
export type RankableApplication = Readonly<{
  id: string
  job_posting_id: string
  role_family: string | null
  covered_count: number | null
  total_count: number | null
  /** ATS fit (0029); null without one. */
  ats_fit?: number | null
  discovered_at: Date
  origin: string
}>

/**
 * Slice 8d (RF-27, RF-28, CR8D-05): Application ids in the Ranked tab order.
 * `rankPostings` breaks a full tie on its id, and the Ranked tab breaks it on
 * the posting id, so each row is ranked under "<posting id> <application id>":
 * the posting id decides first (fixed-length lower-case uuid text), and the
 * Application id only orders two Applications of one posting, which the data
 * never holds today. Every row keeps its own key, so no Application is dropped
 * or repeated whatever the data holds. EPIC-0002 B1: `tiers` is the Candidate's
 * tier map, the one the Ranked tab uses, so submission follows the displayed rank.
 */
export function rankApplications(rows: readonly RankableApplication[], tiers: Readonly<Record<RoleFamily, number>> = TIER): string[] {
  const byKey = new Map(rows.map((row) => [`${row.job_posting_id} ${row.id}`, row.id]))
  const order = rankPostings(
    rows.map((row) => ({
      id: `${row.job_posting_id} ${row.id}`,
      family: (row.role_family ?? "other") as RoleFamily,
      coverage: row.total_count ? (row.covered_count ?? 0) / row.total_count : 0,
      atsFit: row.ats_fit ?? null,
      discoveredAt: row.discovered_at,
      fromEmployerBoard: row.origin === "employer_board",
    })),
    tiers
  )
  return order.flatMap((key) => {
    const applicationId = byKey.get(key)
    return applicationId === undefined ? [] : [applicationId]
  })
}
