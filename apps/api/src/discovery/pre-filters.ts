import { locateAts } from "./application-url.js"
import { foldForKeywords } from "./rules/rule-result.js"

/**
 * Deterministic pre-filters that run before any AI cost (architecture r1,
 * Journey 1). The order sets the reason shown when several apply.
 *
 * "Existing application or requisition record" has no table until slice 5;
 * the requisition-key unique index already stops a second Job Posting, so a
 * posting found again is never re-evaluated (see DiscoveryRepository.storeOnce).
 */
const SOFTWARE_TITLE =
  /\b(engineer|engineering|developer|programmer|software|frontend|front-end|front end|full[- ]?stack|backend|back-end|web|react|typescript|javascript|tech(nical)? lead|architect|sre|devops)\b/
/**
 * Slice 8d (8d.1, D8d-1, D8d-3): more titles that reach evaluation, whole
 * words after `foldForKeywords`. English phrases, never "infrastructure" or
 * "specialist" alone; French, Spanish, Portuguese and German developer words.
 * A fixed list, so the pre-filter stays deterministic with no AI call.
 */
const SOFTWARE_TITLE_8D = new RegExp(
  `\\b(${[
    // English
    "site reliability", "head of infrastructure", "infrastructure specialist",
    // French
    "developpeur", "developpeuse", "programmeur", "programmeuse",
    "ingenieure? logiciel", "ingenieure? developpement",
    // Spanish
    "desarrollador", "desarrolladora", "programador", "programadora", "ingenier[oa] de software",
    // Portuguese ("programador", "programadora" as Spanish)
    "desenvolvedor", "desenvolvedora", "engenheir[oa] de software",
    // German
    "entwickler", "entwicklerin", "softwareentwickler", "softwareentwicklerin", "webentwickler", "webentwicklerin",
    "anwendungsentwickler", "anwendungsentwicklerin", "programmierer", "programmiererin", "softwareingenieur", "softwareingenieurin",
  ].join("|")})\\b`
)
/**
 * Slice 8d (8d.2 r1, D8d-2, CR8D-02, SEC-8D-02): business-development titles
 * that use a developer word. Checked before the software words, on
 * `businessDevelopmentForm(folded)` only. An optional inclusive suffix may
 * follow the developer word ("euse", "se", "e" in French; "a" in Spanish and
 * Portuguese), and "negocio" may be singular. "d affaires" / "daffaires" cover
 * every apostrophe form once punctuation is a space.
 */
const BUSINESS_DEVELOPMENT_TITLE =
  /\b(developpeu(?:r|se)(?: (?:euse|se|e))? (?:commerciale?|d ?affaires)|developpement commercial|desarrollador(?:a)?(?: a)? (?:de negocios?|comercial|de ventas)|desenvolvedor(?:a)?(?: a)? (?:de negocios?|comercial|de vendas))\b/
/**
 * The separator-free copy of the folded title (8d.2 r1, 8e.4, D8e-2): every
 * character that is not a letter, digit or whitespace becomes a space (all
 * punctuation, the backtick and symbols such as `+ ~ | = ∕`), and so do the
 * apostrophe-like letters U+02B9 to U+02BF, U+02C8 to U+02CB, U+A78B and
 * U+A78C, which are `\p{L}`. The dotless `ı` becomes `i`, and runs of spaces
 * collapse. Used only by the business-development check and the
 * inclusive-Ingénieur check (8e.5): the shared fold, the other lists, the
 * classifier and the stored `title_folded` are unchanged, so no backfill.
 */
export function businessDevelopmentForm(folded: string): string {
  return folded
    .replace(/[^\p{L}\p{N}\s]|[\u02b9-\u02bf\u02c8-\u02cb\ua78b\ua78c]/gu, " ")
    .replace(/\u0131/g, "i")
    .replace(/\s+/g, " ")
    .trim()
}
/**
 * Slice 8e (8e.1, D8e-1, QA3-OBS-01): inclusive French "Ingénieur(e)",
 * "Ingénieur·e", "Ingénieur-e" before "logiciel" or "développement", tested on
 * `businessDevelopmentForm(folded)` after every skip check, so it can only
 * turn an Ingénieur title into a pass.
 */
const INCLUSIVE_INGENIEUR_TITLE = /\bingenieur(?: ?e)? (?:logiciel|developpement)\b/
const NON_SOFTWARE_TITLE =
  /\b(sales|account executive|recruiter|marketing|customer success|support specialist|designer|accountant|lawyer|counsel|nurse|driver|copywriter)\b/
/**
 * Slice 8 (8S.1, D8-13): customer-facing engineer titles that do not write
 * product code for a living. Skipped even though they contain "engineer".
 */
const NON_SOFTWARE_ENGINEER_TITLE =
  /\b(sales engineer|sales engineering|pre-sales engineer|presales engineer|pre sales engineer|support engineer|support engineering|customer success engineer|customer engineer|solutions engineer|solution engineer|solutions engineering|field engineer|field application engineer|field applications engineer)\b/
/** Slice 8 (8S.2, D8-14): whole words, so "HR" at the end of a title or before a comma counts. */
const HR_TITLE = /\b(hr|human resources)\b/
/** Only these whole words save an HR title; "engineering" as a department name does not. */
const ENGINEER_OR_DEVELOPER = /\b(engineer|developer)\b/

export type PreFilterResult =
  | Readonly<{ pass: true }>
  | Readonly<{ pass: false; reason: "not_software_role" }>

export function isSoftwareTitle(title: string): boolean {
  const folded = foldForKeywords(title)
  if (NON_SOFTWARE_ENGINEER_TITLE.test(folded)) return false
  const separatorFree = businessDevelopmentForm(folded)
  if (BUSINESS_DEVELOPMENT_TITLE.test(separatorFree)) return false
  if (HR_TITLE.test(folded) && !ENGINEER_OR_DEVELOPER.test(folded)) return false
  const software =
    SOFTWARE_TITLE.test(folded) ||
    SOFTWARE_TITLE_8D.test(folded) ||
    INCLUSIVE_INGENIEUR_TITLE.test(separatorFree)
  return software && !(NON_SOFTWARE_TITLE.test(folded) && !/\bengineer/.test(folded))
}

/** Skips postings whose title is not a software role. Runs only when the shared posting is first stored (8S.5; EPIC-0002 r4: never again for a later Candidate). Unknown titles pass (the model never decides this). */
export function preFilter(posting: Readonly<{ title: string | null }>): PreFilterResult {
  if (posting.title !== null && posting.title.trim() !== "" && !isSoftwareTitle(posting.title)) {
    return { pass: false, reason: "not_software_role" }
  }
  return { pass: true }
}

/** The shared facts a Candidate's starting state is decided from (architecture r4, "Shared pre-filter"). */
export type SharedPostingFacts = Readonly<{
  prefilterSkip: "not_software_role" | null
  applyMode: "automatic" | "manual"
  applicationSystem: string
}>

export type StartingState = Readonly<{
  /** "waiting_to_be_checked" only from DiscoveryRepository.storeOnce (EPIC-0002 D13); `startingState` never returns it. */
  status: "checking" | "waiting_to_be_checked" | "not_checked" | "skipped"
  skipReason: "not_software_role" | "unsupported_application_system" | null
  skipDetail: string | null
}>

/**
 * A Candidate's `candidate_posting` state when they first hold a posting, from
 * the shared facts only: the stored pre-filter skip first, then a Manual
 * Application (skipped before any AI cost), else it waits for evaluation. The
 * pre-filter is never re-run here; its result is the stored `prefilter_skip`.
 */
export function startingState(facts: SharedPostingFacts, hidden = false): StartingState {
  if (facts.prefilterSkip !== null) return { status: "skipped", skipReason: facts.prefilterSkip, skipDetail: null }
  if (facts.applyMode === "manual") return { status: "skipped", skipReason: "unsupported_application_system", skipDetail: facts.applicationSystem }
  // EPIC-0006 (AC-4.3): hidden for this Candidate when stored, so never evaluated for them ("Not checked yet").
  if (hidden) return { status: "not_checked", skipReason: null, skipDetail: null }
  return { status: "checking", skipReason: null, skipDetail: null }
}

/**
 * AC 3.4: only Greenhouse, Lever and Ashby postings can be submitted
 * automatically, and never one from a board whose terms require manual apply.
 */
export function applyModeFor(applicationUrl: string, manualOnly: boolean): "automatic" | "manual" {
  return !manualOnly && locateAts(applicationUrl) !== null ? "automatic" : "manual"
}
