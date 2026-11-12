/**
 * Child process entry for resume text extraction (SEC-201). The parent sends the
 * file on stdin and reads one JSON line on stdout. This process holds nothing
 * else: no database, no secrets, no network use. The parent bounds its heap,
 * resident memory, start-up time, parse time and output size, and kills it on any
 * breach. The child writes "ready" once its modules are loaded, then reads the file.
 */
import { readPeakRssKb } from "./peak-rss.js"
import { extractTextInProcess } from "./resume-text-parsers.js"

/** Written once the parsers are imported. The parent starts the parse deadline only then. */
const READY_LINE = "ready\n"

// pdf.js prints warnings through console.log; stdout carries only the result line.
console.log = () => undefined
console.warn = () => undefined
console.info = () => undefined

const MEDIA_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
])

async function main(): Promise<void> {
  const mediaType = process.argv[2]
  if (!mediaType || !MEDIA_TYPES.has(mediaType)) {
    process.exitCode = 2
    return
  }
  process.stdout.write(READY_LINE)
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const result = await extractTextInProcess(mediaType as Parameters<typeof extractTextInProcess>[0], Buffer.concat(chunks))
  // Peak resident memory of this process in kilobytes (VmHWM on Linux: maxRSS there
  // includes the parent's size at spawn). The parent's sampler can miss a short spike,
  // so it also checks this against the cap.
  const peakRssKb = readPeakRssKb()
  process.stdout.write(`${JSON.stringify({ ...result, peakRssKb })}\n`)
}

await main()
