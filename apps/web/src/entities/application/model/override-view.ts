import type { ApplicationDetail, ApplicationOverride } from "./application"
import { overrideCopy, overrideReasonShort } from "./copy"
import type { Submission } from "./submission"

/** Route state from "Prepare anyway": the Application detail focuses its title once the record renders (design B3). */
export interface ApplicationDetailFocusState {
  readonly focusTitle: true
}

/** C-AA-17, or C-AA-18 for a legacy override (no stored decision). `date` is already formatted (WAT). */
export function overrideFactValue(override: ApplicationOverride, date: string): string {
  const reason = overrideReasonShort(override)
  return reason ? overrideCopy.value(date, reason) : overrideCopy.legacyValue(date)
}

/**
 * AA-4.5 r1 show rule (api-contract v1.24.0): an override that doesn't apply,
 * a posting that isn't ranked, submission state none or queued, details present.
 */
export function showsOverrideInactive(app: ApplicationDetail, submission: Pick<Submission, "state"> | undefined): boolean {
  const o = app.override
  if (!o || o.applies || app.posting === null || app.posting.status === "ranked") return false
  if (app.detailsDeletedAt !== null) return false
  const state = submission?.state ?? null
  return state === null || state === "queued"
}

/** C-AA-21 / C-AA-38 / C-AA-39 by `notAppliesReason`; C-AA-21 when the reason is missing (design worst case). */
export function overrideInactiveBody(override: ApplicationOverride): string {
  return overrideCopy.inactiveBody[override.notAppliesReason ?? "decision_changed"]
}

/** B3a: the drop line, only while the AA-4.5 alert does not show, and only with the submission state still none. */
export function dropLine(app: ApplicationDetail, submission: Pick<Submission, "state"> | undefined, date: string): string | null {
  if (!app.latestDrop || showsOverrideInactive(app, submission)) return null
  if ((submission?.state ?? null) !== null) return null
  return app.latestDrop.reason === "closed" ? overrideCopy.droppedClosed(date) : overrideCopy.droppedNotSubmittable(date)
}
