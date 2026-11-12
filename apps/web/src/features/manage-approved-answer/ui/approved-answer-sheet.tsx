import { useId, useRef, useState, type FormEvent, type ReactNode } from "react"

import {
  answerLabel,
  approvedAnswerCopy,
  SENSITIVE_TOPIC_LABELS,
  STANDARD_TOPIC_LABELS,
  type ApprovedAnswer,
  type SensitiveTopic,
  type StandardTopic,
} from "@/entities/approved-answer"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import { NativeSelect } from "@/shared/ui/native-select"
import { RadioGroup, RadioGroupItem } from "@/shared/ui/radio-group"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet"
import { Textarea } from "@/shared/ui/textarea"
import {
  findSameQuestion,
  formTopic,
  initialAnswerForm,
  toNewAnswer,
  validateAnswerForm,
  valueToSend,
  type AnswerFormErrors,
  type AnswerFormValues,
  type AnswerSheetMode,
} from "../model/answer-form"
import { useSaveApprovedAnswer } from "../model/use-manage-approved-answer"

interface ApprovedAnswerSheetProps {
  mode: AnswerSheetMode | null
  onClose: () => void
  /** Topics already answered; they are left out of the topic list (skill years can repeat). */
  answeredStandardTopics: readonly StandardTopic[]
  answeredSensitiveTopics: readonly SensitiveTopic[]
  /** Every answer, so C-ANS-6's "Edit it" can open the one the backend says already exists. */
  answers: readonly ApprovedAnswer[]
  /** Switches the sheet to editing `answer` (C-ANS-6 "Edit it"). */
  onEditExisting: (answer: ApprovedAnswer) => void
  /** Called after a successful save, before the sheet closes. */
  onSaved?: () => void
}

const GROUP_TITLES = {
  standard: "Standard",
  sensitive: "Sensitive",
  custom: "Custom questions",
} as const

/**
 * Create or edit one Approved Answer (side sheet, full screen below 640px).
 * The topic is a fixed list for Standard and Sensitive and free text for
 * Custom questions. Editing changes only the value: the contract does not
 * allow changing the topic or question.
 */
export function ApprovedAnswerSheet({
  mode,
  onClose,
  ...topics
}: ApprovedAnswerSheetProps) {
  return (
    <Sheet open={mode !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto data-[side=right]:w-full sm:data-[side=right]:max-w-[480px]"
      >
        {mode && (
          <AnswerForm
            key={formKey(mode)}
            mode={mode}
            onClose={onClose}
            {...topics}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function formKey(mode: AnswerSheetMode): string {
  return mode.kind === "edit"
    ? `edit-${mode.answer.id}`
    : `create-${mode.group}`
}

function AnswerForm({
  mode,
  onClose,
  answeredStandardTopics,
  answeredSensitiveTopics,
  answers,
  onEditExisting,
  onSaved,
}: Omit<ApprovedAnswerSheetProps, "mode"> & { mode: AnswerSheetMode }) {
  const standardOptions = (
    Object.keys(STANDARD_TOPIC_LABELS) as StandardTopic[]
  ).filter(
    (topic) =>
      topic === "skill_years" || !answeredStandardTopics.includes(topic)
  )
  const sensitiveOptions = (
    Object.keys(SENSITIVE_TOPIC_LABELS) as SensitiveTopic[]
  ).filter((topic) => !answeredSensitiveTopics.includes(topic))
  const [values, setValues] = useState<AnswerFormValues>(() => ({
    ...initialAnswerForm(mode),
    standardTopic: standardOptions[0] ?? "",
    sensitiveTopic: sensitiveOptions[0] ?? "",
  }))
  const [errors, setErrors] = useState<AnswerFormErrors>({})
  const formRef = useRef<HTMLFormElement>(null)
  const { save, isSaving } = useSaveApprovedAnswer({
    onSaved: () => {
      onSaved?.()
      onClose()
    },
    onFieldErrors: (fieldErrors) => {
      setErrors(fieldErrors)
      focusFirstInvalid(formRef.current)
    },
  })
  const set = (patch: Partial<AnswerFormValues>) =>
    setValues((current) => ({ ...current, ...patch }))
  const group = mode.kind === "edit" ? mode.answer.group : mode.group
  const title =
    mode.kind === "edit"
      ? answerLabel(mode.answer)
      : approvedAnswerCopy.addAnswer

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const found = validateAnswerForm(mode, values)
    setErrors(found)
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(formRef.current)
      return
    }
    save(
      mode.kind === "edit"
        ? {
            kind: "edit",
            id: mode.answer.id,
            value: valueToSend(formTopic(mode, values), values.value),
          }
        : { kind: "create", answer: toNewAnswer(mode.group, values) }
    )
  }

  const topic =
    mode.kind === "create" && group === "standard"
      ? values.standardTopic
      : undefined
  // C-ANS-6's link: the answer already holding this question, when the list has it.
  const existing =
    errors.topic && mode.kind === "create"
      ? findSameQuestion(answers, toNewAnswer(mode.group, values))
      : null
  const editExisting = existing && (
    <button
      type="button"
      className="w-fit text-sm text-foreground underline underline-offset-4"
      onClick={() => onEditExisting(existing)}
    >
      {approvedAnswerCopy.editExisting}
    </button>
  )

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={submit}
      className="flex flex-1 flex-col"
    >
      <SheetHeader>
        <SheetTitle className="pr-8 [overflow-wrap:anywhere]">
          {title}
        </SheetTitle>
        <SheetDescription>{GROUP_TITLES[group]}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-5 px-6 py-6">
        {mode.kind === "create" && group === "standard" && (
          <TopicSelect
            value={values.standardTopic}
            options={standardOptions.map((t) => [t, STANDARD_TOPIC_LABELS[t]])}
            error={errors.topic}
            after={editExisting}
            onChange={(standardTopic) =>
              set({ standardTopic: standardTopic as StandardTopic })
            }
          />
        )}
        {mode.kind === "create" && group === "sensitive" && (
          <TopicSelect
            value={values.sensitiveTopic}
            options={sensitiveOptions.map((t) => [
              t,
              SENSITIVE_TOPIC_LABELS[t],
            ])}
            error={errors.topic}
            help={approvedAnswerCopy.sensitiveHelp}
            after={editExisting}
            onChange={(sensitiveTopic) =>
              set({ sensitiveTopic: sensitiveTopic as SensitiveTopic })
            }
          />
        )}
        {mode.kind === "create" && group === "custom" && (
          <TextField
            label="Question"
            multiline
            value={values.question}
            error={errors.question ?? errors.topic}
            after={editExisting}
            maxLength={500}
            onChange={(question) => set({ question })}
          />
        )}
        {topic === "skill_years" && (
          <TextField
            label="Skill"
            value={values.skill}
            error={errors.skill}
            maxLength={100}
            onChange={(skill) => set({ skill })}
          />
        )}
        <ValueField
          topic={formTopic(mode, values)}
          value={values.value}
          error={errors.value}
          onChange={(value) => set({ value })}
        />
      </div>
      <SheetFooter className="mt-auto flex-row flex-wrap">
        <Button type="submit" aria-busy={isSaving} disabled={isSaving}>
          {isSaving && <ButtonSpinner />}
          {isSaving ? "Saving…" : approvedAnswerCopy.saveAnswer}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={isSaving}
          onClick={onClose}
        >
          {approvedAnswerCopy.cancel}
        </Button>
      </SheetFooter>
    </form>
  )
}

function focusFirstInvalid(form: HTMLFormElement | null) {
  queueMicrotask(() =>
    form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  )
}

function TopicSelect({
  value,
  options,
  error,
  help,
  after,
  onChange,
}: {
  value: string
  options: [string, string][]
  error?: string
  help?: string
  after?: ReactNode
  onChange: (value: string) => void
}) {
  const id = useId()
  const errorId = `${id}-error`
  const helpId = `${id}-help`
  const describedBy =
    [help && helpId, error && errorId].filter(Boolean).join(" ") || undefined
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>Topic</FieldLabel>
      <NativeSelect
        id={id}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([option, label]) => (
          <option key={option} value={option}>
            {label}
          </option>
        ))}
      </NativeSelect>
      {help && <FieldDescription id={helpId}>{help}</FieldDescription>}
      {error && <FieldError id={errorId}>{error}</FieldError>}
      {after}
    </Field>
  )
}

/**
 * The value input matched to the topic (design-spec.r3 F1 step 4): date for
 * start date, number for skill years, a one-link-per-line textarea with
 * C-ANS-9 for profile links, the C-ANS-10 radio group for relocation, and a
 * textarea otherwise.
 */
function ValueField({
  topic,
  value,
  error,
  onChange,
}: {
  topic: StandardTopic | null
  value: string
  error?: string
  onChange: (value: string) => void
}) {
  switch (topic) {
    case "start_date":
      return (
        <TextField
          label="Answer"
          type="date"
          value={value}
          error={error}
          onChange={onChange}
        />
      )
    case "skill_years":
      return (
        <TextField
          label="Answer"
          type="number"
          inputMode="decimal"
          min={0}
          value={value}
          error={error}
          onChange={onChange}
        />
      )
    case "profile_links":
      return (
        <TextField
          label="Answer"
          multiline
          help={approvedAnswerCopy.profileLinksHelp}
          value={value}
          error={error}
          maxLength={2000}
          onChange={onChange}
        />
      )
    case "relocation_willingness":
      return <RelocationField value={value} error={error} onChange={onChange} />
    default:
      return (
        <TextField
          label="Answer"
          multiline
          value={value}
          error={error}
          maxLength={2000}
          onChange={onChange}
        />
      )
  }
}

/** C-ANS-10: legend and two options; the stored value is the option label. */
function RelocationField({
  value,
  error,
  onChange,
}: {
  value: string
  error?: string
  onChange: (value: string) => void
}) {
  const id = useId()
  const legendId = `${id}-legend`
  const errorId = `${id}-error`
  return (
    <Field data-invalid={error ? true : undefined}>
      <span id={legendId} className="text-sm font-medium">
        {approvedAnswerCopy.relocationLegend}{" "}
        <span className="text-xs font-normal text-muted-foreground">
          Required
        </span>
      </span>
      <RadioGroup
        aria-labelledby={legendId}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        value={value}
        onValueChange={(next) => onChange(String(next))}
      >
        {approvedAnswerCopy.relocationOptions.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm">
            <RadioGroupItem value={option} />
            {option}
          </label>
        ))}
      </RadioGroup>
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  )
}

interface TextFieldProps {
  label: string
  value: string
  error?: string
  help?: string
  after?: ReactNode
  multiline?: boolean
  type?: "text" | "date" | "number"
  inputMode?: "decimal"
  min?: number
  maxLength?: number
  onChange: (value: string) => void
}

function TextField({
  label,
  value,
  error,
  help,
  after,
  multiline,
  type = "text",
  onChange,
  ...rest
}: TextFieldProps) {
  const id = useId()
  const errorId = `${id}-error`
  const helpId = `${id}-help`
  const common = {
    id,
    value,
    "aria-invalid": error ? true : undefined,
    "aria-describedby":
      [help && helpId, error && errorId].filter(Boolean).join(" ") || undefined,
    "aria-required": true,
  } as const
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>
        {label}{" "}
        <span className="text-xs font-normal text-muted-foreground">
          Required
        </span>
      </FieldLabel>
      {multiline ? (
        <Textarea
          {...common}
          rows={3}
          maxLength={rest.maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          {...common}
          type={type}
          {...rest}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {help && <FieldDescription id={helpId}>{help}</FieldDescription>}
      {error && <FieldError id={errorId}>{error}</FieldError>}
      {after}
    </Field>
  )
}
