import { useId, type KeyboardEvent, type Ref } from "react"
import { CircleAlert, Plus, X } from "lucide-react"
import { cn } from "cn"

import type { JobCriteriaListName } from "@/entities/candidate-settings"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { FieldDescription, FieldError, FieldLegend, FieldSet } from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import { jobCriteriaCopy } from "../model/copy"
import type { ListServerErrors } from "../model/criteria-form"

export interface ListEntry {
  /** Stable key, so removing one chip doesn't move another's focus. */
  readonly key: number
  readonly value: string
}

interface CriteriaListFieldProps {
  name: JobCriteriaListName
  entries: readonly ListEntry[]
  pending: string
  /** Client entry error from the last add (AC 3.2, 3.3). */
  entryError: string | null
  serverErrors: ListServerErrors
  /** C-JC-TECH-OFF, shown under Technologies while both lists are empty. */
  note?: string
  isSaving: boolean
  inputRef: Ref<HTMLInputElement>
  removeRef: (index: number, element: HTMLButtonElement | null) => void
  onPendingChange: (value: string) => void
  onAdd: () => void
  onRemove: (index: number) => void
  onBackspaceEmpty: () => void
  onClearError: () => void
}

/**
 * One chip list (Frameworks or Technologies): legend with the "n of 20" count,
 * help, an input with "Add", the entry error, and the chips. Enter adds and
 * never submits the form; Backspace in the empty input moves to the last
 * chip's remove button; Escape clears an entry error but keeps the text.
 */
export function CriteriaListField({
  name,
  entries,
  pending,
  entryError,
  serverErrors,
  note,
  isSaving,
  inputRef,
  removeRef,
  onPendingChange,
  onAdd,
  onRemove,
  onBackspaceEmpty,
  onClearError,
}: CriteriaListFieldProps) {
  const id = useId()
  const label = jobCriteriaCopy.listLabel[name]
  const legendId = `${id}-legend`
  const errorId = `${id}-error`
  const listErrorId = `${id}-list-error`
  const hasInputError = entryError !== null || serverErrors.list !== null
  const describedBy = [`${id}-help`, `${id}-count`, note && `${id}-note`, entryError && errorId, serverErrors.list && listErrorId]
    .filter(Boolean)
    .join(" ")

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      if (!isSaving) onAdd()
    } else if (event.key === "Backspace" && pending === "" && entries.length > 0) {
      event.preventDefault()
      onBackspaceEmpty()
    } else if (event.key === "Escape" && entryError) {
      onClearError()
    }
  }

  return (
    <FieldSet className="gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <FieldLegend variant="label" id={legendId} className="mb-0">
          {label}
        </FieldLegend>
        <span id={`${id}-count`} className="text-xs text-muted-foreground tabular-nums">
          {jobCriteriaCopy.count(entries.length)}
        </span>
      </div>
      <FieldDescription id={`${id}-help`}>{jobCriteriaCopy.listHelp[name]}</FieldDescription>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          ref={inputRef}
          className="min-w-0 flex-1"
          aria-labelledby={legendId}
          aria-describedby={describedBy}
          aria-invalid={hasInputError ? true : undefined}
          autoComplete="off"
          enterKeyHint="done"
          placeholder={jobCriteriaCopy.placeholder[name]}
          value={pending}
          readOnly={isSaving}
          onKeyDown={onKeyDown}
          onChange={(event) => onPendingChange(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:h-10"
          aria-label={jobCriteriaCopy.addTo(label)}
          disabled={isSaving}
          focusableWhenDisabled
          onClick={onAdd}
        >
          <Plus aria-hidden="true" />
          {jobCriteriaCopy.add}
        </Button>
      </div>
      {entryError && (
        <FieldError id={errorId} className="flex items-start gap-1.5">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {entryError}
        </FieldError>
      )}
      {serverErrors.list && (
        <FieldError id={listErrorId} className="flex items-start gap-1.5">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {serverErrors.list}
        </FieldError>
      )}
      {[...serverErrors.entries].map(([index, message]) => (
        <FieldError key={index} id={`${id}-entry-${index}-error`} className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {message}
        </FieldError>
      ))}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{jobCriteriaCopy.listEmpty}</p>
      ) : (
        <ul aria-label={label} className="flex flex-wrap gap-1.5">
          {entries.map((entry, index) => {
            const invalid = serverErrors.entries.has(index)
            return (
              <li
                key={entry.key}
                className="max-w-full motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-96 motion-safe:duration-150 motion-safe:ease-[cubic-bezier(0.25,1,0.5,1)]"
              >
                <Badge
                  variant="secondary"
                  className={cn(
                    "h-auto max-w-full items-start gap-0.5 rounded-full py-0.5 pr-0.5 pl-2.5 text-left text-[0.8125rem] whitespace-normal",
                    invalid && "border-destructive"
                  )}
                >
                  <span className="min-w-0 py-0.5 [overflow-wrap:anywhere]">{entry.value}</span>
                  <Button
                    ref={(element) => removeRef(index, element)}
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="rounded-full pointer-coarse:size-10 pointer-coarse:-my-2.5"
                    aria-label={jobCriteriaCopy.remove(entry.value, label)}
                    aria-invalid={invalid ? true : undefined}
                    aria-describedby={invalid ? `${id}-entry-${index}-error` : undefined}
                    disabled={isSaving}
                    focusableWhenDisabled
                    onClick={() => onRemove(index)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </Badge>
              </li>
            )
          })}
        </ul>
      )}
      {note && (
        <p id={`${id}-note`} className="text-sm text-muted-foreground">
          {note}
        </p>
      )}
    </FieldSet>
  )
}
