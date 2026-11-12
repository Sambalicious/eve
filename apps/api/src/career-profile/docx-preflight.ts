import { inflateRawSync } from "node:zlib"

/**
 * Limits checked before mammoth sees a DOCX (SEC-201). A real resume's
 * `word/document.xml` is tens to hundreds of KB and compresses 5:1 to 15:1.
 */
export const DOCX_LIMITS = {
  /** Entries in the zip. Word writes about 10 to 30; images add a few. */
  maxEntries: 200,
  /** Total uncompressed bytes across all entries. */
  maxTotalUncompressedBytes: 20 * 1024 * 1024,
  /** Uncompressed bytes of any one entry. */
  maxEntryUncompressedBytes: 8 * 1024 * 1024,
  /** Uncompressed / compressed, per deflated entry above `ratioCheckMinBytes`. */
  maxCompressionRatio: 100,
  ratioCheckMinBytes: 1024 * 1024,
} as const

export type DocxPreflight =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "not_a_docx" | "too_many_entries" | "too_large_uncompressed" | "compression_ratio" }>

type CentralEntry = { name: string; method: number; compressedSize: number; localHeaderOffset: number }

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const STORED = 0
const DEFLATED = 8

/**
 * Reads the zip's central directory and inflates every entry with a hard output
 * cap, so sizes declared in the headers are never trusted. Never throws.
 */
export function preflightDocx(bytes: Buffer): DocxPreflight {
  const entries = readCentralDirectory(bytes)
  if (!entries || !entries.some((entry) => entry.name === "word/document.xml")) return { ok: false, reason: "not_a_docx" }
  if (entries.length > DOCX_LIMITS.maxEntries) return { ok: false, reason: "too_many_entries" }
  let total = 0
  for (const entry of entries) {
    const size = inflatedSize(bytes, entry, DOCX_LIMITS.maxTotalUncompressedBytes - total)
    if (size === "corrupt") return { ok: false, reason: "not_a_docx" }
    if (size === "over_limit" || size > DOCX_LIMITS.maxEntryUncompressedBytes) return { ok: false, reason: "too_large_uncompressed" }
    total += size
    if (
      entry.method === DEFLATED &&
      size >= DOCX_LIMITS.ratioCheckMinBytes &&
      size / Math.max(entry.compressedSize, 1) > DOCX_LIMITS.maxCompressionRatio
    ) {
      return { ok: false, reason: "compression_ratio" }
    }
  }
  return { ok: true }
}

function readCentralDirectory(bytes: Buffer): CentralEntry[] | undefined {
  const eocd = findEndOfCentralDirectory(bytes)
  if (eocd === undefined) return undefined
  const count = bytes.readUInt16LE(eocd + 10)
  let offset = bytes.readUInt32LE(eocd + 16)
  const entries: CentralEntry[] = []
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) return undefined
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    if (offset + 46 + nameLength > bytes.length) return undefined
    entries.push({
      method: bytes.readUInt16LE(offset + 10),
      compressedSize: bytes.readUInt32LE(offset + 20),
      localHeaderOffset: bytes.readUInt32LE(offset + 42),
      name: bytes.toString("utf8", offset + 46, offset + 46 + nameLength),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function findEndOfCentralDirectory(bytes: Buffer): number | undefined {
  // The record is 22 bytes plus a comment of at most 65,535 bytes.
  const earliest = Math.max(0, bytes.length - 22 - 0xffff)
  for (let offset = bytes.length - 22; offset >= earliest; offset--) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return undefined
}

/** Uncompressed size of one entry, inflating at most `budget` bytes. */
function inflatedSize(bytes: Buffer, entry: CentralEntry, budget: number): number | "over_limit" | "corrupt" {
  const local = entry.localHeaderOffset
  if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== LOCAL_SIGNATURE) return "corrupt"
  const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > bytes.length) return "corrupt"
  const data = bytes.subarray(dataStart, dataEnd)
  if (entry.method === STORED) return data.length > budget ? "over_limit" : data.length
  if (entry.method !== DEFLATED) return "corrupt"
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(budget, 1) }).length
  } catch (error) {
    return (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "over_limit" : "corrupt"
  }
}
