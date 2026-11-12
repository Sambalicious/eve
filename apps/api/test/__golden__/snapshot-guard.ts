/**
 * EPIC-0002 A0 item 6 (architecture r4; golden-capture.feature "Item 6"): the
 * snapshot-change rule. A hand edit to a snapshot is caught by its own spec,
 * which rebuilds the file and compares bytes. This module holds the commit
 * rule: a commit that MODIFIES or DELETES a golden snapshot changes nothing
 * else, and its message gives the reason. Adding a snapshot (first capture) may
 * come with its spec, seed and builder.
 */
export const GOLDEN_SNAPSHOTS: readonly string[] = [
  "apps/api/src/discovery/rules/__golden__/owner-regression.snap.json",
  "apps/api/src/submission/__golden__/work-question-regression.snap.json",
  "apps/api/test/__golden__/job-postings-page.snap.json",
  "apps/api/test/__golden__/controls.snap.json",
  // r5 "Should A0 cover job criteria and Stack posts?": criteria set 2 verdicts and A0 item 9.
  "apps/api/src/discovery/rules/__golden__/owner-criteria-regression.snap.json",
  "apps/api/src/stack-posts/__golden__/stack-posts.snap.json",
]

/** One changed path of a commit, as `git show --name-status` prints it: A, M, D, or R/C (the new path). */
export type ChangedFile = Readonly<{ status: string; path: string }>

export type SnapshotCommitVerdict = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: "snapshot_change_not_alone" | "snapshot_change_without_reason"; snapshots: string[] }>

const MIN_REASON_LENGTH = 10

/**
 * A reason is a non-empty body, or a subject of the form "<what>: <why>" whose
 * "why" has at least 10 characters
 * ("Re-capture owner snapshot: fixture P-41 Match coverage corrected").
 */
export function messageGivesReason(message: string): boolean {
  const [subject = "", ...rest] = message.trim().split("\n")
  if (rest.some((line) => line.trim() !== "")) return true
  const colon = subject.indexOf(": ")
  return colon > 0 && subject.slice(colon + 2).trim().length >= MIN_REASON_LENGTH
}

export function checkSnapshotCommit(files: readonly ChangedFile[], message: string): SnapshotCommitVerdict {
  const changed = files.filter((file) => GOLDEN_SNAPSHOTS.includes(file.path) && file.status[0] !== "A").map((file) => file.path)
  if (changed.length === 0) return { ok: true }
  if (files.some((file) => !GOLDEN_SNAPSHOTS.includes(file.path))) return { ok: false, reason: "snapshot_change_not_alone", snapshots: changed }
  if (!messageGivesReason(message)) return { ok: false, reason: "snapshot_change_without_reason", snapshots: changed }
  return { ok: true }
}
