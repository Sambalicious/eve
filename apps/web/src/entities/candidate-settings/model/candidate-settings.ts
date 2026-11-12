/** The Candidate's rules. Slice 2 has only work authorization (AC 1.5). */
export interface CandidateSettings {
  /** Defaults to "none outside Nigeria" until changed. */
  readonly workAuthorization: string
}

/** Same limit as the contract's `setWorkAuthorizationRequestSchema`. */
export const WORK_AUTHORIZATION_MAX = 200
