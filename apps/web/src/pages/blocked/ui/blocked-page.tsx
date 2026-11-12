import { useState } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { Hand } from "lucide-react"
import { useNavigate } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { approvedAnswersQueryOptions } from "@/entities/approved-answer"
import { blockedReasonLabel, submissionCopy, submissionListQueryOptions } from "@/entities/application"
import { ApprovedAnswerSheet, type AnswerSheetMode } from "@/features/manage-approved-answer"
import { BlockedCard, groupByReason } from "@/features/resolve-submission"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/shared/ui/empty"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { BlockedSkeleton } from "@/components/page-skeletons"

const c = submissionCopy.blocked

/**
 * Blocked Applications (`/blocked`, F6 step 2): cards grouped by reason, each
 * group headed "{Reason label} ({n})". Same-company review holds come from
 * the `held` view and sit in their own group. Empty: C-EMPTY-3.
 */
export function BlockedPage() {
  useDocumentTitle(c.title)
  const [blockedQuery, heldQuery] = useQueries({ queries: [submissionListQueryOptions("blocked"), submissionListQueryOptions("held")] })
  const answers = useQuery(approvedAnswersQueryOptions())
  const [sheet, setSheet] = useState<{ mode: AnswerSheetMode; onSaved: () => void } | null>(null)
  const navigate = useNavigate()
  const isError = blockedQuery.isError || heldQuery.isError
  const rows = blockedQuery.data && heldQuery.data ? [...blockedQuery.data, ...heldQuery.data] : null

  return (
    <AppShell title={c.title} advancedOnly>
      <div className="flex flex-col gap-6 px-4 lg:px-6">
        {isError ? (
          <LoadErrorAlert error={blockedQuery.error ?? heldQuery.error} onRetry={() => void Promise.all([blockedQuery.refetch(), heldQuery.refetch()])} />
        ) : !rows ? (
          <BlockedSkeleton />
        ) : rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Hand aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{c.empty.title}</EmptyTitle>
              <EmptyDescription>{c.empty.text}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          groupByReason(rows).map((group) => (
            <section key={group.reason} aria-labelledby={`group-${group.reason}`} className="flex flex-col gap-3">
              <h2 id={`group-${group.reason}`} className="text-lg font-semibold">
                {c.group(blockedReasonLabel[group.reason], group.rows.length)}
              </h2>
              <ul className="grid gap-3 lg:grid-cols-2">
                {group.rows.map((row) => (
                  <li key={row.application.id} className="min-w-0">
                    <BlockedCard
                      row={row}
                      onAddAnswer={(target, onSaved) =>
                        target.kind === "custom"
                          ? setSheet({ mode: { kind: "create", group: "custom", question: target.question }, onSaved })
                          : void navigate(`/answers#${target.kind}`)
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <ApprovedAnswerSheet
        mode={sheet?.mode ?? null}
        onClose={() => setSheet(null)}
        onSaved={sheet?.onSaved}
        answeredStandardTopics={[]}
        answeredSensitiveTopics={[]}
        answers={answers.data ?? []}
        onEditExisting={(answer) => setSheet((current) => current && { ...current, mode: { kind: "edit", answer } })}
      />
    </AppShell>
  )
}
