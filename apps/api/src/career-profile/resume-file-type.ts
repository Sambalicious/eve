import type { ResumeMediaType } from "@eve/contracts"

const PDF_HEADER = Buffer.from("%PDF-")
const PDF_EOF = Buffer.from("%%EOF")
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const DOCX_MAIN_PART = Buffer.from("word/document.xml")
const CONTENT_TYPES_PART = Buffer.from("[Content_Types].xml")
const PDF_EOF_SEARCH_BYTES = 1024

/**
 * The resume type read from the file's bytes, not its name or the browser's
 * Content-Type. A PDF starts with `%PDF-` and ends with `%%EOF`; a DOCX is a zip
 * holding `[Content_Types].xml` and `word/document.xml`. Anything else is refused.
 */
export function sniffResumeType(bytes: Buffer): ResumeMediaType | undefined {
  if (bytes.subarray(0, PDF_HEADER.length).equals(PDF_HEADER)) {
    return bytes.subarray(-PDF_EOF_SEARCH_BYTES).includes(PDF_EOF) ? "application/pdf" : undefined
  }
  if (
    bytes.subarray(0, ZIP_LOCAL_HEADER.length).equals(ZIP_LOCAL_HEADER) &&
    bytes.includes(DOCX_MAIN_PART) &&
    bytes.includes(CONTENT_TYPES_PART)
  ) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }
  return undefined
}
