import { LoaderCircle, TriangleAlert } from "lucide-react"

import {
  OUTREACH_KINDS,
  type OutreachItem,
  type OutreachKind,
} from "@eve/contracts"

import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { Section } from "@/shared/ui/section"
import { Skeleton } from "@/shared/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs"
import { kindLabel, outreachCopy } from "../model/outreach-copy"
import { causeNotice } from "../model/outreach-state"
import { useOutreachSection } from "../model/use-outreach-section"
import { OutreachPanel } from "./outreach-panel"

export interface OutreachSectionProps {
  applicationId: string
  /** The existing `applicationName` output, e.g. "Frontend Engineer at Reddit". */
  applicationName: string
  roleTitle: string | null
  company: string | null
  /** A 404 on any outreach route: the page swaps to its minimal record view. */
  onUnavailable: () => void
}

/** A kind the api did not return renders as Not written (design spec section 11). */
function notWritten(kind: OutreachKind): OutreachItem {
  return {
    kind,
    status: "idle",
    readerName: null,
    text: null,
    profileVersion: null,
    writtenAt: null,
    lastFailure: null,
    firstFailedSentence: null,
  }
}

/**
 * Outreach on the Application detail page (EPIC-0014, design-spec.r1): one
 * labelled region, three ARIA tabs in a fixed order, one panel each, and one
 * polite live region for the whole section.
 */
export function OutreachSection({ applicationId, applicationName, roleTitle, company, onUnavailable }: OutreachSectionProps) {
  const section = useOutreachSection(applicationId, onUnavailable)

  if (section.status === "unavailable") return null
  if (section.status === "loading") {
    return (
      <Section title={outreachCopy.heading} description={outreachCopy.description}>
        <Skeleton className="h-24" aria-hidden="true" />
      </Section>
    )
  }
  if (section.status === "error") {
    return (
      <Section title={outreachCopy.heading} description={outreachCopy.description}>
        <LoadErrorAlert onRetry={section.retry} />
      </Section>
    )
  }

  const { response, pause } = section
  const itemFor = (kind: OutreachKind): OutreachItem => response.items.find((item) => item.kind === kind) ?? notWritten(kind)

  const tabStatus = (kind: OutreachKind): "writing" | "notice" | null => {
    const item = itemFor(kind)
    if (item.status === "running") return "writing"
    if (pause !== null || causeNotice(item) !== null) return "notice"
    return null
  }

  return (
    <Section title={outreachCopy.heading} description={outreachCopy.description}>
      <Tabs defaultValue="referral_request">
        {/*
          Three equal cells, never a centred row that overflows: a `1fr` grid
          column cannot grow past its share, so a wide label or a status icon
          cannot push the first and last tab outside the gutter (design review
          F1). Each label keeps its full text and wraps; the status icon drops
          to its own line when it no longer fits beside the label.
        */}
        <TabsList
          variant="line"
          aria-label={outreachCopy.tabsLabel}
          activateOnFocus
          className="grid w-full max-w-[72ch] grid-cols-3 items-stretch gap-2"
        >
          {OUTREACH_KINDS.map((kind) => {
            const status = tabStatus(kind)
            return (
              <TabsTrigger
                key={kind}
                value={kind}
                className="flex min-w-0 flex-wrap items-center justify-center gap-1 px-1 text-center whitespace-normal"
              >
                <span className="min-w-0 text-balance">{kindLabel(kind)}</span>
                {status === "writing" && (
                  <>
                    <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
                    <span className="sr-only">, {outreachCopy.tab.writing}</span>
                  </>
                )}
                {status === "notice" && (
                  <>
                    <TriangleAlert aria-hidden="true" className="text-warning-text!" />
                    <span className="sr-only">, {outreachCopy.tab.notice}</span>
                  </>
                )}
              </TabsTrigger>
            )
          })}
        </TabsList>
        {OUTREACH_KINDS.map((kind) => (
          <TabsContent
            key={kind}
            value={kind}
            keepMounted
            aria-label={outreachCopy.kinds[kind].name(applicationName)}
            aria-labelledby={undefined}
            // The panel is not a focus stop: the tablist, then the name field (design spec 12).
            tabIndex={-1}
            className="flex flex-col pt-4"
          >
            <OutreachPanel
              item={itemFor(kind)}
              roleTitle={roleTitle}
              company={company}
              approvedProfileVersion={response.approvedProfileVersion}
              pause={pause}
              pending={section.pending[kind]}
              announce={section.announce}
              onWrite={section.write}
              onSaveName={section.saveName}
              onRefetch={section.refetch}
              onUnavailable={onUnavailable}
            />
          </TabsContent>
        ))}
      </Tabs>
      <div
        data-slot="outreach-live"
        // The region stays mounted so a message is announced on change, but it
        // only takes the `status` role while it holds one: the page already has
        // a status line, and an empty third one would shadow it for role queries.
        role={section.message === "" ? undefined : "status"}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        <span key={section.seq}>{section.message}</span>
      </div>
    </Section>
  )
}
