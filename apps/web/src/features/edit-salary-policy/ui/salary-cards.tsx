import { useId, useState, type FormEvent, type ReactNode } from "react"
import { Ban } from "lucide-react"

import {
  approvedAnswerCopy,
  type GrossPeriod,
  type GrossSalary,
  type PreferredNetPay,
  type SalaryAnswers,
  type SalaryCard,
} from "@/entities/approved-answer"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { FieldError, FieldLabel } from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import { NativeSelect } from "@/shared/ui/native-select"
import { checkAmount } from "../model/amount"
import {
  useClearSalaryCard,
  useSaveGrossSalary,
  useSaveNetPay,
} from "../model/use-salary-card"

/** Currency options in design-spec.r3 order (F1 step 4), each shown as "{code}, {name}"; USD is the default. */
const CURRENCIES = [
  ["USD", "US dollar"],
  ["EUR", "euro"],
  ["GBP", "British pound"],
  ["CAD", "Canadian dollar"],
  ["NGN", "Nigerian naira"],
] as const

/**
 * The Salary group: three separate cards, never one form, so the preferred net
 * pay is never mistaken for a gross figure (AC 1.4). The net card has no
 * period choice and saves through its own endpoint.
 */
export function SalaryCards({ salary }: { salary: SalaryAnswers }) {
  return (
    <div className="flex flex-col divide-y">
      <GrossCard
        card="grossSalaryPolicy"
        title={approvedAnswerCopy.grossCardTitle}
        help={approvedAnswerCopy.grossHelp}
        figure={salary.grossSalaryPolicy}
        emptyText={approvedAnswerCopy.grossEmpty}
      />
      <GrossCard
        card="currentSalary"
        title={approvedAnswerCopy.currentCardTitle}
        help={approvedAnswerCopy.currentHelp}
        figure={salary.currentSalary}
        emptyText={approvedAnswerCopy.currentEmpty}
      />
      <NetCard figure={salary.preferredNetPay} />
    </div>
  )
}

function GrossCard({
  card,
  title,
  help,
  figure,
  emptyText,
}: {
  card: "grossSalaryPolicy" | "currentSalary"
  title: string
  help: string
  figure: GrossSalary | null
  emptyText: string
}) {
  const [isEditing, setIsEditing] = useState(false)
  const { save, isSaving } = useSaveGrossSalary(card, () => setIsEditing(false))
  return (
    <SalaryCardFrame title={title} help={help}>
      {isEditing ? (
        <AmountForm
          initialAmount={figure?.amount}
          initialCurrency={figure?.currency}
          period={{ kind: "choice", initial: figure?.period ?? "year" }}
          isSaving={isSaving}
          onCancel={() => setIsEditing(false)}
          onSave={({ amount, currency, period }) =>
            save({ amount, currency, period: period ?? "year" })
          }
        />
      ) : (
        <FigureView
          card={card}
          display={figure?.display ?? null}
          emptyText={emptyText}
          onEdit={() => setIsEditing(true)}
        />
      )}
    </SalaryCardFrame>
  )
}

function NetCard({ figure }: { figure: PreferredNetPay | null }) {
  const [isEditing, setIsEditing] = useState(false)
  const { save, isSaving } = useSaveNetPay(() => setIsEditing(false))
  return (
    <SalaryCardFrame
      title={approvedAnswerCopy.netCardTitle}
      help={approvedAnswerCopy.netHelp}
      badge={
        <Badge variant="outline">
          <Ban aria-hidden="true" />
          {approvedAnswerCopy.netBadge}
        </Badge>
      }
    >
      {isEditing ? (
        <AmountForm
          initialAmount={figure?.amount}
          initialCurrency={figure?.currency}
          period={{ kind: "fixed", label: approvedAnswerCopy.perMonthNet }}
          isSaving={isSaving}
          onCancel={() => setIsEditing(false)}
          onSave={({ amount, currency }) => save({ amount, currency })}
        />
      ) : (
        <FigureView
          card="preferredNetPay"
          display={figure?.display ?? null}
          emptyText={approvedAnswerCopy.netEmpty}
          onEdit={() => setIsEditing(true)}
        />
      )}
    </SalaryCardFrame>
  )
}

function SalaryCardFrame({
  title,
  help,
  badge,
  children,
}: {
  title: string
  help: string
  badge?: ReactNode
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className="grid min-w-0 gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-8"
    >
      <div className="flex min-w-0 flex-col items-start gap-1">
        <h3 id={headingId} className="text-sm font-medium">
          {title}
        </h3>
        <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
          {help}
        </p>
        {badge && <div className="pt-1">{badge}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

function FigureView({
  card,
  display,
  emptyText,
  onEdit,
}: {
  card: SalaryCard
  display: string | null
  emptyText: string
  onEdit: () => void
}) {
  const { clear, isClearing } = useClearSalaryCard(card, () => undefined)
  return (
    <div className="flex flex-col gap-3">
      {display ? (
        <p className="text-base font-medium tabular-nums [overflow-wrap:anywhere]">
          {display}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={isClearing}
          onClick={onEdit}
        >
          {display ? approvedAnswerCopy.edit : approvedAnswerCopy.addAnswer}
        </Button>
        {display && (
          <Button
            variant="ghost"
            size="sm"
            aria-busy={isClearing}
            disabled={isClearing}
            onClick={clear}
          >
            {isClearing && <ButtonSpinner />}
            {isClearing ? "Deleting…" : approvedAnswerCopy.delete}
          </Button>
        )}
      </div>
    </div>
  )
}

type PeriodControl =
  { kind: "choice"; initial: GrossPeriod } | { kind: "fixed"; label: string }

function AmountForm({
  initialAmount,
  initialCurrency,
  period,
  isSaving,
  onCancel,
  onSave,
}: {
  initialAmount: number | undefined
  initialCurrency: string | undefined
  period: PeriodControl
  isSaving: boolean
  onCancel: () => void
  onSave: (input: {
    amount: number
    currency: string
    period?: GrossPeriod
  }) => void
}) {
  const id = useId()
  const [amountText, setAmountText] = useState(
    initialAmount === undefined ? "" : String(initialAmount)
  )
  const [currency, setCurrency] = useState(initialCurrency ?? "USD")
  const [chosenPeriod, setChosenPeriod] = useState<GrossPeriod>(
    period.kind === "choice" ? period.initial : "year"
  )
  const [error, setError] = useState<string | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const result = checkAmount(amountText)
    if (!result.ok) {
      setError(result.error)
      document.getElementById(`${id}-amount`)?.focus()
      return
    }
    setError(null)
    const { amount } = result
    onSave(
      period.kind === "choice"
        ? { amount, currency, period: chosenPeriod }
        : { amount, currency }
    )
  }

  // A stored code outside the list goes last, as its code alone, so editing never changes it silently.
  const currencyOptions: (readonly [string, string])[] = CURRENCIES.some(
    ([code]) => code === currency
  )
    ? [...CURRENCIES]
    : [...CURRENCIES, [currency, currency]]

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-amount`}>Amount</FieldLabel>
          <Input
            id={`${id}-amount`}
            inputMode="decimal"
            autoComplete="off"
            value={amountText}
            className="tabular-nums"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => setAmountText(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-currency`}>Currency</FieldLabel>
          <NativeSelect
            id={`${id}-currency`}
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          >
            {currencyOptions.map(([code, name]) => (
              <option key={code} value={code}>
                {code === name ? code : `${code}, ${name}`}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
      {period.kind === "choice" ? (
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-period`}>Period</FieldLabel>
          <NativeSelect
            id={`${id}-period`}
            value={chosenPeriod}
            onChange={(event) =>
              setChosenPeriod(event.target.value === "month" ? "month" : "year")
            }
          >
            <option value="year">{approvedAnswerCopy.perYear}</option>
            <option value="month">{approvedAnswerCopy.perMonth}</option>
          </NativeSelect>
        </div>
      ) : (
        <p className="text-sm">
          <span className="font-medium">Period</span>{" "}
          <span className="text-muted-foreground">{period.label}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          aria-busy={isSaving}
          disabled={isSaving}
        >
          {isSaving && <ButtonSpinner />}
          {isSaving ? "Saving…" : approvedAnswerCopy.saveAnswer}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isSaving}
          onClick={onCancel}
        >
          {approvedAnswerCopy.cancel}
        </Button>
      </div>
    </form>
  )
}
