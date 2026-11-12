import { foldForKeywords } from "./rule-result.js"

/**
 * EPIC-0006 (AC-2.2): the seniority marker stored on `job_posting`, a shared
 * fact. `entry`: the title has an entry-level marker and no mid-or-higher one.
 * `mid_plus`: it has a mid-or-higher marker. `none`: neither. Untitled: null
 * (never below the floor, AC-2.4). Whole words after `foldForKeywords`; the
 * title only, never the description or company. Migration 0020 carries a
 * frozen copy (0020-frozen.spec.ts keeps them equal).
 */
export type SeniorityMarker = "entry" | "mid_plus" | "none"

const MID_PLUS = /\b(mid|mid-level|intermediate|senior|sr|staff|principal|lead)\b/
const ENTRY =
  /\b(intern|internship|junior|jr|graduate|grad|new grad|entry level|entry-level|apprentice|apprenticeship|trainee|stagiaire|alternance|becario|becaria|pasante|praktikant|praktikantin|werkstudent|werkstudentin)\b/

export function seniorityMarker(title: string | null): SeniorityMarker | null {
  if (title === null || title.trim() === "") return null
  const folded = foldForKeywords(title)
  if (MID_PLUS.test(folded)) return "mid_plus"
  return ENTRY.test(folded) ? "entry" : "none"
}

/**
 * EPIC-0002 B1 (PRD r4 AC 5.12, 5.13): the seniority and employment type
 * rules over the Candidate's accepted levels and types, stored after industry
 * (D44). Every level or type accepted (the Operator's migrated values, and
 * `STEP3_DEFAULTS`) is `not_applicable`, so the Operator's verdicts are unchanged.
 */
type Outcome = Readonly<{ result: "met" | "unverified" | "violated" | "not_applicable"; quote: string | null }>

const LEVELS: ReadonlyArray<readonly [string, RegExp]> = [
  ["junior", /\b(junior|jr|entry level|entry-level|graduate|new grad|intern|internship|apprentice|trainee)\b/],
  ["mid", /\b(mid|mid-level|intermediate)\b/],
  ["senior", /\b(senior|sr)\b/],
  ["staff", /\bstaff\b/],
  ["principal", /\bprincipal\b/],
]

/** Levels the title states, in catalog order. */
export function titleLevels(title: string | null): string[] {
  if (title === null) return []
  const folded = foldForKeywords(title)
  return LEVELS.filter(([, pattern]) => pattern.test(folded)).map(([level]) => level)
}

/** AC 5.12: a stated level outside `accepted` is violated (met if any stated level is accepted); none stated is Unverified; all accepted is Not applicable. */
export function evaluateSeniority(title: string | null, accepted: readonly string[]): Outcome {
  if (LEVELS.every(([level]) => accepted.includes(level))) return { result: "not_applicable", quote: null }
  const stated = titleLevels(title)
  if (stated.length === 0) return { result: "unverified", quote: null }
  return { result: stated.some((level) => accepted.includes(level)) ? "met" : "violated", quote: title }
}

const EMPLOYMENT_TYPES = ["direct", "employer_of_record", "contract"] as const

/** AC 5.13: a stated type outside `accepted` is violated; unstated is Unverified; all accepted is Not applicable. */
export function evaluateEmploymentType(type: string | null, accepted: readonly string[]): Outcome {
  if (EMPLOYMENT_TYPES.every((value) => accepted.includes(value))) return { result: "not_applicable", quote: null }
  if (type === null) return { result: "unverified", quote: null }
  return { result: accepted.includes(type) ? "met" : "violated", quote: null }
}
