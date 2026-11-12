import { useEffect, useRef } from "react"
import { Link } from "react-router-dom"

import { boardColumnCopy } from "@/entities/application"
import { firstOfNextMonth } from "@/entities/automation-state"
import {
  coveragePercent,
  homeCopy,
  PostingStatusBadge,
  postingWord,
  reasonLine,
  type JobPostingDetail,
  type WaitingReason,
} from "@/entities/job-posting"
import { usePrepareInPlace } from "@/features/prepare-application"
import { formatWatDate, watToday } from "@/shared/lib/format-wat"
import { Button } from "@/shared/ui/button"
import { ButtonLink } from "@/shared/ui/button-link"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { Skeleton } from "@/shared/ui/skeleton"
import { usePasteResult } from "../model/use-paste-result"

/**
 * The pasted job's result in place (R1, `ResultRow`): status word, reason line, Match when known, and the one
 * action the server allows. The posting polls while it is Checking; the new word is announced politely.
 */
export function PasteResultCard({ postingId, waitingReason }: { postingId: string; waitingReason: WaitingReason | null }) {
  const { posting } = usePasteResult(postingId)
  const headingRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    headingRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [postingId])
  if (posting.isError) return <LoadErrorAlert onRetry={() => void posting.refetch()} />
  if (!posting.data) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    )
  }
  return <Result posting={posting.data} waitingReason={waitingReason} />
}

function reasonOf(posting: JobPostingDetail, waitingReason: WaitingReason | null): string | null {
  const word = postingWord(posting)
  if (word === "checking" && posting.status === "waiting_to_be_checked") {
    if (waitingReason === "cost_pause") {
      const date = formatWatDate(firstOfNextMonth(`${watToday(new Date()).slice(0, 7)}-01`))
      return homeCopy.result.waitingPause(date)
    }
    return homeCopy.result.waitingNotEnabled
  }
  if (word === "checking") return null
  if (word === "goodMatch") return homeCopy.result.goodMatch
  if (word === "hidden") return homeCopy.result.hidden
  if (word === "couldntCheck") return homeCopy.result.couldntCheck
  return reasonLine(posting)
}

function Result({ posting, waitingReason }: { posting: JobPostingDetail; waitingReason: WaitingReason | null }) {
  const prepare = usePrepareInPlace(posting)
  const { recheck } = usePasteResult(posting.id)
  const word = postingWord(posting)
  const reason = reasonOf(posting, waitingReason)
  const percent =
    posting.coverage && posting.coverage.total > 0 && (word === "goodMatch" || word === "notMatch")
      ? coveragePercent(posting.coverage.covered, posting.coverage.total)
      : null
  const name = [posting.title, posting.company].filter(Boolean).join(" · ")
  // The server decides what may be prepared; the page never guesses (R1, AC-1.6a).
  const canPrepare = posting.applicationId === null && (posting.pastedDescription ? posting.pastedPrepareOffered : word === "goodMatch")
  const canPrepareAnyway = posting.applicationId === null && word === "notMatch" && posting.applyAnyway !== null
  const preparedId = prepare.applicationId
  return (
    <div className="flex animate-in flex-col gap-3 fade-in slide-in-from-bottom-1 duration-150 motion-reduce:animate-none" data-testid="paste-result">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {preparedId ? (
              <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium">{boardColumnCopy.draft}</span>
            ) : (
              <PostingStatusBadge posting={posting} />
            )}
            <span className="min-w-0 font-medium [overflow-wrap:anywhere]" title={name}>
              {name || posting.requisitionId}
            </span>
          </p>
          <div aria-live="polite" className="flex flex-col gap-1">
            {preparedId ? (
              <p className="text-sm text-muted-foreground">{homeCopy.result.preparing}</p>
            ) : (
              <>
                {reason && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{reason}</p>}
                {percent !== null ? (
                  <p className="text-sm">{homeCopy.result.match(percent)}</p>
                ) : posting.status === "checking" ? (
                  <p className="text-sm text-muted-foreground">{homeCopy.result.matchPending}</p>
                ) : null}
              </>
            )}
          </div>
          {prepare.failed !== null && (
            <p role="alert" className="text-sm text-destructive-text">
              {prepare.failed || homeCopy.result.prepareFailed}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          {preparedId ? (
            <ButtonLink to={`/applications/${preparedId}`}>{homeCopy.result.openApplication}</ButtonLink>
          ) : (
            <>
              {canPrepare && (
                <Button className="w-full sm:w-auto" aria-busy={prepare.isPending} disabled={prepare.isPending} onClick={prepare.prepare}>
                  {prepare.isPending && <ButtonSpinner />}
                  {homeCopy.result.prepare}
                </Button>
              )}
              {canPrepareAnyway && (
                <Button variant="outline" className="w-full sm:w-auto" aria-busy={prepare.isPending} disabled={prepare.isPending} onClick={prepare.askAnyway}>
                  {homeCopy.result.prepareAnyway}
                </Button>
              )}
              {word === "couldntCheck" && (
                <Button variant="outline" className="w-full sm:w-auto" aria-busy={recheck.isPending} disabled={recheck.isPending} onClick={() => recheck.mutate()}>
                  {recheck.isPending && <ButtonSpinner />}
                  {homeCopy.result.checkAgain}
                </Button>
              )}
              <Link to={`/postings/${posting.id}`} className="text-sm underline underline-offset-4">
                {homeCopy.result.openJob}
              </Link>
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={prepare.confirming}
        onOpenChange={prepare.setConfirming}
        title={homeCopy.confirmAnyway.title}
        body={homeCopy.confirmAnyway.body(prepare.anywayReason)}
        confirmLabel={homeCopy.confirmAnyway.confirm}
        pendingLabel="Preparing…"
        isPending={prepare.isPending}
        onConfirm={prepare.confirmAnyway}
      />
    </div>
  )
}
