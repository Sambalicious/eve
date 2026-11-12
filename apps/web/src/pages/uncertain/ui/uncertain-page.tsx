import { useQuery } from "@tanstack/react-query"
import { CircleQuestionMark } from "lucide-react"

import { AppShell } from "@/components/app-shell"
import { submissionCopy, submissionListQueryOptions, submissionStatusQueryOptions } from "@/entities/application"
import { UncertainCard } from "@/features/resolve-submission"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/shared/ui/empty"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { UncertainSkeleton } from "@/components/page-skeletons"

const u = submissionCopy.uncertain

/** Uncertain Submissions (`/uncertain`, F6 steps 4 to 5). Empty: C-EMPTY-4. */
export function UncertainPage() {
  useDocumentTitle(u.title)
  const list = useQuery(submissionListQueryOptions("uncertain"))
  const status = useQuery(submissionStatusQueryOptions())
  return (
    <AppShell title={u.title} advancedOnly>
      <div className="flex flex-col gap-3 px-4 lg:px-6">
        {list.isError ? (
          <LoadErrorAlert error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data ? (
          <UncertainSkeleton />
        ) : list.data.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><CircleQuestionMark aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{u.empty.title}</EmptyTitle>
              <EmptyDescription>{u.empty.text}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2" aria-label={u.title}>
            {list.data.map((row) => (
              <li key={row.application.id} className="min-w-0">
                <UncertainCard row={row} status={status.data} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  )
}
