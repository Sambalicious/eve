import { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, Tab, TabStopPosition, TabStopType, TextRun } from "docx"
import PDFDocument from "pdfkit"
import { extractText, getDocumentProxy } from "unpdf"

import { asciiDigits } from "../career-profile/claim-check.js"
import { type ContactHeader, type DocumentContent, RESUME_SECTION_TITLES, bulletLabel, plainTextOf, skillParts } from "./document-model.js"

/**
 * Deterministic rendering (architecture r1). One column, standard headings,
 * real text (no images), so ATS parsers and the Candidate can select it.
 *
 * Libraries (2026-10-19): pdfkit 0.20.2 (MIT) for PDF and docx 9.8.1 (MIT) for
 * DOCX. Both are long-lived, widely used, pure JavaScript, need no browser or
 * native binary, and write text as text. Text extraction for the check reuses
 * unpdf (pdf.js), already used to read resumes.
 *
 * Font: the PDF standard Helvetica, so no font file is bundled. It covers
 * Windows-1252 (accented Latin letters, dashes, curly quotes). Any character
 * outside that set is reduced to its base letter by `pdfSafe` (for example
 * "Ọ" becomes "O"); the text check compares against the same reduced text.
 */
const MARGIN = 54
const BODY_SIZE = 10.5
const HEADING_SIZE = 11.5
const NAME_SIZE = 19
const CONTACT_SIZE = 9.5
const HEADLINE_SIZE = 11
const ROLE_SIZE = 11
/** Between contact lines on the one centred contact line. */
const CONTACT_SEPARATOR = " \u2022 "
/** Experience bullets: the mark sits at the margin, the text hangs at this indent. */
const BULLET_INDENT = 14
const BULLET_MARK = "\u2022"

/** `compress: false` and `kerning: true` exist for tests: an uncompressed content stream, and the old kerned output. */
export type RenderPdfOptions = Readonly<{ compress?: boolean; kerning?: boolean }>

export async function renderPdf(content: DocumentContent, contact: ContactHeader, options: RenderPdfOptions = {}): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    compress: options.compress ?? true,
    info: { Title: titleOf(content), Producer: "eve" },
  })
  const chunks: Buffer[] = []
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk))
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)))
    pdf.on("error", reject)
  })
  const width = pdf.page.width - MARGIN * 2
  const bottom = () => pdf.page.height - pdf.page.margins.bottom
  const font = (name: string, size: number) => {
    pdf.font(name).fontSize(size)
    if (options.kerning !== true) withoutKerning(pdf)
  }
  /** Starts a new page when the next block (of about `height` points) would not fit. */
  const keepRoom = (height: number) => {
    if (pdf.y + height > bottom()) pdf.addPage()
  }
  const text = (value: string, name: string, size: number, gapAfter: number, align: "left" | "center" = "left") => {
    font(name, size)
    pdf.text(pdfSafe(value), MARGIN, pdf.y, { width, lineGap: 1.5, align })
    pdf.moveDown(gapAfter)
  }
  // Centred name over one centred contact line, as on the owner's resume. Each contact line stays whole.
  text(contact.name, "Helvetica-Bold", NAME_SIZE, 0.15, "center")
  // Contact lines are packed onto as few centred rows as fit, breaking only between lines, so a link
  // or an email address is never split across rows.
  font("Helvetica", CONTACT_SIZE)
  const rows: string[] = []
  for (const line of contact.lines.map(pdfSafe)) {
    const last = rows.at(-1)
    if (last !== undefined && pdf.widthOfString(`${last}${CONTACT_SEPARATOR}${line}`) <= width) rows[rows.length - 1] = `${last}${CONTACT_SEPARATOR}${line}`
    else rows.push(line)
  }
  for (const row of rows) text(row, "Helvetica", CONTACT_SIZE, 0, "center")
  // Rule 1 (EPIC-0012): the backend's headline line, in the order `plainTextOf` gives it.
  const headline = content.kind === "resume" ? content.headline?.trim() : undefined
  if (headline) text(headline, "Helvetica", HEADLINE_SIZE, 0, "center")
  pdf.moveDown(0.6)

  if (content.kind === "cover_letter") {
    text(content.greeting, "Helvetica", BODY_SIZE, 0.6)
    if (content.opening) text(content.opening, "Helvetica", BODY_SIZE, 0.6)
    for (const paragraph of content.paragraphs) text(paragraph.text, "Helvetica", BODY_SIZE, 0.6)
    if (content.closingLine) text(content.closingLine, "Helvetica", BODY_SIZE, 0.6)
    text(content.closing, "Helvetica", BODY_SIZE, 0.2)
    text(contact.name, "Helvetica", BODY_SIZE, 0)
    pdf.end()
    return done
  }

  /** A centred, bold section title with a rule under it. Kept with at least a few lines of its section. */
  const sectionTitle = (title: string) => {
    keepRoom(70)
    pdf.moveDown(0.5)
    text(title, "Helvetica-Bold", HEADING_SIZE, 0.05, "center")
    const y = pdf.y + 1
    pdf.save().moveTo(MARGIN, y).lineTo(MARGIN + width, y).lineWidth(0.8).strokeColor("#000000").stroke().restore()
    pdf.y = y + 5
  }
  /** Employer on the left, dates on the right, on one line; the employer wraps before it reaches the dates. */
  const leftRight = (left: string | null, right: string | null) => {
    font("Helvetica", ROLE_SIZE)
    const top = pdf.y
    const rightText = right ? pdfSafe(right) : ""
    const rightWidth = rightText ? pdf.widthOfString(rightText) : 0
    // Long dates would squeeze the employer until it breaks mid-word: they then get their own line.
    if (rightText && rightWidth > width * 0.4) {
      if (left) pdf.text(pdfSafe(left), MARGIN, top, { width, lineGap: 1.5 })
      pdf.text(rightText, MARGIN, pdf.y, { width, lineGap: 1.5, align: "right" })
      pdf.x = MARGIN
      return
    }
    let afterLeft = top
    if (left) {
      pdf.text(pdfSafe(left), MARGIN, top, { width: width - rightWidth - (rightText ? 16 : 0), lineGap: 1.5 })
      afterLeft = pdf.y
    }
    if (rightText) {
      pdf.text(rightText, MARGIN + width - rightWidth, top, { lineBreak: false })
    }
    pdf.y = Math.max(afterLeft, top + pdf.currentLineHeight(true))
    pdf.x = MARGIN
  }
  // The mark is drawn on its own, so the bullet's text stays one run for the text checks.
  const bulletLine = (value: string) => {
    const labelled = bulletLabel(value)
    font("Helvetica", BODY_SIZE)
    const layout = { width: width - BULLET_INDENT, lineGap: 1.5 }
    // Keep the mark with its text: a bullet that won't fit on this page starts the next one.
    // One spare line: a bold label is wider than the regular text it is measured in.
    keepRoom(pdf.heightOfString(pdfSafe(value), layout) + (labelled ? pdf.currentLineHeight(true) : 0))
    const top = pdf.y
    pdf.text(BULLET_MARK, MARGIN + 2, top, { lineBreak: false })
    if (labelled) {
      font("Helvetica-Bold", BODY_SIZE)
      pdf.text(`${pdfSafe(labelled.label)} `, MARGIN + BULLET_INDENT, top, { ...layout, continued: true })
      font("Helvetica", BODY_SIZE)
      pdf.text(pdfSafe(labelled.rest))
    } else {
      pdf.text(pdfSafe(value), MARGIN + BULLET_INDENT, top, layout)
    }
    pdf.x = MARGIN
    pdf.moveDown(0.15)
  }

  if (content.summary.length > 0) {
    sectionTitle(RESUME_SECTION_TITLES.Summary)
    for (const line of content.summary) text(line.text, "Helvetica", BODY_SIZE, 0.2)
  }
  if (content.experience.length > 0) {
    sectionTitle(RESUME_SECTION_TITLES.Experience)
    content.experience.forEach((entry, index) => {
      if (index > 0) pdf.moveDown(0.5)
      // Keep a role's heading with its first bullet.
      keepRoom(64)
      if (entry.role) {
        leftRight(entry.role.organization, entry.role.period)
        text(entry.role.title, "Helvetica-Bold", BODY_SIZE, 0.15)
      } else {
        text(entry.heading.text, "Helvetica-Bold", BODY_SIZE, 0.15)
      }
      for (const bullet of entry.bullets) bulletLine(bullet.text)
    })
  }
  if (content.education.length > 0) {
    sectionTitle(RESUME_SECTION_TITLES.Education)
    content.education.forEach((line, index) => {
      const role = content.educationRoles?.[index]
      keepRoom(36)
      if (role) {
        if (role.organization) leftRight(role.organization, null)
        text(role.title, "Helvetica-Bold", BODY_SIZE, 0.3)
      } else {
        text(line.text, "Helvetica", BODY_SIZE, 0.3)
      }
    })
  }
  if (content.skills.length > 0) {
    sectionTitle(RESUME_SECTION_TITLES.Skills)
    for (const line of content.skills) {
      const parts = skillParts(line.text)
      keepRoom(30)
      if (parts) {
        text(parts.label, "Helvetica-Bold", BODY_SIZE, 0)
        text(parts.items, "Helvetica", BODY_SIZE, 0.45)
      } else {
        text(line.text, "Helvetica", BODY_SIZE, 0.3)
      }
    }
  }
  pdf.end()
  return done
}

export async function renderDocx(content: DocumentContent, contact: ContactHeader): Promise<Buffer> {
  const run = (value: string, bold = false, size?: number) => new TextRun({ text: docxSafe(value), bold, ...(size !== undefined && { size }) })
  const body = (value: string, bold = false, after = 80) => new Paragraph({ children: [run(value, bold)], spacing: { after } })
  const children: Paragraph[] = [
    new Paragraph({ children: [run(contact.name, true, NAME_SIZE * 2)], alignment: AlignmentType.CENTER, spacing: { after: 60 } }),
  ]
  if (contact.lines.length > 0) {
    children.push(new Paragraph({ children: [run(contact.lines.join(CONTACT_SEPARATOR), false, CONTACT_SIZE * 2)], alignment: AlignmentType.CENTER, spacing: { after: 160 } }))
  }
  // Rule 1 (EPIC-0012): the backend's headline line, under the contact lines.
  const headline = content.kind === "resume" ? content.headline?.trim() : undefined
  if (headline) children.push(new Paragraph({ children: [run(headline, false, HEADLINE_SIZE * 2)], alignment: AlignmentType.CENTER, spacing: { after: 160 } }))
  if (content.kind === "cover_letter") {
    children.push(
      body(content.greeting),
      ...(content.opening ? [body(content.opening)] : []),
      ...content.paragraphs.map((paragraph) => body(paragraph.text)),
      ...(content.closingLine ? [body(content.closingLine)] : []),
      body(content.closing),
      body(contact.name)
    )
  } else {
    // A Word heading (for ATS structure), centred and ruled like the owner's resume.
    const heading = (value: string) =>
      new Paragraph({
        children: [run(value, true, HEADING_SIZE * 2)],
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: "000000", space: 1 } },
        spacing: { before: 240, after: 100 },
      })
    // Employer, then a right-aligned tab to the dates.
    const leftRight = (left: string | null, right: string | null) =>
      new Paragraph({
        children: [run(left ?? "", false, ROLE_SIZE * 2), ...(right ? [new TextRun({ children: [new Tab()] }), run(right, false, ROLE_SIZE * 2)] : [])],
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        spacing: { before: 120, after: 0 },
      })
    const bullet = (value: string) => {
      const labelled = bulletLabel(value)
      const runs = labelled ? [run(`${labelled.label} `, true), run(labelled.rest)] : [run(value)]
      return new Paragraph({ children: runs, bullet: { level: 0 }, spacing: { after: 40 } })
    }
    if (content.summary.length > 0) children.push(heading(RESUME_SECTION_TITLES.Summary), ...content.summary.map((line) => body(line.text)))
    if (content.experience.length > 0) {
      children.push(heading(RESUME_SECTION_TITLES.Experience))
      for (const entry of content.experience) {
        if (entry.role) children.push(leftRight(entry.role.organization, entry.role.period), body(entry.role.title, true, 40))
        else children.push(body(entry.heading.text, true, 40))
        children.push(...entry.bullets.map((line) => bullet(line.text)))
      }
    }
    if (content.education.length > 0) {
      children.push(heading(RESUME_SECTION_TITLES.Education))
      content.education.forEach((line, index) => {
        const role = content.educationRoles?.[index]
        if (role) {
          if (role.organization) children.push(leftRight(role.organization, null))
          children.push(body(role.title, true))
        } else {
          children.push(body(line.text))
        }
      })
    }
    if (content.skills.length > 0) {
      children.push(heading(RESUME_SECTION_TITLES.Skills))
      for (const line of content.skills) {
        const parts = skillParts(line.text)
        if (parts) children.push(body(parts.label, true, 0), body(parts.items, false, 120))
        else children.push(body(line.text))
      }
    }
  }
  const document = new Document({
    creator: "eve",
    title: titleOf(content),
    styles: { default: { document: { run: { font: "Arial", size: 21 } } } },
    sections: [{ children }],
  })
  return Packer.toBuffer(document)
}

/**
 * F-QA4-03: pdfkit applies the AFM kerning pairs of the standard fonts by
 * writing each pair as a separate text run with an offset ("T" -120 "ype").
 * pdf.js joins them, but pypdf-style extractors (and some ATS parsers) read
 * "T ypeScript". pdfkit has no switch for standard fonts, so the current font's
 * pair table is emptied: widths for line breaking then match the emitted text,
 * and every word is written as one run.
 */
function withoutKerning(pdf: PDFKit.PDFDocument): void {
  const font = (pdf as unknown as { _font?: { font?: { kernPairs?: Record<string, number> } } })._font?.font
  if (font?.kernPairs && Object.keys(font.kernPairs).length > 0) font.kernPairs = {}
}

/** The PDF's text, as a reader or ATS would select it, whitespace collapsed. */
export async function extractPdfText(pdf: Buffer): Promise<string> {
  const document = await getDocumentProxy(new Uint8Array(pdf))
  try {
    const { text } = await extractText(document, { mergePages: true })
    return collapse(text)
  } finally {
    await document.cleanup()
  }
}

export type PdfTextCheck = Readonly<{ ok: true }> | Readonly<{ ok: false; missing: string[] }>

/**
 * AC 5.2 automated check: every line of the source content appears in the
 * extracted PDF text, in order. Whitespace and line wrapping are ignored.
 */
export async function verifyPdfText(pdf: Buffer, content: DocumentContent, contact: ContactHeader): Promise<PdfTextCheck> {
  // A line may wrap after a hyphen ("Sequelize-" / "ORM"), which reads back as "Sequelize- ORM": both
  // sides drop the space after a hyphen, so the same words still match and no word can be added or lost.
  const text = joinHyphens(await extractPdfText(pdf))
  const missing: string[] = []
  let from = 0
  for (const line of plainTextOf(content, contact)) {
    const expected = joinHyphens(collapse(pdfSafe(line)))
    if (expected === "") continue
    const at = text.indexOf(expected, from)
    if (at < 0) missing.push(line)
    else from = at + expected.length
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

/**
 * C0/C1 control characters other than tab and newline are not allowed in XML
 * 1.0 and would make word/document.xml malformed (SEC-407). Removed from every
 * rendered string, in both formats, so the PDF check and the DOCX agree.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

export function stripControls(text: string): string {
  return text.replace(CONTROLS, "")
}

function docxSafe(text: string): string {
  return stripControls(text)
}

/** Windows-1252 characters Helvetica can draw beyond Latin-1. */
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ")

/** Keeps Windows-1252 text as is and reduces anything else to its base letters (or drops it). */
export function pdfSafe(text: string): string {
  let out = ""
  for (const char of asciiDigits(stripControls(text)).replace(/\p{Default_Ignorable_Code_Point}/gu, "")) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(char)) out += char
    else if (char === "\t" || char === "\n") out += " "
    else out += char.normalize("NFKD").replace(/[^\x20-\x7e\xa0-\xff]/g, "")
  }
  return out
}

function joinHyphens(text: string): string {
  return text.replace(/-\s+/g, "-")
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function titleOf(content: DocumentContent): string {
  return content.kind === "resume" ? "Resume" : "Cover letter"
}

/**
 * Word integrity, the second check (F-QA4-03). Reads the uncompressed content
 * stream the way a strict extractor does: every TJ array element that is
 * followed by a positioning number is treated as a word boundary. Returns the
 * fragments where a number sits inside a word (letter on both sides).
 */
export function splitWordsInContent(uncompressedPdf: Buffer): string[] {
  const source = uncompressedPdf.toString("latin1")
  const splits: string[] = []
  for (const match of source.matchAll(/\[((?:<[0-9a-fA-F]*>\s*-?\d*\.?\d*\s*)+)\]\s*TJ/g)) {
    const parts = [...(match[1] ?? "").matchAll(/<([0-9a-fA-F]*)>\s*(-?\d*\.?\d*)/g)]
    for (let index = 0; index < parts.length - 1; index++) {
      const left = hexText(parts[index]?.[1] ?? "")
      const offset = parts[index]?.[2] ?? ""
      const right = hexText(parts[index + 1]?.[1] ?? "")
      if (offset !== "" && Number(offset) !== 0 && /\p{L}$/u.test(left) && /^\p{L}/u.test(right)) {
        splits.push(`${left.slice(-12)}|${right.slice(0, 12)}`)
      }
    }
  }
  return splits
}

/** The word-integrity check over a rendered, uncompressed PDF: no word of the source is split. */
export function wordIntegrity(uncompressedPdf: Buffer, content: DocumentContent, contact: ContactHeader): PdfTextCheck {
  const splits = splitWordsInContent(uncompressedPdf)
  if (splits.length === 0) return { ok: true }
  // Report the source words that were split, so the failure names real text.
  const words = plainTextOf(content, contact).flatMap((line) => pdfSafe(line).split(/\s+/))
  const missing = [...new Set(splits.map((split) => words.find((word) => word.includes(split.replace("|", ""))) ?? split))]
  return { ok: false, missing }
}

function hexText(hex: string): string {
  let out = ""
  for (let index = 0; index + 1 < hex.length; index += 2) out += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16))
  return out
}
