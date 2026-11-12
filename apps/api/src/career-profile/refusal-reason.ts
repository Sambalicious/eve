import type { ResumeRefusalReason } from "@eve/contracts"

/**
 * Every refusal reason extraction can produce by name: from resume-text.ts,
 * the parser child (resume-text-parsers.ts) and the DOCX preflight. Typed, so
 * renaming one without updating REFUSAL_REASON_BY_KNOWN is a compile error
 * (CR-03). pdf.js may also report an exception name; that is not in this list
 * and maps to `no_text`.
 */
export const KNOWN_EXTRACTION_REASONS = [
  "timeout",
  "memory_limit",
  "heap_limit",
  "startup_timeout",
  "output_limit",
  "child_failed",
  "too_short",
  "too_long",
  "too_many_pages",
  "too_much_text",
  "not_a_docx",
  "too_many_entries",
  "too_large_uncompressed",
  "compression_ratio",
  "parse_error",
] as const
export type KnownExtractionReason = (typeof KNOWN_EXTRACTION_REASONS)[number]

export const REFUSAL_REASON_BY_KNOWN: Readonly<Record<KnownExtractionReason, ResumeRefusalReason>> = {
  too_many_pages: "pages",
  too_long: "characters",
  too_much_text: "characters",
  // The child's text output is capped at 1 MB, far above 60,000 characters.
  output_limit: "characters",
  too_many_entries: "docx_limits",
  too_large_uncompressed: "docx_limits",
  compression_ratio: "docx_limits",
  timeout: "parse_limits",
  memory_limit: "parse_limits",
  heap_limit: "parse_limits",
  // A child that never finished loading is a server-side fault, not the file's;
  // it is still reported as a parse limit so the Candidate is told nothing was sent.
  startup_timeout: "parse_limits",
  // The file had no text the parsers could read.
  too_short: "no_text",
  not_a_docx: "no_text",
  parse_error: "no_text",
  child_failed: "no_text",
}

function isKnown(reason: string): reason is KnownExtractionReason {
  return (KNOWN_EXTRACTION_REASONS as readonly string[]).includes(reason)
}

/** The contract reason for an extraction refusal. An unknown name (a pdf.js exception) is `no_text`. */
export function refusalReasonFor(internalReason: string): ResumeRefusalReason {
  return isKnown(internalReason) ? REFUSAL_REASON_BY_KNOWN[internalReason] : "no_text"
}
