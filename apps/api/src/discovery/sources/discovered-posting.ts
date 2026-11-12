import { isWebUrl } from "../application-url.js"
import type { EmploymentType, StructuredFields } from "../rules/eligibility.js"
import type { DateCandidate } from "./posted-date.js"

/** One posting as a Job Source reports it, before it is stored or evaluated. */
export type DiscoveredPosting = Readonly<{
  /** Employer application URL (or the board's own page for a remote-board posting with no ATS link). */
  applicationUrl: string
  /** Requisition ID, or the Application System's posting ID as the fallback (architecture r1). */
  requisitionId: string
  /** Where Apply starts. Himalayas: the API's applicationLink, always. */
  applyUrl: string
  title: string
  company: string
  /** Plain text of the posting. Untrusted. */
  text: string
  structured: StructuredFields
  /** Board credit to show, with a followed link (remote boards only). */
  attribution: Readonly<{ name: string; url: string }> | null
  /** True when the board's terms forbid automatic submission (Himalayas). */
  manualOnly: boolean
  /**
   * EPIC-0006 (AC-5.2): the source's date fields in preference order, parsed
   * but not yet bounded. The pipeline picks the first one within the AC-5.4
   * bounds of its read moment (`resolvePostedDate`). Empty: undated.
   */
  postedDate: readonly DateCandidate[]
}>

export const EMPTY_STRUCTURED: StructuredFields = {
  workplace: null,
  locationRestrictions: null,
  pay: null,
  employmentType: null,
}

export function employmentTypeFrom(value: string | null | undefined): EmploymentType | null {
  const folded = (value ?? "").toLowerCase()
  if (/contract|freelance/.test(folded)) return "contract"
  if (/full|part|permanent|employee/.test(folded)) return "direct"
  return null
}

/** Strips tags and decodes the common entities. Never used to render HTML. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
      .replace(/<\s*(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d{1,10});/g, (_m, code: string) => codePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]{1,8});/gi, (_m, code: string) => codePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&")
}

/** A character for a numeric reference; out-of-range values and surrogates become U+FFFD instead of throwing (SEC-304). */
function codePoint(value: number): string {
  const valid = Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
  return valid ? String.fromCodePoint(value) : "\uFFFD"
}

/**
 * Keeps only postings whose application, apply and attribution URLs are http(s)
 * (SEC-301). One bad posting is dropped; the rest of the board is kept.
 */
export function onlyWebUrls(postings: readonly DiscoveredPosting[]): DiscoveredPosting[] {
  return postings.filter(
    (posting) => isWebUrl(posting.applicationUrl) && isWebUrl(posting.applyUrl) && (posting.attribution === null || isWebUrl(posting.attribution.url))
  )
}

/** The first http(s) URL among the candidates, or undefined. */
export function firstWebUrl(...candidates: ReadonlyArray<string | null | undefined>): string | undefined {
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && isWebUrl(candidate))
}
