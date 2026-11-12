import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, Clock, Rss, ShieldQuestionMark } from "lucide-react"
import { useLocation, useSearchParams } from "react-router-dom"
import { buildStackSearchGroups, type RoleFamilyValue } from "@eve/contracts"

import { AppShell } from "@/components/app-shell"
import {
  AlertFeedsBodySkeleton,
  PostsBodySkeleton,
  SearchLinksBodySkeleton,
} from "@/components/page-skeletons"
import {
  HiringPostList,
  StackPostList,
  StackPostPagination,
} from "@/components/stack-post-list"
import {
  HIRING_SEARCH_LINKS_SECTION_ID,
  HiringSearchLinksSection,
  SearchLinksSection,
  type HiringSearchLinksState,
} from "@/components/stack-search-links"
import { jobCriteriaQueryOptions } from "@/entities/candidate-settings"
import { jobSourcesQueryOptions } from "@/entities/job-source"
import { useViewer } from "@/entities/viewer"
import { EmployerListCard } from "@/features/approve-employer-list"
import { RemoteBoardsTable } from "@/features/manage-job-source"
import { findJobsCopy } from "@/entities/stack-post"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible"
import {
  alertFeedsQueryOptions,
  hiringAlertFeedsQueryOptions,
  hiringCopy as h,
  hiringHintTermsQueryOptions,
  hiringPostsQueryOptions,
  readPageParam,
  stackPostsCopy as c,
  stackPostsQueryOptions,
  type AlertFeeds,
  type StackPostsPage,
} from "@/entities/stack-post"
import {
  ALERT_FEEDS_SECTION_ID,
  AlertFeedsSection,
  ConfirmFeedsStep,
  HIRING_ALERT_FEEDS_SECTION_ID,
  HiringAlertFeedsSection,
} from "@/features/manage-alert-feeds"
import {
  CHECK_THIS_JOB_SECTION_ID,
  CheckThisJobSection,
} from "@/features/paste-job-link"
import {
  buildHiringSearchGroups,
  hiringFamilies,
  resolveHiringFamily,
  ROLE_FAMILY_HIRING_PHRASES,
} from "@/shared/lib/hiring-contracts"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { useScrollToHash } from "@/shared/lib/use-scroll-to-hash"
import { HelpPopover, HelpPopoverLead } from "@/shared/ui/help-popover"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { QuietEmpty, Section, SectionNote, SectionStack } from "@/shared/ui/section"

/** Section ids. The old ids keep resolving: `#posts` is mapped to `#practitioner-posts` by the `/stack-posts` redirect. */
const FIND_JOBS_IDS = {
  searchLinks: "search-links",
  hiringPosts: "hiring-posts",
  practitionerPosts: "practitioner-posts",
  setUpAlerts: "set-up-alerts",
  jobSources: "job-sources",
} as const

/** The hash targets that live inside the collapsed Set up alerts: opening one of them opens the section. */
const ALERT_HASHES: readonly string[] = [FIND_JOBS_IDS.setUpAlerts, FIND_JOBS_IDS.jobSources, ALERT_FEEDS_SECTION_ID, HIRING_ALERT_FEEDS_SECTION_ID, "employer-list"]

/**
 * Find jobs (`/find-jobs`, R5): search links, Hiring posts, posts from your field, then Set up alerts,
 * collapsed. Every section has its own query, skeleton and load error, so one failing never hides the rest.
 * Hiring posts use `?page`; posts from your field use `?spage`. The Operator also sees the former
 * Job Sources content, last, as "Job boards" (AC-5.2a).
 */
export function FindJobsPage() {
  useDocumentTitle(findJobsCopy.title)
  return (
    <AppShell title={findJobsCopy.title} description={findJobsCopy.description}>
      <div className="flex w-full max-w-[1120px] flex-col px-4 lg:px-6">
        <FindJobsSections />
      </div>
    </AppShell>
  )
}

function FindJobsSections() {
  const links = useHiringSearchLinks()
  const hiringFeeds = useQuery(hiringAlertFeedsQueryOptions())
  const stackFeeds = useQuery(alertFeedsQueryOptions())
  const criteria = useQuery(jobCriteriaQueryOptions())
  const groups = useMemo(
    () => criteria.data && buildStackSearchGroups(criteria.data.frameworks, criteria.data.technologies),
    [criteria.data]
  )
  const { hash } = useLocation()
  const opensAlerts = ALERT_HASHES.includes(decodeURIComponent(hash.slice(1)))
  // A link to something inside Set up alerts opens it. After that the user's own toggle rules, and a later
  // navigation without that hash (paging a list, say) leaves it as it is.
  const [alertsOpen, setAlertsOpen] = useState(opensAlerts)
  const [seenHash, setSeenHash] = useState(opensAlerts ? hash : null)
  if (opensAlerts && seenHash !== hash) {
    setSeenHash(hash)
    setAlertsOpen(true)
  }
  useScrollToHash(hiringFeeds.data !== undefined && stackFeeds.data !== undefined && (!opensAlerts || alertsOpen))
  return (
    <OpenAlertsContext value={() => setAlertsOpen(true)}>
    <SectionStack>
      <HiringHelp />
      <HiringSearchLinksSection
        state={links.state}
        onFamilyChange={links.changeFamily}
        onHintLink={() => focusSection(CHECK_THIS_JOB_SECTION_ID)}
        onFeedsLink={() => {
          setAlertsOpen(true)
          requestAnimationFrame(() => focusSection(HIRING_ALERT_FEEDS_SECTION_ID))
        }}
        loadingBody={<SearchLinksBodySkeleton />}
        errorBody={<LoadErrorAlert onRetry={links.retry} />}
      />
      <SearchLinksSection
        groups={groups}
        content={
          criteria.isError ? <LoadErrorAlert onRetry={() => void criteria.refetch()} /> : <SearchLinksBodySkeleton />
        }
      />
      <CheckThisJobSection hintShown={links.state.kind === "ready"} />
      <HiringPostsSection feeds={hiringFeeds.data} />
      <StackPostsSection feeds={stackFeeds.data} />
      <SetUpAlerts open={alertsOpen} onOpenChange={setAlertsOpen} hiringFeeds={hiringFeeds} stackFeeds={stackFeeds} />
    </SectionStack>
    </OpenAlertsContext>
  )
}

/**
 * Set up alerts (`#set-up-alerts`): collapsed by default. Inside: the Alert feeds and Hiring Alert
 * feeds with their permitted-use step, then, for the Operator only, "Job boards".
 */
function SetUpAlerts({
  open,
  onOpenChange,
  hiringFeeds,
  stackFeeds,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  hiringFeeds: ReturnType<typeof useQuery<AlertFeeds>>
  stackFeeds: ReturnType<typeof useQuery<AlertFeeds>>
}) {
  const { isOperator } = useViewer()
  const pendingLists = [
    ...(stackFeeds.data && stackFeeds.data.verification === null ? (["stack"] as const) : []),
    ...(hiringFeeds.data && hiringFeeds.data.verification === null ? (["hiring"] as const) : []),
  ]
  const panelId = useId()
  const headingId = useId()
  return (
    <section id={FIND_JOBS_IDS.setUpAlerts} aria-labelledby={headingId} className="scroll-mt-20 border-t border-border pt-7">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger
          aria-controls={panelId}
          className="group flex w-full cursor-pointer items-start justify-between gap-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
        >
          <span className="flex min-w-0 flex-col gap-1">
            <h2 id={headingId} tabIndex={-1} className="text-[0.9375rem] leading-snug font-semibold tracking-[-0.01em] outline-none">
              {findJobsCopy.alerts.heading}
            </h2>
            <span className="max-w-[60ch] text-[0.8125rem] leading-relaxed font-normal text-muted-foreground">{findJobsCopy.alerts.description}</span>
          </span>
          <ChevronDown aria-hidden="true" className="mt-1 size-4 shrink-0 transition-transform duration-200 group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <CollapsibleContent id={panelId} className="pt-5">
          <SectionStack>
            <ConfirmFeedsStep
              id="confirm-feeds"
              pending={pendingLists}
              onConfirmed={() => focusWhenReady(() => document.getElementById(ALERT_FEEDS_SECTION_ID)?.querySelector<HTMLInputElement>('input[type="url"], input'))}
            />
            <AlertFeedsSection
              data={stackFeeds.data}
              content={stackFeeds.isError ? <LoadErrorAlert onRetry={() => void stackFeeds.refetch()} /> : <AlertFeedsBodySkeleton />}
            />
            <HiringAlertFeedsSection
              data={hiringFeeds.data}
              content={hiringFeeds.isError ? <LoadErrorAlert onRetry={() => void hiringFeeds.refetch()} /> : <AlertFeedsBodySkeleton />}
            />
            {isOperator && <JobBoards />}
          </SectionStack>
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}

/** The former Job Sources content, Operator only: the employer list and the remote boards, under one plain line. */
function JobBoards() {
  const sources = useQuery(jobSourcesQueryOptions())
  const headingId = useId()
  return (
    <section id={FIND_JOBS_IDS.jobSources} aria-labelledby={headingId} className="scroll-mt-20 border-t border-border pt-7">
      <div className="mb-4 flex flex-col gap-1">
        <h3 id={headingId} tabIndex={-1} className="text-[0.9375rem] leading-snug font-semibold tracking-[-0.01em] outline-none">
          {findJobsCopy.boards.heading}
        </h3>
        <p className="text-[0.8125rem] text-muted-foreground">{findJobsCopy.boards.description}</p>
      </div>
      {sources.isError ? (
        <LoadErrorAlert onRetry={() => void sources.refetch()} />
      ) : sources.data ? (
        <div className="flex flex-col gap-7">
          <EmployerListCard list={sources.data.employerList} />
          <RemoteBoardsTable boards={sources.data.remoteBoards} />
        </div>
      ) : (
        <SearchLinksBodySkeleton />
      )}
    </section>
  )
}

/**
 * Hiring posts (`#hiring-posts`, design-spec r2 B4, H7): 50 rows per page from
 * `?page=` (history push links that keep `view=hiring`), the pagination
 * status from `totalCount` and `totalPages`, and exactly one empty state chosen
 * from the session Candidate's own Hiring feeds response (AC 7.5).
 */
function HiringPostsSection({ feeds }: { feeds: AlertFeeds | undefined }) {
  const [params, setParams] = useSearchParams()
  const rawPage = params.get("page")
  const page = readPageParam(rawPage)
  const posts = useQuery(hiringPostsQueryOptions(page))
  useCorrectedPage(rawPage, page, posts.isPlaceholderData ? undefined : posts.data?.totalPages, setParams)
  return (
    <PostsSection
      id="hiring-posts"
      title={h.postsTitle}
      description={h.postsDesc}
      page={page}
      posts={posts.data}
      isError={posts.isError}
      isChangingPage={posts.isPlaceholderData}
      onRetry={() => void posts.refetch()}
      list={(items) => <HiringPostList posts={items} />}
      pagination={(current, totalPages) => (
        <StackPostPagination
          page={current}
          totalPages={totalPages}
          navLabel={h.pageNavSr}
          pageHref={(n) => `?${withPage(params, n).toString()}`}
        />
      )}
      empty={feeds && <HiringPostsEmptyState feeds={feeds} />}
    />
  )
}

/** Exactly one empty state, in the design's order: not recorded, no feeds, waiting (design-spec r2 H7 step 7). */
function HiringPostsEmptyState({ feeds }: { feeds: AlertFeeds }) {
  // find.hiring.empty: no confirmation yet and no feeds read the same, with one action that opens Set up alerts.
  if (!feeds.verification || feeds.feeds.length === 0) {
    return (
      <QuietEmpty
        icon={<Rss />}
        titleAs="h3"
        title={findJobsCopy.hiring.empty}
        action={
          <SectionLink target={FIND_JOBS_IDS.setUpAlerts} inAlerts>
            {findJobsCopy.alerts.action}
          </SectionLink>
        }
      />
    )
  }
  return (
    <QuietEmpty
      icon={<Clock />}
      titleAs="h3"
      title={h.postsEmptyWaitingTitle}
      description={h.postsEmptyWaitingBody}
    />
  )
}

/** An in-page link that scrolls to a section and focuses its heading, without touching the URL (`?view=hiring` stays). */
/** Opens Set up alerts, for links whose target is inside it. */
const OpenAlertsContext = createContext<() => void>(() => undefined)

function SectionLink({ target, children, inAlerts = false }: { target: string; children: ReactNode; inAlerts?: boolean }) {
  const openAlerts = useContext(OpenAlertsContext)
  const before = inAlerts ? openAlerts : undefined
  return (
    <a
      href={`#${target}`}
      onClick={(event) => {
        event.preventDefault()
        before?.()
        // A closed Set up alerts mounts its content on the next frame.
        if (before) requestAnimationFrame(() => focusSection(target))
        else focusSection(target)
      }}
      className="text-sm font-medium underline underline-offset-4"
    >
      {children}
    </a>
  )
}

/**
 * The Hiring view lead (EPIC-0009 design-spec S3): C-EH-HIRING-LINE and one (i)
 * that explains why Eve can't read LinkedIn and the three ways in. Each "Go to"
 * link closes the popover without returning focus to the trigger, then moves
 * focus to the section heading. The URL is untouched, so `view` and `family`
 * stay. It reads no data and sends nothing.
 */
function HiringHelp() {
  const [open, setOpen] = useState(false)
  const [returnFocus, setReturnFocus] = useState(true)
  const openAlerts = useContext(OpenAlertsContext)
  const why = h.helpWhy

  const changeOpen = (next: boolean) => {
    if (next) setReturnFocus(true)
    setOpen(next)
  }
  const goTo = (sectionId: string) => {
    setReturnFocus(false)
    setOpen(false)
    // The Hiring Alert feeds live in Set up alerts, closed until asked for; its content mounts on the next frame.
    const inAlerts = sectionId === HIRING_ALERT_FEEDS_SECTION_ID
    if (inAlerts) openAlerts()
    requestAnimationFrame(() => (inAlerts ? requestAnimationFrame(() => focusSection(sectionId)) : focusSection(sectionId)))
  }
  const ways = [
    { text: why.links, go: why.linksGo, target: HIRING_SEARCH_LINKS_SECTION_ID },
    { text: why.check, go: why.checkGo, target: CHECK_THIS_JOB_SECTION_ID },
    { text: why.feeds, go: why.feedsGo, target: HIRING_ALERT_FEEDS_SECTION_ID },
  ]

  return (
    <div className="flex max-w-[72ch] items-start gap-1">
      <p className="min-w-0 flex-1 text-[0.8125rem] leading-[1.45] text-pretty text-muted-foreground">{h.helpLine}</p>
      <HelpPopover
        triggerLabel={why.triggerSr}
        title={why.title}
        open={open}
        onOpenChange={changeOpen}
        finalFocus={returnFocus}
      >
        <p>{why.reason}</p>
        <HelpPopoverLead>{why.waysLead}</HelpPopoverLead>
        <ul className="flex list-disc flex-col gap-1.5 pl-4">
          {ways.map((way) => (
            <li key={way.target}>
              {way.text}{" "}
              <a
                href={`#${way.target}`}
                onClick={(event) => {
                  event.preventDefault()
                  goTo(way.target)
                }}
                className="font-medium underline underline-offset-4 pointer-coarse:inline-flex pointer-coarse:min-h-10 pointer-coarse:items-center"
              >
                {way.go}
              </a>
            </li>
          ))}
        </ul>
      </HelpPopover>
    </div>
  )
}

/**
 * Hiring search links data (design-spec r1 H2): Job criteria and the hint
 * terms, each read once per load. The Role family lives in `?family=`
 * (history replace); a change re-renders from loaded data and sends nothing,
 * and the value never reaches the API (AC 2.2).
 */
function useHiringSearchLinks(): {
  state: HiringSearchLinksState
  changeFamily: (family: RoleFamilyValue) => void
  retry: () => void
} {
  const [params, setParams] = useSearchParams()
  const requested = params.get("family")
  const criteria = useQuery(jobCriteriaQueryOptions())
  const targets = criteria.data?.targetRoleFamilies
  const family = targets ? resolveHiringFamily(targets, requested) : null
  // The no-family empty state reads nothing more (design-spec r1 H2, AC 3.7).
  const hints = useQuery({
    ...hiringHintTermsQueryOptions(),
    enabled: family !== null,
  })

  const state = useMemo((): HiringSearchLinksState => {
    if (criteria.isError) return { kind: "error" }
    if (!criteria.data) return { kind: "loading" }
    if (family === null) return { kind: "no-family" }
    if (hints.isError) return { kind: "error" }
    if (!hints.data) return { kind: "loading" }
    return {
      kind: "ready",
      families: hiringFamilies(criteria.data.targetRoleFamilies),
      family,
      phrases: ROLE_FAMILY_HIRING_PHRASES[family],
      hintTerms: hints.data,
      groups: buildHiringSearchGroups({
        family,
        frameworks: criteria.data.frameworks,
        technologies: criteria.data.technologies,
        hintTerms: hints.data,
      }),
    }
  }, [criteria.data, criteria.isError, family, hints.data, hints.isError])

  const changeFamily = (family: RoleFamilyValue) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.set("family", family)
        return next
      },
      { replace: true }
    )
  const retry = () => {
    if (criteria.isError) void criteria.refetch()
    if (hints.isError) void hints.refetch()
  }
  return { state, changeFamily, retry }
}

/** Focuses the element once it exists: the Alert feeds' form mounts a render after the confirmation saves. */
function focusWhenReady(find: () => HTMLElement | null | undefined, frames = 90) {
  const element = find()
  if (element) return element.focus()
  if (frames > 0) requestAnimationFrame(() => focusWhenReady(find, frames - 1))
}

/** Scroll to a section and focus its heading (C-HP-HINT-LINK, the posts empty-state links; design-spec r2 H2, H7). */
function focusSection(sectionId: string) {
  const section = document.getElementById(sectionId)
  if (!section) return
  section.scrollIntoView?.({ block: "start" })
  const headingId = section.getAttribute("aria-labelledby")
  if (headingId) document.getElementById(headingId)?.focus({ preventScroll: true })
}

/**
 * Posts from your field (`#practitioner-posts`, the former Stack posts): its own page in `?spage=` so it
 * never fights the Hiring posts' `?page=`.
 */
function StackPostsSection({ feeds }: { feeds: AlertFeeds | undefined }) {
  const [params, setParams] = useSearchParams()
  const rawPage = params.get(STACK_PAGE_PARAM)
  const page = readPageParam(rawPage)
  const posts = useQuery(stackPostsQueryOptions(page))
  useCorrectedPage(rawPage, page, posts.isPlaceholderData ? undefined : posts.data?.totalPages, setParams, STACK_PAGE_PARAM)
  return (
    <PostsSection
      id={FIND_JOBS_IDS.practitionerPosts}
      title={findJobsCopy.stack.heading}
      description={findJobsCopy.stack.helper}
      page={page}
      posts={posts.data}
      isError={posts.isError}
      isChangingPage={posts.isPlaceholderData}
      onRetry={() => void posts.refetch()}
      list={(items) => <StackPostList posts={items} />}
      pagination={(current, totalPages) => (
        <StackPostPagination page={current} totalPages={totalPages} pageHref={(n) => `?${withPage(params, n, STACK_PAGE_PARAM).toString()}`} />
      )}
      empty={feeds && <PostsEmptyState feeds={feeds} />}
      note={feeds && feeds.verification === null && <PostsUnverifiedNote />}
    />
  )
}

/** A malformed `?page=` reads as page 1; a page past the last becomes the last page (design-spec F6 step 4, r2 H7 step 6). */
function useCorrectedPage(
  rawPage: string | null,
  page: number,
  totalPages: number | undefined,
  setParams: ReturnType<typeof useSearchParams>[1],
  key = "page"
) {
  useEffect(() => {
    if (rawPage !== null && String(page) !== rawPage) {
      setParams((current) => withPage(current, null, key), { replace: true })
    } else if (totalPages !== undefined && totalPages > 0 && page > totalPages) {
      setParams((current) => withPage(current, totalPages, key), { replace: true })
    }
  }, [page, rawPage, totalPages, setParams, key])
}

const STACK_PAGE_PARAM = "spage"

function withPage(
  current: URLSearchParams,
  page: number | null,
  key = "page"
): URLSearchParams {
  const next = new URLSearchParams(current)
  if (page === null || page === 1) next.delete(key)
  else next.set(key, String(page))
  return next
}

/**
 * A posts section (Stack posts `#posts`, Hiring posts `#hiring-posts`): rows,
 * pagination, or the given empty state. After a page change the new rows
 * replace the old ones, then the view moves to the heading (EPIC-0005 F6 step
 * 3, EPIC-0007 H7 step 6); an open row panel closes with its rows.
 */
function PostsSection({
  id,
  title,
  description,
  page,
  posts,
  isError,
  isChangingPage,
  onRetry,
  list,
  pagination,
  empty,
  note,
}: {
  id: string
  title: string
  description: string
  page: number
  posts: StackPostsPage | undefined
  isError: boolean
  isChangingPage: boolean
  onRetry: () => void
  list: (items: StackPostsPage["items"]) => ReactNode
  pagination: (page: number, totalPages: number) => ReactNode
  empty: ReactNode
  /** Shown above the first row on every page while posts exist (EPIC-0008 C-SP-POSTS-UNVERIFIED-NOTE). */
  note?: ReactNode
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const shownPage = useRef(page)

  // After a page change, the new rows replace the old ones; then the view moves to the Posts heading (design-spec F6 step 3).
  useEffect(() => {
    if (!posts || isChangingPage || posts.page === shownPage.current) return
    shownPage.current = posts.page
    headingRef.current?.scrollIntoView?.({ block: "start" })
    headingRef.current?.focus({ preventScroll: true })
  }, [posts, isChangingPage])

  const hasPosts = posts !== undefined && posts.totalCount > 0
  return (
    <Section
      id={id}
      title={title}
      description={hasPosts ? description : undefined}
      headingProps={{ tabIndex: -1, ref: headingRef }}
      aria-busy={isChangingPage || undefined}
    >
      {isError ? (
        <LoadErrorAlert onRetry={onRetry} />
      ) : !posts ? (
        <PostsBodySkeleton />
      ) : hasPosts ? (
        posts.items.length > 0 && (
          <>
            {note}
            {/* Keyed by page so a page change closes any open row panel. */}
            <div key={posts.page}>{list(posts.items)}</div>
            {posts.totalPages > 1 && pagination(posts.page, posts.totalPages)}
          </>
        )
      ) : (
        (empty ?? null)
      )}
    </Section>
  )
}

/**
 * Above the Stack posts rows while the session Candidate has no record of her
 * own (EPIC-0008 design-spec S3 step 2): the list will not grow until she
 * records, so say so and link to Alert feeds.
 */
function PostsUnverifiedNote() {
  return (
    <SectionNote className="mb-3 flex flex-col items-start gap-1.5 text-[0.8125rem] sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
      <p className="flex items-start gap-2">
        <ShieldQuestionMark aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        {c.postsUnverifiedNote}
      </p>
      <SectionLink target={FIND_JOBS_IDS.setUpAlerts} inAlerts>{findJobsCopy.alerts.action}</SectionLink>
    </SectionNote>
  )
}

/** Exactly one empty state, in the design's order: not recorded, no feeds, waiting (EPIC-0008 design-spec S3 step 3). */
function PostsEmptyState({ feeds }: { feeds: AlertFeeds }) {
  // find.stack.empty, with the same single action.
  if (!feeds.verification || feeds.feeds.length === 0) {
    return (
      <QuietEmpty
        icon={<Rss />}
        titleAs="h3"
        title={findJobsCopy.stackEmpty}
        action={
          <SectionLink target={FIND_JOBS_IDS.setUpAlerts} inAlerts>
            {findJobsCopy.alerts.action}
          </SectionLink>
        }
      />
    )
  }
  return (
    <QuietEmpty
      icon={<Clock />}
      titleAs="h3"
      title={c.postsEmptyWaitingTitle}
      description={c.postsEmptyWaitingBody}
    />
  )
}
