import { describe, expect, it } from "vitest"

import type { CareerProfile, ProfileVersion } from "./career-profile"
import { careerProfileCopy } from "./copy"
import {
  draftingFailureProblem,
  dropZoneDraftingFailure,
  resumeNotUsedFilename,
  uploadRefusalProblem,
} from "./resume-problem"

const emptyProfile: CareerProfile = { inUse: null, draft: null, drafting: null, history: [] }
const draft2: ProfileVersion = {
  version: 2,
  status: "draft",
  createdAt: "2026-10-18T09:00:00Z",
  approvedAt: null,
  sections: [],
  droppedFactCount: 0,
}

describe("uploadRefusalProblem", () => {
  it("C-PROFILE-14 names the file being drafted, or omits it when unknown", () => {
    const drafting = { status: "drafting", filename: "cv-2026.pdf", startedAt: "x", failureReason: null } as const
    expect(uploadRefusalProblem({ kind: "drafting_in_progress" }, { ...emptyProfile, drafting }).message).toBe(
      "Your Career Profile is still being drafted from cv-2026.pdf. Wait for it to finish, then try again."
    )
    expect(uploadRefusalProblem({ kind: "drafting_in_progress" }, undefined).message).toBe(
      "Your Career Profile is still being drafted. Wait for it to finish, then try again."
    )
  })

  it("C-PROFILE-15 names the draft and links to it once the draft is known", () => {
    expect(uploadRefusalProblem({ kind: "draft_exists" }, { ...emptyProfile, draft: draft2 })).toEqual({
      message: "You already have draft version 2. Approve or discard it before uploading a new resume.",
      detail: null,
      retryLabel: "Choose resume",
      link: { label: "Go to the draft", to: "/profile" },
    })
  })

  it("C-PROFILE-10 with C-PROFILE-10a and Try again for 503 resume_storage_unavailable", () => {
    expect(uploadRefusalProblem({ kind: "storage_unavailable" }, undefined)).toMatchObject({
      message: "Couldn't save your resume on the server. Nothing was sent to Anthropic. Try again later.",
      detail: "Your file is fine. The server's storage needs fixing, so another try may fail the same way until it is.",
      retryLabel: "Try again",
    })
  })

  it("C-ERR-2 with Try again for any other failure", () => {
    expect(uploadRefusalProblem({ kind: "failed", action: "upload your resume" }, undefined)).toMatchObject({
      message: "Couldn't upload your resume. Nothing changed. Try again.",
      retryLabel: "Try again",
    })
  })
})

describe("draftingFailureProblem", () => {
  it("treats an unknown or missing reason like no verified facts (C-PROFILE-4e)", () => {
    expect(draftingFailureProblem(null).message).toMatch(/^Couldn't draft a Career Profile from this resume\./)
  })
})

describe("C-PROFILE-23", () => {
  it("groups large counts with a thousands separator", () => {
    expect(careerProfileCopy.dropped(1284)).toMatch(/^The assistant left out 1,284 fact\(s\) or heading\(s\)/)
    expect(careerProfileCopy.dropped(1)).toMatch(/^The assistant left out 1 fact\(s\)/)
  })
})

describe("draft_exists (QA-2B-03)", () => {
  const failed = (failureReason: "draft_exists" | "provider_error", filename = "cv.pdf") =>
    ({ status: "failed", filename, startedAt: "2026-10-18T09:00:00Z", failureReason }) as const

  it("is a draft-view notice with the filename while the draft exists, never a drop-zone failure", () => {
    const profile = { ...emptyProfile, draft: draft2, drafting: failed("draft_exists") }
    expect(resumeNotUsedFilename(profile)).toBe("cv.pdf")
    expect(dropZoneDraftingFailure(profile)).toBeNull()
  })

  it("passes an empty filename through, for C-PROFILE-17's no-filename form", () => {
    expect(resumeNotUsedFilename({ ...emptyProfile, draft: draft2, drafting: failed("draft_exists", "") })).toBe("")
  })

  it("shows nowhere once the draft is gone", () => {
    const profile = { ...emptyProfile, drafting: failed("draft_exists") }
    expect(resumeNotUsedFilename(profile)).toBeNull()
    expect(dropZoneDraftingFailure(profile)).toBeNull()
  })

  it("leaves every other failure to the drop zone", () => {
    const profile = { ...emptyProfile, drafting: failed("provider_error") }
    expect(resumeNotUsedFilename(profile)).toBeNull()
    expect(dropZoneDraftingFailure(profile)?.message).toMatch(/^Couldn't reach Anthropic/)
  })
})
