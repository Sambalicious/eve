import path from "node:path"
import { fileURLToPath } from "node:url"

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const REPO_ROOT = path.resolve(E2E_DIR, "../..")
export const STATE_FILE = path.join(E2E_DIR, "test-results", ".stack-state.json")

/** Synthetic identities. Never real accounts. */
export const ADA = { email: "ada@example.com", sub: "100000000000000000001", role: "operator" } as const
export const BOLA = { email: "bola@example.com", sub: "100000000000000000002", role: "candidate" } as const

export type StackState = Readonly<{
  baseUrl: string
  /** Bootstrap superuser on the E2E database: fixtures only (RLS does not bind it). */
  adminUrl: string
  outboundLog: string
  /**
   * EPIC-0007 Phase 3: origin of support/feed-stand-in.mjs, the loopback stand-in
   * for Google Alerts feed URLs (api env ALERT_FEED_TEST_ORIGIN). Null when an
   * external stack was given without E2E_FEED_STAND_IN_ORIGIN.
   */
  feedStandInOrigin: string | null
  pids: number[]
  containerId: string | null
}>
