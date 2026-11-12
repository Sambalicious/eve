import { Fragment } from "react"
import { isAdvancedOn, useViewer } from "@/entities/viewer"
import { finalStatusLabel, recordCopy, type RequisitionRecord } from "@/entities/requisition-record"
import { fillCopy, retentionCopy } from "@/entities/retention"
import { ClearRecordButton } from "@/features/clear-requisition-record"
import { formatWatDate } from "@/shared/lib/format-wat"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { Section } from "@/shared/ui/section"
import { RecordsTableSkeleton } from "@/components/page-skeletons"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table"

const c = recordCopy

/**
 * "Minimal requisition records" (`#records`): help C-DATA-2, then company,
 * URL, requisition ID, date, final status, "Deleted by" (C-RET-16h: "You"
 * C-RET-16 or "Automatic, 12 months" C-RET-17) and "Clear" (C-CONFIRM-13). Empty:
 * C-EMPTY-6. Table on md and up, card list below 768px. URLs are text, not links.
 */
export function MinimalRecordsSection({ records, isError, onRetry }: { records: readonly RequisitionRecord[] | undefined; isError: boolean; onRetry: () => void }) {
  const plain = !isAdvancedOn(useViewer())
  return (
    <Section id="records" title={c.recordsHeading} description={c.recordsHelp} layout="split" headingProps={{ id: "records-heading" }}>
      {isError ? (
        <LoadErrorAlert onRetry={onRetry} />
      ) : !records ? (
        <RecordsTableSkeleton />
      ) : records.length === 0 ? (
        <p className="text-sm text-muted-foreground">{c.empty}</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block" tabIndex={0} role="region" aria-label={`${c.recordsHeading}, scrolls horizontally`}>
            <Table scroll={false}>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-normal">{c.columns.company}</TableHead>
                  <TableHead className="whitespace-normal">{c.columns.url}</TableHead>
                  <TableHead className="whitespace-normal">{c.columns.requisitionId}</TableHead>
                  <TableHead className="whitespace-normal">{c.columns.date}</TableHead>
                  <TableHead className="whitespace-normal">{c.columns.finalStatus}</TableHead>
                  <TableHead className="whitespace-normal">{retentionCopy["privacy.records.columns.deletedBy"]}</TableHead>
                  <TableHead><span className="sr-only">{c.clear}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <TableRow key={record.applicationId} className="[&>td]:align-top">
                    <TableCell className="max-w-48 whitespace-normal [overflow-wrap:anywhere]">{companyOf(record)}</TableCell>
                    <TableCell className="max-w-64 font-mono text-[13px] whitespace-normal [overflow-wrap:anywhere]"><span className="block min-w-16">{record.applicationUrl}</span></TableCell>
                    <TableCell className="font-mono text-[13px] whitespace-normal [overflow-wrap:anywhere]">{record.requisitionId}</TableCell>
                    <TableCell className="whitespace-normal">
                      {/* May break before the year only ("10 May / 2025"), so the table fits 624px with long dates. */}
                      <time dateTime={record.createdAt}>{formatWatDate(record.createdAt).replace(" ", "\u00a0")}</time>
                    </TableCell>
                    <TableCell className="whitespace-normal">{finalStatusLabel(record.finalStatus, plain)}</TableCell>
                    <TableCell className="whitespace-normal">
                      {/* Wraps only at the comma: "Automatic, / 12 months", never "12 / months". */}
                      <CommaWrapped text={deletedByLabel(record)} />
                    </TableCell>
                    <TableCell className="text-right"><ClearButton record={record} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col divide-y md:hidden" aria-label={c.recordsHeading}>
            {records.map((record) => (
              <li key={record.applicationId} className="flex flex-col gap-1.5 py-3 text-sm">
                <span className="font-medium [overflow-wrap:anywhere]">{companyOf(record)}</span>
                <span className="font-mono text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{record.applicationUrl}</span>
                <span className="font-mono text-[13px] [overflow-wrap:anywhere]">{record.requisitionId}</span>
                <span className="text-muted-foreground">
                  {rowMeta(record, plain).map((fragment, i) => (
                    <span key={i}>
                      {i > 0 && " · "}
                      <span data-meta-fragment className="inline-block max-w-full">{fragment}</span>
                    </span>
                  ))}
                </span>
                <div><ClearButton record={record} /></div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  )
}

/**
 * C-RET-16 or C-RET-17. The api sends `candidate` for a row with no stored
 * value (E5.3 B-5); an absent field means an older api, so the cell is empty
 * and the UI never guesses "You" (design spec §5, deck C-RET-18 note).
 */
function deletedByLabel(record: RequisitionRecord): string {
  if (record.deletedBy === "expiry") return retentionCopy["privacy.records.deletedBy.expiry"]
  if (record.deletedBy === "candidate") return retentionCopy["privacy.records.deletedBy.candidate"]
  return ""
}

/**
 * C-RET-18 below 768px: "{date} · {finalStatus} · {deletedBy}", or "{date} ·
 * {finalStatus}" with no `deletedBy`. Returned as the filled fragments
 * between the " · " separators, so each renders unbreakable and the line
 * wraps only after a separator (spec §5).
 */
function rowMeta(record: RequisitionRecord, plain: boolean): string[] {
  const values = { date: formatWatDate(record.createdAt), finalStatus: finalStatusLabel(record.finalStatus, plain), deletedBy: deletedByLabel(record) }
  const template = values.deletedBy ? retentionCopy["privacy.records.row.meta"] : retentionCopy["privacy.records.row.meta"].replace(" · {deletedBy}", "")
  return template.split(" · ").map((part) => fillCopy(part, values))
}

/** Each comma part unbreakable, so "Automatic, 12 months" can wrap only after the comma. */
function CommaWrapped({ text }: { text: string }) {
  return (
    <span className="block">
      {text.split(", ").map((part, i, parts) => (
        <Fragment key={i}>
          {i > 0 && " "}
          <span className="whitespace-nowrap">{i < parts.length - 1 ? `${part},` : part}</span>
        </Fragment>
      ))}
    </span>
  )
}

function companyOf(record: RequisitionRecord): string {
  return record.company ?? record.requisitionId
}

function ClearButton({ record }: { record: RequisitionRecord }) {
  return (
    <ClearRecordButton
      applicationId={record.applicationId}
      requisitionId={record.requisitionId}
      company={companyOf(record)}
      label={c.clear}
      ariaLabel={`${c.clear} ${record.requisitionId} at ${companyOf(record)}`}
    />
  )
}
