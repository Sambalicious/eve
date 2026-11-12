import { lazy, Suspense, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Navigate } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { aiProviderQueryOptions } from "@/entities/ai-provider"
import { careerProfileQueryOptions } from "@/entities/career-profile"
import { homeCopy, type WaitingReason } from "@/entities/job-posting"
import { isAdvancedOn, useViewer } from "@/entities/viewer"
import { AccessRequestAlert, notificationStatusQueryOptions, NotifyFailureAlert } from "@/entities/notification"
import { HomePasteBox } from "@/features/paste-job-link"
import { ButtonLink } from "@/shared/ui/button-link"
import { HomeNeedsYou } from "./home-needs-you"
import { HomePauseBanner } from "./pause-banner"
import { SimplerNote } from "./simpler-note"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { Section, SectionStack } from "@/shared/ui/section"

// Below-the-fold Home parts load on their own so the Home chunk stays inside its budget allowance.
const PasteResultCard = lazy(async () => ({ default: (await import("@/components/paste-result-card")).PasteResultCard }))
const RecentApplications = lazy(async () => ({ default: (await import("@/components/recent-applications")).RecentApplications }))
const AdvancedHome = lazy(async () => ({ default: (await import("./advanced-home-page")).AdvancedHome }))
const ImproveResults = lazy(async () => ({ default: (await import("@/components/improve-results")).ImproveResults }))

/**
 * Home (`/dashboard`, R1): the paste box leads, the pasted job's result shows in place, then Recent applications
 * and Improve your results. The automation cards and the setup checklist show only with Advanced on; the pause
 * banner and Needs you show whatever the switch says. A Candidate with no resume at all goes to Upload.
 */
export function DashboardPage() {
  useDocumentTitle(homeCopy.title)
  const viewer = useViewer()
  const advanced = isAdvancedOn(viewer)
  const profile = useQuery(careerProfileQueryOptions())
  const provider = useQuery(aiProviderQueryOptions())
  const [pasted, setPasted] = useState<{ postingId: string; waitingReason: WaitingReason | null } | null>(null)
  const canPaste = profile.data?.inUse != null && provider.data?.approval != null
  // A failed status read only hides C-NOTIFY-1; the rest of Home doesn't depend on it.
  const notificationStatus = useQuery(notificationStatusQueryOptions()).data
  const notifyFailure = notificationStatus?.latestFailure ?? null
  // EPIC-0003: unsent access requests, beside C-NOTIFY-1 (OQ7: every signed-in session until EPIC-0002).
  const accessRequests = notificationStatus?.accessRequests ?? null
  // AC-2.1: nothing uploaded yet means the Upload screen (a user with Advanced on is an existing user and stays). A draft or a drafting resume keeps Home, with the link back.
  if (!advanced && profile.data && !profile.data.inUse && !profile.data.draft && !profile.data.drafting) return <Navigate to="/welcome" replace />
  return (
    <AppShell title={homeCopy.title} description={homeCopy.description}>
      <div className="flex max-w-[760px] flex-col gap-7 px-4 lg:px-6">
        <HomePauseBanner />
        {viewer.simplerNoteDue && !advanced && <SimplerNote />}
        {/* With Advanced on these sit under the Automation status card, as they always did. */}
        {!advanced && notifyFailure && <NotifyFailureAlert failure={notifyFailure} plain />}
        {!advanced && accessRequests && <AccessRequestAlert counts={accessRequests} />}
        {!advanced && <HomeNeedsYou />}
        <SectionStack>
          <Section title={homeCopy.paste.heading}>
            {profile.isPending || provider.isPending ? (
              <div className="h-10" aria-hidden="true" />
            ) : canPaste ? (
              <div className="flex flex-col gap-5">
                <HomePasteBox filled={pasted === null} onPasted={(job) => setPasted({ postingId: job.postingId, waitingReason: job.waitingReason })} />
                {pasted && (
                  <Suspense fallback={<div className="h-24" aria-hidden="true" />}>
                    <PasteResultCard key={pasted.postingId} postingId={pasted.postingId} waitingReason={pasted.waitingReason} />
                  </Suspense>
                )}
              </div>
            ) : (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <span>{homeCopy.paste.noProfile}</span>
                <ButtonLink size="sm" variant="outline" to="/welcome">
                  {homeCopy.paste.noProfileLink}
                </ButtonLink>
              </p>
            )}
          </Section>
          <Suspense fallback={null}>
            <RecentApplications />
            {!viewer.improveListDismissed && <ImproveResults />}
          </Suspense>
          {advanced && (
            <Suspense fallback={null}>
              <AdvancedHome notifyFailure={notifyFailure} accessRequests={accessRequests} />
            </Suspense>
          )}
        </SectionStack>
      </div>
    </AppShell>
  )
}
