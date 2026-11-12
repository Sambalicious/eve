import { useQuery } from "@tanstack/react-query"
import { Download, FileText } from "lucide-react"
import { Link } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import {
  applicationCopy,
  applicationName,
  documentsListQueryOptions,
  PastedApplicationBadge,
  type DocumentFiles,
  type DocumentsListRow,
} from "@/entities/application"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { QuietEmpty } from "@/shared/ui/section"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { DocumentsListSkeleton } from "@/components/page-skeletons"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table"

/**
 * Documents (`/documents`): one row per Application with documents: the
 * Application (role, company, requisition ID, linking to its detail), Resume
 * (PDF, DOCX), Cover letter (PDF, DOCX) and the cover letter status in short
 * form ("Uploaded" / "Not uploaded"), blank before submission. Empty: C-DOC-4.
 * Table on md and up; stacked cards below 768px.
 */
export function DocumentsPage() {
  useDocumentTitle(applicationCopy.documentsPageTitle)
  const list = useQuery(documentsListQueryOptions())
  return (
    <AppShell title={applicationCopy.documentsPageTitle}>
      <div className="flex w-full max-w-[1120px] flex-col gap-4 px-4 lg:px-6">
        {list.isError ? (
          <LoadErrorAlert onRetry={() => void list.refetch()} />
        ) : !list.data ? (
          <DocumentsListSkeleton />
        ) : list.data.length === 0 ? (
          <QuietEmpty
            icon={<FileText />}
            title={applicationCopy.empty.title}
            description={applicationCopy.empty.text}
          />
        ) : (
          <DocumentsTable rows={list.data} />
        )}
      </div>
    </AppShell>
  )
}

function DocumentsTable({ rows }: { rows: readonly DocumentsListRow[] }) {
  return (
    <>
      <div
        className="hidden overflow-x-auto md:block"
        tabIndex={0}
        role="region"
        aria-label="Documents, scrolls horizontally"
      >
        <Table scroll={false}>
          <TableHeader>
            <TableRow>
              <TableHead>Application</TableHead>
              <TableHead>{applicationCopy.tabs.resume}</TableHead>
              <TableHead>{applicationCopy.tabs.cover_letter}</TableHead>
              <TableHead>{applicationCopy.coverLetterStatusHeader}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.applicationId} className="[&>td]:align-top">
                <TableCell className="max-w-[28rem] min-w-56 whitespace-normal">
                  <ApplicationCell row={row} />
                </TableCell>
                <TableCell>
                  <FileLinks
                    files={row.resume}
                    label={applicationCopy.tabs.resume}
                    name={applicationName(row)}
                  />
                </TableCell>
                <TableCell>
                  <FileLinks
                    files={row.coverLetter}
                    label={applicationCopy.tabs.cover_letter}
                    name={applicationName(row)}
                  />
                </TableCell>
                <TableCell>{coverLetterShort(row)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y md:hidden" aria-label="Documents">
        {rows.map((row) => (
          <li key={row.applicationId} className="flex flex-col gap-3 py-4">
            <ApplicationCell row={row} />
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">
                {applicationCopy.tabs.resume}
              </dt>
              <dd>
                <FileLinks
                  files={row.resume}
                  label={applicationCopy.tabs.resume}
                  name={applicationName(row)}
                />
              </dd>
              <dt className="text-muted-foreground">
                {applicationCopy.tabs.cover_letter}
              </dt>
              <dd>
                <FileLinks
                  files={row.coverLetter}
                  label={applicationCopy.tabs.cover_letter}
                  name={applicationName(row)}
                />
              </dd>
              {coverLetterShort(row) && (
                <>
                  <dt className="text-muted-foreground">
                    {applicationCopy.coverLetterStatusHeader}
                  </dt>
                  <dd>{coverLetterShort(row)}</dd>
                </>
              )}
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}

function ApplicationCell({ row }: { row: DocumentsListRow }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <Link
        to={`/applications/${row.applicationId}`}
        className="font-medium underline-offset-4 [overflow-wrap:anywhere] hover:underline"
      >
        {applicationName(row)}
      </Link>
      {/* v1.27.0 (B4): a pasted Application shows C-PD-51 instead of its synthetic requisition ID. */}
      {row.pastedDescription && (
        <span className="mt-0.5">
          <PastedApplicationBadge />
        </span>
      )}
      {/* With no role or company the name already is the requisition ID; don't print it twice. */}
      {!row.pastedDescription && (row.roleTitle || row.company) && (
        <span className="font-mono text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
          {row.requisitionId}
        </span>
      )}
    </div>
  )
}

/** "PDF" and "DOCX" download links, each named in full for screen readers. A missing document shows nothing. */
function FileLinks({
  files,
  label,
  name,
}: {
  files: DocumentFiles | null
  label: string
  name: string
}) {
  if (!files) return null
  return (
    <span className="flex gap-3 whitespace-nowrap">
      {(
        [
          ["PDF", files.pdfUrl],
          ["DOCX", files.docxUrl],
        ] as const
      ).map(([format, href]) => (
        <a
          key={format}
          href={href}
          download
          className="inline-flex items-center gap-1 text-sm underline underline-offset-4"
        >
          <Download aria-hidden="true" className="size-3.5 shrink-0" />
          {format}
          <span className="sr-only">
            , {label}, {name}
          </span>
        </a>
      ))}
    </span>
  )
}

function coverLetterShort(row: DocumentsListRow): string {
  if (row.coverLetterStatus === "uploaded")
    return applicationCopy.coverLetterShort.uploaded
  if (row.coverLetterStatus === "no_field")
    return applicationCopy.coverLetterShort.no_field
  return ""
}
