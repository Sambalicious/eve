import { useQuery } from "@tanstack/react-query"

import { AppShell } from "@/components/app-shell"
import { aiProviderQueryOptions } from "@/entities/ai-provider"
import { automationStateQueryOptions } from "@/entities/automation-state"
import { requisitionRecordsQueryOptions } from "@/entities/requisition-record"
import { retentionQueryOptions } from "@/entities/retention"
import { AiProviderCard } from "@/features/approve-ai-provider"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { useScrollToHash } from "@/shared/lib/use-scroll-to-hash"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { AiProviderSkeleton } from "@/components/page-skeletons"
import { MinimalRecordsSection } from "./minimal-records"
import { RetentionSection } from "./retention-section"

/**
 * Data and privacy (`/privacy`): "AI provider" (`#ai-provider`, slice 2),
 * "Retention" (`#retention`, slice 9: rule C-RET-1 and the facts from
 * `GET /v1/retention`) and "Minimal requisition records" (`#records`, slice 7,
 * with "Deleted by" from slice 9).
 */
export function PrivacyPage() {
  useDocumentTitle("Data and privacy")
  const provider = useQuery(aiProviderQueryOptions())
  const records = useQuery(requisitionRecordsQueryOptions())
  const retention = useQuery(retentionQueryOptions())
  const paused = useQuery(automationStateQueryOptions()).data?.globalPaused ?? false
  useScrollToHash(provider.isSuccess && !records.isPending && !retention.isPending)

  return (
    <AppShell title="Data and privacy">
      <div className="flex w-full max-w-[960px] flex-col gap-7 px-4 lg:px-6">
        {provider.isError ? (
          <LoadErrorAlert onRetry={() => void provider.refetch()} />
        ) : provider.data ? (
          <AiProviderCard provider={provider.data} />
        ) : (
          <AiProviderSkeleton />
        )}
        <RetentionSection facts={retention.data} isError={retention.isError} onRetry={() => void retention.refetch()} paused={paused} />
        <MinimalRecordsSection records={records.data} isError={records.isError} onRetry={() => void records.refetch()} />
      </div>
    </AppShell>
  )
}
