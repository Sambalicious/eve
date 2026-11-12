import { useId, useRef, useState, type KeyboardEvent } from "react"
import { ClipboardCheck, MessageSquareDashed } from "lucide-react"

import { hiringCopy as h, type StackPost } from "@/entities/stack-post"
import { PasteJobLinkForm } from "@/features/paste-job-link"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { SectionNote } from "@/shared/ui/section"
import { postTitle } from "../model/post-title"
import { StackPostRowBody, type RowBodyParts } from "./stack-post-list"

const PANEL_MOTION =
  "animate-in fade-in slide-in-from-top-1 duration-180 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:animate-none"

/**
 * D8 line budget at 375px (design-review phase 3 B-2): below 1024px the badges
 * sit right after the title on its first line instead of wrapping under it; a
 * long title shrinks and wraps beside them, so the title and badges together
 * take at most the title's 2 clamped lines. The meta is clamped to 2 lines
 * (design-spec r3 B-3): its parts stay in order (date, chips, source), so only
 * the end of a long source label is cut; the full label stays in the DOM for
 * screen readers. From 1024px the built Stack posts layout applies.
 */
const ROW_PARTS: RowBodyParts = {
  titleRow: "max-lg:flex-nowrap",
  badges: "max-lg:flex-nowrap",
  meta: "max-lg:line-clamp-2",
}

/**
 * Hiring posts rows (EPIC-0007 design-spec r2 B4, H7): the Stack posts row
 * plus the "Not vetted" outline label and a per-row "Check this job" button.
 * From 1024px the button sits in a right column; below that, on its own line.
 * The button opens an inline panel under its row with an empty paste field
 * (never the LinkedIn URL, AC 8.1); only one panel is open at a time, and
 * opening another discards the first one's value. Close or Escape returns
 * focus to the row's button. Nothing here requests the post.
 */
export function HiringPostList({ posts }: { posts: readonly StackPost[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const toggles = useRef(new Map<string, HTMLButtonElement>())

  const close = (id: string) => {
    setOpenId(null)
    requestAnimationFrame(() => toggles.current.get(id)?.focus())
  }

  return (
    <ol className="flex flex-col divide-y border-y">
      {posts.map((post) => (
        <HiringPostRow
          key={post.id}
          post={post}
          open={openId === post.id}
          toggleRef={(node) => {
            if (node) toggles.current.set(post.id, node)
            else toggles.current.delete(post.id)
          }}
          onToggle={() => (openId === post.id ? close(post.id) : setOpenId(post.id))}
          onClose={() => close(post.id)}
        />
      ))}
    </ol>
  )
}

function HiringPostRow({
  post,
  open,
  toggleRef,
  onToggle,
  onClose,
}: {
  post: StackPost
  open: boolean
  toggleRef: (node: HTMLButtonElement | null) => void
  onToggle: () => void
  onClose: () => void
}) {
  const id = useId()
  const panelId = `${id}-panel`
  const helpId = `${id}-help`
  const title = postTitle(post)

  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return
    event.stopPropagation()
    onClose()
  }

  return (
    <li aria-label={title} className="grid grid-cols-1 gap-x-6 gap-y-2 py-3 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col gap-1">
        <StackPostRowBody
          post={post}
          feedFallbackName={h.feedFallbackName}
          parts={ROW_PARTS}
          badges={
            <Badge variant="outline">
              <MessageSquareDashed aria-hidden="true" />
              {h.notVetted}
            </Badge>
          }
        />
      </div>
      <div className="lg:row-start-1 lg:col-start-2">
        <Button
          ref={toggleRef}
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={h.rowCheckSr(title)}
          onClick={onToggle}
        >
          <ClipboardCheck aria-hidden="true" />
          {h.rowCheck}
        </Button>
      </div>
      <div id={panelId} hidden={!open} className="lg:col-span-2" onKeyDown={closeOnEscape}>
        {open && (
          <SectionNote className={`flex flex-col gap-2 ${PANEL_MOTION}`}>
            <p id={helpId} className="text-[0.8125rem] text-muted-foreground">
              {h.rowHelp}
            </p>
            <div className="flex flex-col gap-2 lg:flex-row lg:items-start">
              <div className="min-w-0 flex-1 lg:max-w-xl">
                <PasteJobLinkForm
                  kind="check"
                  label={h.rowUrlLabel(title)}
                  openLabel={h.checkUrlLabel}
                  describedBy={helpId}
                  submitVariant="outline"
                  autoFocus
                />
              </div>
              <Button variant="ghost" size="sm" className="self-end lg:mt-1.5 lg:self-start" onClick={onClose}>
                {h.rowClose}
              </Button>
            </div>
          </SectionNote>
        )}
      </div>
    </li>
  )
}
