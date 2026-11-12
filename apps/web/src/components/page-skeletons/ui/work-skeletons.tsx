import { Card, CardContent, CardFooter, CardHeader } from "@/shared/ui/card"
import {
  Skeleton,
  SkeletonBadge,
  SkeletonButton,
  SkeletonSection,
  SkeletonText,
} from "@/shared/ui/skeleton"

const DETAIL_H1 = "font-display text-[1.75rem] leading-[1.15] md:text-[2rem]"

/** Table header cell: TableHead's 36px row with its label size. */
function HeadCell({ width, className }: { width: string; className?: string }) {
  return (
    <div className={className}>
      <SkeletonText className="text-[0.78125rem]" widths={[width]} />
    </div>
  )
}

/** A table on md and up and a stacked list below, as the loaded lists render. */
function ResponsiveRows({
  rows,
  head,
  row,
  card,
}: {
  rows: number
  head: React.ReactNode
  row: (i: number) => React.ReactNode
  card: (i: number) => React.ReactNode
}) {
  return (
    <>
      <div className="hidden text-sm md:block">
        <div className="flex h-9 items-center gap-6 border-b">{head}</div>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-start gap-6 border-b py-3 last:border-0">
            {row(i)}
          </div>
        ))}
      </div>
      <ul className="flex flex-col divide-y md:hidden">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex flex-col gap-2 py-4">
            {card(i)}
          </li>
        ))}
      </ul>
    </>
  )
}

const nameWidth = (i: number) => (["w-72", "w-60", "w-80", "w-64", "w-56", "w-72"][i % 6] ?? "w-64") + " max-w-full"

/** Job Postings list (the ranked tab's table) below the tabs. */
export function PostingsListSkeleton() {
  return (
    <div aria-hidden="true">
      <ResponsiveRows
        rows={6}
        head={
          <>
            <HeadCell className="w-12" width="w-8" />
            <HeadCell className="min-w-56 flex-1" width="w-8" />
            <HeadCell className="hidden w-32 lg:block" width="w-20" />
            <HeadCell className="w-40" width="w-16" />
            <HeadCell className="w-16" width="w-10" />
            <HeadCell className="hidden w-32 lg:block" width="w-28" />
            <HeadCell className="w-48" width="w-10" />
          </>
        }
        row={(i) => (
          <>
            <SkeletonText className="w-12" widths={["w-4"]} />
            <div className="flex min-w-56 flex-1 flex-col gap-0.5">
              <SkeletonText widths={[nameWidth(i)]} />
              <SkeletonText className="text-xs" widths={["w-24"]} />
            </div>
            <SkeletonText className="hidden w-32 lg:flex" widths={["w-24"]} />
            <div className="w-40">
              {i % 3 === 1 ? <SkeletonBadge className="w-32" /> : <SkeletonText className="text-sm" widths={["w-20"]} />}
            </div>
            <SkeletonText className="w-16" widths={["w-12"]} />
            <SkeletonText className="hidden w-32 lg:flex" widths={["w-20"]} />
            <div className="w-48" />
          </>
        )}
        card={(i) => (
          <>
            <div className="flex items-start gap-3">
              <SkeletonText className="w-auto text-sm" widths={["w-3"]} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <SkeletonText widths={[nameWidth(i)]} />
                <SkeletonText className="text-xs" widths={["w-24"]} />
              </div>
            </div>
            <SkeletonText className="text-sm" widths={["w-24"]} />
            <SkeletonText className="text-sm" widths={["w-28"]} />
          </>
        )}
      />
    </div>
  )
}

/** "Add a job link" and the three line tabs above the list, for the first load. */
export function PostingsSkeleton() {
  return (
    <div className="flex w-full max-w-[1120px] flex-col gap-4 px-4 lg:px-6" aria-hidden="true">
      <SkeletonSection titleWidth="w-28" className="mb-6">
        <div className="flex max-w-xl flex-col gap-1.5">
          <Skeleton className="h-10 w-full rounded-lg pointer-coarse:h-12" />
          <SkeletonText className="text-sm leading-normal" widths={["w-full", "w-1/2"]} />
        </div>
      </SkeletonSection>
      <div className="flex gap-5 border-b">
        {["w-14", "w-36", "w-6"].map((width, i) => (
          <SkeletonText key={i} className="w-auto pb-2.5 text-sm" widths={[width]} />
        ))}
      </div>
      <PostingsListSkeleton />
    </div>
  )
}

/** Documents: one row per Application with two download pairs. */
export function DocumentsListSkeleton() {
  const downloads = (
    <span className="flex gap-3">
      <SkeletonText className="w-auto text-sm" widths={["w-10"]} />
      <SkeletonText className="w-auto text-sm" widths={["w-12"]} />
    </span>
  )
  return (
    <div aria-hidden="true">
      <ResponsiveRows
        rows={4}
        head={
          <>
            <HeadCell className="min-w-56 flex-1" width="w-20" />
            <HeadCell className="w-32" width="w-12" />
            <HeadCell className="w-32" width="w-20" />
            <HeadCell className="w-36" width="w-28" />
          </>
        }
        row={(i) => (
          <>
            <div className="flex min-w-56 flex-1 flex-col gap-0.5">
              <SkeletonText widths={[nameWidth(i)]} />
              <SkeletonText className="text-[13px]" widths={["w-20"]} />
            </div>
            <div className="w-32">{downloads}</div>
            <div className="w-32">{downloads}</div>
            <SkeletonText className="w-36" widths={["w-20"]} />
          </>
        )}
        card={(i) => (
          <>
            <div className="flex flex-col gap-0.5">
              <SkeletonText widths={[nameWidth(i)]} />
              <SkeletonText className="text-[13px]" widths={["w-20"]} />
            </div>
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 pt-1 text-sm">
              <SkeletonText widths={["w-14"]} />
              {downloads}
              <SkeletonText widths={["w-20"]} />
              {downloads}
            </div>
          </>
        )}
      />
    </div>
  )
}

/** Breadcrumb with its link and a placeholder current page. */
export function BreadcrumbSkeleton({ parentWidth = "w-24" }: { parentWidth?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-sm" aria-hidden="true">
      <SkeletonText className="w-auto" widths={[parentWidth]} />
      <SkeletonText className="w-auto" widths={["w-2"]} />
      <SkeletonText className="w-auto" widths={["w-48"]} />
    </div>
  )
}

function FactsSkeleton({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex min-w-0 flex-col gap-0.5">
          <SkeletonText className="text-xs" widths={["w-24"]} />
          <SkeletonText widths={[i === 1 ? "w-20" : "w-28"]} />
        </div>
      ))}
    </div>
  )
}

/** Eligibility section: five rule rows with result badge and quote. */
function EligibilitySkeleton() {
  return (
    <SkeletonSection titleWidth="w-20">
      <ul className="@container flex flex-col divide-y">
        {Array.from({ length: 5 }, (_, i) => (
          <li
            key={i}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 py-3.5 first:pt-0 last:pb-0 @lg:grid-cols-[9rem_minmax(0,1fr)_auto] @lg:items-start @lg:gap-x-5"
          >
            <SkeletonText className="col-start-1 row-start-1 text-sm" widths={["w-20"]} />
            <span className="col-start-2 row-start-1 justify-self-end @lg:col-start-3">
              <SkeletonBadge className="w-14" />
            </span>
            <SkeletonText
              className="col-span-2 col-start-1 row-start-2 max-w-[72ch] text-sm leading-snug @lg:col-span-1 @lg:col-start-2 @lg:row-start-1"
              widths={i % 2 ? ["w-3/4"] : ["w-full", "w-1/3"]}
            />
          </li>
        ))}
      </ul>
    </SkeletonSection>
  )
}

/** Match section: verdict badge, coverage, threshold help and the core responsibilities. */
function MatchSkeleton() {
  return (
    <SkeletonSection titleWidth="w-14">
      <div className="mb-6 flex flex-col items-start gap-1.5">
        <SkeletonBadge className="w-36" />
        <SkeletonText className="text-sm" widths={["w-96 max-w-full"]} />
        <SkeletonText className="max-w-[72ch] text-xs" widths={["w-full", "w-1/2"]} />
      </div>
      <div className="flex flex-col gap-2 border-t pt-4">
        <SkeletonText className="text-xs" widths={["w-36"]} />
        <ul className="flex flex-col gap-3.5">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="flex min-w-0 flex-col items-start gap-1">
              <SkeletonText className="text-sm" widths={[i === 1 ? "w-2/3" : "w-4/5"]} />
              <SkeletonText className="text-sm" widths={["w-3/5"]} />
            </li>
          ))}
        </ul>
      </div>
    </SkeletonSection>
  )
}

/** Job Posting detail below the breadcrumb: header, facts, Eligibility and Match, posting text. */
export function PostingDetailSkeleton() {
  return (
    <div className="contents" aria-hidden="true">
      <div className="flex flex-col gap-5 border-b pb-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <SkeletonText className={DETAIL_H1} widths={["w-3/4"]} />
            <SkeletonText className="text-sm" widths={["w-36"]} />
          </div>
          <SkeletonButton className="w-full sm:w-40" />
        </div>
        <FactsSkeleton count={4} />
      </div>
      <div className="grid gap-x-12 gap-y-7 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-7 xl:col-span-8">
          <EligibilitySkeleton />
          <MatchSkeleton />
        </div>
        <div className="min-w-0 border-t pt-7 xl:col-span-4 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-8">
          <SkeletonSection titleWidth="w-16">
            <SkeletonText
              className="max-w-[72ch] text-sm"
              widths={["w-full", "w-11/12", "w-full", "w-4/5", "w-full", "w-10/12", "w-full", "w-2/3"]}
            />
          </SkeletonSection>
        </div>
      </div>
    </div>
  )
}

/** Documents viewer: line tabs, download buttons and the PDF preview. */
function DocumentsViewerSkeleton() {
  return (
    <SkeletonSection titleWidth="w-24">
      <div className="flex flex-col gap-2">
        <div className="flex gap-5 border-b">
          <SkeletonText className="w-auto pb-2.5 text-sm" widths={["w-14"]} />
          <SkeletonText className="w-auto pb-2.5 text-sm" widths={["w-20"]} />
        </div>
        <div className="flex flex-col gap-3 pt-3">
          <div className="flex flex-wrap gap-2">
            <SkeletonButton className="w-32" />
            <SkeletonButton className="w-36" />
          </div>
          <Skeleton className="h-[70vh] w-full rounded-xl" />
        </div>
      </div>
    </SkeletonSection>
  )
}

/** Application detail below the breadcrumb: header, Documents viewer, Eligibility and Match. */
export function ApplicationDetailSkeleton() {
  return (
    <div className="contents" aria-hidden="true">
      <div className="flex flex-col gap-4 border-b pb-6">
        <SkeletonText className={DETAIL_H1} widths={["w-3/4"]} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          <SkeletonBadge className="w-28" />
          <SkeletonText className="w-auto" widths={["w-36"]} />
          <SkeletonText className="w-auto" widths={["w-32"]} />
          <SkeletonText className="w-auto" widths={["w-32"]} />
        </div>
        <FactsSkeleton count={2} />
      </div>
      <div className="grid gap-x-12 gap-y-7 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-7 xl:col-span-7">
          <DocumentsViewerSkeleton />
        </div>
        <div className="flex min-w-0 flex-col gap-7 border-t pt-7 xl:col-span-5 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-8">
          <EligibilitySkeleton />
          <MatchSkeleton />
        </div>
      </div>
    </div>
  )
}

/** Sample review below the breadcrumb: header, action bar, documents, form answers, Eligibility and Match. */
export function SampleReviewSkeleton() {
  return (
    <div className="contents" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <SkeletonText className="text-2xl" widths={["w-2/3"]} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <SkeletonBadge className="w-28" />
          <SkeletonText className="w-auto" widths={["w-36"]} />
          <SkeletonText className="w-auto" widths={["w-32"]} />
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:max-w-xl">
          <SkeletonText widths={["w-24"]} />
          <SkeletonText widths={["w-20"]} />
          <SkeletonText widths={["w-32"]} />
          <SkeletonText widths={["w-20"]} />
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2 md:justify-start">
        <SkeletonButton className="w-16" />
        <SkeletonButton className="w-36" />
      </div>
      <div className="grid gap-4 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-7">
          <DocumentsViewerSkeleton />
          <Card>
            <CardHeader>
              <SkeletonText className="text-lg" widths={["w-32"]} />
              <SkeletonText className="text-sm" widths={["w-full", "w-1/2"]} />
            </CardHeader>
            <CardContent>
              <div className="flex flex-col divide-y text-sm">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="grid gap-1 py-2 md:grid-cols-[2fr_1.5fr_1fr] md:gap-3">
                    <SkeletonText widths={[i % 2 ? "w-3/5" : "w-4/5"]} />
                    <SkeletonText widths={["w-2/3"]} />
                    <SkeletonText widths={["w-1/2"]} />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-5">
          <EligibilitySkeleton />
          <MatchSkeleton />
        </div>
      </div>
    </div>
  )
}

/** Activation Gate's status card. */
export function GateStatusCardSkeleton() {
  return (
    <div className="max-w-2xl" aria-hidden="true">
      <Card>
        <CardHeader>
          <SkeletonText className="text-lg" widths={["w-48"]} />
          <SkeletonText className="text-sm" widths={["w-full", "w-1/2"]} />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-1 w-full rounded-full" />
            <SkeletonText className="text-sm" widths={["w-full", "w-2/3"]} />
          </div>
          <ul className="flex flex-col gap-2 text-sm">
            {["w-44", "w-60", "w-36"].map((width, i) => (
              <li key={i} className="grid grid-cols-[auto_1fr] items-center gap-x-2">
                <Skeleton className="size-4 rounded-full" />
                <SkeletonText widths={[width]} />
              </li>
            ))}
          </ul>
        </CardContent>
        <CardFooter>
          <SkeletonButton className="w-52" />
        </CardFooter>
      </Card>
    </div>
  )
}

/** Activation Gate's three sample tabs and the bordered sample list. */
export function SampleTabsSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <Skeleton className="h-8 w-96 max-w-full rounded-lg" />
      <div className="flex flex-col gap-3 pt-3">
        <ul className="flex flex-col divide-y rounded-xl border">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <SkeletonText widths={[nameWidth(i)]} />
                <SkeletonText className="text-[13px]" widths={["w-20"]} />
                <SkeletonText className="text-sm" widths={["w-24"]} />
                <SkeletonText className="text-sm" widths={["w-96 max-w-full"]} />
              </div>
              <SkeletonButton size="sm" className="w-28" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** A Blocked or Uncertain card: badge line, linked name, requisition ID, detail and footer actions. */
function SubmissionCardSkeleton({ detailLines, actions }: { detailLines: readonly string[]; actions: readonly string[] }) {
  return (
    <Card size="sm">
      <CardHeader className="gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <SkeletonBadge className="w-32" />
          <SkeletonText className="w-auto text-xs" widths={["w-32"]} />
        </div>
        <SkeletonText className="text-base" widths={["w-3/4"]} />
        <SkeletonText className="text-[13px]" widths={["w-20"]} />
      </CardHeader>
      <CardContent>
        <SkeletonText className="text-sm" widths={detailLines} />
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {actions.map((width, i) => (
          <SkeletonButton key={i} size="sm" className={width} />
        ))}
      </CardFooter>
    </Card>
  )
}

/** Blocked Applications: one reason group with two cards. */
export function BlockedSkeleton() {
  return (
    <section className="flex flex-col gap-3" aria-hidden="true">
      <SkeletonText className="text-lg" widths={["w-56"]} />
      <ul className="grid gap-3 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <li key={i} className="min-w-0">
            <SubmissionCardSkeleton detailLines={["w-full", "w-1/2"]} actions={["w-36", "w-36", "w-40"]} />
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Uncertain Submissions: two cards. */
export function UncertainSkeleton() {
  return (
    <ul className="grid gap-3 lg:grid-cols-2" aria-hidden="true">
      {[0, 1].map((i) => (
        <li key={i} className="min-w-0">
          <SubmissionCardSkeleton detailLines={["w-full", "w-full", "w-1/3"]} actions={["w-36", "w-28", "w-36"]} />
        </li>
      ))}
    </ul>
  )
}
