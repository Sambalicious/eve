import { factClaimsMissing } from "../career-profile/claim-check.js"
import type { CoverLetterContent, DocumentContent, DocumentLine, ResumeContent } from "./document-model.js"
import { addedRowId, isAddedId, isSkillOnlyId, oneLinerId } from "./added-fact-ids.js"

/**
 * FEAT-0017 truth guard: where a skill-only fact may be cited, the hedge rule for
 * every line citing an added fact, and the deterministic strip that repairs a
 * misplaced citation before the hard fail in `checkLine` becomes a block.
 *
 * The rules (architecture "Placement rule in code", PRD 5.3 to 5.5, 10.4):
 *
 * - A skill-only fact says only "I have used this". It may be cited by a resume
 *   Skills line, or by a cover-letter paragraph that cites skill-only facts only
 *   (so its support text is the terms alone and any employer, number, title or
 *   level in it fails the existing claim check). Every other kind is a hard fail
 *   `skill_only_in_bullet`, alone or with other facts.
 * - A line citing any added fact may not hedge it: an aspiration phrase that no
 *   cited fact states is a hard fail `added_fact_hedge` (PRD 3.4, 10.7).
 *
 * Both are hard fails: no meaning-check answer releases them.
 */

/** Architect-owned aspiration list (PRD 3.3), matched as whole words, case-insensitive. Past tense is allowed. */
export const ASPIRATION_PHRASES: readonly string[] = [
  "learning",
  "want to learn",
  "wants to learn",
  "will learn",
  "going to learn",
  "plan to",
  "planning to",
  "hope to",
  "looking to",
  "aspire",
  "aspiring",
  "interested in",
  "familiar with",
  "familiarity with",
  "exposure to",
  "currently studying",
]

/** The refusal message the add form shows for `aspiration_text` (PRD 3.3). */
export const ASPIRATION_MESSAGE = "Write only what you have done."

/** A failure kind this module raises; structurally part of `DocumentValidation`. */
export type AddedFactHardFail = "skill_only_in_bullet" | "added_fact_hedge"

export type AddedFactFailure = Readonly<{
  ok: false
  reason: "unsupported_claim"
  claim: string
  unsupported: string[]
  hardFail: AddedFactHardFail
}>

/** The line kinds the placement rule knows; the same set `document-claims` uses. */
export type AddedFactLineKind =
  | "summary"
  | "experience_heading"
  | "experience_bullet"
  | "skills"
  | "education"
  | "letter_paragraph"
  | "outreach_ask"

/** Lower case, accents and invisible characters removed, every non-letter/digit run as one space (the `foldWords` fold). */
export function foldForPhrases(text: string): string {
  return text
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** The first aspiration phrase the text holds as whole words, or null. */
export function aspirationPhraseIn(text: string): string | null {
  const folded = ` ${foldForPhrases(text)} `
  return ASPIRATION_PHRASES.find((phrase) => folded.includes(` ${phrase} `)) ?? null
}

/** The skill-only fact ids a line cites. */
export function skillOnlyIds(factIds: readonly string[]): string[] {
  return factIds.filter(isSkillOnlyId)
}

/**
 * The placement failure for a line, or null. `skill_only_in_bullet` when a
 * skill-only id is cited outside a Skills line or a skill-only letter paragraph;
 * `added_fact_hedge` when a hedged phrase is in the line and no cited fact states it.
 */
export function addedFactFailure(line: DocumentLine, kind: AddedFactLineKind, facts: ReadonlyMap<string, string>): AddedFactFailure | null {
  const skillOnly = skillOnlyIds(line.factIds)
  if (skillOnly.length > 0) {
    const allowed = kind === "skills" || (kind === "letter_paragraph" && skillOnly.length === line.factIds.length)
    if (!allowed) return { ok: false, reason: "unsupported_claim", claim: line.text, unsupported: [], hardFail: "skill_only_in_bullet" }
  }
  // A letter paragraph that mentions a skill-only fact must be a plain mention (PRD 5.4, 10.4): the support text is the
  // terms alone, so any other content word (an outcome, a level, an employer, a number) is a hard fail no judge can release.
  if (kind === "letter_paragraph" && skillOnly.length > 0 && skillOnly.length === line.factIds.length) {
    const support = line.factIds.map((id) => facts.get(id) ?? "").join(". ")
    if (factClaimsMissing(line.text, support, { documentWords: true, meaningChecked: false }).length > 0) {
      return { ok: false, reason: "unsupported_claim", claim: line.text, unsupported: [], hardFail: "skill_only_in_bullet" }
    }
  }
  if (!line.factIds.some(isAddedId)) return null
  const phrase = aspirationPhraseIn(line.text)
  if (phrase === null) return null
  const support = ` ${line.factIds.map((id) => foldForPhrases(facts.get(id) ?? "")).join(" ")} `
  if (support.includes(` ${phrase} `)) return null
  return { ok: false, reason: "unsupported_claim", claim: line.text, unsupported: [phrase], hardFail: "added_fact_hedge" }
}

/** What a strip did: the repaired documents and how many lines lost a misplaced citation or were dropped. */
export type StrippedDocuments = Readonly<{ resume: ResumeContent; letter: CoverLetterContent; stripped: number }>

function withoutSkillOnly(line: DocumentLine): DocumentLine {
  const factIds = line.factIds.filter((id) => !isSkillOnlyId(id))
  return factIds.length === line.factIds.length ? line : { text: line.text, factIds }
}

/**
 * Removes a skill-only citation from the lines where the placement rule forbids
 * it, before the hard fail becomes a block (architecture "Strip repair"). A line
 * left with no ids is dropped; an experience entry keeps its heading. After the
 * strip a line that still names the skill fails `gap` or `claim_word`, so nothing
 * untrue is waved through, and `validateDocument` still hard-fails as the backstop.
 */
export function stripMisplacedSkillOnly(resume: ResumeContent, letter: CoverLetterContent): StrippedDocuments {
  let stripped = 0
  const clean = (line: DocumentLine, dropWhenEmpty: boolean): DocumentLine | null => {
    const repaired = withoutSkillOnly(line)
    if (repaired === line) return line
    stripped += 1
    if (repaired.factIds.length === 0 && dropWhenEmpty) return null
    return repaired
  }
  const repairedResume: ResumeContent = {
    ...resume,
    summary: resume.summary.flatMap((line) => clean(line, true) ?? []),
    experience: resume.experience.map((entry) => ({
      ...entry,
      heading: clean(entry.heading, false) ?? entry.heading,
      bullets: entry.bullets.flatMap((line) => clean(line, true) ?? []),
    })),
    // A Skills line may cite skill-only facts, so nothing is stripped there.
    skills: resume.skills,
    education: resume.education.flatMap((line) => clean(line, true) ?? []),
  }
  // A letter paragraph citing skill-only facts with anything else must lose them; one citing skill-only facts only keeps them.
  const paragraphs = letter.paragraphs.map((paragraph) => {
    const mixed = paragraph.factIds.some(isSkillOnlyId) && paragraph.factIds.some((id) => !isSkillOnlyId(id))
    return mixed ? (clean(paragraph, false) ?? paragraph) : paragraph
  })
  return { resume: repairedResume, letter: { ...letter, paragraphs }, stripped }
}

/** The added-fact row ids a finished document cites, in line order, each once. */
export function citedAddedIds(content: DocumentContent): string[] {
  const cited = documentLines(content).flatMap((line) => line.factIds.filter(isAddedId).map(addedRowId))
  return [...new Set(cited)]
}

/** The minimum a role-placement repair needs to know about an added fact. */
export type AddedFactRoleHint = Readonly<{ id: string; kind: "skill_only" | "one_liner"; roleSectionId: string | null }>

/**
 * A bullet citing a one-liner written for another role is dropped, so it is never
 * printed under the wrong role or credited to another employer (PRD 5.5, 10.6).
 * The entry's role is the one section its profile facts (never its added ids) all
 * come from; an entry with no single owner is left to the validator.
 */
export function keepBulletsUnderTheirRole(
  resume: ResumeContent,
  facts: readonly AddedFactRoleHint[],
  sections: readonly Readonly<{ id: string; facts: ReadonlyArray<Readonly<{ id: string }>> }>[]
): ResumeContent {
  const sectionOf = new Map(sections.flatMap((section) => section.facts.map((fact) => [fact.id, section.id] as const)))
  const roleOf = new Map(facts.filter((fact) => fact.kind === "one_liner" && fact.roleSectionId !== null).map((fact) => [oneLinerId(fact.id), fact.roleSectionId!]))
  if (roleOf.size === 0) return resume
  return {
    ...resume,
    experience: resume.experience.map((entry) => {
      const profileIds = [...entry.heading.factIds, ...entry.bullets.flatMap((bullet) => bullet.factIds)].filter((id) => !isAddedId(id))
      const owners = new Set(profileIds.map((id) => sectionOf.get(id)).filter((id): id is string => id !== undefined))
      if (owners.size !== 1) return entry
      const [owner] = owners
      return { ...entry, bullets: entry.bullets.filter((bullet) => !bullet.factIds.some((id) => roleOf.has(id) && roleOf.get(id) !== owner)) }
    }),
  }
}

/** Every line of a document, for the strip's and the validator's bookkeeping. */
export function documentLines(content: DocumentContent): readonly DocumentLine[] {
  if (content.kind === "cover_letter") return content.paragraphs
  return [...content.summary, ...content.experience.flatMap((entry) => [entry.heading, ...entry.bullets]), ...content.skills, ...content.education]
}
