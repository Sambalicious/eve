import { useQuery } from "@tanstack/react-query"

import { AppShell } from "@/components/app-shell"
import { MonthlyCostSection } from "@/components/spend-breakdown"
import { submissionStatusQueryOptions } from "@/entities/application"
import { TurnOnAutomatic } from "@/features/enable-automatic-submission"
import { PauseControl } from "@/features/toggle-global-pause"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { useScrollToHash } from "@/shared/lib/use-scroll-to-hash"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { Section, SectionStack } from "@/shared/ui/section"
import { Skeleton } from "@/shared/ui/skeleton"

/** Copy deck: pauseCost.title, pauseCost.description (PROPOSAL). The section names reuse today's automation copy. */
const TITLE = "Pause and cost"
const DESCRIPTION = "Pause Eve's checks and see this month's AI cost against your ceiling."

/**
 * Pause and cost (`/pause-and-cost`, Advanced). Holds, unchanged, the global pause control, the
 * automatic on/off control (`#automatic`) and the Monthly cost section (`#cost`) that Settings and
 * the header carried before. Old `/settings#cost` links land here.
 */
export function PauseAndCostPage() {
  useDocumentTitle(TITLE)
  const status = useQuery({ ...submissionStatusQueryOptions(), retry: false })
  useScrollToHash(!status.isPending)
  return (
    <AppShell title={TITLE} description={DESCRIPTION} advancedOnly>
      <div className="flex w-full max-w-[960px] flex-col gap-7 px-4 lg:px-6">
        <SectionStack>
          <Section id="pause" title="Global pause" layout="split">
            <PauseControl />
          </Section>
          <Section id="automatic" title="Automatic applying" layout="split">
            {status.isError ? (
              <LoadErrorAlert error={status.error} onRetry={() => void status.refetch()} />
            ) : status.data ? (
              <TurnOnAutomatic status={status.data} />
            ) : (
              <Skeleton className="h-9 w-48" />
            )}
          </Section>
          <MonthlyCostSection />
        </SectionStack>
      </div>
    </AppShell>
  )
}
