import { Radio } from "@base-ui/react/radio"
import { RadioGroup } from "@base-ui/react/radio-group"
import { cn } from "cn"

interface SegmentedRadioProps<T extends string | number> {
  id?: string
  value: T
  options: readonly { readonly value: T; readonly label: string; readonly srLabel?: string }[]
  labelledBy: string
  /** Overrides `labelledBy` when the name must be exact ("Mobile, Hidden"). */
  label?: string
  describedBy?: string
  invalid?: boolean
  readOnly?: boolean
  onChange: (next: T) => void
  className?: string
}

/**
 * A single-select radio group drawn as segments (tiers, arrangement, period,
 * daily cap; design-spec.r4 S4c, S4e). One tab stop, arrow keys move, Space
 * selects. The selected segment uses the neutral pressed style, never a tone
 * colour (Status map: "Excluded tier selected"). 40px targets on coarse pointers.
 */
export function SegmentedRadio<T extends string | number>({
  id,
  value,
  options,
  labelledBy,
  label,
  describedBy,
  invalid,
  readOnly,
  onChange,
  className,
}: SegmentedRadioProps<T>) {
  return (
    <RadioGroup
      id={id}
      value={value}
      aria-labelledby={label ? undefined : labelledBy}
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      readOnly={readOnly}
      onValueChange={(next) => {
        if (!readOnly) onChange(next as T)
      }}
      className={cn("inline-flex w-full max-w-full rounded-lg border border-input p-0.5 sm:w-fit", className)}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          aria-label={option.srLabel}
          className="min-h-7 min-w-0 flex-1 rounded-md px-3 text-[0.8125rem] font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:bg-muted data-checked:text-foreground pointer-coarse:min-h-10 sm:flex-none"
        >
          <span aria-hidden={option.srLabel ? true : undefined}>{option.label}</span>
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
