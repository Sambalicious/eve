import { cn } from "cn"

import {
  existingApplicationCopy as c,
  type ExistingApplication,
} from "@/entities/existing-application"
import { formatWatDate } from "@/shared/lib/format-wat"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table"

/** The attribute "View it" (C-EXIST-3) finds a record's row or card by. */
export const ROW_ATTRIBUTE = "data-existing-application-id"

/**
 * The recorded applications, oldest first (F1 step 6a.4). The URL is text,
 * not a link. No row actions (OQ-D12). Below 640px each row is a card: role
 * and company, then the date, then URL and requisition ID. Up to 1,000 rows
 * scroll inside their own container; long values wrap.
 */
export function ExistingApplicationsTable({
  applications,
  highlightedId,
}: {
  applications: readonly ExistingApplication[]
  highlightedId: string | null
}) {
  const highlight = (id: string) =>
    cn(
      "scroll-mt-12 outline-none transition-colors duration-200 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
      id === highlightedId && "bg-primary/10"
    )
  return (
    <div
      role="region"
      aria-label={c.pageTitle}
      tabIndex={0}
      className="max-h-[70vh] overflow-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Table scroll={false} className="hidden sm:table">
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead>{c.columns.company}</TableHead>
            <TableHead>{c.columns.roleTitle}</TableHead>
            <TableHead>{c.columns.applicationUrl}</TableHead>
            <TableHead>{c.columns.requisitionId}</TableHead>
            <TableHead>{c.columns.appliedOn}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {applications.map((a) => (
            <TableRow
              key={a.id}
              {...{ [ROW_ATTRIBUTE]: a.id }}
              data-highlighted={a.id === highlightedId ? true : undefined}
              tabIndex={-1}
              className={cn("align-top", highlight(a.id))}
            >
              <TableCell className="min-w-36 font-medium whitespace-normal [overflow-wrap:anywhere]">
                {a.company}
              </TableCell>
              <TableCell className="min-w-40 whitespace-normal [overflow-wrap:anywhere]">
                {a.roleTitle}
              </TableCell>
              <TableCell className="max-w-[24rem] min-w-56 font-mono text-[12.5px] break-all whitespace-normal">
                {a.applicationUrl}
              </TableCell>
              <RequisitionCell value={a.requisitionId} />
              <TableCell className="whitespace-nowrap">
                {formatWatDate(a.appliedOn)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul className="flex flex-col divide-y sm:hidden" aria-label={c.pageTitle}>
        {applications.map((a) => (
          <li
            key={a.id}
            {...{ [ROW_ATTRIBUTE]: a.id }}
            data-highlighted={a.id === highlightedId ? true : undefined}
            tabIndex={-1}
            className={cn(
              "flex flex-col gap-1 rounded-sm px-1 py-3 text-sm",
              highlight(a.id)
            )}
          >
            <span className="flex flex-wrap gap-x-2 [overflow-wrap:anywhere]">
              <span className="font-medium">{a.roleTitle}</span>
              <span className="text-muted-foreground">{a.company}</span>
            </span>
            <span className="text-muted-foreground tabular-nums">
              {formatWatDate(a.appliedOn)}
            </span>
            <span className="flex flex-wrap gap-x-3 gap-y-1 text-[0.8125rem]">
              <span className="font-mono text-[12.5px] break-all">
                {a.applicationUrl}
              </span>
              <span
                className={
                  a.requisitionId
                    ? "font-mono text-[12.5px]"
                    : "text-muted-foreground"
                }
              >
                {a.requisitionId ?? c.noRequisition}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RequisitionCell({ value }: { value: string | null }) {
  return value ? (
    <TableCell className="font-mono text-[12.5px] whitespace-normal [overflow-wrap:anywhere]">
      {value}
    </TableCell>
  ) : (
    <TableCell className="text-muted-foreground">{c.noRequisition}</TableCell>
  )
}
