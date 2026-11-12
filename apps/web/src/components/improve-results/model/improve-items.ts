import type { JobCriteria, ContactDetails } from "@/entities/candidate-settings"
import { hasContactName } from "@/entities/candidate-settings"
import type { ExistingApplications } from "@/entities/existing-application"
import type { JobPreferences } from "@/entities/job-preferences"
import type { AlertFeeds } from "@/entities/stack-post"
import { homeCopy } from "@/entities/job-posting"

export type ImproveId = "preferences" | "criteria" | "contact" | "existing" | "alerts"

export interface ImproveItem {
  readonly id: ImproveId
  readonly title: string
  readonly helper: string
  readonly href: string
  /** Null while the answer is still loading. */
  readonly done: boolean | null
}

export interface ImproveData {
  readonly preferences: JobPreferences | undefined
  readonly criteria: JobCriteria | undefined
  readonly contact: ContactDetails | undefined
  readonly existing: ExistingApplications | undefined
  readonly feeds: AlertFeeds | undefined
  readonly hiringFeeds: AlertFeeds | undefined
}

/**
 * The five optional rows of "Improve your results" (AC-2.4). Done is derived from what is stored, as the setup
 * checklist does: preferences saved, criteria saved once, a contact name, the existing-applications step completed,
 * at least one alert feed. Unknown reads are null, never "not done" (worst-case data table).
 */
export function deriveImproveItems(data: ImproveData): ImproveItem[] {
  const c = homeCopy.improve
  return [
    { id: "preferences", title: c.preferences, helper: c.helperPreferences, href: "/settings#preferences", done: data.preferences ? data.preferences.version !== null : null },
    { id: "criteria", title: c.criteria, helper: c.helperCriteria, href: "/settings#job-criteria", done: data.criteria ? data.criteria.version > 1 : null },
    { id: "contact", title: c.contact, helper: c.helperContact, href: "/settings#contact", done: data.contact ? hasContactName(data.contact) : null },
    { id: "existing", title: c.existing, helper: c.helperExisting, href: "/existing-applications", done: data.existing ? data.existing.completedAt !== null : null },
    {
      id: "alerts",
      title: c.alerts,
      helper: c.helperAlerts,
      href: "/find-jobs#set-up-alerts",
      done: data.feeds && data.hiringFeeds ? data.feeds.feeds.length + data.hiringFeeds.feeds.length > 0 : null,
    },
  ]
}
