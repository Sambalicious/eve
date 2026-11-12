/** One job the Candidate applied to before Eve (prd.r4.md AC 1.6). `appliedOn` is a calendar date, `YYYY-MM-DD`. */
export interface ExistingApplication {
  readonly id: string
  readonly company: string
  readonly roleTitle: string
  readonly applicationUrl: string
  readonly requisitionId: string | null
  readonly appliedOn: string
}

/** The recorded list, oldest first, and when the step was marked complete (null until then). */
export interface ExistingApplications {
  readonly applications: readonly ExistingApplication[]
  readonly completedAt: string | null
}

export interface NewExistingApplication {
  readonly company: string
  readonly roleTitle: string
  readonly applicationUrl: string
  readonly requisitionId: string | null
  readonly appliedOn: string
}

/** `created: false` means the same URL and requisition ID was already recorded; `application` is the stored one (C-EXIST-3). */
export interface AddExistingApplicationResult {
  readonly created: boolean
  readonly application: ExistingApplication
}
