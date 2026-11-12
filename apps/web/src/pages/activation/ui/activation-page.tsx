import { useQueries, useQuery } from "@tanstack/react-query"
import { ListChecks } from "lucide-react"
import { useSearchParams } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { GateStatusCard } from "@/components/activation-gate"
import { samplesQueryOptions, submissionCopy, submissionStatusQueryOptions, type SampleRow, type SampleState } from "@/entities/application"
import { PrepareSamplesButton } from "@/features/review-sample"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { ButtonLink } from "@/shared/ui/button-link"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/shared/ui/empty"
import { isNotYetAvailable } from "@/shared/lib/not-yet-available"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { GateStatusCardSkeleton, SampleTabsSkeleton } from "@/components/page-skeletons"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs"
import { SampleList } from "./sample-list"

const g = submissionCopy.gate
type Tab = "awaiting" | "approved" | "rejected"
const readTab = (value: string | null): Tab => (value === "approved" || value === "rejected" ? value : "awaiting")
const TABS: readonly [Tab, SampleState, string][] = [
  ["awaiting", "awaiting_review", g.tabs.awaiting],
  ["approved", "approved", g.tabs.approved],
  ["rejected", "rejected", g.tabs.rejected],
]

/**
 * Activation Gate (`/activation`, F2): the gate status card, then the samples
 * in three tabs (the tab lives in the URL), one `GET /v1/samples?state=…` each.
 * Approval happens on the review page only.
 */
export function ActivationPage() {
  useDocumentTitle(g.title)
  const status = useQuery(submissionStatusQueryOptions())
  const lists = useQueries({ queries: TABS.map(([, state]) => samplesQueryOptions(state)) })
  const [params, setParams] = useSearchParams()
  const tab = readTab(params.get("tab"))
  const isError = lists.some((q) => q.isError)
  // F7: the "not available" note shows once, from the status read, not again from the lists.
  const noteAlreadyShown = status.isError && isNotYetAvailable(status.error) && isNotYetAvailable(lists.find((q) => q.isError)?.error)
  const isLoading = lists.some((q) => !q.data)

  return (
    <AppShell title={g.title} advancedOnly>
      <div className="flex flex-col gap-6 px-4 lg:px-6">
        {status.isError ? (
          <LoadErrorAlert error={status.error} onRetry={() => void status.refetch()} />
        ) : status.data ? (
          <div className="max-w-2xl">
            <GateStatusCard status={status.data} />
          </div>
        ) : (
          <GateStatusCardSkeleton />
        )}
        {status.data && status.data.gatePassedAt === null && <HowItWorks />}
        {isError && noteAlreadyShown ? null : isError ? (
          <LoadErrorAlert error={lists.find((q) => q.isError)?.error} onRetry={() => lists.forEach((q) => q.isError && void q.refetch())} />
        ) : isLoading ? (
          <SampleTabsSkeleton />
        ) : (
          <Tabs value={tab} onValueChange={(next) => setParams({ tab: readTab(String(next)) })}>
            <TabsList className="max-w-full overflow-x-auto">
              {TABS.map(([value, , label], i) => (
                <TabsTrigger key={value} value={value}>
                  {label} ({lists[i].data?.length ?? 0})
                </TabsTrigger>
              ))}
            </TabsList>
            {TABS.map(([value], i) => {
              const rows: SampleRow[] = lists[i].data ?? []
              // Preparing samples only makes sense before the gate passes and once the Career Profile is approved.
              const canPrepare = value === "awaiting" && status.data?.gatePassedAt === null && status.data.careerProfileApproved
              return (
                <TabsContent key={value} value={value} className="flex flex-col gap-3 pt-3">
                  {canPrepare && rows.length > 0 && (
                    <div>
                      <PrepareSamplesButton variant="outline" />
                    </div>
                  )}
                  {rows.length > 0 ? (
                    <SampleList tab={value} rows={rows} countingSamples={status.data?.countingSamples ?? 0} />
                  ) : (
                    <EmptyTab tab={value} canPrepare={canPrepare === true} careerProfileApproved={status.data?.careerProfileApproved ?? true} />
                  )}
                </TabsContent>
              )
            })}
          </Tabs>
        )}
      </div>
    </AppShell>
  )
}

/** The three-step explanation of samples, shown under the gate card until the gate passes. */
function HowItWorks() {
  return (
    <section aria-labelledby="gate-how" className="max-w-2xl text-sm">
      <h2 id="gate-how" className="font-medium">
        {g.steps.title}
      </h2>
      <ol className="mt-2 flex list-decimal flex-col gap-1.5 ps-5 text-muted-foreground">
        {g.steps.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
    </section>
  )
}

/** C-EMPTY-1 (Awaiting review), C-EMPTY-7 (Approved), C-EMPTY-8 (Rejected). */
function EmptyTab({ tab, canPrepare, careerProfileApproved }: { tab: Tab; canPrepare: boolean; careerProfileApproved: boolean }) {
  const copy = tab === "awaiting" ? g.empty : g.emptyTab[tab]
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><ListChecks aria-hidden="true" /></EmptyMedia>
        <EmptyTitle>{copy.title}</EmptyTitle>
        <EmptyDescription>{copy.text}</EmptyDescription>
      </EmptyHeader>
      {tab === "awaiting" && (canPrepare || !careerProfileApproved) && (
        <EmptyContent>
          {canPrepare ? <PrepareSamplesButton /> : <ButtonLink to="/profile">{g.empty.action}</ButtonLink>}
        </EmptyContent>
      )}
    </Empty>
  )
}
