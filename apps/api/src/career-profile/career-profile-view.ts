import type {
  CareerProfileResponse,
  CareerProfileVersion,
  CareerProfileVersionSummary,
  ResumeDrafting,
} from "@eve/contracts"
import { resumeDraftingFailureSchema } from "@eve/contracts"

import type { ResumeUploadRow, VersionRow } from "./career-profile.repository.js"

export function toSummary(row: VersionRow): CareerProfileVersionSummary {
  return {
    version: row.version,
    status: row.status,
    source: row.source,
    createdAt: row.created_at.toISOString(),
    approvedAt: row.approved_at?.toISOString() ?? null,
  }
}

export function toVersion(row: VersionRow): CareerProfileVersion {
  return { ...toSummary(row), sections: row.sections, droppedFactCount: row.rejected_fact_count }
}

/**
 * The latest upload while it drafts, and after it failed.
 *
 * Rule for a failed attempt when a draft newer than the upload exists:
 * - `draft_exists` is always shown. It means exactly that a newer draft won the
 *   race, so that draft is always newer; hiding it on that ground would hide it
 *   every time (QA-2B-01, api-contract.md v1.3.0 lists it as a reported reason).
 * - Any other failure is hidden. The newer draft came from the Candidate editing
 *   after the failed upload, so the failure no longer describes the profile they
 *   are working on.
 */
export function toDrafting(upload: ResumeUploadRow | undefined, draft: VersionRow | undefined): ResumeDrafting | null {
  if (!upload || upload.status === "drafted") return null
  const supersededByNewerDraft = upload.status === "failed" && draft !== undefined && draft.created_at > upload.started_at
  if (supersededByNewerDraft && upload.failure_reason !== "draft_exists") return null
  const reason = resumeDraftingFailureSchema.safeParse(upload.failure_reason)
  return {
    status: upload.status,
    filename: upload.original_filename,
    startedAt: upload.started_at.toISOString(),
    failureReason: upload.status === "failed" && reason.success ? reason.data : null,
  }
}

export function toProfileResponse(versions: VersionRow[], upload: ResumeUploadRow | undefined): CareerProfileResponse {
  const inUse = versions.find((row) => row.status === "approved")
  const draft = versions.find((row) => row.status === "draft")
  return {
    inUse: inUse ? toVersion(inUse) : null,
    draft: draft ? toVersion(draft) : null,
    drafting: toDrafting(upload, draft),
    history: versions.map(toSummary),
  }
}
