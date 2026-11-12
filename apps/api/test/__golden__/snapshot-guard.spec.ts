import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { GOLDEN_SNAPSHOTS, checkSnapshotCommit, messageGivesReason } from "./snapshot-guard.js"

const REPO = fileURLToPath(new URL("../../../../", import.meta.url))
const OWNER = "apps/api/src/discovery/rules/__golden__/owner-regression.snap.json"
const PAGE = "apps/api/test/__golden__/job-postings-page.snap.json"
const CRITERIA = "apps/api/src/discovery/rules/__golden__/owner-criteria-regression.snap.json"
const STACK = "apps/api/src/stack-posts/__golden__/stack-posts.snap.json"

function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
}

function gitAvailable(): boolean {
  try {
    git(["rev-parse", "--is-inside-work-tree"])
    return true
  } catch {
    return false
  }
}

describe("snapshot-change guard (EPIC-0002 A0 item 6)", () => {
  it("every guarded snapshot exists", () => {
    for (const path of GOLDEN_SNAPSHOTS) expect(existsSync(`${REPO}${path}`), path).toBe(true)
  })

  it("guards the r5 Job criteria and Stack posts snapshots", () => {
    expect(GOLDEN_SNAPSHOTS).toContain(CRITERIA)
    expect(GOLDEN_SNAPSHOTS).toContain(STACK)
    expect(checkSnapshotCommit([{ status: "M", path: CRITERIA }, { status: "M", path: "apps/api/src/discovery/rules/job-criteria.ts" }], "Re-capture criteria snapshot: step 5 fixed").ok).toBe(false)
    expect(checkSnapshotCommit([{ status: "M", path: STACK }], "Update snapshot")).toEqual({ ok: false, reason: "snapshot_change_without_reason", snapshots: [STACK] })
    expect(checkSnapshotCommit([{ status: "M", path: STACK }], "Re-capture Stack posts snapshot: alias table gained an entry")).toEqual({ ok: true })
  })

  it("refuses a snapshot change bundled with other changes", () => {
    expect(checkSnapshotCommit([{ status: "M", path: OWNER }, { status: "M", path: "apps/api/src/discovery/rules/pay.ts" }], "Re-capture owner snapshot: pay rule fixed")).toEqual({
      ok: false,
      reason: "snapshot_change_not_alone",
      snapshots: [OWNER],
    })
  })

  it("refuses a snapshot change whose message gives no reason", () => {
    expect(checkSnapshotCommit([{ status: "M", path: PAGE }], "Update snapshot")).toEqual({ ok: false, reason: "snapshot_change_without_reason", snapshots: [PAGE] })
  })

  it("accepts a snapshot change in its own commit with a reason", () => {
    expect(checkSnapshotCommit([{ status: "M", path: OWNER }], "Re-capture owner snapshot: fixture P-41 Match coverage corrected from 0.69 to 0.71")).toEqual({ ok: true })
    expect(checkSnapshotCommit([{ status: "M", path: OWNER }], "Re-capture owner snapshot\n\nSlice 8e changed the pre-filter for Ingénieur titles.")).toEqual({ ok: true })
  })

  it("a deleted snapshot follows the same rule; a first capture may come with its spec", () => {
    expect(checkSnapshotCommit([{ status: "D", path: PAGE }, { status: "M", path: "apps/api/test/x.ts" }], "x: y").ok).toBe(false)
    expect(checkSnapshotCommit([{ status: "A", path: PAGE }, { status: "A", path: "apps/api/test/__golden__/job-postings-page.int-spec.ts" }], "A0 item 4").ok).toBe(true)
  })

  it("a reason is a body or a subject 'what: why' with at least 10 characters of why", () => {
    expect(messageGivesReason("Re-capture: short")).toBe(false)
    expect(messageGivesReason("Re-capture page snapshot: tab order fix")).toBe(true)
    expect(messageGivesReason("Re-capture\n\nbecause")).toBe(true)
  })

  it.skipIf(!gitAvailable())("every commit on this branch that changed a snapshot keeps the rule", () => {
    const shas = git(["log", "--no-merges", "--format=%H", "--diff-filter=MDR", "--", ...GOLDEN_SNAPSHOTS]).split("\n").filter(Boolean)
    const failures = shas.flatMap((sha) => {
      const files = git(["show", "--no-renames", "--format=", "--name-status", sha])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [status = "", path = ""] = line.split("\t")
          return { status, path }
        })
      const verdict = checkSnapshotCommit(files, git(["show", "-s", "--format=%B", sha]))
      return verdict.ok ? [] : [`${sha.slice(0, 7)} ${verdict.reason} ${verdict.snapshots.join(", ")}`]
    })
    expect(failures).toEqual([])
  })
})
