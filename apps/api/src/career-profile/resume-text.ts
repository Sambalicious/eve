import { execFile, spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { ResumeMediaType } from "@eve/contracts"

import type { KnownExtractionReason } from "./refusal-reason.js"

/** Below this the file holds no usable text (a scanned image, an empty page). */
const MIN_TEXT_LENGTH = 40
/** Well above any resume; bounds the prompt. */
export const MAX_TEXT_LENGTH = 60_000

/**
 * Bounds for the extraction child process (SEC-201). A real resume parses in well
 * under a second with a peak below 150 MB.
 */
export type ExtractionLimits = Readonly<{
  startupTimeoutMs: number
  timeoutMs: number
  heapMb: number
  rssMb: number
  rssSampleMs: number
  maxOutputBytes: number
}>

export const EXTRACTION_LIMITS: ExtractionLimits = {
  /**
   * From spawn until the child reports its parsers are loaded. Node start-up and
   * importing pdf.js and mammoth take about 0.2 s idle but several seconds on a
   * CPU-starved host (measured 3.2-3.9 s with every core busy), and no file content
   * is involved yet, so this has its own bound instead of eating the parse budget.
   */
  startupTimeoutMs: 30_000,
  /** Parsing: from the child's ready signal to its result; the child is killed at this point. */
  timeoutMs: 5_000,
  /** V8 old-space limit of the child. */
  heapMb: 128,
  /**
   * Resident memory of the child: sampled by the parent while it runs (catches native
   * buffers outside the V8 heap) and checked against the peak the child reports at the end.
   */
  rssMb: 384,
  rssSampleMs: 25,
  /** The child's stdout; a result past this is refused unread. */
  maxOutputBytes: 1024 * 1024,
}

/** Why extraction gave no text. Safe to log: it never contains file content. */
export type ExtractionRefusal =
  | KnownExtractionReason
  | (string & {}) // a pdf.js exception name from the child; see refusal-reason.ts

export type ExtractionOutcome = Readonly<{ ok: true; text: string }> | Readonly<{ ok: false; reason: ExtractionRefusal }>

/**
 * Parsing runs in a separate Node process with its own heap, so a hostile file
 * can stall or exhaust only that process (SEC-201). The child is killed when it
 * does not start within `startupTimeoutMs`, parsing passes `timeoutMs` after it
 * reported ready, its resident memory passes the cap, or its output passes the
 * byte limit.
 */
export async function runResumeExtraction(
  mediaType: ResumeMediaType,
  bytes: Buffer,
  limits: ExtractionLimits = EXTRACTION_LIMITS,
  child: ExtractionChild = COMPILED_EXTRACTION_CHILD
): Promise<ExtractionOutcome> {
  const outcome = await runExtractionChild(mediaType, bytes, limits, child)
  if (!outcome.ok) return outcome
  const trimmed = outcome.text.replace(/\n{3,}/g, "\n\n").trim()
  if (trimmed.length < MIN_TEXT_LENGTH) return { ok: false, reason: "too_short" }
  if (trimmed.length > MAX_TEXT_LENGTH) return { ok: false, reason: "too_long" }
  return { ok: true, text: trimmed }
}

function runExtractionChild(
  mediaType: ResumeMediaType,
  bytes: Buffer,
  limits: ExtractionLimits,
  childCommand: ExtractionChild
): Promise<ExtractionOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let output = Buffer.alloc(0)
    const child = spawn(process.execPath, [...childCommand.nodeArgs, `--max-old-space-size=${limits.heapMb}`, childCommand.script, mediaType], {
      // Only what Node needs: no secrets, no database URL, no proxy settings.
      env: EXTRACTION_CHILD_ENV(),
      stdio: ["pipe", "pipe", "ignore"],
    })
    let ready = false
    const finish = (outcome: ExtractionOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      memoryWatch.stop()
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      resolve(outcome)
    }
    // Two deadlines: start-up (spawn to "ready"), then parsing (ready to result).
    let deadline = setTimeout(() => finish({ ok: false, reason: "startup_timeout" }), limits.startupTimeoutMs)
    const memoryWatch = watchResidentMemory(child.pid, limits, () => finish({ ok: false, reason: "memory_limit" }))
    child.stdout.on("data", (chunk: Buffer) => {
      output = Buffer.concat([output, chunk])
      if (!ready && output.length >= READY_LINE.length && output.subarray(0, READY_LINE.length).toString() === READY_LINE) {
        ready = true
        output = output.subarray(READY_LINE.length)
        clearTimeout(deadline)
        deadline = setTimeout(() => finish({ ok: false, reason: "timeout" }), limits.timeoutMs)
        child.stdin.end(bytes)
      }
      if (output.length > limits.maxOutputBytes) finish({ ok: false, reason: "output_limit" })
    })
    child.on("error", () => finish({ ok: false, reason: "child_failed" }))
    // A V8 heap-limit abort ends with SIGABRT ("Reached heap limit") and no output:
    // that is the heap limit, a parse limit, not a file without text.
    child.on("close", (code, signal) =>
      finish(code === 0 ? parseResult(output, limits) : { ok: false, reason: signal === "SIGABRT" ? "heap_limit" : "child_failed" })
    )
    child.stdin.on("error", () => finish({ ok: false, reason: "child_failed" }))
    // The file is sent only after "ready", so no parsing can start before the parse deadline.
  })
}

/**
 * Samples the child's resident memory every `rssSampleMs` without blocking the
 * event loop (CR2-07): reads are asynchronous and at most one is in flight, so a
 * slow `ps` on macOS delays the next sample instead of stalling the api.
 */
function watchResidentMemory(pid: number | undefined, limits: ExtractionLimits, onBreach: () => void): { stop(): void } {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  const sample = async () => {
    if (stopped || pid === undefined) return
    const megabytes = await residentMb(pid)
    if (stopped) return
    if (megabytes > limits.rssMb) {
      onBreach()
      return
    }
    timer = setTimeout(() => void sample(), limits.rssSampleMs)
  }
  timer = setTimeout(() => void sample(), limits.rssSampleMs)
  return {
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}

/** The child's whole environment. Exported for the test that checks no secret is passed. */
export function EXTRACTION_CHILD_ENV(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "production" }
}

/**
 * The child's result. A child whose own peak RSS passed the cap is refused as
 * `memory_limit` whatever it produced: sampling every 25 ms (and less often when
 * the host is busy; gaps up to 775 ms measured) can miss a short spike, and a
 * finished child would otherwise have its result accepted despite breaching the cap.
 */
function parseResult(output: Buffer, limits: ExtractionLimits): ExtractionOutcome {
  try {
    const result = JSON.parse(output.toString("utf8")) as { ok?: unknown; text?: unknown; reason?: unknown; peakRssKb?: unknown }
    if (typeof result.peakRssKb === "number" && result.peakRssKb / 1024 > limits.rssMb) return { ok: false, reason: "memory_limit" }
    if (result.ok === true && typeof result.text === "string") return { ok: true, text: result.text }
    return { ok: false, reason: typeof result.reason === "string" ? result.reason.slice(0, 40) : "child_failed" }
  } catch {
    return { ok: false, reason: "child_failed" }
  }
}

/**
 * Resident set size of a process in MB, from /proc on Linux (the container) and
 * `ps` elsewhere (development machines). 0 when the process is gone.
 */
async function residentMb(pid: number): Promise<number> {
  return (await readProcRss(pid)) ?? (await readPsRss(pid)) ?? 0
}

async function readProcRss(pid: number): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined
  try {
    const match = /VmRSS:\s+(\d+) kB/.exec(await readFile(`/proc/${pid}/status`, "utf8"))
    return match ? Number(match[1]) / 1024 : undefined
  } catch {
    return undefined
  }
}

const execFileAsync = promisify(execFile)

async function readPsRss(pid: number): Promise<number | undefined> {
  if (process.platform === "linux") return undefined
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" })
    const kilobytes = Number(stdout.trim())
    return Number.isFinite(kilobytes) ? kilobytes / 1024 : undefined
  } catch {
    return undefined
  }
}

/** First line the child writes once its modules are loaded (see extract-text.child.ts). */
const READY_LINE = "ready\n"

/** How to start the extraction child: extra Node flags and the script path. */
export type ExtractionChild = Readonly<{ nodeArgs: readonly string[]; script: string }>

/** The compiled child next to this module in `dist` (production and the image). */
export const COMPILED_EXTRACTION_CHILD: ExtractionChild = {
  nodeArgs: [],
  script: fileURLToPath(new URL("./extract-text.child.js", import.meta.url)),
}

/** DI token for the child the controller uses; tests provide the TypeScript-source child. */
export const EXTRACTION_CHILD = Symbol("EXTRACTION_CHILD")
