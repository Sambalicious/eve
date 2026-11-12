import { crc32, deflateRawSync } from "node:zlib"

/**
 * Builds synthetic resume files in memory. No real CV is used anywhere in the
 * tests: the text below is invented for a fictional Candidate.
 */
export const SYNTHETIC_RESUME_LINES = [
  "Ada Okafor",
  "Senior Frontend Engineer, Lagos, Nigeria",
  "Brightwave Ltd, Senior Frontend Engineer, 2021-2024",
  "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024",
  "Cut checkout page load time by 38% by moving to server rendering",
  "Kora Payments, Frontend Engineer, 2018-2021",
  "Built the merchant dashboard in React and TypeScript",
  "University of Lagos, BSc Computer Science, 2017",
  "Skills: React, TypeScript, Node.js, GraphQL",
] as const

/**
 * A one-page PDF 1.4 whose text layer holds `lines`, with a valid xref table.
 * `padToBytes` adds a comment line after the header so the file is exactly that size.
 */
export function buildPdf(lines: readonly string[] = SYNTHETIC_RESUME_LINES, options: { padToBytes?: number } = {}): Buffer {
  if (options.padToBytes !== undefined) {
    let padding = 0
    for (let attempt = 0; attempt < 4; attempt++) {
      const size = buildPdfWithPadding(lines, padding).length
      if (size === options.padToBytes) return buildPdfWithPadding(lines, padding)
      padding += options.padToBytes - size
    }
    throw new Error(`could not pad the PDF to ${options.padToBytes} bytes`)
  }
  return buildPdfWithPadding(lines, 0)
}

function buildPdfWithPadding(lines: readonly string[], padding: number): Buffer {
  const escape = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`)
  const stream = [
    "BT",
    "/F1 11 Tf",
    "14 TL",
    "50 780 Td",
    ...lines.map((line) => `(${escape(line)}) Tj T*`),
    "ET",
  ].join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let body = padding > 0 ? `%PDF-1.4\n%${"x".repeat(Math.max(padding - 2, 0))}\n` : "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(body, "latin1")
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body, "latin1")
}

/** A minimal WordprocessingML document, one paragraph per line, plus optional extra zip entries. */
export function buildDocx(
  lines: readonly string[] = SYNTHETIC_RESUME_LINES,
  extraEntries: readonly (readonly [string, string])[] = []
): Buffer {
  const xmlEscape = (text: string) => text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c)
  const paragraphs = lines.map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`).join("")
  return buildZip([
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
    ],
    ...extraEntries,
  ])
}

/** A DOCX whose `word/document.xml` body is exactly `bodyXml`. */
export function buildRawDocx(bodyXml: string): Buffer {
  return buildZip([
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    ["word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`],
  ])
}

/** A zip that is not a Word document (no word/document.xml). */
export function buildPlainZip(): Buffer {
  return buildZip([["notes.txt", "hello"]])
}

/** 1x1 PNG. */
export const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000050001a5f645400000000049454e44ae426082",
  "hex"
)

function buildZip(entries: readonly (readonly [string, string])[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of entries) {
    const data = Buffer.from(text, "utf8")
    const compressed = deflateRawSync(data)
    const nameBytes = Buffer.from(name, "utf8")
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + compressed.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}
