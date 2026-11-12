import type { ReactNode } from "react"
import { EyeOff, Info } from "lucide-react"

import { submissionCopy, type FormAnswer } from "@/entities/application"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { SkeletonText } from "@/shared/ui/skeleton"
import { answerCell, sourceLabel } from "../model/form-answer-lines"
import { useFormAnswers } from "../model/use-form-answers"

const f = submissionCopy.sample.formAnswers

/**
 * Form answers panel (F2 step 3, C-SAMPLE-14 to 17): one row per planned
 * answer in form order, with its source. A sensitive value never reaches the
 * page; its cell says so and offers no reveal. Rows stack as label/value pairs
 * below 768px. The Application page reuses it as the Answers table
 * (`#answers`) with its own heading.
 */
export function FormAnswersPanel({ applicationId, company, title = f.title, showHelp = true }: { applicationId: string; company: string; title?: string; showHelp?: boolean }) {
  const query = useFormAnswers(applicationId)
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {/* `#answers` is the target of E1's "View the answers used" (CR6-01); it takes focus from the hash. */}
          <h2 id="answers" tabIndex={-1} className="scroll-mt-20 text-lg font-semibold outline-none">{title}</h2>
        </CardTitle>
        {showHelp && <CardDescription>{f.help(company)}</CardDescription>}
      </CardHeader>
      <CardContent>
        {query.isError ? (
          <LoadErrorAlert onRetry={() => void query.refetch()} />
        ) : !query.data ? (
          <div className="flex flex-col divide-y text-sm" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="grid gap-1 py-2 md:grid-cols-[2fr_1.5fr_1fr] md:gap-3">
                <SkeletonText widths={[i % 2 ? "w-3/5" : "w-4/5"]} />
                <SkeletonText widths={["w-2/3"]} />
                <SkeletonText widths={["w-1/2"]} />
              </div>
            ))}
          </div>
        ) : !query.data.available ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {f.notRead}
          </p>
        ) : query.data.answers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{f.empty}</p>
        ) : (
          <AnswerRows answers={query.data.answers} />
        )}
      </CardContent>
    </Card>
  )
}

function AnswerRows({ answers }: { answers: readonly FormAnswer[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="sr-only md:not-sr-only">
        <tr className="text-left text-muted-foreground">
          <th scope="col" className="pb-2 pr-3 font-medium">{f.columns.question}</th>
          <th scope="col" className="pb-2 pr-3 font-medium">{f.columns.answer}</th>
          <th scope="col" className="pb-2 font-medium">{f.columns.source}</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {answers.map((answer, i) => (
          <tr key={`${i}-${answer.question}`} className="grid gap-1 py-2 md:table-row">
            <Cell label={f.columns.question}>
              <span className="[overflow-wrap:anywhere]">{answer.question}</span>
            </Cell>
            <Cell label={f.columns.answer}>
              <AnswerValue answer={answer} />
            </Cell>
            <Cell label={f.columns.source} muted>
              {sourceLabel(answer)}
            </Cell>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Cell({ label, muted, children }: { label: string; muted?: boolean; children: ReactNode }) {
  return (
    <td className={`min-w-0 align-top md:py-2 md:pr-3 ${muted ? "text-muted-foreground" : ""}`}>
      <span aria-hidden="true" className="mr-1 text-muted-foreground md:hidden">{label}:</span>
      {children}
    </td>
  )
}

function AnswerValue({ answer }: { answer: FormAnswer }) {
  const cell = answerCell(answer)
  switch (cell.kind) {
    case "hidden":
      return (
        <span className="inline-flex items-start gap-1.5 text-muted-foreground">
          <EyeOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span aria-hidden="true">{f.hidden}</span>
          <span className="sr-only">{f.hiddenSr}</span>
        </span>
      )
    case "blocked":
      return <span className="text-destructive-text">{cell.text}</span>
    case "text":
      return <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{cell.text}</span>
  }
}
