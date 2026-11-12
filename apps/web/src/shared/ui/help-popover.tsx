import * as React from "react"
import { InfoIcon, XIcon } from "lucide-react"
import { cn } from "cn"

import { Button } from "@/shared/ui/button"
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/shared/ui/popover"

type PopupProps = React.ComponentProps<typeof PopoverContent>

interface HelpPopoverProps {
  /** Accessible name of the (i) button. Says what it explains ("Why …"). */
  triggerLabel: string
  /** Visible title; it also names the popup for assistive tech. */
  title: React.ReactNode
  /** The body: short paragraphs, a list, then a note. Owned by the caller. */
  children: React.ReactNode
  /** Accessible name of the close button (C-EH-POPOVER-CLOSE). */
  closeLabel?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Where focus goes on close. Default: back to the trigger. */
  finalFocus?: PopupProps["finalFocus"]
  /** Extra classes for the trigger. */
  className?: string
}

/**
 * Explanatory help (EPIC-0009 design-spec "HelpPopover"): a ghost (i) button
 * that opens a non-modal popover with a pinned title and close button over a
 * scrolling body. Opens on click, tap, Enter and Space, never on hover. On open,
 * focus moves to the popup so its title is read first; on close it returns to
 * the trigger. Escape stops at the popover, so inside a Dialog it closes only
 * the popover. Under reduced motion it opens and closes with no animation: the
 * reduce variants also carry `data-open`/`data-closed` so they match the
 * specificity of popover.tsx's enter and exit classes. The always-visible help line is the caller's sibling element,
 * so the trigger's name never joins a description.
 */
function HelpPopover({
  triggerLabel,
  title,
  children,
  closeLabel = "Close help",
  open,
  onOpenChange,
  finalFocus,
  className,
}: HelpPopoverProps) {
  const popupRef = React.useRef<HTMLDivElement>(null)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label={triggerLabel}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn(
              "-my-1 text-muted-foreground pointer-coarse:-my-2.5 motion-reduce:transition-none",
              className
            )}
          />
        }
      >
        <InfoIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        ref={popupRef}
        tabIndex={-1}
        initialFocus={popupRef}
        finalFocus={finalFocus}
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={16}
        data-slot="help-popover"
        className="max-h-[min(30rem,var(--available-height))] w-[min(22rem,calc(100vw-2rem))] gap-0 p-0 motion-reduce:transition-none motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b py-2.5 pr-2 pl-3.5">
          <PopoverTitle className="text-sm leading-snug font-semibold">
            {title}
          </PopoverTitle>
          <PopoverClose
            aria-label={closeLabel}
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="-my-1 pointer-coarse:-my-2 motion-reduce:transition-none"
              />
            }
          >
            <XIcon aria-hidden="true" />
          </PopoverClose>
        </div>
        <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto overscroll-contain px-3.5 py-3 text-sm leading-normal text-popover-foreground">
          {children}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** The list lead-in inside a help popover body (13px/500 muted). */
function HelpPopoverLead({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("text-[0.8125rem] font-medium text-muted-foreground", className)}
      {...props}
    />
  )
}

/** The disclaimer note, last in a help popover body (13px muted). */
function HelpPopoverNote({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("text-[0.8125rem] text-muted-foreground", className)}
      {...props}
    />
  )
}

export { HelpPopover, HelpPopoverLead, HelpPopoverNote }
