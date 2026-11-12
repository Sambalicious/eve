import type { ResumeMediaType } from "@eve/contracts"
import mammoth from "mammoth"
import { extractText, getDocumentProxy } from "unpdf"

import { preflightDocx } from "./docx-preflight.js"

/** A resume has a few pages; more is not a resume and costs pdf.js time and memory. */
export const MAX_PDF_PAGES = 20
/** Stop collecting text past this; the caller refuses anything this long anyway. */
const TEXT_COLLECTION_LIMIT = 200_000

export type ParseResult = Readonly<{ ok: true; text: string }> | Readonly<{ ok: false; reason: string }>

/**
 * The parsers themselves. Runs only inside the extraction child process
 * (`extract-text.child.ts`); calling it in the api would undo SEC-201's isolation.
 */
export async function extractTextInProcess(mediaType: ResumeMediaType, bytes: Buffer): Promise<ParseResult> {
  try {
    return mediaType === "application/pdf" ? await pdfText(bytes) : await docxText(bytes)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : "parse_error" }
  }
}

async function pdfText(bytes: Buffer): Promise<ParseResult> {
  const document = await getDocumentProxy(new Uint8Array(bytes))
  try {
    if (document.numPages > MAX_PDF_PAGES) return { ok: false, reason: "too_many_pages" }
    const { text } = await extractText(document, { mergePages: true })
    return text.length > TEXT_COLLECTION_LIMIT ? { ok: false, reason: "too_much_text" } : { ok: true, text }
  } finally {
    await document.cleanup()
  }
}

async function docxText(bytes: Buffer): Promise<ParseResult> {
  const preflight = preflightDocx(bytes)
  if (!preflight.ok) return { ok: false, reason: preflight.reason }
  const { value } = await mammoth.extractRawText({ buffer: bytes })
  return value.length > TEXT_COLLECTION_LIMIT ? { ok: false, reason: "too_much_text" } : { ok: true, text: value }
}
