import { useId } from "react"
import { FileWarning } from "lucide-react"

import { applicationCopy, type TailoredDocument } from "@/entities/application"
import { useIsMobile } from "@/shared/lib/use-mobile"
import { Button } from "@/shared/ui/button"
import { Skeleton } from "@/shared/ui/skeleton"
import { usePdfObjectUrl } from "../model/use-pdf-object-url"

/**
 * Inline PDF preview: an iframe with a title, 70vh on desktop, showing a
 * `blob:` URL of the authenticated download. Never HTML from the document.
 * Below 768px there is no inline preview, just "Open PDF" (and the download
 * buttons the viewer always shows). The text preview from the contract sits
 * under a disclosure for screen readers and copy-paste.
 */
export function DocumentPreview({
  document,
  title,
}: {
  document: TailoredDocument
  title: string
}) {
  const id = useId()
  const isMobile = useIsMobile()
  const pdf = usePdfObjectUrl(document.pdfUrl, !isMobile)
  return (
    <div className="flex flex-col gap-3">
      {isMobile ? (
        <div>
          <a
            href={document.pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm underline underline-offset-4"
          >
            {applicationCopy.openPdf}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      ) : pdf.isError ? (
        // C-DOC-16.
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/60 px-4 py-3.5 text-sm"
        >
          <FileWarning
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1">
            {applicationCopy.previewFailed}
          </span>
          <Button variant="outline" size="sm" onClick={pdf.retry}>
            Try again
          </Button>
        </div>
      ) : pdf.url ? (
        <iframe
          title={title}
          src={pdf.url}
          className="h-[70vh] w-full rounded-xl bg-muted ring-1 ring-border"
          referrerPolicy="no-referrer"
        />
      ) : (
        <Skeleton aria-hidden="true" className="h-[70vh] w-full rounded-xl" />
      )}
      <details className="text-sm">
        <summary className="w-fit cursor-pointer text-[0.8125rem] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Text version
        </summary>
        <div
          id={`${id}-text`}
          className="mt-2 flex max-w-[72ch] flex-col gap-1 [overflow-wrap:anywhere]"
        >
          {document.previewText.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
      </details>
    </div>
  )
}
