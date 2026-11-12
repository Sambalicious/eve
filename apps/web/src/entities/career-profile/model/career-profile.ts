/** Career Profile as the dashboard uses it (CONTEXT.md: Career Profile). */

import type { ResumeDrafting as ResumeDraftingBody } from "@eve/contracts"

/** Why a drafting attempt failed, from the contract (`storage_error` since v1.2.0). */
export type ResumeDraftingFailure = NonNullable<ResumeDraftingBody["failureReason"]>

export type ProfileVersionStatus = "draft" | "approved" | "replaced"

export type ProfileSectionKind = "experience" | "education" | "skills" | "summary" | "other"

/** A fact. `sourceQuote` is the resume text it came from; null when the Candidate wrote or edited it. */
export interface ProfileFact {
  readonly id: string
  readonly text: string
  readonly sourceQuote: string | null
}

export interface ProfileSection {
  readonly id: string
  readonly kind: ProfileSectionKind
  readonly title: string
  readonly organization: string | null
  readonly period: string | null
  readonly sourceQuote: string | null
  readonly facts: readonly ProfileFact[]
}

export interface ProfileVersionSummary {
  readonly version: number
  readonly status: ProfileVersionStatus
  readonly createdAt: string
  readonly approvedAt: string | null
}

export interface ProfileVersion extends ProfileVersionSummary {
  readonly sections: readonly ProfileSection[]
  /**
   * Facts and headings the backend left out of this version when drafting it:
   * quote not in the resume, or quote not supporting the text. A dropped
   * heading's facts are each counted (contract v1.3.0). Shown as C-PROFILE-23.
   */
  readonly droppedFactCount: number
}

/** The latest resume drafting attempt, while it runs or after it failed. */
export interface ResumeDrafting {
  readonly status: "drafting" | "failed"
  readonly filename: string
  readonly startedAt: string
  /** Why the attempt failed; null while drafting. `storage_error`: the server couldn't store the file. */
  readonly failureReason: ResumeDraftingFailure | null
}

export interface CareerProfile {
  /** The approved version new Tailored Documents use. */
  readonly inUse: ProfileVersion | null
  /** The one draft version, if any. */
  readonly draft: ProfileVersion | null
  readonly drafting: ResumeDrafting | null
  /** Every version, newest first. */
  readonly history: readonly ProfileVersionSummary[]
}

/** The full list of sections and facts a saved draft should hold. No `id` means new. */
export interface DraftContent {
  readonly sections: readonly {
    readonly id?: string
    readonly kind: ProfileSectionKind
    readonly title: string
    readonly organization: string | null
    readonly period: string | null
    readonly facts: readonly { readonly id?: string; readonly text: string }[]
  }[]
}

/** Facts with no text. Approval refuses a draft that has any (C-VAL-PROFILE-2). */
export function emptyFactIds(version: ProfileVersion): string[] {
  return version.sections.flatMap((section) =>
    section.facts.filter((fact) => fact.text.trim() === "").map((fact) => fact.id)
  )
}
