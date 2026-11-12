/** The signed-in Candidate's own facts and view flags (`GET /v1/me`, contract v1.28.0 C2). */
export interface Viewer {
  readonly isOperator: boolean
  readonly advancedEnabled: boolean
  /** Automatic applying is on, so Advanced can't be turned off. Forces the Advanced view on. */
  readonly advancedLocked: boolean
  readonly simplerNoteDue: boolean
  readonly improveListDismissed: boolean
}

/** The safe view when `/v1/me` can't be read (AC-3.8): Advanced off, nothing Operator-only. */
export const SAFE_VIEWER: Viewer = {
  isOperator: false,
  advancedEnabled: false,
  advancedLocked: false,
  simplerNoteDue: false,
  improveListDismissed: false,
}

/** What the shell shows: a locked flag forces Advanced on, even if stored data disagrees. */
export function isAdvancedOn(viewer: Viewer): boolean {
  return viewer.advancedEnabled || viewer.advancedLocked
}
