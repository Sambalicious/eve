import type { Ref } from "react"
import { CircleX, Clock, Trash2 } from "lucide-react"

import { stackPostsCopy as c, type AlertFeed } from "@/entities/stack-post"
import { Badge } from "@/shared/ui/badge"
import { cn } from "@/shared/lib/utils"
import { Button } from "@/shared/ui/button"
import { feedName } from "../model/feed-name"
import type { FeedList } from "../model/feed-list"
import type { RowPhase } from "../model/use-feed-row-presence"

/**
 * design-spec r1 Motion (N-1): opacity only, DESIGN.md ease-out. A new row
 * fades in over 150ms; a removed row fades out over 120ms and holds at 0
 * until it unmounts. Siblings reflow without animation. Off under reduced
 * motion (the presence hook never sets a phase then; the CSS guard is backup).
 */
const MOTION: Record<RowPhase, string> = {
  present: "",
  entering: "animate-in fade-in duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:animate-none",
  leaving:
    "pointer-events-none animate-out fade-out duration-[120ms] ease-[cubic-bezier(0.25,1,0.5,1)] fill-mode-forwards motion-reduce:animate-none",
}

/** The mask in mono: visible "…654321", read as "feed ending 6 5 4 3 2 1". */
export function MaskedUrl({ maskedUrl }: { maskedUrl: string }) {
  return (
    <span className="font-mono text-[0.78125rem] whitespace-nowrap text-muted-foreground">
      <span aria-hidden="true">{maskedUrl}</span>
      <span className="sr-only">{c.feedEnding(maskedUrl)}</span>
    </span>
  )
}

/**
 * One Alert feed (design-spec B2, F5): name and mask, then a quiet last-read
 * line or the Failing badge with its reason. No edit, reveal or copy-URL
 * control (D-E5-5). Remove is a visible ghost button. A leaving row is inert
 * and hidden from assistive technology while it fades, so focus and the
 * reading order never reach it.
 */
export function FeedRow({
  feed,
  onRemove,
  removeRef,
  phase = "present",
  list = "stack",
}: {
  feed: AlertFeed
  onRemove: () => void
  removeRef?: Ref<HTMLButtonElement>
  phase?: RowPhase
  /** Picks the unlabelled name: "Alert feed" or "Hiring Alert feed". */
  list?: FeedList
}) {
  const name = feedName(feed, list)
  const leaving = phase === "leaving"
  return (
    <li
      aria-label={c.feedRowName(name, feed.maskedUrl)}
      data-motion={phase}
      inert={leaving || undefined}
      aria-hidden={leaving || undefined}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]",
        MOTION[phase]
      )}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-medium [overflow-wrap:anywhere]">{name}</span>
        <MaskedUrl maskedUrl={feed.maskedUrl} />
      </div>
      <div className="col-start-1 row-start-2 flex min-w-0 flex-col gap-1 text-[0.8125rem] text-muted-foreground lg:col-start-2 lg:row-start-1">
        {feed.failure && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant="destructive">
              <CircleX aria-hidden="true" />
              {c.feedFailing}
            </Badge>
            <span className="text-foreground">{c.feedFailReason(feed.failure.reason, feed.failure.at)}</span>
          </p>
        )}
        {feed.lastReadAt && (
          <p className="flex items-center gap-1.5 tabular-nums">
            {!feed.failure && <Clock aria-hidden="true" className="size-3.5 shrink-0" />}
            {c.feedLastRead(feed.lastReadAt)}
          </p>
        )}
      </div>
      <Button
        ref={removeRef}
        variant="ghost"
        size="sm"
        className="col-start-2 row-span-2 row-start-1 lg:col-start-3 lg:row-span-1"
        aria-label={c.feedRemoveSr(name, feed.maskedUrl)}
        onClick={onRemove}
      >
        <Trash2 aria-hidden="true" />
        {c.feedRemove}
      </Button>
    </li>
  )
}
