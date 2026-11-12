import { useQueries } from "@tanstack/react-query"

import { contactQueryOptions, jobCriteriaQueryOptions } from "@/entities/candidate-settings"
import { existingApplicationsQueryOptions } from "@/entities/existing-application"
import { preferencesQueryOptions } from "@/entities/job-preferences"
import { alertFeedsQueryOptions, hiringAlertFeedsQueryOptions } from "@/entities/stack-post"
import { deriveImproveItems, type ImproveItem } from "./improve-items"

/** The five rows, each with its own Done state as its read answers. Failed reads stay unknown. */
export function useImproveItems(): ImproveItem[] {
  return useQueries({
    queries: [
      preferencesQueryOptions(),
      jobCriteriaQueryOptions(),
      contactQueryOptions(),
      existingApplicationsQueryOptions(),
      alertFeedsQueryOptions(),
      hiringAlertFeedsQueryOptions(),
    ],
    combine: ([preferences, criteria, contact, existing, feeds, hiringFeeds]) =>
      deriveImproveItems({
        preferences: preferences.data,
        criteria: criteria.data,
        contact: contact.data,
        existing: existing.data,
        feeds: feeds.data,
        hiringFeeds: hiringFeeds.data,
      }),
  })
}
