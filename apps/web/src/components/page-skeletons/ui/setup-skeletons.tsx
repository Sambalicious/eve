import { Card, CardContent, CardHeader } from "@/shared/ui/card"
import {
  Skeleton,
  SkeletonBadge,
  SkeletonButton,
  SkeletonInput,
  SkeletonSection,
  SkeletonText,
} from "@/shared/ui/skeleton"

/** Career Profile: the version bar, three sections of facts with source quotes, and version history. */
export function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-hidden="true">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b pb-5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <SkeletonBadge className="w-20" />
              <SkeletonText className="w-auto text-sm" widths={["w-16"]} />
            </div>
            <SkeletonText className="text-[0.8125rem]" widths={["w-96 max-w-full"]} />
          </div>
          <SkeletonButton className="w-36" />
        </div>
        <div className="flex flex-col">
          {[3, 2, 2].map((facts, i) => (
            <div
              key={i}
              className="grid min-w-0 gap-4 border-t py-6 first:border-t-0 first:pt-2 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:gap-10"
            >
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <SkeletonText className="text-[0.9375rem]" widths={["w-40"]} />
                  <SkeletonText className="text-[0.8125rem]" widths={["w-32"]} />
                </div>
                <QuoteSkeleton lines={2} />
              </div>
              <ul className="flex min-w-0 flex-col divide-y">
                {Array.from({ length: facts }, (_, f) => (
                  <li key={f} className="flex min-w-0 flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
                    <SkeletonText className="text-sm leading-relaxed" widths={["w-full", "w-3/5"]} />
                    <div className="flex min-w-0 flex-col gap-1">
                      <QuoteSkeleton lines={1} />
                      <SkeletonText className="text-[12.5px]" widths={["w-24"]} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3 border-t pt-7">
        <SkeletonText className="text-[0.9375rem]" widths={["w-28"]} />
        <ol className="flex flex-col divide-y">
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
            <SkeletonText className="w-auto text-sm" widths={["w-16"]} />
            <SkeletonBadge />
            <SkeletonText className="ml-auto w-auto text-xs" widths={["w-56"]} />
          </li>
        </ol>
      </div>
    </div>
  )
}

function QuoteSkeleton({ lines }: { lines: number }) {
  return (
    <div className="flex max-w-[72ch] flex-col gap-0.5">
      <SkeletonText className="text-xs" widths={["w-24"]} />
      <div className="border-l-2 border-muted pl-2.5">
        <SkeletonText className="text-[0.8125rem]" widths={lines === 1 ? ["w-4/5"] : ["w-full", "w-2/3"]} />
      </div>
    </div>
  )
}

function AnswerRowsSkeleton({ rows }: { rows: number }) {
  return (
    <ul className="flex flex-col divide-y">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-start sm:gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <SkeletonText className="text-[0.8125rem]" widths={[i % 2 ? "w-28" : "w-36"]} />
            <SkeletonText className="text-sm" widths={[i % 2 ? "w-48" : "w-40"]} />
            <SkeletonText className="text-xs" widths={["w-32"]} />
          </div>
          <div className="-mr-2 flex shrink-0 gap-0.5">
            <SkeletonButton size="sm" className="w-14" />
            <SkeletonButton size="sm" className="w-16" />
          </div>
        </li>
      ))}
    </ul>
  )
}

function AnswerHeadingSkeleton({ width }: { width: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <SkeletonText className="w-auto text-[0.9375rem]" widths={[width]} />
      <SkeletonButton size="sm" className="w-24" />
    </div>
  )
}

/** Approved Answers: Standard, Salary (three cards), Sensitive and Custom questions. */
export function AnswersSkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-hidden="true">
      <div className="flex flex-col gap-3">
        <AnswerHeadingSkeleton width="w-20" />
        <AnswerRowsSkeleton rows={3} />
      </div>
      <div className="flex flex-col gap-3 border-t pt-7">
        <SkeletonText className="text-[0.9375rem]" widths={["w-14"]} />
        <div className="flex flex-col divide-y">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="grid min-w-0 gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-8">
              <div className="flex min-w-0 flex-col items-start gap-1">
                <SkeletonText className="text-sm" widths={["w-36"]} />
                <SkeletonText className="text-[0.8125rem] leading-relaxed" widths={["w-full", "w-1/2"]} />
              </div>
              <div className="flex min-w-0 flex-col gap-3">
                <SkeletonText className="text-sm" widths={["w-3/4"]} />
                <SkeletonButton size="sm" className="w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3 border-t pt-7">
        <AnswerHeadingSkeleton width="w-20" />
        <SkeletonText className="-mt-1 max-w-[60ch] text-[0.8125rem]" widths={["w-full", "w-1/3"]} />
        <AnswerRowsSkeleton rows={1} />
      </div>
      <div className="flex flex-col gap-3 border-t pt-7">
        <AnswerHeadingSkeleton width="w-32" />
        <AnswerRowsSkeleton rows={1} />
      </div>
    </div>
  )
}

function FieldSkeleton({ label = "w-32", help }: { label?: string; help?: readonly string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <SkeletonText className="text-sm leading-snug" widths={[label]} />
      <SkeletonInput />
      {help && <SkeletonText className="text-sm leading-normal" widths={help} />}
    </div>
  )
}

/** Settings: work authorization, Job criteria and contact details (split sections), then Monthly cost. */
export function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-hidden="true">
      <SkeletonSection layout="split" titleWidth="w-48" descriptionWidths={["w-56"]}>
        <div className="flex flex-col gap-4">
          <FieldSkeleton label="w-32" help={["w-full", "w-2/3"]} />
          <SkeletonButton className="w-28" />
        </div>
      </SkeletonSection>
      <SkeletonSection layout="split" titleWidth="w-28" descriptionWidths={["w-full", "w-3/4"]}>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <SkeletonText className="text-sm" widths={["w-36"]} />
            <SkeletonInput className="w-28" />
            <SkeletonText className="text-sm leading-normal" widths={["w-full"]} />
          </div>
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <SkeletonText className="text-sm" widths={["w-24"]} />
              <SkeletonText className="text-sm leading-normal" widths={["w-3/4"]} />
              <div className="flex items-center gap-2">
                <SkeletonInput />
                <SkeletonButton size="sm" className="w-16" />
              </div>
              <SkeletonText className="text-sm" widths={["w-20"]} />
            </div>
          ))}
          <SkeletonButton className="w-28" />
        </div>
      </SkeletonSection>
      <SkeletonSection layout="split" titleWidth="w-32" descriptionWidths={["w-full", "w-3/4", "w-1/3"]}>
        <div className="flex flex-col gap-4">
          <FieldSkeleton label="w-36" />
          <div className="flex flex-col gap-2">
            <SkeletonText className="mb-1.5 text-sm" widths={["w-28"]} />
            <SkeletonText className="text-sm leading-normal" widths={["w-96 max-w-full"]} />
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-2">
                <SkeletonInput />
                <SkeletonButton size="icon" />
              </div>
            ))}
            <SkeletonButton size="sm" className="w-24" />
          </div>
          <SkeletonButton className="w-28" />
        </div>
      </SkeletonSection>
      <SkeletonSection layout="split" titleWidth="w-28">
        <MonthlyCostRowsSkeleton />
      </SkeletonSection>
    </div>
  )
}

/** The minimal requisition records table while it loads. */
export function RecordsTableSkeleton() {
  return (
    <div className="flex flex-col text-sm" aria-hidden="true">
      <div className="flex h-9 items-center gap-6 border-b">
        {["w-16", "w-8", "w-24", "w-8", "w-20"].map((width, i) => (
          <SkeletonText key={i} className="w-auto text-[0.78125rem]" widths={[width]} />
        ))}
      </div>
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className="flex items-center gap-6 border-b py-3 last:border-0">
          <SkeletonText className="w-24" widths={["w-20"]} />
          <SkeletonText className="flex-1 text-[13px]" widths={["w-48 max-w-full"]} />
          <SkeletonText className="w-20 text-[13px]" widths={["w-16"]} />
          <SkeletonText className="w-24" widths={["w-20"]} />
        </div>
      ))}
    </div>
  )
}

/** Retention facts while `GET /v1/retention` loads: two rows as tall as the loaded `dt`/`dd` rows. */
export function RetentionFactsSkeleton() {
  return (
    <div className="flex flex-col divide-y" aria-hidden="true">
      {["w-40", "w-56"].map((width) => (
        <div key={width} className="flex flex-col gap-0.5 py-3 first:pt-0">
          <SkeletonText className="text-[0.78125rem]" widths={["w-32"]} />
          <SkeletonText className="text-sm" widths={[width]} />
        </div>
      ))}
    </div>
  )
}

/** Applications: "Select all on this page", then the table (checkbox, name, requisition ID, status, created, expires). */
export function ApplicationsListSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <div className="flex min-h-9 items-center gap-2">
        <Skeleton className="size-4 rounded-[4px]" />
        <SkeletonText className="w-auto text-sm" widths={["w-36"]} />
      </div>
      <div className="flex flex-col text-sm">
        <div className="hidden h-9 items-center gap-6 border-b md:flex">
          <div className="w-8" />
          <SkeletonText className="min-w-56 flex-1 text-[0.78125rem]" widths={["w-20"]} />
          <SkeletonText className="w-28 text-[0.78125rem]" widths={["w-24"]} />
          <SkeletonText className="w-32 text-[0.78125rem]" widths={["w-12"]} />
          <SkeletonText className="w-24 text-[0.78125rem]" widths={["w-14"]} />
          <SkeletonText className="w-24 text-[0.78125rem]" widths={["w-14"]} />
        </div>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-start gap-3 border-b py-3 last:border-0 md:items-center md:gap-6">
            <div className="w-auto md:w-8">
              <Skeleton className="size-4 rounded-[4px]" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1 md:min-w-56 md:flex-row md:items-center md:gap-6">
              <SkeletonText className="flex-1" widths={[["w-72", "w-60", "w-80", "w-64", "w-56"][i] + " max-w-full"]} />
              <SkeletonText className="text-[13px] md:w-28" widths={["w-20"]} />
              <div className="md:w-32">
                <SkeletonBadge className="w-28" />
              </div>
              <SkeletonText className="text-sm md:hidden" widths={["w-56 max-w-full"]} />
              <SkeletonText className="hidden w-24 md:flex" widths={["w-20"]} />
              <SkeletonText className="hidden w-24 md:flex" widths={["w-20"]} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The AI provider section (terms summary and its action) while the provider read loads. */
export function AiProviderSkeleton() {
  return (
    <SkeletonSection layout="split" titleWidth="w-52">
      <div className="flex flex-col gap-3" aria-hidden="true">
        <div className="flex max-w-[72ch] flex-col gap-2">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonText key={i} className="text-sm" widths={["w-full", i === 1 ? "w-1/2" : "w-3/4"]} />
          ))}
        </div>
        <SkeletonText className="text-xs" widths={["w-full max-w-[60ch]"]} />
        <div className="pt-2">
          <SkeletonButton className="w-36" />
        </div>
      </div>
    </SkeletonSection>
  )
}

/** Data and privacy on first load: AI provider, Retention and the minimal records table. */
export function PrivacySkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-hidden="true">
      <AiProviderSkeleton />
      <SkeletonSection layout="split" titleWidth="w-20">
        <SkeletonText className="max-w-[60ch] text-sm" widths={["w-full", "w-1/2"]} />
      </SkeletonSection>
      <SkeletonSection layout="split" titleWidth="w-48" descriptionWidths={["w-full", "w-full", "w-1/2"]}>
        <RecordsTableSkeleton />
      </SkeletonSection>
    </div>
  )
}

/** Job Sources: the employer list table above the four remote-job boards. */
export function JobSourcesSkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-hidden="true">
      <SkeletonSection titleWidth="w-28" descriptionWidths={["w-full", "w-2/3", "w-full", "w-full", "w-1/3"]}>
        <div className="flex flex-col gap-2">
          <SkeletonText className="text-[0.8125rem]" widths={["w-24"]} />
          <div className="flex flex-col text-sm">
            <div className="flex h-9 items-center gap-6 border-b">
              <SkeletonText className="w-40 min-w-40 text-[0.78125rem]" widths={["w-16"]} />
              <SkeletonText className="w-36 text-[0.78125rem]" widths={["w-28"]} />
              <SkeletonText className="text-[0.78125rem]" widths={["w-20"]} />
            </div>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center gap-6 border-b py-3 last:border-0">
                <SkeletonText className="w-40 min-w-40" widths={[i % 3 ? "w-24" : "w-32"]} />
                <SkeletonText className="w-36" widths={["w-16"]} />
                <SkeletonText className="text-[13px]" widths={["w-72 max-w-full"]} />
              </div>
            ))}
          </div>
        </div>
      </SkeletonSection>
      <SkeletonSection titleWidth="w-36">
        <ul className="flex flex-col divide-y">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex flex-col gap-2 py-4">
              <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                <div className="flex min-w-[min(100%,18rem)] flex-1 flex-col gap-1">
                  <SkeletonText className="text-sm" widths={["w-28"]} />
                  <SkeletonText className="text-xs" widths={["w-24"]} />
                  <SkeletonBadge className="w-24" />
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <SkeletonButton size="sm" className="w-24" />
                  <Skeleton className="h-[18.4px] w-[32px] rounded-full" />
                  <SkeletonText className="w-auto text-sm" widths={["w-14"]} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </SkeletonSection>
    </div>
  )
}

/** The sign-in card while the session check runs, in place of a blank page. */
export function SignInCardSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader className="justify-items-center text-center">
        <SkeletonText className="items-center text-2xl" widths={["w-40"]} />
        <SkeletonText className="items-center text-sm" widths={["w-64"]} />
      </CardHeader>
      <CardContent className="grid gap-4">
        <SkeletonButton size="lg" className="w-full" />
      </CardContent>
    </Card>
  )
}

/** Settings "Monthly cost" content (same as spend-breakdown's MonthlyCostSkeleton): total, bar, five categories and the ceiling row. */
function MonthlyCostRowsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <SkeletonText className="text-sm" widths={["w-48"]} />
      <Skeleton className="h-1 w-full rounded-full" />
      <div className="flex flex-col divide-y text-sm">
        {["w-14", "w-6", "w-16", "w-20", "w-12"].map((width, i) => (
          <div key={i} className="flex justify-between py-2">
            <SkeletonText className="w-auto" widths={[width]} />
            <SkeletonText className="w-auto" widths={["w-16"]} />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <SkeletonText className="text-sm" widths={["w-32"]} />
          <SkeletonText className="text-sm" widths={["w-20"]} />
          <SkeletonText className="text-[0.8125rem]" widths={["w-full", "w-1/2"]} />
        </div>
        <SkeletonButton size="sm" className="w-44" />
      </div>
    </div>
  )
}


/** Existing applications: the step status, the add form's field row, then the table. */
export function ExistingApplicationsSkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-hidden="true">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b pb-6">
        <SkeletonText className="min-w-0 flex-1 text-sm" widths={["w-96 max-w-full"]} />
        <SkeletonButton className="w-44" />
      </div>
      <div className="flex flex-col gap-4">
        <SkeletonText className="text-[0.9375rem]" widths={["w-44"]} />
        <div className="flex flex-col gap-4 md:flex-row md:flex-wrap">
          {["w-16", "w-10", "w-44", "w-36", "w-24"].map((label, i) => (
            <div key={i} className="flex min-w-[min(100%,12rem)] flex-1 flex-col gap-1.5">
              <SkeletonText className="text-sm leading-snug" widths={[label]} />
              <SkeletonInput />
            </div>
          ))}
        </div>
        <SkeletonButton className="w-48" />
      </div>
      <div className="flex flex-col text-sm">
        <div className="hidden h-9 items-center gap-6 border-b sm:flex">
          {["w-16", "w-10", "w-40", "w-24", "w-20"].map((width, i) => (
            <SkeletonText key={i} className="w-auto text-[0.78125rem]" widths={[width]} />
          ))}
        </div>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex flex-col gap-1 border-b py-3 last:border-0 sm:flex-row sm:items-center sm:gap-6">
            <SkeletonText className="sm:w-28" widths={["w-20"]} />
            <SkeletonText className="sm:w-32" widths={["w-28"]} />
            <SkeletonText className="flex-1 text-[13px]" widths={["w-56 max-w-full"]} />
            <SkeletonText className="sm:w-20" widths={["w-14"]} />
            <SkeletonText className="sm:w-24" widths={["w-20"]} />
          </div>
        ))}
      </div>
    </div>
  )
}
