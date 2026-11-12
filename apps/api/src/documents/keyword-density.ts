/**
 * Rule 3 (EPIC-0012): keywords sparingly. The ATS score rewards coverage, not repetition, so a resume
 * that repeats one keyword or packs four into a line is a keyword dump and scores no better. This module
 * names the lines to repair; the caller replaces each with its plain fact wording. Pure and deterministic:
 * it only reads the generated resume lines and the posting's keywords. Stuffing never blocks a document.
 *
 * Summary lines and experience bullets only. A skills line legitimately lists many keywords, and replacing
 * it with one fact's wording would drop skills and lower the ATS score, which automatic submission holds to
 * a minimum. So skills lines are exempt: they never count toward a keyword's line limit, are never
 * repaired, and are never judged crowded.
 *
 * A keyword occurrence is one of those resume lines the keyword appears in, the same whole-word test the
 * ATS score uses, so aliases ("JS" for "JavaScript") count like the keyword itself.
 */
import { type AtsKeyword, containsKeyword, normaliseForAts } from "../ats/ats-score.js"
import type { DocumentLine, ResumeContent } from "./document-model.js"
import { dedupeLines } from "./line-text.js"

/** More than this many resume lines holding one keyword: the later lines are repaired. */
export const KEYWORD_LINE_LIMIT = 2
/** Four or more distinct posting keywords in one line is a keyword dump. */
export const LINE_KEYWORD_LIMIT = 4

/** A resume line the density check can name. Headings and skills lines are left out: see the module comment. */
export type ResumeLineRef = Readonly<{ id: string; line: DocumentLine }>

export type KeywordDensity = Readonly<{
  /** The lines to repair, in reading order. */
  lineIds: readonly string[]
  /** Each keyword the resume mentions more than `KEYWORD_LINE_LIMIT` times, with its line count. */
  repeated: ReadonlyArray<Readonly<{ keyword: string; count: number }>>
  /** The lines holding `LINE_KEYWORD_LIMIT` or more distinct keywords. */
  crowdedLineIds: readonly string[]
}>

/** The generated, claim-bearing resume lines with stable ids: summary and experience bullets. Skills lines are exempt. */
export function resumeLineRefs(resume: ResumeContent): ResumeLineRef[] {
  return [
    ...resume.summary.map((line, index) => ({ id: summaryId(index), line })),
    ...resume.experience.flatMap((entry, entryIndex) => entry.bullets.map((line, bulletIndex) => ({ id: bulletId(entryIndex, bulletIndex), line }))),
  ]
}

/** The resume lines to repair: the excess mentions of a repeated keyword, and any line holding 4 keywords. */
export function keywordDensity(lines: readonly ResumeLineRef[], keywords: readonly AtsKeyword[]): KeywordDensity {
  const distinct = distinctKeywords(keywords)
  const normalised = lines.map(({ line }) => normaliseForAts(line.text))
  const repeated: Array<{ keyword: string; count: number }> = []
  const excess = new Set<string>()
  for (const { keyword } of distinct) {
    const hits = lines.filter((_, index) => containsKeyword(normalised[index]!, keyword))
    if (hits.length <= KEYWORD_LINE_LIMIT) continue
    repeated.push({ keyword, count: hits.length })
    // Keep the first mentions in reading order; the lines carrying the rest are the ones to repair.
    for (const { id } of hits.slice(KEYWORD_LINE_LIMIT)) excess.add(id)
  }
  const crowdedLineIds = lines.filter((_, index) => matchedIn(normalised[index]!, distinct).length >= LINE_KEYWORD_LIMIT).map(({ id }) => id)
  return { lineIds: [...new Set([...excess, ...crowdedLineIds])], repeated, crowdedLineIds }
}

/**
 * Replaces each flagged line with the plain wording of the first fact it cites, the same fallback the claim
 * repair uses. A line with no fact, or a fact with no wording, is left as written so the document still
 * never blocks over density. After repair, each list is de-duplicated with `sameLine`, keeping the first
 * copy (Revision 2, R13): one entry never prints the same bullet twice, whatever the order. The list is
 * never left empty, and the dropped repair still counts as a repair.
 */
export function repairDenseLines(
  resume: ResumeContent,
  lineIds: Iterable<string>,
  wording: ReadonlyMap<string, string>
): Readonly<{ resume: ResumeContent; replaced: number }> {
  const flagged = new Set(lineIds)
  let replaced = 0
  const repairList = (lines: readonly DocumentLine[], idOf: (index: number) => string): DocumentLine[] => {
    const kept: DocumentLine[] = []
    lines.forEach((line, index) => {
      if (!flagged.has(idOf(index))) {
        kept.push(line)
        return
      }
      const first = line.factIds[0]
      const plain = first === undefined ? undefined : wording.get(first)
      if (first === undefined || plain === undefined) {
        kept.push(line)
        return
      }
      replaced += 1
      kept.push({ text: plain, factIds: [first] })
    })
    return dedupeLines(kept)
  }
  return {
    resume: {
      ...resume,
      summary: repairList(resume.summary, summaryId),
      experience: resume.experience.map((entry, entryIndex) => ({
        ...entry,
        bullets: repairList(entry.bullets, (bulletIndex) => bulletId(entryIndex, bulletIndex)),
      })),
    },
    replaced,
  }
}

/** Keywords by normalised form, first seen. Two forms the ATS treats as one keyword count once. */
function distinctKeywords(keywords: readonly AtsKeyword[]): AtsKeyword[] {
  const seen = new Set<string>()
  return keywords.filter(({ keyword }) => {
    const form = normaliseForAts(keyword)
    if (seen.has(form)) return false
    seen.add(form)
    return true
  })
}

function matchedIn(normalisedText: string, keywords: readonly AtsKeyword[]): AtsKeyword[] {
  return keywords.filter(({ keyword }) => containsKeyword(normalisedText, keyword))
}

function summaryId(index: number): string {
  return `summary:${index}`
}

function bulletId(entry: number, bullet: number): string {
  return `experience:${entry}:bullet:${bullet}`
}
