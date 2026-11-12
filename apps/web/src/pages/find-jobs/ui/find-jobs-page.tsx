import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Clock, Rss, ShieldQuestionMark } from "lucide-react"
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
import { HelpPopover, HelpPopoverLead } from "@/shared/ui/help-popover"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { QuietEmpty, Section, SectionNote, SectionStack } from "@/shared/ui/section"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs"

/** Section ids. The old ids keep resolving: `#posts` is mapped to `#practitioner-posts` by the `/stack-posts` redirect. */
const FIND_JOBS_IDS = {
  searchLinks: "search-links",
  hiringPosts: "hiring-posts",
  practitionerPosts: "practitioner-posts",
  setUpAlerts: "set-up-alerts",
  jobSources: "job-sources",
} as const

/** The four tabs, grouped by what the Candidate is doing (EPIC-0015 design note section 1); Search is the start. */
const FIND_JOBS_TABS = {
  search: "search",
  hiringPosts: "hiring-posts",
  practitionerPosts: "practitioner-posts",
  setUpAlerts: "set-up-alerts",
} as const
type FindJobsTab = (typeof FIND_JOBS_TABS)[keyof typeof FIND_JOBS_TABS]

/** Tab labels: one new, three the section headings already in the deck (design note section 7). */
const FIND_JOBS_TAB_LABELS: readonly { value: FindJobsTab; label: string }[] = [
  { value: FIND_JOBS_TABS.search, label: findJobsCopy.searchTab },
  { value: FIND_JOBS_TABS.hiringPosts, label: h.postsTitle },
  { value: FIND_JOBS_TABS.practitionerPosts, label: findJobsCopy.stack.heading },
  { value: FIND_JOBS_TABS.setUpAlerts, label: findJobsCopy.alerts.heading },
]

/** Posts from your field pages in `?spage`; Hiring posts use `?page` (design-spec F6 step 4). */
const STACK_PAGE_PARAM = "spage"

/** Every in-page target and the tab it lives in (design note section 3). */
const TAB_FOR_TARGET: Readonly<Record<string, FindJobsTab | undefined>> = {
  [HIRING_SEARCH_LINKS_SECTION_ID]: FIND_JOBS_TABS.search,
  [CHECK_THIS_JOB_SECTION_ID]: FIND_JOBS_TABS.search,
  [FIND_JOBS_IDS.searchLinks]: FIND_JOBS_TABS.search,
  [FIND_JOBS_IDS.hiringPosts]: FIND_JOBS_TABS.hiringPosts,
  [FIND_JOBS_IDS.practitionerPosts]: FIND_JOBS_TABS.practitionerPosts,
  [FIND_JOBS_IDS.setUpAlerts]: FIND_JOBS_TABS.setUpAlerts,
  "confirm-feeds": FIND_JOBS_TABS.setUpAlerts,
  [ALERT_FEEDS_SECTION_ID]: FIND_JOBS_TABS.setUpAlerts,
  [HIRING_ALERT_FEEDS_SECTION_ID]: FIND_JOBS_TABS.setUpAlerts,
  [FIND_JOBS_IDS.jobSources]: FIND_JOBS_TABS.setUpAlerts,
  "employer-list": FIND_JOBS_TABS.setUpAlerts,
}

/**
 * Find jobs (`/find-jobs`, R5, EPIC-0015): four tabs. Search holds the Hiring search links, Check this job and
 * the Search links; Hiring posts and Posts from your field hold one list each; Set up alerts holds the whole
 * delivery set-up. Every section keeps its own query, skeleton and load error, and every panel stays mounted,
 * so one failure never hides another and no typed draft is lost on a switch.
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
  const tabs = useFindJobsTabs({
    searchSettled: links.state.kind !== "loading",
    alertsSettled:
      (stackFeeds.data !== undefined || stackFeeds.isError) && (hiringFeeds.data !== undefined || hiringFeeds.isError),
  })
  return (
    <GoToSectionContext value={tabs.goTo}>
      <SectionStack>
        <HiringHelp />
        <Tabs value={tabs.tab} onValueChange={(value) => tabs.select(value as FindJobsTab)}>
          {/*
            Four equal cells below 640px (a column cannot grow past its share, so no label is clipped and all
            four stay on screen at 375px); from 640px each tab sizes to its label, on one line, left-aligned.
          */}
          <TabsList
            variant="line"
            aria-label={findJobsCopy.title}
            activateOnFocus
            className="grid w-full grid-cols-4 items-stretch gap-2 sm:flex sm:w-fit sm:items-center"
          >
            {FIND_JOBS_TAB_LABELS.map(({ value, label }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="flex min-w-0 flex-wrap items-center justify-center px-1 text-center whitespace-normal sm:justify-start"
              >
                <span className="min-w-0 text-balance">{label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={FIND_JOBS_TABS.search} keepMounted tabIndex={-1} className="pt-4">
            <SectionStack>
              <HiringSearchLinksSection
                state={links.state}
                onFamilyChange={links.changeFamily}
                onHintLink={() => tabs.goTo(CHECK_THIS_JOB_SECTION_ID)}
                onFeedsLink={() => tabs.goTo(HIRING_ALERT_FEEDS_SECTION_ID)}
                loadingBody={<SearchLinksBodySkeleton />}
                errorBody={<LoadErrorAlert onRetry={links.retry} />}
              />
              <CheckThisJobSection hintShown={links.state.kind === "ready"} />
              <SearchLinksSection
                groups={groups}
                content={
                  criteria.isError ? <LoadErrorAlert onRetry={() => void criteria.refetch()} /> : <SearchLinksBodySkeleton />
                }
              />
            </SectionStack>
          </TabsContent>
          <TabsContent value={FIND_JOBS_TABS.hiringPosts} keepMounted tabIndex={-1} className="pt-4">
            <HiringPostsSection feeds={hiringFeeds.data} />
          </TabsContent>
          <TabsContent value={FIND_JOBS_TABS.practitionerPosts} keepMounted tabIndex={-1} className="pt-4">
            <StackPostsSection feeds={stackFeeds.data} />
          </TabsContent>
          <TabsContent value={FIND_JOBS_TABS.setUpAlerts} keepMounted tabIndex={-1} className="pt-4">
            <SetUpAlerts hiringFeeds={hiringFeeds} stackFeeds={stackFeeds} />
          </TabsContent>
        </Tabs>
      </SectionStack>
    </GoToSectionContext>
  )
}

interface HashTarget {
  tab: FindJobsTab
  target: string
}

/** The selected tab and the deep-link target still waiting for its panel (the hash it arrived with). */
interface Navigation {
  hash: string
  tab: FindJobsTab
  pending: HashTarget | null
}

/** The tab and scroll target a recognised hash names; null for no hash, an unknown target or one that decodes to nothing. */
function tabForHash(hash: string): HashTarget | null {
  const target = decodeTarget(hash)
  const tab = TAB_FOR_TARGET[target]
  return tab === undefined ? null : { tab, target }
}

/** `#a%20b` decoded; a malformed escape counts as no hash rather than throwing. */
function decodeTarget(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1))
  } catch {
    return ""
  }
}

/** The first render's tab: a recognised hash, else `?spage` then `?page` on first load only, else Search. */
function firstTab(initial: HashTarget | null, search: string): FindJobsTab {
  if (initial) return initial.tab
  const params = new URLSearchParams(search)
  if (params.get(STACK_PAGE_PARAM) !== null) return FIND_JOBS_TABS.practitionerPosts
  if (params.get("page") !== null) return FIND_JOBS_TABS.hiringPosts
  return FIND_JOBS_TABS.search
}

/**
 * The selected tab, seeded in the first render so a deep-linked panel is visible before any scroll. A later
 * navigation with a recognised hash selects its tab; one without (paging, `family`, Back to page 1) leaves it
 * alone. Neither a tab click nor an in-page link writes the URL, so neither adds a history entry.
 */
function useFindJobsTabs({ searchSettled, alertsSettled }: { searchSettled: boolean; alertsSettled: boolean }) {
  const { hash, search } = useLocation()
  const initial = tabForHash(hash)
  const [nav, setNav] = useState<Navigation>(() => ({ hash, tab: firstTab(initial, search), pending: initial }))

  // A recognised hash wins, on arrival and on every later navigation that carries one. Deriving it here,
  // during the render of that navigation, keeps the target panel in the same paint. One without a recognised
  // hash (paging, `family`, Back to page 1) leaves the tab alone.
  if (nav.hash !== hash) {
    const next = tabForHash(hash)
    setNav({ hash, tab: next?.tab ?? nav.tab, pending: next })
  }

  const settled =
    nav.tab === FIND_JOBS_TABS.search ? searchSettled : nav.tab === FIND_JOBS_TABS.setUpAlerts ? alertsSettled : true
  const focused = useRef<HashTarget | null>(null)

  // Scroll to the target and focus its heading once its tab is visible (it is, in this commit) and its queries
  // have settled (data or error), so a deep link lands where it says and a failed panel still gets focus.
  useEffect(() => {
    const target = nav.pending
    if (!target || target.tab !== nav.tab || !settled || focused.current === target) return
    focused.current = target
    focusSection(target.target)
  }, [nav, settled])

  const select = useCallback((value: FindJobsTab) => setNav((current) => ({ ...current, tab: value })), [])

  // One helper for every in-page link: select the target's tab, then focus its heading. The URL is untouched.
  // A target already on screen is focused now, as the in-page links always did; a target on another tab is
  // focused once that panel is visible, in the next commit.
  const goTo = useCallback(
    (target: string) => {
      const destination = TAB_FOR_TARGET[target]
      if (destination === undefined || destination === nav.tab) {
        focusSection(target)
        return
      }
      setNav((current) => ({ ...current, tab: destination }))
      // The panel is visible in the next commit; the frame after that, so a closing help popover that restores
      // the page scroll first has finished (HH9-13).
      requestAnimationFrame(() => requestAnimationFrame(() => focusSection(target)))
    },
    [nav.tab]
  )

  return { tab: nav.tab, select, goTo }
}

/**
 * Set up alerts (`#set-up-alerts`): the tab's head, then the Alert feeds and Hiring Alert feeds with their
 * permitted-use step, then, for the Operator only, "Job boards". The tab is the only disclosure.
 */
function SetUpAlerts({
  hiringFeeds,
  stackFeeds,
}: {
  hiringFeeds: ReturnType<typeof useQuery<AlertFeeds>>
  stackFeeds: ReturnType<typeof useQuery<AlertFeeds>>
}) {
  const { isOperator } = useViewer()
  const pendingLists = [
    ...(stackFeeds.data && stackFeeds.data.verification === null ? (["stack"] as const) : []),
    ...(hiringFeeds.data && hiringFeeds.data.verification === null ? (["hiring"] as const) : []),
  ]
  return (
    <Section
      id={FIND_JOBS_IDS.setUpAlerts}
      title={findJobsCopy.alerts.heading}
      description={findJobsCopy.alerts.description}
      headingProps={{ tabIndex: -1 }}
    >
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
    </Section>
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
        action={<SectionLink target={FIND_JOBS_IDS.setUpAlerts}>{findJobsCopy.alerts.action}</SectionLink>}
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

/** The in-page link helper: select the target's tab and focus its heading, without touching the URL. */
const GoToSectionContext = createContext<(target: string) => void>(() => undefined)

function SectionLink({ target, children }: { target: string; children: ReactNode }) {
  const goTo = useContext(GoToSectionContext)
  return (
    <a
      href={`#${target}`}
      onClick={(event) => {
        event.preventDefault()
        goTo(target)
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
 * link closes the popover without returning focus to the trigger, then selects
 * the section's tab and moves focus to its heading. The URL is untouched, so
 * `view` and `family` stay. It reads no data and sends nothing.
 */
function HiringHelp() {
  const [open, setOpen] = useState(false)
  const [returnFocus, setReturnFocus] = useState(true)
  const goToSection = useContext(GoToSectionContext)
  const why = h.helpWhy

  const changeOpen = (next: boolean) => {
    if (next) setReturnFocus(true)
    setOpen(next)
  }
  const goTo = (sectionId: string) => {
    setReturnFocus(false)
    setOpen(false)
    goToSection(sectionId)
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
      <SectionLink target={FIND_JOBS_IDS.setUpAlerts}>{findJobsCopy.alerts.action}</SectionLink>
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
        action={<SectionLink target={FIND_JOBS_IDS.setUpAlerts}>{findJobsCopy.alerts.action}</SectionLink>}
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
