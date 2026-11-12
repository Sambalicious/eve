import { useEffect, useRef, type Ref } from "react"
import { CirclePause, ShieldCheck } from "lucide-react"

import { findJobsCopy, stackPostsCopy as c, type AlertFeeds } from "@/entities/stack-post"
import { Button } from "@/shared/ui/button"
import { Section, SectionNote } from "@/shared/ui/section"
import { usePermittedUseDialog } from "../model/use-permitted-use-dialog"
import { FeedsList } from "./feeds-list"
import { VerifyAlertSourceDialog } from "./verify-alert-source-dialog"

export const ALERT_FEEDS_SECTION_ID = "alert-feeds"

/**
 * Stack posts Alert feeds (`#alert-feeds`, EPIC-0008 design-spec S1, B1). The
 * session Candidate's own permitted-use record decides the state; nothing is
 * chosen by role and no text names another person, a shared record or the
 * Hiring list (AC 7.1, 7.2).
 * - `verification === null`, no feeds: the not-recorded panel with a filled
 *   Record button. No list and no form (registration would answer 409).
 * - `verification === null`, saved feeds (registered before EPIC-0008, OD-7):
 *   the same panel with the "{n} saved feeds" body, then a read-only "Your
 *   feeds" with Remove only.
 * - recorded: one line with the date and an outline Update, then "Your feeds"
 *   with the form. The basis shows only in the dialog (AC 1.6).
 * `content` fills the section while the feeds load or after they failed, so
 * the panel never flashes before the recorded line.
 */
export function AlertFeedsSection({
  data,
  content,
  headingRef,
}: {
  data: AlertFeeds | undefined
  content?: React.ReactNode
  headingRef?: Ref<HTMLHeadingElement>
}) {
  return (
    <Section
      id={ALERT_FEEDS_SECTION_ID}
      title={c.feedsSectionTitle}
      description={c.feedsDesc}
      headingProps={{ tabIndex: -1, ref: headingRef }}
    >
      {data ? <AlertFeedsBody data={data} /> : content}
    </Section>
  )
}

function AlertFeedsBody({ data }: { data: AlertFeeds }) {
  const { dialog, open, close, updateRef, formRef } = usePermittedUseDialog(data.verification !== null)
  const savedFeedCount = data.verification === null ? data.feeds.length : null
  const previousSavedFeedCount = useRef(savedFeedCount)
  // Removing the last saved feed (read-only, no confirmation yet) leaves nothing here to focus: the confirm step is next.
  useEffect(() => {
    const before = previousSavedFeedCount.current
    previousSavedFeedCount.current = savedFeedCount
    if (before !== null && before > 0 && savedFeedCount === 0) document.getElementById("confirm-feeds")?.querySelector("button")?.focus()
  }, [savedFeedCount])

  return (
    <div className="flex flex-col gap-4">
      {data.globalPaused && (
        <SectionNote className="flex items-start gap-2 text-[0.8125rem]">
          <CirclePause aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p>{c.paused}</p>
        </SectionNote>
      )}
      {data.verification ? (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="flex items-center gap-1.5 text-sm">
              <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-success-text" />
              {c.verifyRecorded(data.verification.verifiedOn)}
            </p>
            <Button ref={updateRef} variant="outline" size="sm" aria-label={c.verifyUpdateSr} onClick={() => open("update")}>
              {c.verifyUpdate}
            </Button>
          </div>
          <FeedsList feeds={data.feeds} formRef={formRef} />
        </>
      ) : (
        <>
          {/* Unconfirmed: the one step at the top of Set up alerts asks first; no panel and no Record button here. */}
          <p className="text-sm text-muted-foreground">
            <span>{data.feeds.length > 0 ? c.verifyMissingBodyHasFeeds(data.feeds.length) : findJobsCopy.alerts.feedsEmpty}</span>{" "}
            <span>{findJobsCopy.alerts.unconfirmedHint}</span>
          </p>
          {data.feeds.length > 0 && <FeedsList feeds={data.feeds} canAdd={false} />}
        </>
      )}
      <VerifyAlertSourceDialog
        list="stack"
        open={dialog !== "closed"}
        current={dialog === "update" ? data.verification : null}
        onClose={close}
      />
    </div>
  )
}
