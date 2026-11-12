import { useId, type ReactNode } from "react"
import { Pencil, Plus, Trash2 } from "lucide-react"

import {
  answerLabel,
  approvedAnswerCopy,
  type ApprovedAnswer,
} from "@/entities/approved-answer"
import { formatWatDate } from "@/shared/lib/format-wat"
import { Button } from "@/shared/ui/button"

interface AnswerSectionProps {
  /** Anchor for `/answers#{anchor}` links (F6: "Add Approved Answer" for sensitive blocks). */
  anchor?: string
  title: string
  help?: string
  answers: readonly ApprovedAnswer[]
  canAdd: boolean
  onAdd: () => void
  onEdit: (answer: ApprovedAnswer) => void
  onDelete: (answer: ApprovedAnswer) => void
  children?: ReactNode
}

/**
 * One Approved Answers section: each row shows topic, value, last edited,
 * "Edit" and "Delete"; "Add answer" per section. Values are rendered as text
 * and wrap, because the Candidate checks them word for word.
 */
export function AnswerSection({
  anchor,
  title,
  help,
  answers,
  canAdd,
  onAdd,
  onEdit,
  onDelete,
}: AnswerSectionProps) {
  const headingId = useId()
  return (
    <section
      id={anchor}
      aria-labelledby={headingId}
      className="flex scroll-mt-4 flex-col gap-3 border-t pt-7 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id={headingId}
          className="text-[0.9375rem] font-semibold tracking-[-0.01em]"
        >
          {title}
        </h2>
        {canAdd && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${approvedAnswerCopy.addAnswer}, ${title}`}
            onClick={onAdd}
          >
            <Plus aria-hidden="true" />
            {approvedAnswerCopy.addAnswer}
          </Button>
        )}
      </div>
      {help && (
        <p className="-mt-1 max-w-[60ch] text-[0.8125rem] text-muted-foreground">
          {help}
        </p>
      )}
      {answers.length > 0 && (
        <ul className="flex flex-col divide-y">
          {answers.map((answer) => (
            <AnswerRow
              key={answer.id}
              answer={answer}
              onEdit={() => onEdit(answer)}
              onDelete={() => onDelete(answer)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function AnswerRow({
  answer,
  onEdit,
  onDelete,
}: {
  answer: ApprovedAnswer
  onEdit: () => void
  onDelete: () => void
}) {
  const label = answerLabel(answer)
  return (
    <li className="group/row flex flex-col gap-2 py-3.5 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[0.8125rem] text-muted-foreground [overflow-wrap:anywhere]">
          {label}
        </span>
        <span className="text-sm font-medium whitespace-pre-line [overflow-wrap:anywhere]">
          {answer.value}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {approvedAnswerCopy.lastEdited(formatWatDate(answer.updatedAt))}
        </span>
      </div>
      <div className="-mr-2 flex shrink-0 gap-0.5 text-muted-foreground">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${approvedAnswerCopy.edit} ${label}`}
          onClick={onEdit}
        >
          <Pencil aria-hidden="true" />
          <span aria-hidden="true">{approvedAnswerCopy.edit}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${approvedAnswerCopy.delete} ${label}`}
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" />
          <span aria-hidden="true">{approvedAnswerCopy.delete}</span>
        </Button>
      </div>
    </li>
  )
}
