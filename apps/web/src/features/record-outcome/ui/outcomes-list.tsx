import { Plus } from "lucide-react"

import { outcomeCopy, OutcomeTypeBadge, type Outcome } from "@/entities/outcome"
import { formatWatDate } from "@/shared/lib/format-wat"
import { Button } from "@/shared/ui/button"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { Section } from "@/shared/ui/section"
import { Skeleton } from "@/shared/ui/skeleton"
import { useOutcomes } from "../model/use-outcomes"
import { useRecordOutcome } from "../model/use-record-outcome"
import { OutcomeDialog } from "./outcome-dialog"

/**
 * Outcomes list (Composite blocks, F9 step 4): rows with type badge, date,
 * "Recorded by you" and "Edit"; "Record Outcome". No sender or excerpt in the
 * MVP. Empty: C-OUT-1.
 */
export function OutcomesList({ applicationId }: { applicationId: string }) {
  const query = useOutcomes(applicationId)
  const dialog = useRecordOutcome(applicationId)
  return (
    <Section
      title={outcomeCopy.heading}
      headingProps={{ id: "outcomes", tabIndex: -1 }}
      actions={
        <Button variant="outline" size="sm" onClick={() => dialog.open({ kind: "record" })}>
          <Plus aria-hidden="true" />
          {outcomeCopy.record}
        </Button>
      }
    >
      {query.isError ? (
        <LoadErrorAlert onRetry={query.retry} />
      ) : !query.outcomes ? (
        <Skeleton aria-hidden="true" className="h-12 w-full" />
      ) : query.outcomes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{outcomeCopy.empty}</p>
      ) : (
        <ul className="divide-y">
          {query.outcomes.map((outcome) => (
            <OutcomeRow key={outcome.id} outcome={outcome} onEdit={() => dialog.open({ kind: "edit", outcome })} />
          ))}
        </ul>
      )}
      <OutcomeDialog target={dialog.target} isSaving={dialog.isSaving} onClose={dialog.close} onSave={dialog.save} />
    </Section>
  )
}

function OutcomeRow({ outcome, onEdit }: { outcome: Outcome; onEdit: () => void }) {
  const label = outcomeCopy.type[outcome.type]
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <OutcomeTypeBadge type={outcome.type} />
        <time dateTime={outcome.updatedAt}>{formatWatDate(outcome.updatedAt)}</time>
        <span className="text-muted-foreground">{outcomeCopy.recordedByYou}</span>
      </div>
      <Button variant="ghost" size="sm" aria-label={`${outcomeCopy.edit} Outcome: ${label}`} onClick={onEdit}>
        {outcomeCopy.edit}
      </Button>
    </li>
  )
}
