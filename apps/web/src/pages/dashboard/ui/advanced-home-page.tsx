import { useQuery } from "@tanstack/react-query"
import { CalendarClock } from "lucide-react"
import { Link } from "react-router-dom"

import { SetupChecklist, useSetupItems } from "@/components/setup-checklist"
import { SpendCard } from "@/components/spend-breakdown"
import { AutomationStatusCard, NeedsYouList, TodaysCapCard } from "@/components/submission-overview"
import { submissionStatusQueryOptions, submissionSummaryQueryOptions } from "@/entities/application"
import { automationCopy, automationStateQueryOptions } from "@/entities/automation-state"
import { homeCopy } from "@/entities/job-posting"
import { jobSourceCopy, jobSourcesQueryOptions } from "@/entities/job-source"
import { AccessRequestAlert, NotifyFailureAlert, type notificationStatusQueryOptions } from "@/entities/notification"
import { useViewer } from "@/entities/viewer"
import { formatWatDate } from "@/shared/lib/format-wat"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { SectionNote } from "@/shared/ui/section"
import { SetupChecklistSkeleton, StatusCardsSkeleton } from "@/components/page-skeletons"

const SETUP_DONE = "Setup is done. Nothing needs you right now."

type Status = NonNullable<Awaited<ReturnType<NonNullable<ReturnType<typeof notificationStatusQueryOptions>["queryFn"]>>>>

/** The Advanced-on part of Home: setup checklist, automation cards, spend and Needs you. Loaded only with Advanced on. */
export function AdvancedHome({ notifyFailure, accessRequests }: { notifyFailure: Status["latestFailure"] | null; accessRequests: Status["accessRequests"] | null }) {
  const viewer = useViewer()
  const setup = useSetupItems()
  const sources = useQuery(jobSourcesQueryOptions())
  const status = useQuery(submissionStatusQueryOptions())
  const summary = useQuery(submissionSummaryQueryOptions())
  // A failed controls read hides the Spend card and the cost line.
  const automation = useQuery(automationStateQueryOptions()).data
  const costPause = automation?.costPause
    ? { title: automationCopy.cost.pausedForCost, line: automationCopy.cost.resumesLine(formatWatDate(automation.costPause.resumesAt)) }
    : null
  const isSetupDone = setup.items?.every((item) => item.state === "done") ?? false
  const blocked = summary.data ? summary.data.blocked + summary.data.held : 0
  const uncertain = summary.data?.uncertain ?? 0
  const awaitingSamples = summary.data?.samples.awaitingReview ?? 0
  // C-HOME-2 rule: only when samples awaiting review, Blocked and Uncertain are all zero and no C-NOTIFY-1 alert.
  // Unknown counts are not zero.
  const nothingNeedsYou = summary.data !== undefined && blocked + uncertain + awaitingSamples === 0 && notifyFailure === null
  return (
    <>
      {setup.isError ? (
        <LoadErrorAlert onRetry={setup.retry} />
      ) : isSetupDone ? (
        nothingNeedsYou && <SectionNote className="text-muted-foreground">{SETUP_DONE}</SectionNote>
      ) : setup.items ? (
        <SetupChecklist items={setup.items} />
      ) : (
        <SetupChecklistSkeleton />
      )}
      {status.data ? (
        <div className="flex flex-col gap-4">
          <AutomationStatusCard status={status.data} costPause={costPause}>
            {sources.data && <DiscoveryLine isOn={sources.data.scheduledDiscoveryOn} />}
          </AutomationStatusCard>
          {viewer.advancedLocked && <p className="text-[0.8125rem] text-muted-foreground">{homeCopy.automationLocked}</p>}
          {notifyFailure && <NotifyFailureAlert failure={notifyFailure} />}
          {accessRequests && <AccessRequestAlert counts={accessRequests} />}
          <TodaysCapCard status={status.data} />
          {automation && <SpendCard spend={automation.spend} />}
          <NeedsYouList samples={status.data.gatePassedAt ? null : awaitingSamples} blocked={blocked} uncertain={uncertain} />
        </div>
      ) : status.isPending ? (
        <StatusCardsSkeleton />
      ) : (
        <>
          {sources.data && <DiscoveryLine isOn={sources.data.scheduledDiscoveryOn} />}
          {notifyFailure && <NotifyFailureAlert failure={notifyFailure} />}
          {accessRequests && <AccessRequestAlert counts={accessRequests} />}
        </>
      )}
    </>
  )
}

/** C-SRC-8 with "Review the list" while the employer list waits; "Next discovery: 08:00 WAT" once approved. */
function DiscoveryLine({ isOn }: { isOn: boolean }) {
  return (
    <p className="flex items-start gap-2 text-[0.8125rem] text-muted-foreground">
      <CalendarClock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      {isOn ? (
        <span>{jobSourceCopy.nextDiscovery}</span>
      ) : (
        <span>
          {jobSourceCopy.discoveryOff}{" "}
          <Link
            to="/find-jobs#employer-list"
            className="text-foreground underline underline-offset-4"
          >
            {jobSourceCopy.reviewTheList}
          </Link>
        </span>
      )}
    </p>
  )
}
