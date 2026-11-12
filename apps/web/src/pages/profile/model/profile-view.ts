import type { CareerProfile, ProfileVersion } from "@/entities/career-profile"

/**
 * What the Career Profile page shows, derived from the API state (F1 steps 3,
 * 3a, 3b). One draft exists at a time. The first draft is approved as drafted
 * (OQ-D8 default), so only later drafts can be edited or discarded.
 */
export type ProfileView =
  | { kind: "empty" }
  | { kind: "first-draft"; draft: ProfileVersion }
  | { kind: "approved"; inUse: ProfileVersion }
  | { kind: "later-draft"; draft: ProfileVersion; inUse: ProfileVersion }

export function toProfileView(profile: CareerProfile): ProfileView {
  const { inUse, draft } = profile
  if (draft && inUse) return { kind: "later-draft", draft, inUse }
  if (draft) return { kind: "first-draft", draft }
  if (inUse) return { kind: "approved", inUse }
  return { kind: "empty" }
}

/**
 * The resume drop zone is offered only before any version exists, or when the
 * last drafting attempt failed before one did. With a draft the API refuses
 * uploads; replacing the resume of an approved profile is not in scope (OQ-D8).
 */
/** The first upload: no profile yet, so the drop zone leads the page. */
export function canUploadResume(profile: CareerProfile): boolean {
  return profile.inUse === null && profile.draft === null && profile.drafting?.status !== "drafting"
}

/**
 * A new resume over an approved profile: allowed whenever no draft is open or drafting (the server's
 * own rule). The approved version stays in use until the new draft is approved.
 */
export function canReplaceResume(profile: CareerProfile): boolean {
  return profile.inUse !== null && profile.draft === null && profile.drafting?.status !== "drafting"
}
