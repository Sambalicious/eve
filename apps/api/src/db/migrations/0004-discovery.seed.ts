/**
 * Seed data for migration 0004. Frozen with the migration: change the list later
 * with a new migration, never by editing this file.
 *
 * Employer list: the 28 verified companies from
 * .runs/slice-03/research/employer-list.md (researched 2026-10-19), in the
 * researched order, as a DRAFT the Candidate approves. Coinbase, Phantom and
 * Consensys are flagged "crypto" for the Candidate's call. Discord is excluded.
 */
export type EmployerSeed = Readonly<{
  position: number
  company: string
  applicationSystem: "greenhouse" | "lever" | "ashby"
  boardToken: string
  flag: "crypto" | null
  note: string | null
}>

const rows: ReadonlyArray<readonly [string, EmployerSeed["applicationSystem"], string, ("crypto" | null)?, string?]> = [
  ["Railway", "ashby", "railway"],
  ["Supabase", "ashby", "supabase"],
  ["Canonical", "greenhouse", "canonical"],
  ["Moniepoint", "greenhouse", "moniepoint", null, "Posts roles as \"Remote, Lagos, Nigeria\"."],
  ["Metabase", "lever", "metabase"],
  ["Automattic", "greenhouse", "automatticcareers"],
  ["Andela", "ashby", "andela", null, "Says it does not offer work visas."],
  ["GitLab", "greenhouse", "gitlab"],
  ["Phantom", "ashby", "phantom", "crypto", "Crypto wallet. Decide at approval."],
  ["Linear", "ashby", "linear"],
  ["Camunda", "ashby", "camunda"],
  ["Synthesia", "ashby", "synthesia"],
  ["n8n", "ashby", "n8n"],
  ["Grafana Labs", "greenhouse", "grafanalabs"],
  ["ClickHouse", "ashby", "clickhouse"],
  ["Wikimedia Foundation", "greenhouse", "wikimedia", null, "Hiring countries list does not include Nigeria."],
  ["Mozilla", "greenhouse", "mozilla"],
  ["PostHog", "ashby", "posthog"],
  ["Docker", "ashby", "docker"],
  ["Consensys", "greenhouse", "consensys", "crypto", "Crypto and web3. Decide at approval."],
  ["Pleo", "ashby", "pleo"],
  ["Sanity", "ashby", "sanity"],
  ["Paddle", "ashby", "paddle"],
  ["ClickUp", "ashby", "clickup", null, "Considers visa sponsorship case by case."],
  ["Bitwarden", "greenhouse", "bitwarden", null, "US roles only on the check date."],
  ["Sentry", "ashby", "sentry", null, "San Francisco and Toronto roles on the check date."],
  ["1Password", "ashby", "1password", null, "US and Canada roles on the check date."],
  ["Coinbase", "greenhouse", "coinbase", "crypto", "Crypto exchange. Decide at approval."],
]

export const EMPLOYER_LIST_SEED: readonly EmployerSeed[] = rows.map(([company, applicationSystem, boardToken, flag, note], index) => ({
  position: index + 1,
  company,
  applicationSystem,
  boardToken,
  flag: flag ?? null,
  note: note ?? null,
}))

/**
 * Remote boards in the AC 1.9 order. Verification records the orchestrator's
 * decision of 2026-10-19 from .runs/slice-03/research/remote-boards.md. Every
 * board starts disabled; Remotive is not available until the Candidate obtains
 * written permission (its terms section 8).
 */
export type RemoteBoardSeed = Readonly<{
  key: "himalayas" | "remoteok" | "remotive" | "weworkremotely"
  name: string
  position: number
  verifiedOn: string | null
  verificationBasis: string | null
  available: boolean
  unavailableReason: string | null
  attributionName: string
  attributionUrl: string
}>

export const REMOTE_BOARD_SEED: readonly RemoteBoardSeed[] = [
  {
    key: "himalayas",
    name: "Himalayas",
    position: 1,
    verifiedOn: "2026-10-19",
    verificationBasis:
      "Terms clauses 30A and 113 permit the public API for personal integrations, on condition of a visible Himalayas credit and Apply starting from the API's applicationLink.",
    available: true,
    unavailableReason: null,
    attributionName: "Himalayas",
    attributionUrl: "https://himalayas.app",
  },
  {
    key: "remoteok",
    name: "Remote OK",
    position: 2,
    verifiedOn: "2026-10-19",
    verificationBasis:
      "API terms in the live response and remoteok.com/legal allow use with a followed link back and Remote OK named as the source. No clause forbids automated use.",
    available: true,
    unavailableReason: null,
    attributionName: "Remote OK",
    attributionUrl: "https://remoteok.com",
  },
  {
    key: "remotive",
    name: "Remotive",
    position: 3,
    verifiedOn: null,
    verificationBasis: null,
    available: false,
    unavailableReason: "Remotive's terms (section 8) require written permission for automated access. The Candidate must obtain it first.",
    attributionName: "Remotive",
    attributionUrl: "https://remotive.com",
  },
  {
    key: "weworkremotely",
    name: "We Work Remotely",
    position: 4,
    verifiedOn: "2026-10-19",
    verificationBasis: "The official RSS feed page says anyone can use the feed, with attribution. The terms have no clause on automated access.",
    available: true,
    unavailableReason: null,
    attributionName: "We Work Remotely",
    attributionUrl: "https://weworkremotely.com",
  },
]
