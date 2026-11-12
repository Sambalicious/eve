import { useEffect, useRef, useState, type ReactNode } from "react"
import { Check, ChevronDown, CircleAlert, Copy, ExternalLink } from "lucide-react"
import { GOOGLE_ALERTS_URL } from "@eve/contracts"

import { stackPostsCopy as c } from "@/entities/stack-post"
import { Button } from "@/shared/ui/button"
import { CollapsibleTrigger } from "@/shared/ui/collapsible"
import { SectionNote } from "@/shared/ui/section"
import { COPIED_MS } from "./use-announcer"

/**
 * Parts shared by the Stack posts and the Hiring search links group rows
 * (EPIC-0007 design-spec r1 inventory: "Search group row, query block,
 * CopyButton … reused by extraction. No visual change to Stack posts").
 */

export function LiveRegion({ text }: { text: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {text}
    </p>
  )
}

/** A new-tab search link styled as a small outline button. */
export function SearchLink({ href, label, accessibleName }: { href: string; label: string; accessibleName: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={accessibleName}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[min(var(--radius-md),12px)] border border-border bg-background px-2.5 text-[0.8rem] font-medium whitespace-nowrap transition-colors outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 pointer-coarse:h-10"
    >
      {label}
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  )
}

/** The ghost disclosure under a group's links. */
export function AlertsToggle({ open, panelId, label, accessibleName }: { open: boolean; panelId: string; label: string; accessibleName: string }) {
  return (
    <CollapsibleTrigger
      render={<Button variant="ghost" size="sm" className="-ml-2.5" />}
      aria-controls={panelId}
      aria-label={accessibleName}
    >
      <ChevronDown
        aria-hidden="true"
        className={`transition-transform duration-180 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none ${open ? "rotate-0" : "-rotate-90"}`}
      />
      {label}
    </CollapsibleTrigger>
  )
}

/** The setup line and the "Open Google Alerts" new-tab link (C-SP-ALERTQ-OPEN). */
export function AlertsHowTo({ text }: { text: ReactNode }) {
  return (
    <p className="text-[0.8125rem] text-muted-foreground">
      {text}{" "}
      <a
        href={GOOGLE_ALERTS_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${c.alertsOpen} ${c.newTab}`}
        className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
      >
        {c.alertsOpen}
        <ExternalLink aria-hidden="true" className="size-3.5" />
      </a>
    </p>
  )
}

function selectText(node: HTMLElement | null) {
  const selection = window.getSelection()
  if (!node || !selection) return
  const range = document.createRange()
  range.selectNodeContents(node)
  selection.removeAllRanges()
  selection.addRange(range)
}

/** One read-only query with its Copy button (EPIC-0005 design-spec F2). A refused copy selects the text and says so, never "copied". */
export function QueryBlock({
  query,
  label,
  copyName,
  blockName,
  onCopied,
}: {
  query: string
  label: string
  copyName: string
  blockName: string
  onCopied: () => void
}) {
  const textRef = useRef<HTMLElement>(null)
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(resetTimer.current), [])

  const copy = async () => {
    clearTimeout(resetTimer.current)
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(query)
      setState("copied")
      onCopied()
      resetTimer.current = setTimeout(() => setState("idle"), COPIED_MS)
    } catch {
      setState("failed")
      selectText(textRef.current)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.78125rem] font-medium text-muted-foreground uppercase">{label}</span>
        <Button variant="outline" size="sm" aria-label={copyName} onClick={() => void copy()}>
          {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span aria-hidden="true">{state === "copied" ? c.copied : c.copy}</span>
        </Button>
      </div>
      <SectionNote className="px-3 py-2.5">
        <code ref={textRef} aria-label={blockName} className="font-mono text-[0.78125rem] select-all [overflow-wrap:anywhere]">
          {query}
        </code>
      </SectionNote>
      {state === "failed" && (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive-text">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {c.copyFailed}
        </p>
      )}
    </div>
  )
}
