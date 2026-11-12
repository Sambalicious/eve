import { useQueries } from "@tanstack/react-query"

import { aiProviderQueryOptions } from "@/entities/ai-provider"
import { approvedAnswersQueryOptions, salaryQueryOptions } from "@/entities/approved-answer"
import { careerProfileQueryOptions } from "@/entities/career-profile"
import { existingApplicationsQueryOptions } from "@/entities/existing-application"
import { jobSourcesQueryOptions } from "@/entities/job-source"
import { deriveSetupItems, type SetupItem } from "./setup-items"

/** The checklist items, or null while any of their data is loading or failed. */
export function useSetupItems(): { items: SetupItem[] | null; isError: boolean; retry: () => void } {
  return useQueries({
    queries: [
      aiProviderQueryOptions(),
      careerProfileQueryOptions(),
      approvedAnswersQueryOptions(),
      salaryQueryOptions(),
      existingApplicationsQueryOptions(),
      jobSourcesQueryOptions(),
    ],
    combine: ([aiProvider, careerProfile, answers, salary, existingApplications, jobSources]) => {
      const all = [aiProvider, careerProfile, answers, salary, existingApplications, jobSources]
      return {
        items:
          aiProvider.data && careerProfile.data && answers.data && salary.data && existingApplications.data && jobSources.data
            ? deriveSetupItems({
                aiProvider: aiProvider.data,
                careerProfile: careerProfile.data,
                answers: answers.data,
                salary: salary.data,
                existingApplications: existingApplications.data,
                jobSources: jobSources.data,
              })
            : null,
        isError: all.some((query) => query.isError),
        retry: () => {
          for (const query of all) if (query.isError) void query.refetch()
        },
      }
    },
  })
}
