import { useId } from "react"

import type { SeniorityFloor } from "@/entities/candidate-settings"
import { FieldLegend, FieldSet } from "@/shared/ui/field"
import { RadioGroup, RadioGroupItem } from "@/shared/ui/radio-group"
import { jobCriteriaCopy } from "../model/copy"

const OPTIONS: readonly SeniorityFloor[] = ["all_levels", "hide_entry_level"]

/**
 * "Seniority" (design-spec.r1 B1): two radios, one tab stop, arrow keys move
 * the choice. The second option's helper is its description.
 */
export function SeniorityField({
  value,
  isSaving,
  onChange,
}: {
  value: SeniorityFloor
  isSaving: boolean
  onChange: (next: SeniorityFloor) => void
}) {
  const id = useId()
  const copy = jobCriteriaCopy.seniority
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label" id={`${id}-legend`} className="mb-0">
        {copy.legend}
      </FieldLegend>
      <RadioGroup
        className="gap-y-2"
        aria-labelledby={`${id}-legend`}
        value={value}
        readOnly={isSaving}
        onValueChange={(next) => {
          if (!isSaving && (next === "all_levels" || next === "hide_entry_level")) onChange(next)
        }}
      >
        {OPTIONS.map((option) => (
          // Same row rhythm as the Role families checkboxes: 8px apart, 4px padding, no fixed height on fine pointers (DP-6).
          <label key={option} className="flex cursor-pointer items-start gap-2.5 py-1 pointer-coarse:min-h-10">
            <RadioGroupItem
              value={option}
              className="mt-0.5"
              aria-labelledby={`${id}-${option}`}
              aria-describedby={option === "hide_entry_level" ? `${id}-help` : undefined}
              aria-disabled={isSaving || undefined}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span id={`${id}-${option}`} className="text-sm leading-snug">
                {copy.option[option]}
              </span>
              {option === "hide_entry_level" && (
                <span id={`${id}-help`} className="text-[0.8125rem] leading-snug text-muted-foreground">
                  {copy.hideEntryHelp}
                </span>
              )}
            </span>
          </label>
        ))}
      </RadioGroup>
    </FieldSet>
  )
}
