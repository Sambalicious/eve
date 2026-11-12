import { useQuery } from "@tanstack/react-query"
import { Navigate, useLocation } from "react-router-dom"
import { Link } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { atsMinimumQueryOptions, contactQueryOptions, jobCriteriaQueryOptions } from "@/entities/candidate-settings"
import { submissionStatusQueryOptions } from "@/entities/application"
import { preferencesQueryOptions } from "@/entities/job-preferences"
import { JobPreferencesSection } from "@/components/job-preferences-section"
import { JobPreferencesForm, prefsCopy } from "@/features/edit-job-preferences"
import { ContactDetailsForm } from "@/features/edit-contact-details"
import { AtsMinimumForm } from "@/features/edit-ats-minimum"
import { JobCriteriaForm } from "@/features/edit-job-criteria"
import { isAdvancedOn, useViewer } from "@/entities/viewer"
import { AdvancedSwitch, advancedCopy } from "@/features/toggle-advanced"
import { Section } from "@/shared/ui/section"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { useScrollToHash } from "@/shared/lib/use-scroll-to-hash"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { SettingsSkeleton } from "@/components/page-skeletons"

/**
 * Settings (`/settings`), B1 interim order (EPIC-0002 design-spec.r6 "B1 interim
 * Settings"): Job preferences (`#preferences`), Job criteria (`#job-criteria`),
 * Contact details (`#contact`) and Monthly cost (`#cost`). Location and work
 * authorization is gone: Job preferences owns country, work authorization and
 * sponsorship from B1. Each form saves only itself.
 */
/** Copy deck: settings.description (PROPOSAL), settings.privacyLink, settings.existingLink. */
const SETTINGS_DESCRIPTION = "Your job preferences, contact details and privacy."

export function SettingsPage() {
  useDocumentTitle("Settings")
  const advanced = isAdvancedOn(useViewer())
  const { hash, search } = useLocation()
  const contact = useQuery(contactQueryOptions())
  const criteria = useQuery(jobCriteriaQueryOptions())
  const preferences = useQuery(preferencesQueryOptions())
  // ATS minimum: optional on the page, so a failed read hides only its form.
  const atsMinimum = useQuery({ ...atsMinimumQueryOptions(), retry: false })
  // C-PREF-CAP-WARN only; a failed or slow read never holds the page.
  const submission = useQuery({ ...submissionStatusQueryOptions(), retry: false })
  useScrollToHash(contact.isSuccess && criteria.isSuccess && preferences.isSuccess)
  // The Monthly cost section moved to Pause and cost; old `/settings#cost` links follow it (architecture, Routes and redirects).
  if (hash === "#cost") return <Navigate to={`/pause-and-cost${search}${hash}`} replace />
  return (
    <AppShell title="Settings" description={SETTINGS_DESCRIPTION}>
      <div className="flex w-full max-w-[960px] flex-col gap-7 px-4 lg:px-6">
        {contact.isError || criteria.isError || preferences.isError ? (
          <LoadErrorAlert
            onRetry={() => {
              if (contact.isError) void contact.refetch()
              if (criteria.isError) void criteria.refetch()
              if (preferences.isError) void preferences.refetch()
            }}
          />
        ) : contact.data && criteria.data && preferences.data ? (
          <>
            <JobPreferencesSection title={prefsCopy.settingsTitle}>
              <JobPreferencesForm
                mode="settings"
                preferences={preferences.data}
                todayCount={advanced ? (submission.data?.todayCount ?? null) : null}
                boardFamilies={criteria.data.targetRoleFamilies}
              />
            </JobPreferencesSection>
            <JobCriteriaForm criteria={criteria.data} />
            {advanced && atsMinimum.data !== undefined && <AtsMinimumForm minAtsPercent={atsMinimum.data} />}
            <ContactDetailsForm contact={contact.data} />
            <Section id="advanced" title={advancedCopy.heading} description={advancedCopy.description} layout="split">
              <AdvancedSwitch />
            </Section>
            <nav aria-label="More" className="flex flex-col gap-2 text-sm">
              <Link to="/privacy" className="w-fit underline underline-offset-4">
                Data and privacy
              </Link>
              <Link to="/existing-applications" className="w-fit underline underline-offset-4">
                Jobs you've already applied to
              </Link>
            </nav>
          </>
        ) : (
          <SettingsSkeleton />
        )}
      </div>
    </AppShell>
  )
}
