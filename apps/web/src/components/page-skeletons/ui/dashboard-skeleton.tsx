import { Card, CardContent, CardHeader } from "@/shared/ui/card"
import { Skeleton, SkeletonButton, SkeletonSection, SkeletonText } from "@/shared/ui/skeleton"

/** The setup checklist (4 rows, first-run state) while its reads load. */
export function SetupChecklistSkeleton() {
  return (
    <SkeletonSection
      titleWidth="w-24"
      descriptionWidths={["w-16"]}
      actions={<Skeleton className="mt-1.5 h-1 w-28 rounded-full" />}
    >
      <ol className="flex flex-col divide-y" aria-hidden="true">
        {["w-64", "w-80", "w-72", "w-80"].map((width, i) => (
          <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3.5 first:pt-1 last:pb-0">
            <Skeleton className="size-[1.125rem] shrink-0 self-start rounded-full sm:self-center" />
            <div className="flex min-w-48 flex-1 flex-col items-start gap-1.5">
              <SkeletonText className="text-sm" widths={[`${width} max-w-full`]} />
              {i === 1 && <Skeleton className="h-5 w-56" />}
            </div>
            <SkeletonButton size="sm" className="w-14" />
          </li>
        ))}
      </ol>
    </SkeletonSection>
  )
}

/** Automation status, Today's cap, Spend and Needs you cards while the status reads load. */
export function StatusCardsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <Card size="sm">
        <CardHeader>
          <SkeletonText className="text-base leading-snug" widths={["w-56"]} />
          <SkeletonText className="text-sm" widths={["w-full", "w-2/3"]} />
        </CardHeader>
        <CardContent>
          <SkeletonText className="text-[0.8125rem]" widths={["w-80 max-w-full"]} />
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <SkeletonText className="text-sm leading-snug" widths={["w-20"]} />
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="flex items-baseline gap-2">
            <SkeletonText className="w-auto text-3xl" widths={["w-5"]} />
            <SkeletonText className="text-sm" widths={["w-60 max-w-full"]} />
          </p>
          <Skeleton className="h-1 w-full rounded-full" />
          <SkeletonText className="text-xs" widths={["w-full", "w-1/2"]} />
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <SkeletonText className="text-sm leading-snug" widths={["w-12"]} />
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="flex items-baseline gap-2">
            <SkeletonText className="w-auto text-3xl" widths={["w-24"]} />
            <SkeletonText className="text-sm" widths={["w-40"]} />
          </p>
          <Skeleton className="h-1 w-full rounded-full" />
          <SkeletonText className="text-sm" widths={["w-24"]} />
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <SkeletonText className="text-base leading-snug" widths={["w-24"]} />
        </CardHeader>
        <CardContent className="px-0">
          <ul className="flex flex-col">
            {["w-44", "w-40", "w-44"].map((width, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <SkeletonText widths={[width]} />
                <Skeleton className="h-4 w-12 shrink-0" />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

/** "Add a job link" with its input group and help, for the first load before the page code runs. */
export function AddJobLinkSkeleton() {
  return (
    <SkeletonSection titleWidth="w-28">
      <div className="flex max-w-xl flex-col gap-1.5" aria-hidden="true">
        <Skeleton className="h-10 w-full rounded-lg pointer-coarse:h-12" />
        <SkeletonText className="text-sm leading-normal" widths={["w-full", "w-1/2"]} />
      </div>
    </SkeletonSection>
  )
}

/** Home's content area: the page container with every block above as a skeleton. */
export function DashboardSkeleton() {
  return (
    <div className="flex max-w-[760px] flex-col gap-7 px-4 lg:px-6" aria-hidden="true">
      <div className="flex flex-col gap-7">
        <AddJobLinkSkeleton />
        <SetupChecklistSkeleton />
      </div>
    </div>
  )
}
