import {
  CAREER_PROFILE_DRAFT_APPROVE_PATH,
  CAREER_PROFILE_DRAFT_PATH,
  CAREER_PROFILE_PATH,
  CAREER_PROFILE_RESUME_PATH,
  careerProfileResponseSchema,
  careerProfileVersionPath,
  careerProfileVersionSchema,
  RESUME_FILE_FIELD,
  type CareerProfileResponse,
  type CareerProfileVersion,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { CareerProfile, DraftContent, ProfileVersion } from "../model/career-profile"

export async function fetchCareerProfile(): Promise<CareerProfile> {
  const response = await apiRequest(CAREER_PROFILE_PATH)
  return toCareerProfile(careerProfileResponseSchema.parse(await response.json()))
}

export async function fetchProfileVersion(version: number): Promise<ProfileVersion> {
  const response = await apiRequest(careerProfileVersionPath(version))
  return toProfileVersion(careerProfileVersionSchema.parse(await response.json()))
}

/** Starts drafting a Career Profile from a resume. The API answers 202 and drafts in the background. */
export async function uploadResume(file: File, csrfToken: string): Promise<CareerProfile> {
  const formData = new FormData()
  formData.append(RESUME_FILE_FIELD, file)
  const response = await apiRequest(CAREER_PROFILE_RESUME_PATH, { method: "POST", csrfToken, formData })
  return toCareerProfile(careerProfileResponseSchema.parse(await response.json()))
}

/** Saves the draft: creates version n+1 from the version in use, or replaces the current draft. */
export async function saveDraft(content: DraftContent, csrfToken: string): Promise<ProfileVersion> {
  const response = await apiRequest(CAREER_PROFILE_DRAFT_PATH, { method: "PUT", csrfToken, json: content })
  return toProfileVersion(careerProfileVersionSchema.parse(await response.json()))
}

export async function approveDraft(version: number, csrfToken: string): Promise<CareerProfile> {
  const response = await apiRequest(CAREER_PROFILE_DRAFT_APPROVE_PATH, {
    method: "POST",
    csrfToken,
    json: { version },
  })
  return toCareerProfile(careerProfileResponseSchema.parse(await response.json()))
}

export async function discardDraft(version: number, csrfToken: string): Promise<void> {
  const path = `${CAREER_PROFILE_DRAFT_PATH}?${new URLSearchParams({ version: String(version) })}`
  await apiRequest(path, { method: "DELETE", csrfToken })
}

function toCareerProfile(body: CareerProfileResponse): CareerProfile {
  return {
    inUse: body.inUse && toProfileVersion(body.inUse),
    draft: body.draft && toProfileVersion(body.draft),
    drafting: body.drafting && {
      status: body.drafting.status,
      filename: body.drafting.filename,
      startedAt: body.drafting.startedAt,
      failureReason: body.drafting.failureReason,
    },
    history: body.history.map(({ version, status, createdAt, approvedAt }) => ({
      version,
      status,
      createdAt,
      approvedAt,
    })),
  }
}

function toProfileVersion(body: CareerProfileVersion): ProfileVersion {
  return {
    version: body.version,
    status: body.status,
    createdAt: body.createdAt,
    approvedAt: body.approvedAt,
    droppedFactCount: body.droppedFactCount,
    sections: body.sections.map((section) => ({
      id: section.id,
      kind: section.kind,
      title: section.title,
      organization: section.organization,
      period: section.period,
      sourceQuote: section.sourceQuote,
      facts: section.facts.map(({ id, text, sourceQuote }) => ({ id, text, sourceQuote })),
    })),
  }
}
