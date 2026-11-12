import { useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { MessageSquareText } from "lucide-react"

import { AppShell } from "@/components/app-shell"
import {
  approvedAnswerCopy,
  approvedAnswersQueryOptions,
  salaryQueryOptions,
  type ApprovedAnswer,
} from "@/entities/approved-answer"
import { SalaryCards } from "@/features/edit-salary-policy"
import {
  ApprovedAnswerSheet,
  DeleteAnswerDialog,
  type AnswerSheetMode,
} from "@/features/manage-approved-answer"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { useScrollToHash } from "@/shared/lib/use-scroll-to-hash"
import { Button } from "@/shared/ui/button"
import { SectionNote } from "@/shared/ui/section"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { AnswersSkeleton } from "@/components/page-skeletons"
import { answeredTopics, canAddTo, groupAnswers } from "../model/answer-groups"
import { AnswerSection } from "./answer-list"

/** Approved Answers (`/answers`): Standard, Salary, Sensitive and Custom questions. */
export function AnswersPage() {
  useDocumentTitle(approvedAnswerCopy.pageTitle)
  const answers = useQuery(approvedAnswersQueryOptions())
  const salary = useQuery(salaryQueryOptions())
  const [sheet, setSheet] = useState<AnswerSheetMode | null>(null)
  const [deleting, setDeleting] = useState<ApprovedAnswer | null>(null)
  useScrollToHash(answers.isSuccess && salary.isSuccess)

  return (
    <AppShell title={approvedAnswerCopy.pageTitle} advancedOnly>
      <div className="flex w-full max-w-[760px] flex-col gap-7 px-4 lg:px-6">
        {answers.isError || salary.isError ? (
          <LoadErrorAlert
            onRetry={() => {
              if (answers.isError) void answers.refetch()
              if (salary.isError) void salary.refetch()
            }}
          />
        ) : answers.data && salary.data ? (
          <AnswerGroupsView
            answers={answers.data}
            onAdd={(group) => setSheet({ kind: "create", group })}
            onEdit={(answer) => setSheet({ kind: "edit", answer })}
            onDelete={setDeleting}
            salaryCards={<SalaryCards salary={salary.data} />}
          />
        ) : (
          <AnswersSkeleton />
        )}
      </div>
      <ApprovedAnswerSheet
        mode={sheet}
        onClose={() => setSheet(null)}
        answeredStandardTopics={
          answeredTopics(groupAnswers(answers.data ?? [])).standard
        }
        answeredSensitiveTopics={
          answeredTopics(groupAnswers(answers.data ?? [])).sensitive
        }
        answers={answers.data ?? []}
        onEditExisting={(answer) => setSheet({ kind: "edit", answer })}
      />
      <DeleteAnswerDialog answer={deleting} onClose={() => setDeleting(null)} />
    </AppShell>
  )
}

function AnswerGroupsView({
  answers,
  onAdd,
  onEdit,
  onDelete,
  salaryCards,
}: {
  answers: readonly ApprovedAnswer[]
  onAdd: (group: "standard" | "sensitive" | "custom") => void
  onEdit: (answer: ApprovedAnswer) => void
  onDelete: (answer: ApprovedAnswer) => void
  salaryCards: ReactNode
}) {
  const groups = groupAnswers(answers)
  return (
    <>
      {answers.length === 0 && (
        <SectionNote className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <MessageSquareText
            aria-hidden="true"
            className="size-5 shrink-0 text-muted-foreground"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="text-sm font-semibold">
              {approvedAnswerCopy.emptyTitle}
            </h2>
            <p className="text-[0.8125rem] text-muted-foreground">
              {approvedAnswerCopy.emptyText}
            </p>
          </div>
          <Button onClick={() => onAdd("standard")}>
            {approvedAnswerCopy.addAnswer}
          </Button>
        </SectionNote>
      )}
      <AnswerSection
        title="Standard"
        answers={groups.standard}
        canAdd={canAddTo("standard", groups)}
        onAdd={() => onAdd("standard")}
        onEdit={onEdit}
        onDelete={onDelete}
      />
      <section
        id="salary"
        aria-labelledby="salary-heading"
        className="flex scroll-mt-4 flex-col gap-3 border-t pt-7"
      >
        <h2
          id="salary-heading"
          className="text-[0.9375rem] font-semibold tracking-[-0.01em]"
        >
          Salary
        </h2>
        {salaryCards}
      </section>
      <AnswerSection
        anchor="sensitive"
        title="Sensitive"
        help={approvedAnswerCopy.sensitiveHelp}
        answers={groups.sensitive}
        canAdd={canAddTo("sensitive", groups)}
        onAdd={() => onAdd("sensitive")}
        onEdit={onEdit}
        onDelete={onDelete}
      />
      <AnswerSection
        title="Custom questions"
        answers={groups.custom}
        canAdd
        onAdd={() => onAdd("custom")}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </>
  )
}
