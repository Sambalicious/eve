import type { AiProvider } from "@/entities/ai-provider"
import type { ApprovedAnswer, SalaryAnswers } from "@/entities/approved-answer"
import type { CareerProfile } from "@/entities/career-profile"
import type { ExistingApplications } from "@/entities/existing-application"
import type { JobSources } from "@/entities/job-source"

/** One checklist row's state: done, or the link label, or blocked by another item. */
export type SetupItemState = "done" | "start" | "continue" | "needs-anthropic"

export interface SetupItem {
  readonly id: "ai-provider" | "career-profile" | "approved-answers" | "existing-applications" | "job-sources"
  readonly label: string
  readonly href: string
  readonly requiredForAutomaticSubmission: boolean
  readonly state: SetupItemState
}

export interface SetupData {
  readonly aiProvider: AiProvider
  readonly careerProfile: CareerProfile
  readonly answers: readonly ApprovedAnswer[]
  readonly salary: SalaryAnswers
  readonly existingApplications: ExistingApplications
  readonly jobSources: JobSources
}

/**
 * Items 1 to 5 of the F1 checklist, the ones the API can answer today.
 * Item 6 (samples) has no checklist read yet.
 */
export function deriveSetupItems({ aiProvider, careerProfile, answers, salary, existingApplications, jobSources }: SetupData): SetupItem[] {
  const isApproved = aiProvider.approval !== null
  return [
    {
      id: "ai-provider",
      label: "Approve Anthropic as your AI provider",
      href: "/privacy#ai-provider",
      requiredForAutomaticSubmission: false,
      state: isApproved ? "done" : "start",
    },
    {
      id: "career-profile",
      label: "Upload your resume and approve your Career Profile",
      href: "/profile",
      requiredForAutomaticSubmission: true,
      state: careerProfileState(careerProfile, isApproved),
    },
    {
      id: "approved-answers",
      label: "Add Approved Answers and your gross-salary policy",
      href: "/answers",
      requiredForAutomaticSubmission: false,
      state: answersState(answers, salary),
    },
    {
      id: "existing-applications",
      label: "Record existing applications and mark the step complete",
      href: "/existing-applications",
      requiredForAutomaticSubmission: true,
      state: existingApplicationsState(existingApplications),
    },
    {
      id: "job-sources",
      label: "Choose and verify Job Sources, and approve the employer list",
      href: "/find-jobs#job-sources",
      requiredForAutomaticSubmission: false,
      state: jobSourcesState(jobSources),
    },
  ]
}

function careerProfileState(profile: CareerProfile, isAiProviderApproved: boolean): SetupItemState {
  if (profile.inUse) return "done"
  if (profile.draft || profile.drafting) return "continue"
  return isAiProviderApproved ? "start" : "needs-anthropic"
}

/** Done once there is at least one Approved Answer and a gross-salary policy, as the item's label says. */
function answersState(answers: readonly ApprovedAnswer[], salary: SalaryAnswers): SetupItemState {
  const hasAnswers = answers.length > 0
  const hasPolicy = salary.grossSalaryPolicy !== null
  if (hasAnswers && hasPolicy) return "done"
  return hasAnswers || hasPolicy ? "continue" : "start"
}

/** F1 item 4 (2026-10-30): done once marked complete; Continue once at least one is recorded. */
function existingApplicationsState({ applications, completedAt }: ExistingApplications): SetupItemState {
  if (completedAt) return "done"
  return applications.length > 0 ? "continue" : "start"
}

/** Done once the employer list is approved; Continue once a remote board is verified or enabled. */
function jobSourcesState(sources: JobSources): SetupItemState {
  if (sources.employerList.approvedAt) return "done"
  return sources.remoteBoards.some((board) => board.enabled) ? "continue" : "start"
}
