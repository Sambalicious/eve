import { useId } from "react"
import { Download, FileText } from "lucide-react"

import {
  applicationCopy,
  coverLetterLine,
  type DocumentKind,
  type TailoredDocument,
} from "@/entities/application"
import { buttonVariants } from "@/shared/ui/button"
import { Section } from "@/shared/ui/section"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs"
import { AtsScoreCard } from "./ats-score-card"
import { DocumentPreview } from "./document-preview"

const KINDS: readonly DocumentKind[] = ["resume", "cover_letter"]
const ANCHOR: Record<DocumentKind, string> = {
  resume: "resume",
  cover_letter: "cover-letter",
}

/**
 * Documents section (F5): tabs "Resume" and "Cover letter", each with the
 * inline PDF preview and "Download PDF" / "Download DOCX". The cover letter
 * tab adds C-DOC-1 or C-DOC-2 once slice 5 sets the status. A tab whose
 * document isn't listed (blocked) offers no download.
 */
export function DocumentsViewer({
  documents,
  coverLetterStatus,
  initialTab,
  name,
}: {
  documents: readonly TailoredDocument[]
  coverLetterStatus: Parameters<typeof coverLetterLine>[0]
  initialTab: DocumentKind
  name: string
}) {
  const id = useId()
  return (
    <Section
      title={applicationCopy.documentsHeading}
      headingProps={{ id: `${id}-heading` }}
    >
      <Tabs defaultValue={initialTab}>
        <TabsList variant="line" className="w-full justify-start">
          {KINDS.map((kind) => (
            <TabsTrigger key={kind} value={kind}>
              {applicationCopy.tabs[kind]}
            </TabsTrigger>
          ))}
        </TabsList>
        {KINDS.map((kind) => {
          const document = documents.find((d) => d.kind === kind)
          const line =
            kind === "cover_letter" ? coverLetterLine(coverLetterStatus) : null
          return (
            <TabsContent
              key={kind}
              value={kind}
              className="flex flex-col gap-3 pt-3"
            >
              <h3
                id={ANCHOR[kind]}
                tabIndex={-1}
                className="sr-only scroll-mt-20"
              >
                {applicationCopy.tabs[kind]}
              </h3>
              {line && <p className="text-sm">{line}</p>}
              {document ? (
                <>
                  {document.ats && <AtsScoreCard ats={document.ats} />}
                  <DownloadButtons document={document} />
                  <DocumentPreview
                    document={document}
                    title={`${applicationCopy.tabs[kind]}, ${name}`}
                  />
                </>
              ) : (
                // C-DOC-15.
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <FileText aria-hidden="true" className="size-4 shrink-0" />
                  {applicationCopy.emptyTab(kind)}
                </p>
              )}
            </TabsContent>
          )
        })}
      </Tabs>
    </Section>
  )
}

/** Plain links to the authenticated download; the server sends `content-disposition: attachment`. */
function DownloadButtons({ document }: { document: TailoredDocument }) {
  const kind = applicationCopy.tabs[document.kind]
  return (
    <div className="flex flex-wrap gap-2">
      {(
        [
          [applicationCopy.downloadPdf, document.pdfUrl],
          [applicationCopy.downloadDocx, document.docxUrl],
        ] as const
      ).map(([label, href]) => (
        <a
          key={href}
          href={href}
          download
          data-slot="button"
          className={buttonVariants({ variant: "outline" })}
        >
          <Download aria-hidden="true" />
          {label}
          <span className="sr-only">, {kind}</span>
        </a>
      ))}
    </div>
  )
}
