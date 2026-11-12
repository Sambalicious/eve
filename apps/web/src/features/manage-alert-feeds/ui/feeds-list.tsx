import { useRef, useState, type RefObject } from "react"
import { CircleAlert, Info } from "lucide-react"

import { stackPostsCopy as c, type AlertFeed } from "@/entities/stack-post"
import { useReducedMotion } from "@/shared/lib/use-reduced-motion"
import { Alert, AlertTitle } from "@/shared/ui/alert"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { FEED_LIST_COPY, type FeedList } from "../model/feed-list"
import { feedName } from "../model/feed-name"
import { useRemoveFeed } from "../model/use-alert-feed-writes"
import { useFeedRowPresence } from "../model/use-feed-row-presence"
import { FeedRow } from "./feed-row"
import { RegisterFeedForm, type RegisterFeedFormHandle } from "./register-feed-form"

/**
 * "Your feeds" (EPIC-0005 design-spec B2, F5; EPIC-0007 design-spec r2 H6 steps 5
 * to 11): count, change help, rows or the none line, the registration form and
 * the remove confirmation. `list` picks copy and endpoints; `formRef` lets the
 * section focus Feed URL after a first permitted-use save.
 *
 * `canAdd={false}` is the EPIC-0008 read-only variant (design-spec S1 step 5):
 * saved feeds of a Candidate with no Stack posts record, Remove only, with no
 * change help and no form. The section unmounts it after the last removal and
 * moves focus to the Record button.
 */
export function FeedsList({
  feeds,
  list = "stack",
  formRef: outerFormRef,
  canAdd = true,
}: {
  feeds: readonly AlertFeed[]
  list?: FeedList
  formRef?: RefObject<RegisterFeedFormHandle | null>
  canAdd?: boolean
}) {
  const copy = FEED_LIST_COPY[list]
  const [removing, setRemoving] = useState<AlertFeed | null>(null)
  const [removeAlert, setRemoveAlert] = useState<string | null>(null)
  const removeRefs = useRef(new Map<string, HTMLButtonElement>())
  const ownFormRef = useRef<RegisterFeedFormHandle>(null)
  const formRef = outerFormRef ?? ownFormRef
  /** Where the confirm dialog returns focus: the opening Remove button, or after a removal the next control (never the fading row). */
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const { remove, isRemoving } = useRemoveFeed(list)
  const rows = useFeedRowPresence(feeds, useReducedMotion())

  const close = () => {
    setRemoving(null)
    setRemoveAlert(null)
  }

  /**
   * Focus after removal: the next row's Remove, else the previous row's, else
   * the URL input (design-spec F5 step 4). Set before the dialog closes, so the
   * dialog's own focus return goes there and never to the removed row, which
   * stays in the DOM for its 120ms fade (N-1).
   */
  const focusAfterRemoval = (index: number) => {
    const next = feeds[index + 1] ?? feeds[index - 1]
    const target = (next && removeRefs.current.get(next.id)) ?? formRef.current?.urlInput() ?? null
    returnFocusRef.current = target
    requestAnimationFrame(() => target?.focus())
  }

  const confirmRemove = () => {
    if (!removing) return
    const index = feeds.findIndex((feed) => feed.id === removing.id)
    setRemoveAlert(null)
    remove(removing.id, {
      onDone: () => {
        focusAfterRemoval(index)
        close()
      },
      onFailed: (failure) => {
        if (failure.kind === "signed_out") return
        setRemoveAlert(failure.kind === "message" ? failure.message : copy.removeErrNet)
      },
    })
  }

  return (
    <div className="flex flex-col border-t pt-4">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-sm font-semibold">{c.feedsTitle}</h3>
        <span className="text-[0.8125rem] text-muted-foreground tabular-nums">{c.feedsCount(feeds.length)}</span>
      </div>
      {rows.length > 0 ? (
        <>
          {canAdd && (
            <p className="mt-1 flex items-start gap-1.5 text-[0.8125rem] text-muted-foreground">
              <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              {c.feedsChangeHelp}
            </p>
          )}
          <ul aria-label={c.feedsTitle} className="mt-2 flex flex-col divide-y border-y">
            {rows.map(({ item: feed, phase }) => (
              <FeedRow
                key={feed.id}
                feed={feed}
                phase={phase}
                list={list}
                removeRef={(node) => {
                  if (node) removeRefs.current.set(feed.id, node)
                  else removeRefs.current.delete(feed.id)
                }}
                onRemove={() => {
                  setRemoveAlert(null)
                  returnFocusRef.current = removeRefs.current.get(feed.id) ?? null
                  setRemoving(feed)
                }}
              />
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-2 text-[0.8125rem] text-muted-foreground">{copy.feedsNone}</p>
      )}
      {canAdd && <RegisterFeedForm ref={formRef} feedCount={feeds.length} list={list} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && close()}
        title={copy.removeTitle}
        body={removing ? copy.removeBody(feedName(removing, list), removing.maskedUrl) : ""}
        confirmLabel={c.removeConfirm}
        pendingLabel={c.removeConfirm}
        isPending={isRemoving}
        finalFocus={returnFocusRef}
        destructive
        onConfirm={confirmRemove}
        alert={
          removeAlert && (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>{removeAlert}</AlertTitle>
            </Alert>
          )
        }
      />
    </div>
  )
}

