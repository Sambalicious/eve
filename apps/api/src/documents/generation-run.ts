import type { StoredSection } from "../db/schema.js"
import { type atsKeywords, containsKeyword, normaliseForAts } from "../ats/ats-score.js"
import type { GenerationAddedFacts } from "../added-facts/generation-facts.js"
import { oneLinerId, skillOnlyId } from "./added-fact-ids.js"
import type { ClaimContext, LetterTarget } from "./claim-types.js"
import type { AliasedAddedFact, aliasAddedFacts, aliasFacts } from "./document-generation.js"
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
  /** FEAT-0017: the added facts this generation may cite, and what the stored snapshot records. */
  effective: GenerationAddedFacts
  /** FEAT-0017: the added-facts counter read at the start; the record refuses the write when it changed. */
  addedFactsVersion: number
  /** FEAT-0017: the citable added facts' text, so the ATS score counts a ticked term as stated. */
  addedText: string
  /** FEAT-0017: the added facts' aliases, numbered on after the profile's own. */
  aliasedAdded: ReturnType<typeof aliasAddedFacts>
  /** FEAT-0017: `sections` plus each added fact appended as a fact, so a one-liner's support text is its role. */
  claimSections: readonly StoredSection[]
  /** What the generation prompt names: the posting's company, role title and text. */
  promptTarget: Readonly<{ company: string | null; roleTitle: string | null; text: string }>
  aliased: ReturnType<typeof aliasFacts>
  keywords: ReturnType<typeof atsKeywords>
  atsTargets: ReadonlyArray<Readonly<{ keyword: string; factIds: string[] }>>
  /** The profile's own text, for the ATS score's gap list. */
  profileText: string
  direction: readonly string[]
  sectionOfFact: ReadonlyMap<string, string>
  /** Each fact's own text by id, profile and added. */
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
 * FEAT-0017: the sections the claim checks read. A one-liner joins its own role's section as a fact, so
 * `withRoleHeadings` prints it under the role the Candidate picked and the role heading is its support text;
 * the skill-only facts join one synthetic, titleless Skills section, so the term alone is their support text.
 */
export function claimSectionsOf(sections: readonly StoredSection[], effective: GenerationAddedFacts): StoredSection[] {
  const claim = sections.map((section) => ({ ...section, facts: [...section.facts] }))
  const roles = new Map(claim.filter((section) => section.kind === "experience").map((section) => [section.id, section]))
  const skillOnly: StoredSection["facts"] = []
  for (const fact of effective.citable) {
    if (fact.kind === "skill_only") {
      skillOnly.push({ id: skillOnlyId(fact.id), text: fact.text, sourceQuote: null })
      continue
    }
    const role = fact.roleSectionId === null ? undefined : roles.get(fact.roleSectionId)
    if (role) role.facts.push({ id: oneLinerId(fact.id), text: fact.text, sourceQuote: null })
  }
  if (skillOnly.length > 0) claim.push({ id: "added-skills", kind: "skills", title: "", organization: null, period: null, sourceQuote: null, facts: skillOnly })
  return claim
}

/**
 * ATS: the posting's keywords that the profile states, each with up to three (aliased) facts that state it.
 * A keyword the profile never states is left out. FEAT-0017: an added fact states a term too, so a ticked
 * term is not a gap.
 */
export function atsTargetsOf(
  keywords: ReturnType<typeof atsKeywords>,
  aliased: ReturnType<typeof aliasFacts>,
  addedFacts: readonly AliasedAddedFact[] = []
): Array<{ keyword: string; factIds: string[] }> {
  return keywords.flatMap(({ keyword }) => {
    const stating = [
      ...aliased.sections.flatMap((section) => section.facts.filter((fact) => containsKeyword(normaliseForAts(fact.text), keyword)).map((fact) => fact.id)),
      ...addedFacts.filter((fact) => containsKeyword(normaliseForAts(fact.text), keyword)).map((fact) => fact.alias),
    ]
    return stating.length > 0 ? [{ keyword, factIds: stating.slice(0, 3) }] : []
  })
}
