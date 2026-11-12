import { useState, type Ref } from "react"
import { CalendarIcon } from "lucide-react"

import { formatWatDate, watToday } from "@/shared/lib/format-wat"
import { Button } from "@/shared/ui/button"
import { Calendar } from "@/shared/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover"

interface DateAppliedPickerProps {
  id: string
  labelId: string
  /** `YYYY-MM-DD`, or empty. */
  value: string
  onChange: (value: string) => void
  invalid: boolean
  describedBy?: string
  triggerRef?: Ref<HTMLButtonElement>
}

/**
 * "Date applied" (F1 step 6a.2): `calendar` in `popover`, no default, no
 * future dates. The value is a calendar date: it is read and written from the
 * picker's local day, never shifted by a time zone. Month and year dropdowns
 * reach a date months back without paging.
 */
export function DateAppliedPicker({
  id,
  labelId,
  value,
  onChange,
  invalid,
  describedBy,
  triggerRef,
}: DateAppliedPickerProps) {
  const [open, setOpen] = useState(false)
  const today = fromCalendarDate(watToday()) ?? new Date()
  const selected = value ? fromCalendarDate(value) : undefined
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={triggerRef}
        render={
          <Button
            id={id}
            variant="outline"
            aria-labelledby={`${labelId} ${id}`}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={describedBy}
            aria-required="true"
            className="h-8 w-full justify-start gap-2 px-2.5 font-normal tabular-nums aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 pointer-coarse:h-11"
          />
        }
      >
        <CalendarIcon aria-hidden="true" className="text-muted-foreground" />
        <span>{selected ? formatWatDate(value) : ""}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          captionLayout="dropdown"
          selected={selected}
          defaultMonth={selected ?? today}
          endMonth={today}
          disabled={{ after: today }}
          today={today}
          onSelect={(date) => {
            if (!date) return
            onChange(toCalendarDate(date))
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** `YYYY-MM-DD` to the local midnight of that day; null-safe for malformed input. */
function fromCalendarDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function toCalendarDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
