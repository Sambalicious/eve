import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, FileText, MessageSquare, Rss } from "lucide-react"
import { Fragment } from "react"
import { cn } from "cn"

import { stackPostsCopy as c, type StackPost } from "@/entities/stack-post"
import { Badge } from "@/shared/ui/badge"
import { buttonVariants } from "@/shared/ui/button"
import { ButtonLink } from "@/shared/ui/button-link"
import { postTitle } from "../model/post-title"

const MAX_CHIPS = 4

/** "from React posts", or "from Alert feed …654321" for an unlabelled feed, or "Removed feed". */
function sourceText(source: StackPost["source"], fallbackName: string = c.feedFallbackName): string {
  if (!source) return c.sourceRemoved
  return c.source(source.label ?? `${fallbackName} ${source.maskedUrl}`)
}

/**
 * Stack posts rows (design-spec B3): title link to the canonical LinkedIn URL in
 * a new tab, kind badge, 2-line snippet, then date, matched technologies and
 * source. Title and snippet render as text, never HTML. No link to any Eve
 * action (AC 9.1).
 */
export function StackPostList({ posts }: { posts: readonly StackPost[] }) {
  return (
    <ol className="flex flex-col divide-y border-y">
      {posts.map((post) => (
        <li key={post.id} aria-label={postTitle(post)} className="flex flex-col gap-1 py-3">
          <StackPostRowBody post={post} />
        </li>
      ))}
    </ol>
  )
}

/** Class overrides for the parts of a row, so a list can place them in its own grid. */
export interface RowBodyParts {
  readonly titleRow?: string
  readonly title?: string
  readonly badges?: string
  readonly snippet?: string
  readonly meta?: string
}

/**
 * One row's content: title link, the badge group (kind badge, then `badges`),
 * snippet and meta. Shared by Stack posts and Hiring posts (EPIC-0007
 * design-spec r2 inventory: "adds `badges` and `action` slots to the built row
 * rather than copying it"). `parts` lets Hiring posts place the parts in its
 * row grid (design-review phase 3 B-2).
 *
 * The meta is inline text, not one flex item per part, so date, technologies
 * and source pack onto as few lines as fit (at most 2 at 375px). It keeps the
 * three parts as its three children, each later part opening with its "·"
 * (design-review N-2). The "·" before the chips and the source's "·" and feed
 * icon sit in their part's inline left padding, which stays on the line of the
 * part's first word, so neither ends a line alone. Below 1024px the source's
 * "·" is hidden and its feed icon is the separator, so no line starts with "·".
 */
export function StackPostRowBody({
  post,
  badges,
  feedFallbackName,
  parts = {},
}: {
  post: StackPost
  badges?: React.ReactNode
  /** The unlabelled source name: "Alert feed" (default) or "Hiring Alert feed". */
  feedFallbackName?: string
  parts?: RowBodyParts
}) {
  const title = postTitle(post)
  const chips = post.matchedTechnologies.slice(0, MAX_CHIPS)
  const more = post.matchedTechnologies.length - chips.length
  return (
    <>
      <div className={cn("flex flex-wrap items-start gap-x-2 gap-y-1", parts.titleRow)}>
        <a
          href={post.canonicalUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${title} ${c.newTab}`}
          dir="auto"
          className={cn(
            "line-clamp-2 min-w-0 text-sm font-medium [overflow-wrap:anywhere] underline-offset-4 hover:underline",
            !post.title && "text-muted-foreground",
            parts.title
          )}
        >
          {title}
          <ExternalLink aria-hidden="true" className="ml-1 inline size-3.5 align-[-0.125em] text-muted-foreground" />
        </a>
        <span data-slot="row-badges" className={cn("inline-flex flex-wrap items-center gap-2", parts.badges)}>
          <Badge variant="outline">
            {post.kind === "post" ? <MessageSquare aria-hidden="true" /> : <FileText aria-hidden="true" />}
            {c.kind[post.kind]}
          </Badge>
          {badges}
        </span>
      </div>
      {post.snippet && (
        <p
          dir="auto"
          className={cn("line-clamp-2 max-w-[80ch] text-[0.8125rem] text-muted-foreground [overflow-wrap:anywhere]", parts.snippet)}
        >
          {post.snippet}
        </p>
      )}
      <p data-slot="row-meta" className={cn("text-[0.78125rem] leading-6 text-muted-foreground", parts.meta)}>
        <span className="whitespace-nowrap tabular-nums">
          <CalendarDays aria-hidden="true" className="mr-1 inline size-3.5 align-[-0.1875em]" />
          {post.dateKind === "found" ? c.found(post.date) : c.posted(post.date)}
        </span>{" "}
        {chips.length > 0 ? (
          <span className="relative pl-3">
            <Separator className="absolute top-0 left-0 leading-4" />
            <span className="sr-only">{c.techSr}</span>
            {chips.map((tech, i) => (
              <Fragment key={tech}>
                {i > 0 && " "}
                <Badge variant="secondary" className="max-w-full align-middle">
                  <span className="truncate">{tech}</span>
                </Badge>
              </Fragment>
            ))}
            {more > 0 && (
              <>
                {" "}
                <Badge variant="secondary" className="align-middle">
                  <span aria-hidden="true">{c.techMore(more)}</span>
                  <span className="sr-only">{c.techMoreSr(more)}</span>
                </Badge>
              </>
            )}
          </span>
        ) : (
          <span>
            <Separator />
            {c.noTech}
          </span>
        )}{" "}
        <span className="relative pl-[1.125rem] [overflow-wrap:anywhere] lg:pl-[1.875rem]">
          <Separator className="absolute top-0 left-0 leading-4 max-lg:hidden" />
          <Rss aria-hidden="true" className="absolute top-px left-0 size-3.5 lg:left-3" />
          {sourceText(post.source, feedFallbackName)}
        </span>
      </p>
    </>
  )
}

/** The "·" between meta parts. It is glued to the part after it, so a wrapped line never ends with it (design-review N-2). */
function Separator({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("mr-1.5", className)}>
      ·
    </span>
  )
}

/**
 * Previous / status / Next (design-spec B3). Both controls always render; the
 * unavailable one is `aria-disabled` and not focusable as a link. Pages are
 * real `?page=n` links, so Back and middle-click work.
 */
export function StackPostPagination({
  page,
  totalPages,
  navLabel = c.pageNavSr,
  pageHref = (n) => `?page=${n}`,
}: {
  page: number
  totalPages: number
  /** The `nav` name: "Posts pages" (default) or "Hiring posts pages". */
  navLabel?: string
  /** The link for page n; the Hiring view keeps `view=hiring`. */
  pageHref?: (page: number) => string
}) {
  const hasPrev = page > 1
  const hasNext = page < totalPages
  return (
    <nav aria-label={navLabel} className="flex flex-col gap-2 pt-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-[0.8125rem] text-muted-foreground tabular-nums">{c.pageStatus(page, totalPages)}</p>
      <div className="flex justify-between gap-2 sm:justify-end">
        <PageLink to={hasPrev ? pageHref(page - 1) : null}>
          <ChevronLeft aria-hidden="true" />
          {c.pagePrev}
        </PageLink>
        <PageLink to={hasNext ? pageHref(page + 1) : null}>
          {c.pageNext}
          <ChevronRight aria-hidden="true" />
        </PageLink>
      </div>
    </nav>
  )
}

function PageLink({ to, children }: { to: string | null; children: React.ReactNode }) {
  if (to === null) {
    return (
      <a role="link" aria-disabled="true" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "pointer-events-none opacity-50")}>
        {children}
      </a>
    )
  }
  // ButtonLink merges the variant through cn(), so the outline border wins over the base border-transparent (DR-E5-01).
  return (
    <ButtonLink to={to} variant="outline" size="sm">
      {children}
    </ButtonLink>
  )
}
