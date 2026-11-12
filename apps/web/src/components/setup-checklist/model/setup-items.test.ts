import { describe, expect, it } from "vitest"

import type { AiProvider } from "@/entities/ai-provider"
import type { CareerProfile, ProfileVersion } from "@/entities/career-profile"
import type { JobSources } from "@/entities/job-source"
import { deriveSetupItems, type SetupData } from "./setup-items"

const provider = (approved: boolean): AiProvider => ({
  name: "Anthropic",
  terms: {
    checkedOn: "2026-10-16",
    trainingLine: "t",
    retentionLine: "r",
    whatsSentLine: "w",
    trainingTermsUrl: "https://example.com/t",
    retentionTermsUrl: "https://example.com/r",
  },
  approval: approved
    ? { approvedAt: "2026-10-16T09:00:00Z", termsCheckedOn: "2026-10-16", trainingLine: "t", retentionLine: "r" }
    : null,
})
const v: ProfileVersion = { version: 1, status: "draft", createdAt: "2026-10-16T09:00:00Z", approvedAt: null, sections: [], droppedFactCount: 0 }
const profile = (patch: Partial<CareerProfile> = {}): CareerProfile => ({
  inUse: null,
  draft: null,
  drafting: null,
  history: [],
  ...patch,
})
const noSalary = { grossSalaryPolicy: null, currentSalary: null, preferredNetPay: null }
const sources = (approvedAt: string | null, enabled = false): JobSources => ({
  employerList: { approvedAt, companies: [] },
  remoteBoards: [{ key: "himalayas", name: "Himalayas", verification: { on: "2026-10-19", basis: "b" }, enabled, unavailableReason: null }],
  scheduledDiscoveryOn: approvedAt !== null,
})
const noExisting = { applications: [], completedAt: null }
const base: SetupData = { aiProvider: provider(false), careerProfile: profile(), answers: [], salary: noSalary, existingApplications: noExisting, jobSources: sources(null) }

const states = (data: SetupData) => deriveSetupItems(data).slice(0, 3).map((item) => item.state)
const itemState = (data: SetupData, id: string) => deriveSetupItems(data).find((item) => item.id === id)?.state
const sourcesState = (data: SetupData) => itemState(data, "job-sources")

describe("setup checklist", () => {
  it("on first run asks to approve Anthropic, and the profile item waits for it", () => {
    expect(states(base)).toEqual(["start", "needs-anthropic", "start"])
  })

  it("moves the profile item to continue while a draft exists and done once approved", () => {
    const approved = { ...base, aiProvider: provider(true) }
    expect(states({ ...approved, careerProfile: profile({ draft: v }) })[1]).toBe("continue")
    expect(states({ ...approved, careerProfile: profile({ inUse: { ...v, status: "approved" } }) })[1]).toBe("done")
  })

  it("counts Approved Answers as done only with a gross-salary policy too", () => {
    const answer = { group: "custom", id: "a", question: "q", value: "v", updatedAt: "2026-10-16T09:00:00Z" } as const
    const policy = { kind: "gross", amount: 48000, currency: "USD", period: "year", display: "USD 48,000 per year" } as const
    expect(states({ ...base, answers: [answer] })[2]).toBe("continue")
    expect(states({ ...base, answers: [answer], salary: { ...noSalary, grossSalaryPolicy: policy } })[2]).toBe("done")
  })

  it("item 4: Start, Continue once one is recorded, Done once the step is marked complete (2026-10-30)", () => {
    const one = { id: "e", company: "Globex", roleTitle: "Frontend Lead", applicationUrl: "https://x.test/1", requisitionId: null, appliedOn: "2026-09-30" }
    expect(itemState(base, "existing-applications")).toBe("start")
    expect(itemState({ ...base, existingApplications: { applications: [one], completedAt: null } }, "existing-applications")).toBe("continue")
    expect(itemState({ ...base, existingApplications: { applications: [], completedAt: "2026-10-17T09:00:00Z" } }, "existing-applications")).toBe("done")
    const item = deriveSetupItems(base)[3]
    expect(item).toMatchObject({
      id: "existing-applications",
      label: "Record existing applications and mark the step complete",
      href: "/existing-applications",
      requiredForAutomaticSubmission: true,
    })
  })

  it("item 5: Start, Continue once a remote board is enabled, Done once the employer list is approved", () => {
    expect(sourcesState(base)).toBe("start")
    expect(sourcesState({ ...base, jobSources: sources(null, true) })).toBe("continue")
    expect(sourcesState({ ...base, jobSources: sources("2026-10-19T09:00:00Z") })).toBe("done")
  })
})
