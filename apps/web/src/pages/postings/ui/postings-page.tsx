import { useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { BriefcaseBusiness, CircleAlert, Clock, EyeOff, ListChecks, SearchX, UserRound } from "lucide-react"
import { Link } from "react-router-dom"
import { useScrollToHash } from "@/shared/lib/use-scroll-to-hash"
import { cn } from "cn"

import { AppShell } from "@/components/app-shell"
import { PostingsListSkeleton } from "@/components/page-skeletons"
import { PostingList } from "@/components/posting-list"
import {
  hiddenCountsLine,
  jobPostingCopy,
  postingsCopy,
  relevanceCopy,
  waitingNoticeText,
  type HiddenCounts,
  type WaitingReason,
} from "@/entities/job-posting"
import { CheckAgainPanel, useCheckAgain } from "@/features/check-again"
import { FilterBar, POSTINGS_TABS, postingsSearch, type PostingsWebTab } from "@/features/filter-postings"
import { hasExcludedFamily, preferencesQueryOptions } from "@/entities/job-preferences"
import { AddJobLink } from "@/features/paste-job-link"
import { useOverflowEnd } from "@/shared/lib/use-overflow-end"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { Button } from "@/shared/ui/button"
import { ButtonLink } from "@/shared/ui/button-link"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { Alert, AlertTitle } from "@/shared/ui/alert"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { QuietEmpty } from "@/shared/ui/section"
import { SkeletonText } from "@/shared/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs"
import { usePostingsView } from "../model/use-postings-view"

/**
 * Job Postings (`/postings`): Add a job link, the Good matches / Not a match /
 * All tabs (EPIC-0002 B1, AC-4.5), the filter bar, the count line and the paged list with
 * Load more. Tab and filter live in the URL; loaded pages don't.
 */
export function PostingsPage() {
  useDocumentTitle(jobPostingCopy.pageTitle)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const excludedListRef = useRef<HTMLDivElement>(null)
  const view = usePostingsView({ listRef, searchRef })
  const { tab, page } = view
  // Not a match stacks two existing list queries: `skipped`, then `excluded_family` (AC-4.5, no API change).
  const isNotMatch = view.webTab === "not_a_match"
  const excluded = usePostingsView({ listRef: excludedListRef, searchRef, apiTab: "excluded_family", enabled: isNotMatch })
  const excludedShown = isNotMatch && excluded.rows.length > 0
  useScrollToHash(excludedShown)
  const { content } = view
  const isFilterEmpty = content === "filterEmpty"
  const checkAgain = useCheckAgain({ onAnnounce: view.announce })
  const tabListRef = useRef<HTMLDivElement>(null)
  useOverflowEnd(tabListRef)
  // F18a steps 6 and 7: the excluded-families empty state and the All hint read the saved tiers, not the postings page.
  const preferences = useQuery(preferencesQueryOptions())
  const anyExcluded = preferences.data ? hasExcludedFamily(preferences.data.values) : false

  return (
    <AppShell title={jobPostingCopy.pageTitle} description={jobPostingCopy.pageDescription}>
      <div className="flex w-full max-w-[1120px] flex-col gap-4 px-4 lg:px-6">
        <AddJobLink className="mb-6" />
        {/* recheckableCount ignores tab, filter and cursor: the same panel on every tab (P13). */}
        {page && page.recheckableCount > 0 && (
          <CheckAgainPanel
            count={page.recheckableCount}
            open={checkAgain.open}
            alert={checkAgain.alert}
            isPending={checkAgain.isPending}
            onOpen={checkAgain.openDialog}
            onOpenChange={checkAgain.onOpenChange}
            onConfirm={checkAgain.confirm}
            movedRows={checkAgain.movedRows}
            activeTab={() => tabListRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null}
          />
        )}
        <Tabs value={view.webTab} onValueChange={(next) => view.setTab(String(next) as PostingsWebTab)}>
          <TabsList
            ref={tabListRef}
            variant="line"
            // DP-B1-07: fade the end edge while tabs remain off screen, so "All" never looks cut.
            className="w-full max-w-full justify-start overflow-x-auto data-[overflow-end]:[mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)]"
          >
            {POSTINGS_TABS.map((value) => (
              <TabsTrigger key={value} value={value}>
                {jobPostingCopy.tabs[value]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <FilterBar
          filter={view.filter}
          families={view.targetRoleFamilies}
          onChange={view.setFilter}
          showClear={!isFilterEmpty}
          searchRef={searchRef}
        />
        <section aria-label={jobPostingCopy.tabs[view.webTab]} aria-busy={view.isFetching}>
          {view.isError ? (
            <LoadErrorAlert
              onRetry={view.retry}
              title={postingsCopy.loadError.alert}
              retryLabel={postingsCopy.loadError.retry}
            />
          ) : page && content ? (
            <div className="flex flex-col gap-4">
              {tab === "ranked" && page.waitingToBeCheckedCount > 0 && (
                <WaitingNotice count={page.waitingToBeCheckedCount} reason={page.waitingReason ?? "cost_pause"} />
              )}
              {content === "list" ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1 text-[0.8125rem] leading-[1.45] text-muted-foreground tabular-nums">
                    <p>{view.countLine}</p>
                    {tab === "ranked" && view.isFiltered && <p>{postingsCopy.rankHint.filtered}</p>}
                    <HiddenCountsLine counts={page.hiddenCounts} withLink />
                    {tab === "all" && anyExcluded && <AllExcludedHint search={postingsSearch({ tab: "not_a_match", filter: view.filter })} />}
                  </div>
                  {excludedShown && <h2 className="text-sm font-semibold">{jobPostingCopy.notMatchSections.rules}</h2>}
                  <div
                    ref={listRef}
                    className={cn(
                      "flex flex-col gap-4 transition-opacity duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
                      view.isPlaceholder && "opacity-60 delay-150"
                    )}
                  >
                    <PostingList postings={view.rows} showRank={tab === "ranked"} />
                    {view.loadMore.isShown && <LoadMore {...view.loadMore} />}
                  </div>
                </div>
              ) : (
                // design-spec r2 B2. While a new view loads, the last settled empty state
                // stays, dimmed like the rows (finding-r3-empty-flash).
                <div
                  className={cn(
                    "flex flex-col gap-3 transition-opacity duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
                    view.isStale && "opacity-60 delay-150"
                  )}
                >
                  {/* design-spec.r1 B3/B4: the line sits alone above the empty state; the all-hidden state carries the one link. */}
                  <HiddenCountsLine
                    counts={page.hiddenCounts}
                    withLink={content !== "allHidden"}
                    className="text-[0.8125rem] leading-[1.45] text-muted-foreground tabular-nums"
                  />
                  {/* Not a match: when the excluded-family section below holds rows, this list's own empty state would contradict it. */}
                  {excludedShown ? null : content === "filterEmpty" ? (
                    <FilterEmpty onClear={view.clearFilters} />
                  ) : content === "allHidden" ? (
                    <AllHiddenEmpty undated={page.hiddenCounts.undated > 0} />
                  ) : content === "criteriaEmpty" ? (
                    <CriteriaEmptyState />
                  ) : content === "skippedEmpty" ? (
                    <QuietEmpty icon={<ListChecks />} title={jobPostingCopy.emptySkipped.title} description={jobPostingCopy.emptySkipped.text} />
                  ) : content === "manualEmpty" ? (
                    <QuietEmpty icon={<UserRound />} title={jobPostingCopy.emptyManual.title} description={jobPostingCopy.emptyManual.text} />
                  ) : content === "excludedEmpty" ? (
                    <ExcludedFamiliesEmpty anyExcluded={anyExcluded} />
                  ) : (
                    <EmptyState first={content === "firstRun"} />
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <SkeletonText className="text-[0.8125rem] leading-[1.45]" widths={["w-40"]} />
              <PostingsListSkeleton />
            </div>
          )}
        </section>
        {excludedShown && (
          <section id="excluded-families" aria-labelledby="excluded-families-heading" className="flex scroll-mt-20 flex-col gap-3">
            <h2 id="excluded-families-heading" className="text-sm font-semibold">
              {jobPostingCopy.notMatchSections.families}
            </h2>
            <div ref={excludedListRef} className="flex flex-col gap-4">
              <PostingList postings={excluded.rows} showRank={false} />
              {excluded.loadMore.isShown && <LoadMore {...excluded.loadMore} />}
            </div>
          </section>
        )}
        <p role="status" className="sr-only">
          {view.status}
        </p>
      </div>
    </AppShell>
  )
}

/**
 * EPIC-0006 `postings.waitingNotice.*`: the text follows `waitingReason` (cost pause for the
 * Operator, checks not enabled for everyone else). Ignores the filter, and its link drops it.
 * A calm, persistent fact: a polite status, not an alert (design r3, 8d.24).
 */
function WaitingNotice({ count, reason }: { count: number; reason: WaitingReason }) {
  return (
    <Alert role="status">
      <Clock aria-hidden="true" />
      <AlertTitle className="font-normal">
        {waitingNoticeText(reason, count)}{" "}
        <Link to="/postings?tab=all" className="underline underline-offset-4">
          {relevanceCopy.postings.waitingNotice.link}
        </Link>
      </AlertTitle>
    </Alert>
  )
}

/**
 * EPIC-0006 B3 `postings.hidden.*`: hidden total and each non-zero reason, then
 * "Change job criteria". A plain paragraph, not a live region. Absent at zero.
 */
function HiddenCountsLine({ counts, withLink, className }: { counts: HiddenCounts; withLink: boolean; className?: string }) {
  const line = hiddenCountsLine(counts)
  if (line === null) return null
  return (
    <p className={cn("flex items-start gap-1.5", className)}>
      <EyeOff aria-hidden="true" className="mt-[0.2em] size-3.5 shrink-0" />
      <span>
        {line}
        {withLink && (
          <>
            {" "}
            <Link to={jobPostingCopy.criteria.settingsHref} className="text-foreground underline underline-offset-4">
              {relevanceCopy.postings.hidden.link}
            </Link>
          </>
        )}
      </span>
    </p>
  )
}

/** EPIC-0006 B4 `postings.allHidden.*`: Eve holds postings but every one is hidden. */
function AllHiddenEmpty({ undated }: { undated: boolean }) {
  const copy = relevanceCopy.postings.allHidden
  return (
    <QuietEmpty
      icon={<EyeOff />}
      title={copy.title}
      description={undated ? copy.bodyUndated : copy.body}
      action={
        <ButtonLink to={jobPostingCopy.criteria.settingsHref} variant="outline">
          {copy.action}
        </ButtonLink>
      }
    />
  )
}

/** `postings.allExcludedHint` (F18a step 7): plain muted line, a real link that keeps the filter. */
function AllExcludedHint({ search }: { search: string }) {
  const copy = jobPostingCopy.allExcludedHint
  return (
    <p>
      {copy.before}
      <Link to={`/postings?${search}`} className="text-foreground underline underline-offset-4">
        {copy.link}
      </Link>
      {copy.after}
    </p>
  )
}

/** `postings.excludedEmpty.none` with "Change job preferences", or `.some` with no action (F18a step 6). */
function ExcludedFamiliesEmpty({ anyExcluded }: { anyExcluded: boolean }) {
  const copy = anyExcluded ? jobPostingCopy.emptyExcludedSome : jobPostingCopy.emptyExcludedNone
  return (
    <QuietEmpty
      icon={<EyeOff />}
      title={copy.title}
      description={copy.text}
      action={
        !anyExcluded && (
          <ButtonLink to={jobPostingCopy.prefsHref} variant="ghost">
            {jobPostingCopy.changePrefs}
          </ButtonLink>
        )
      }
    />
  )
}

/** `postings.loadMore.*`. aria-disabled, not disabled, so focus stays on the button while it loads. */
function LoadMore({
  isBusy,
  isLoading,
  hasError,
  onPress,
}: {
  isBusy: boolean
  isLoading: boolean
  hasError: boolean
  onPress: () => void
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      {hasError && !isLoading && (
        <p id="postings-load-more-error" className="flex items-start gap-1.5 text-[0.8125rem] leading-[1.45] text-destructive-text">
          <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
          {postingsCopy.loadMore.error}
        </p>
      )}
      <Button
        variant="outline"
        size="lg"
        className="w-full sm:w-auto sm:min-w-32"
        aria-disabled={isBusy || undefined}
        aria-busy={isLoading || undefined}
        aria-describedby={hasError && !isLoading ? "postings-load-more-error" : undefined}
        onClick={() => {
          if (!isBusy) onPress()
        }}
      >
        {isLoading ? (
          <>
            <ButtonSpinner />
            {postingsCopy.loadMore.busy}
          </>
        ) : hasError ? (
          postingsCopy.loadMore.retry
        ) : (
          postingsCopy.loadMore.idle
        )}
      </Button>
    </div>
  )
}

/** `postings.filterEmpty.*`: a filter is on and nothing matches. Wins over first-run and "Nothing eligible" (8W.11). */
function FilterEmpty({ onClear }: { onClear: () => void }) {
  return (
    <QuietEmpty
      icon={<SearchX />}
      title={postingsCopy.filterEmpty.title}
      description={postingsCopy.filterEmpty.text}
      action={
        <Button variant="outline" onClick={onClear}>
          {postingsCopy.filterEmpty.action}
        </Button>
      }
    />
  )
}

/**
 * AC 6.3: Ranked is empty because of the saved Job criteria (C-JC-EMPTY-*).
 * Outline action: "Check link" stays the page's only primary. A slice 8
 * selection that empties the tab shows FilterEmpty first (AC 6.3, decision D1).
 */
function CriteriaEmptyState() {
  const copy = jobPostingCopy.criteria
  return (
    <QuietEmpty
      icon={<ListChecks />}
      title={copy.emptyTitle}
      description={copy.emptyBody}
      action={
        <ButtonLink to={copy.settingsHref} variant="outline">
          {copy.change}
        </ButtonLink>
      }
    />
  )
}

/**
 * `postings.firstRun.*` when nothing exists yet; `postings.rankedEmpty.*` on
 * the Ranked tab otherwise. OPEN[designer] FE3-5: the Skipped and All
 * tabs have no empty copy, so they reuse C-EMPTY-2.
 */
function EmptyState({ first }: { first: boolean }) {
  const copy = first ? postingsCopy.firstRun : postingsCopy.rankedEmpty
  return (
    <QuietEmpty
      icon={<BriefcaseBusiness />}
      title={copy.title}
      description={copy.text}
      action={first && <ButtonLink to="/find-jobs">{postingsCopy.firstRun.action}</ButtonLink>}
    />
  )
}

