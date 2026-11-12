import type { ReactNode } from "react"
import { CirclePause, ShieldCheck } from "lucide-react"

import { findJobsCopy, hiringCopy as h, type AlertFeeds } from "@/entities/stack-post"
import { Button } from "@/shared/ui/button"
import { Section, SectionNote } from "@/shared/ui/section"
import { usePermittedUseDialog } from "../model/use-permitted-use-dialog"
import { FeedsList } from "./feeds-list"
import { VerifyAlertSourceDialog } from "./verify-alert-source-dialog"

export const HIRING_ALERT_FEEDS_SECTION_ID = "hiring-alert-feeds"

/**
 * Hiring Alert feeds (`#hiring-alert-feeds`, EPIC-0007 design-spec r2 B3, H6,
 * H6b). Every Candidate sees her own state; nothing is chosen by role and no
 * text names another person or a shared record (D12, D14).
 * - `verification === null`: the not-recorded panel with an outline Record
 *   button that opens the permitted-use dialog empty. No form and no list.
 * - recorded: one line with the date and an outline Update button (dialog
 *   pre-filled), then "Your feeds" with its own "{n} of 10" and the form.
 * `content` fills the section while the feeds load or after they failed, so
 * the panel never flashes before the recorded line.
 */
export function HiringAlertFeedsSection({
  data,
  content,
}: {
  data: AlertFeeds | undefined
  content: ReactNode
}) {
  return (
    <Section
      id={HIRING_ALERT_FEEDS_SECTION_ID}
      title={h.feedsSectionTitle}
      description={<p>{h.feedsDesc}</p>}
      headingProps={{ tabIndex: -1 }}
    >
      {data ? <HiringFeedsBody data={data} /> : content}
    </Section>
  )
}

function HiringFeedsBody({ data }: { data: AlertFeeds }) {
  const { dialog, open, close, updateRef, formRef } = usePermittedUseDialog(data.verification !== null)

  return (
    <div className="flex flex-col gap-4">
      {data.globalPaused && (
        <SectionNote className="flex items-start gap-2 text-[0.8125rem]">
          <CirclePause aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p>{h.paused}</p>
        </SectionNote>
      )}
      {data.verification ? (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="flex items-center gap-1.5 text-sm">
              <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-success-text" />
              {h.verifyDone(data.verification.verifiedOn)}
            </p>
            <Button ref={updateRef} variant="outline" size="sm" aria-label={h.verifyUpdateSr} onClick={() => open("update")}>
              {h.verifyUpdate}
            </Button>
          </div>
          <FeedsList feeds={data.feeds} list="hiring" formRef={formRef} />
        </>
      ) : (
        // Unconfirmed: the one step at the top of Set up alerts asks first; no panel and no Record button here.
        <p className="text-sm text-muted-foreground">
          <span>{findJobsCopy.alerts.hiringFeedsEmpty}</span> <span>{findJobsCopy.alerts.unconfirmedHint}</span>
        </p>
      )}
      <VerifyAlertSourceDialog
        list="hiring"
        open={dialog !== "closed"}
        current={dialog === "update" ? data.verification : null}
        onClose={close}
      />
    </div>
  )
}
