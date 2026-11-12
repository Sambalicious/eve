import { TriangleAlert } from "lucide-react"
import { Link } from "react-router-dom"
import { cn } from "cn"

import {
  automationCopy,
  firstOfNextMonth,
  isNearCeiling,
  monthLabel,
  SPEND_CATEGORIES,
  type CostPause,
  type MonthlySpend,
} from "@/entities/automation-state"
import { RaiseCeiling } from "@/features/raise-cost-ceiling"
import { formatWatDate } from "@/shared/lib/format-wat"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { Progress } from "@/shared/ui/progress"
import { Section } from "@/shared/ui/section"
import { Skeleton, SkeletonButton, SkeletonText } from "@/shared/ui/skeleton"
import { useAutomationState } from "../model/use-automation-state"

const c = automationCopy.cost

/** Spend bar; warning colour at 80% or more, and its accessible name carries the numbers. */
function SpendBar({ spend }: { spend: MonthlySpend }) {
  return (
    <Progress
      value={Math.min(spend.percentUsed, 100)}
      max={100}
      aria-label={c.barLabel(spend.spent, spend.ceiling)}
      className={cn(isNearCeiling(spend) && "[&_[data-slot=progress-indicator]]:bg-warning")}
    />
  )
}

function NearCeilingLine({ spend }: { spend: MonthlySpend }) {
  if (!isNearCeiling(spend)) return null
  return (
    <p className="flex items-start gap-2 text-sm text-pretty">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-text" />
      {c.nearCeiling(spend.percentUsed, spend.ceiling)}
    </p>
  )
}

/** Home's Spend card (Composite blocks): amount, "of USD {ceiling} this month", bar, C-COST-3, "See breakdown". */
export function SpendCard({ spend }: { spend: MonthlySpend }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2 className="text-sm font-medium text-muted-foreground">{c.spendTitle}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-3xl font-semibold tabular-nums">USD {spend.spent}</span>
          <span className="text-sm text-muted-foreground">{c.ofCeilingShort(spend.ceiling)}</span>
        </p>
        <SpendBar spend={spend} />
        <NearCeilingLine spend={spend} />
        <Link to="/pause-and-cost#cost" className="w-fit text-sm underline underline-offset-4">
          {c.seeBreakdown}
        </Link>
      </CardContent>
    </Card>
  )
}

/**
 * Settings "Monthly cost" (`#cost`): C-COST-2, bar, breakdown by category,
 * C-COST-3, and the "This month's ceiling" row with C-COST-5 and the raise
 * button, shown at any time.
 */
export function MonthlyCostSection() {
  const query = useAutomationState()
  return (
    <Section id="cost" title={c.title} layout="split" headingProps={{ id: "cost-heading" }}>
      {query.isError ? (
        <LoadErrorAlert onRetry={query.retry} />
      ) : !query.data ? (
        <MonthlyCostSkeleton />
      ) : (
        <MonthlyCost spend={query.data.spend} costPause={query.data.costPause} />
      )}
    </Section>
  )
}

function MonthlyCost({ spend, costPause }: { spend: MonthlySpend; costPause: CostPause | null }) {
  const month = monthLabel(spend.month)
  const returns = formatWatDate(firstOfNextMonth(spend.month))
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm font-medium tabular-nums">{c.ofCeiling(spend.spent, spend.ceiling)}</p>
      <SpendBar spend={spend} />
      <NearCeilingLine spend={spend} />
      <table className="w-full text-sm">
        <thead className="sr-only">
          <tr>
            <th scope="col">{c.categoryColumn}</th>
            <th scope="col">{c.amountColumn}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {SPEND_CATEGORIES.map((category) => (
            <tr key={category}>
              <th scope="row" className="py-2 text-left font-normal text-muted-foreground">
                {c.categories[category]}
              </th>
              <td className="py-2 text-right tabular-nums">USD {spend.byCategory[category]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium">{c.ceilingRow}</p>
          <p className="text-sm tabular-nums">{c.ceilingValue(spend.ceiling)}</p>
          <p className="text-[0.8125rem] text-muted-foreground text-pretty">
            {spend.raised ? c.raisedHelp(month, spend.defaultCeiling, returns) : c.defaultHelp(spend.defaultCeiling, month)}
          </p>
        </div>
        <RaiseCeiling
          spend={spend}
          costPause={costPause}
          trigger={(open) => (
            <Button variant="outline" size="sm" className="shrink-0" onClick={open}>
              {c.raise}
            </Button>
          )}
        />
      </div>
    </div>
  )
}

/** Settings "Monthly cost" content: total, bar, five categories and the ceiling row. */
function MonthlyCostSkeleton() {
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
