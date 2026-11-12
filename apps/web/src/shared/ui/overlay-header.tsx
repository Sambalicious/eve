import * as React from "react"
import { cn } from "cn"
import { XIcon } from "lucide-react"

import { Button } from "@/shared/ui/button"
import { DialogClose, DialogTitle } from "@/shared/ui/dialog"
import { SheetClose, SheetTitle } from "@/shared/ui/sheet"

interface OverlayHeaderProps {
  title: React.ReactNode
  closeLabel: string
  titleSlot?: "dialog" | "sheet"
  /**
   * `inline` (default): the close control is the header's last child.
   * `end`: `children` (the body) render between the title and the close
   * control in DOM order, so keyboard users reach the body first, while the
   * grid keeps the close control in the header row.
   */
  closePlacement?: "inline" | "end"
  children?: React.ReactNode
  className?: string
}

/**
 * The shared overlay header (architecture r1 8.2, design-spec r2 S2): title
 * and close control on one row, a divider below. Padding 16 16 16 24, title
 * Bricolage 20/600, ghost close at 32px (40px on coarse pointers) with a
 * 16px icon. The title wraps to two lines
 * before it truncates; the close control never shrinks.
 */
export function OverlayHeader({ title, closeLabel, titleSlot = "dialog", closePlacement = "inline", children, className }: OverlayHeaderProps) {
  const Title = titleSlot === "sheet" ? SheetTitle : DialogTitle
  const Close = titleSlot === "sheet" ? SheetClose : DialogClose
  const close = (
    <Close
      data-slot="overlay-close"
      render={<Button variant="ghost" size="icon-sm" className="size-8 shrink-0 pointer-coarse:size-10" />}
    >
      <XIcon aria-hidden="true" />
      <span className="sr-only">{closeLabel}</span>
    </Close>
  )
  const header = (
    <div
      data-slot="overlay-header"
      className={cn(
        "grid min-h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b py-4 pr-4 pl-6",
        className
      )}
    >
      <Title
        className="line-clamp-2 min-w-0 font-display text-xl leading-tight font-semibold tracking-[-0.015em] [overflow-wrap:anywhere]"
        title={typeof title === "string" ? title : undefined}
      >
        {title}
      </Title>
      {closePlacement === "inline" ? close : <span aria-hidden="true" className="size-8 shrink-0 pointer-coarse:size-10" />}
    </div>
  )
  if (closePlacement === "inline") return header
  // The body scrolls under a fixed header; the close control sits over the
  // header's right end but comes last in DOM and tab order.
  return (
    <div data-slot="overlay-frame" className="relative flex min-h-0 flex-1 flex-col">
      {header}
      <div data-slot="overlay-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {children}
      </div>
      <div className="absolute top-3 right-4 pointer-coarse:top-2">{close}</div>
    </div>
  )
}
