import { useRef, useState } from "react"
import { Check, ChevronDown, Lock, X } from "lucide-react"
import { cn } from "cn"

import type { CountryCode } from "@/entities/job-preferences"
import { Button } from "@/shared/ui/button"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/shared/ui/command"
import { Popover, PopoverClose, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/shared/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import { COUNTRY_OPTIONS, countryName } from "../model/display"

interface CountryPickerProps {
  id: string
  labelId: string
  /** `prefs.country.popoverTitle.*`. */
  title: string
  closeLabel: string
  selected: readonly CountryCode[]
  /** Single choice (home country): picking closes the popover. */
  single?: boolean
  /** The home country chip in work authorization: no remove button, `Lock` and C-PREF-HOME-LOCK. */
  locked?: CountryCode | null
  lockedHint?: string
  /** Not offered (the home country in excluded relocation countries). */
  omit?: readonly CountryCode[]
  describedBy?: string
  invalid?: boolean
  readOnly?: boolean
  onChange: (next: CountryCode[]) => void
}

/**
 * S4a country picker: a `Command` list in a popover with the slice 8 popover
 * header (title, Close, divider), chips below with "Remove {country}" buttons.
 * The trigger is named by the field label; single mode shows the choice.
 */
export function CountryPicker({
  id,
  labelId,
  title,
  closeLabel,
  selected,
  single = false,
  locked = null,
  lockedHint,
  omit = [],
  describedBy,
  invalid,
  readOnly,
  onChange,
}: CountryPickerProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([])
  const options = COUNTRY_OPTIONS.filter((code) => !omit.includes(code))

  const pick = (code: CountryCode) => {
    if (readOnly) return
    if (single) {
      onChange([code])
      setOpen(false)
      return
    }
    if (code === locked) return
    onChange(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code])
  }
  const remove = (code: CountryCode, index: number) => {
    if (readOnly) return
    onChange(selected.filter((c) => c !== code))
    // Focus the next chip, else the previous one, else the trigger (as the built chip lists).
    requestAnimationFrame(() => (chipRefs.current[index] ?? chipRefs.current[index - 1] ?? triggerRef.current)?.focus())
  }
  const chips = single ? [] : selected

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          ref={triggerRef}
          id={id}
          aria-labelledby={single && selected[0] ? `${labelId} ${id}-value` : labelId}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          render={
            <button
              type="button"
              className={cn(
                "flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2.5 text-left text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 pointer-coarse:h-11 sm:max-w-80"
              )}
            />
          }
        >
          <span id={`${id}-value`} className="min-w-0 truncate">
            {single && selected[0] ? countryName(selected[0]) : ""}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 max-w-[calc(100vw-32px)] gap-0 p-0" initialFocus={false}>
          <PopoverHeader className="flex-row items-center justify-between gap-2 border-b py-1.5 ps-3 pe-1.5">
            <PopoverTitle render={<h2 />} className="text-[0.9375rem] leading-[1.4] font-semibold">
              {title}
            </PopoverTitle>
            <PopoverClose render={<Button variant="ghost" size="icon-sm" />}>
              <X aria-hidden="true" />
              <span className="sr-only">{closeLabel}</span>
            </PopoverClose>
          </PopoverHeader>
          <Command loop label={title}>
            <CommandInput aria-label={title} autoFocus />
            <CommandList className="max-h-64">
              <CommandEmpty>{""}</CommandEmpty>
              {options.map((code) => {
                const isSelected = selected.includes(code)
                return (
                  <CommandItem key={code} value={`${countryName(code)} ${code}`} onSelect={() => pick(code)} aria-selected={isSelected} data-checked={isSelected || undefined}>
                    <span className="min-w-0 flex-1">{countryName(code)}</span>
                    {code === locked ? <Lock aria-hidden="true" className="size-3.5" /> : isSelected && <Check aria-hidden="true" className="size-4" />}
                  </CommandItem>
                )
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {chips.map((code, index) => (
            <li key={code} className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted py-0.5 ps-2.5 pe-1 text-[0.8125rem]">
              <span className="min-w-0 [overflow-wrap:anywhere]">{countryName(code)}</span>
              {code === locked ? (
                <Tooltip>
                  <TooltipTrigger render={<span tabIndex={0} className="inline-flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />}>
                    <Lock aria-hidden="true" className="size-3.5 text-muted-foreground" />
                    <span className="sr-only">{lockedHint}</span>
                  </TooltipTrigger>
                  <TooltipContent>{lockedHint}</TooltipContent>
                </Tooltip>
              ) : (
                <button
                  ref={(el) => {
                    chipRefs.current[index] = el
                  }}
                  type="button"
                  aria-label={`Remove ${countryName(code)}`}
                  onClick={() => remove(code, index)}
                  className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:size-10"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
