import type { StoredSection } from "../db/schema.js"
import { type atsKeywords, containsKeyword, normaliseForAts } from "../ats/ats-score.js"
import type { ClaimContext, LetterTarget } from "./claim-types.js"
import type { aliasFacts } from "./document-generation.js"
import type { ContactHeader, CoverLetterContent, DocumentContent, DocumentKind, ResumeContent } from "./document-model.js"

/**
 * What every stage of one generation reads: the Application, the approved profile, the posting's keywords and
 * direction quotes, and the claim context for the letter. Built once by `prepare`; no stage changes it.
 */
export type GenerationRun = Readonly<{
  applicationId: string
  profileVersion: number
  roleTitle: string | null
  contact: ContactHeader
  sections: readonly StoredSection[]
  /** What the generation prompt names: the posting's company, role title and text. */
  promptTarget: Readonly<{ company: string | null; roleTitle: string | null; text: string }>
  aliased: ReturnType<typeof aliasFacts>
  keywords: ReturnType<typeof atsKeywords>
  atsTargets: ReadonlyArray<Readonly<{ keyword: string; factIds: string[] }>>
  /** The profile's own text, for the ATS score's gap list. */
  profileText: string
  direction: readonly string[]
  sectionOfFact: ReadonlyMap<string, string>
  /** Each fact's own text by id. */
  wording: ReadonlyMap<string, string>
  letterTarget: LetterTarget
  /** The claim context with the letter's target and no meaning-check verdicts yet. */
  claims: ClaimContext
}>

/** The model's draft, with fact ids resolved and the backend's role headings added. */
export type Draft = Readonly<{ resume: ResumeContent; letter: CoverLetterContent }>

/** The judge's verdicts. `supported` are the paragraph and line verdicts; `checked` adds the sentence ones. */
export type Verdicts = Readonly<{ failed: boolean; supported: ReadonlySet<string>; checked: ReadonlySet<string> }>

/** The documents after every repair, scored and ready to validate, with the letter's final verdicts. */
export type Repaired = Readonly<{
  documents: ReadonlyArray<readonly [DocumentKind, DocumentContent]>
  letter: CoverLetterContent
  checked: ReadonlySet<string>
}>

/**
 * ATS: the posting's keywords that the profile states, each with up to three (aliased) facts that state it.
 * A keyword the profile never states is left out.
 */
export function atsTargetsOf(keywords: ReturnType<typeof atsKeywords>, aliased: ReturnType<typeof aliasFacts>): Array<{ keyword: string; factIds: string[] }> {
  return keywords.flatMap(({ keyword }) => {
    const stating = aliased.sections.flatMap((section) => section.facts.filter((fact) => containsKeyword(normaliseForAts(fact.text), keyword)).map((fact) => fact.id))
    return stating.length > 0 ? [{ keyword, factIds: stating.slice(0, 3) }] : []
  })
}
