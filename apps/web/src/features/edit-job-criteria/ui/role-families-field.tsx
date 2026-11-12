import { Link } from "react-router-dom"
import { useId, type Ref } from "react"
import { CircleAlert } from "lucide-react"

import type { TargetRoleFamily } from "@/entities/candidate-settings"
import { ROLE_FAMILIES, roleFamilyLabel } from "@/entities/job-posting"
import { Checkbox } from "@/shared/ui/checkbox"
import { FieldDescription, FieldError, FieldLegend, FieldSet } from "@/shared/ui/field"
import { jobCriteriaCopy } from "../model/copy"

interface RoleFamiliesFieldProps {
  selected: readonly TargetRoleFamily[]
  /** `jobCriteria.families.errorNone` or `.errorServer`, or null. */
  error: string | null
  isSaving: boolean
  firstCheckboxRef: Ref<HTMLButtonElement>
  onChange: (next: TargetRoleFamily[]) => void
}

/**
 * "Role families" (design-spec.r1 B1): 13 checkboxes in catalog order, each
 * with an example line. The `<legend>` holds only "Role families", so that is
 * the group's accessible name; the counter, helper and error describe the
 * fieldset through `aria-describedby`. Checkboxes are never disabled, so the
 * "choose at least one" refusal is reachable and explained.
 */
export function RoleFamiliesField({ selected, error, isSaving, firstCheckboxRef, onChange }: RoleFamiliesFieldProps) {
  const id = useId()
  const copy = jobCriteriaCopy.families
  const describedBy = [`${id}-count`, `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ")

  const toggle = (family: TargetRoleFamily, checked: boolean) => {
    if (isSaving) return
    const next = new Set(selected)
    if (checked) next.add(family)
    else next.delete(family)
    onChange(ROLE_FAMILIES.filter((f) => next.has(f)))
  }

  return (
    // The legend sits in a row with the counter, so it is not the fieldset's first child;
    // aria-labelledby keeps the group's name exactly the legend text.
    <FieldSet className="gap-2" aria-labelledby={`${id}-legend`} aria-describedby={describedBy} aria-invalid={error ? true : undefined}>
      <div className="flex items-baseline justify-between gap-3">
        <FieldLegend variant="label" id={`${id}-legend`} className="mb-0">
          {copy.legend}
        </FieldLegend>
        <span id={`${id}-count`} className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {copy.count(selected.length)}
        </span>
      </div>
      <FieldDescription id={`${id}-help`}>{copy.help}</FieldDescription>
      {/* Standalone link: 40px target on coarse pointers (DESIGN.md:64, DR-B1-01). */}
      <Link to={copy.prefsHref} className="inline-flex w-fit items-center text-[0.8125rem] text-foreground underline underline-offset-4 pointer-coarse:min-h-10">
        {copy.prefsLink}
      </Link>
      {error && (
        // No live role: the error is read once, as part of the fieldset's description when focus
        // moves to the first checkbox (design-spec.r1 Accessibility > Families; DP-7).
        <FieldError id={`${id}-error`} role={undefined} className="flex items-start gap-1.5">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {error}
        </FieldError>
      )}
      <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {ROLE_FAMILIES.map((family, index) => (
          <label
            key={family}
            className="flex min-h-8 cursor-pointer items-start gap-2.5 rounded-md py-1 pointer-coarse:min-h-10"
          >
            <Checkbox
              ref={index === 0 ? firstCheckboxRef : undefined}
              checked={selected.includes(family)}
              readOnly={isSaving}
              aria-disabled={isSaving || undefined}
              // Name = the label only; the example line is its description (copy deck, Accessibility text).
              aria-labelledby={`${id}-label-${family}`}
              aria-describedby={`${id}-example-${family}`}
              onCheckedChange={(checked) => toggle(family, checked)}
              className="mt-0.5"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span id={`${id}-label-${family}`} className="text-sm leading-snug [overflow-wrap:anywhere]">{roleFamilyLabel[family]}</span>
              <span id={`${id}-example-${family}`} className="text-[0.8125rem] leading-snug text-muted-foreground">
                {copy.example[family]}
              </span>
            </span>
          </label>
        ))}
      </div>
    </FieldSet>
  )
}
