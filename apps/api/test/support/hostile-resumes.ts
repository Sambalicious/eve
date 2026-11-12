import { crc32, deflateRawSync, deflateSync } from "node:zlib"

/**
 * Hostile resume files for SEC-201, built in memory at test time so no large or
 * malicious file is committed. Each one is a valid PDF or DOCX by content sniffing.
 */

type ZipEntry = Readonly<{ name: string; data: Buffer; declaredSize?: number }>

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
const DOC_OPEN = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
const DOC_CLOSE = "</w:body></w:document>"

/** The reviewer's paragraph bomb: `count` tiny paragraphs (397 KB at 4 million hung the api). */
export function paragraphBombDocx(count: number): Buffer {
  const paragraph = Buffer.from("<w:p><w:r><w:t>x</w:t></w:r></w:p>")
  const xml = Buffer.concat([Buffer.from(DOC_OPEN), Buffer.alloc(paragraph.length * count).fill(paragraph), Buffer.from(DOC_CLOSE)])
  return docx(xml)
}

/**
 * One paragraph holding `megabytes` of text, which deflates about 1000:1. With
 * `lieAboutSize` the zip headers declare a tiny uncompressed size, so only a
 * bounded inflate can catch it.
 */
export function zipBombDocx(megabytes: number, options: { lieAboutSize?: boolean } = {}): Buffer {
  const text = Buffer.alloc(megabytes * 1024 * 1024, "a")
  const xml = Buffer.concat([Buffer.from(`${DOC_OPEN}<w:p><w:r><w:t>`), text, Buffer.from(`</w:t></w:r></w:p>${DOC_CLOSE}`)])
  return docx(xml, options.lieAboutSize ? 4096 : undefined)
}

/** A one-page PDF whose content stream inflates to `megabytes` of zeros (pdf.js decodes it natively). */
export function flateBombPdf(megabytes: number): Buffer {
  const stream = deflateSync(Buffer.alloc(megabytes * 1024 * 1024, 0), { level: 9 })
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from("\nendstream")]),
  ])
}

/**
 * A PDF whose pages each hold the given lines, laid out in columns of tiny text so
 * every line sits inside the page box (pdf.js drops text that runs off the page).
 */
export function textPdf(pages: readonly (readonly string[])[]): Buffer {
  const escape = (line: string) => line.replace(/[\\()]/g, (c) => `\\${c}`)
  // Columns of 2 pt text, 110 lines tall, so a page holds about 2,000 short lines inside its box.
  const contents = pages.map((lines) => {
    const ops = ["BT", "/F1 2 Tf"]
    lines.forEach((line, i) => {
      const column = Math.floor(i / 110)
      const row = i % 110
      ops.push(`1 0 0 1 ${10 + column * 30} ${780 - row * 7} Tm (${escape(line)}) Tj`)
    })
    ops.push("ET")
    return Buffer.from(ops.join("\n"))
  })
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")
  const objects: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  contents.forEach((content, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]))
  })
  return pdf(objects)
}

/** A PDF with `pages` pages of real text: far more than a resume. */
export function manyPagesPdf(pages: number): Buffer {
  const content = Buffer.from("BT /F1 11 Tf 50 780 Td (Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024) Tj ET")
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i} 0 R`).join(" ")
  const pageObjects = Array.from(
    { length: pages },
    () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${4 + pages} 0 R >>`
  )
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pageObjects,
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
  ])
}

function docx(documentXml: Buffer, declaredDocumentSize?: number): Buffer {
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES) },
    { name: "_rels/.rels", data: Buffer.from(RELS) },
    { name: "word/document.xml", data: documentXml, declaredSize: declaredDocumentSize },
  ])
}

function pdf(objects: readonly (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")]
  let length = parts[0]!.length
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(length)
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from("\nendobj\n")])
    parts.push(chunk)
    length += chunk.length
  })
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`
  parts.push(Buffer.from(xref))
  return Buffer.concat(parts)
}

function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data, { level: 9 })
    const name = Buffer.from(entry.name)
    const size = entry.declaredSize ?? entry.data.length
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + compressed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
