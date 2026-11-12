/**
 * Fact-to-quote consistency (CR2-02, SEC-203, Candidate decision 2026-10-18).
 * Backend code, not the model, decides whether a drafted fact or section heading
 * says more than its quote. Rephrasing is allowed: only *claims* are compared.
 *
 * Claims (what must appear in the quote):
 * - Numbers: digits with optional thousands separators and decimals, scaled by a
 *   following magnitude (k, thousand, m, million, bn, b, billion), and number words
 *   two to ninety-nine ("four", "twenty-five"). "one" is not a claim, because it is
 *   usually a pronoun ("one of the first"); it still counts as support in a quote.
 *   Canonical form is the plain decimal value, so 1,000,000 = 1000000 = 1m and
 *   01 = 1. A trailing "%" or "percent" is not part of the claim.
 * - Months: a month name or abbreviation (jan, sept, september, ...) that is
 *   capitalised or followed by a year counts as its number (January = 1 = 01), so
 *   "January 2021" matches "01/2021". Lower-case "may" or "march" alone is a word.
 * - Ongoing end dates: a year followed by "-", "to", "until" or "till" and then
 *   present, current, now, today, date or ongoing is the claim "present". A fact
 *   that says "2021-Present" against a quote "2021-2024" is dropped.
 * - Facts: every word that contains an upper-case letter (proper nouns, titles,
 *   employers, acronyms such as AWS, PhD, iOS). That includes the first word of the
 *   fact and of every sentence or clause (after . ! ? ; :), except a word on the
 *   fixed OPENING_WORDS list below, which a fact may start with although its quote
 *   uses another word ("Shipped" for "built"). The pronoun "I" is exempt. (SEC-213:
 *   exempting every sentence-initial word let "Director of…", "Kubernetes" and
 *   "Employer: Google" through.)
 * - Headings: every word of the title and employer (lower case too, minus short
 *   stopwords and generic section labels such as "Skills" or "Summary"), and every
 *   number, month and ongoing marker in the dates.
 *
 * Normalisation applied to both sides before comparing:
 * - Zero-width characters (U+200B-U+200D, U+2060, U+FEFF) and soft hyphens (U+00AD)
 *   are removed first, so they can't split a word into harmless fragments (SEC-214).
 * - Unicode NFKD with combining marks removed, so "Société" = "Societe" (PDF
 *   extraction often drops accents); typographic dashes become "-".
 * - Case-insensitive comparison; words are compared whole, never as substrings,
 *   so "Lagosville" is not supported by "Lagos".
 * - Tokens are runs of letters and digits, keeping "+" and "#" (C++, C#); "." splits
 *   ("Node.js" = node, js); other punctuation is ignored.
 * - Common company and title abbreviations are expanded on both sides: ltd =
 *   limited, inc = incorporated, corp = corporation, co = company, sr = senior,
 *   jr = junior, mgr = manager, univ = university, dept = department.
 *
 * False-drop risk for real CVs, and why this is acceptable: every rule above is
 * aimed at the ways the same fact is written differently (case, accents, dashes,
 * number formats, month names versus numbers, "Present" versus "current",
 * abbreviations, a new leading verb). What remains is a model that adds a proper
 * noun or number that the quote doesn't contain. Dropping it is the decision, and
 * the Candidate sees the dropped count and can add the fact back by hand.
 */

import { EVERYDAY_WORDS } from "./everyday-words.js"

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11,
  november: 11, dec: 12, december: 12,
}
/** Month and day names are ordinary words, never borrowed names (EPIC-0012 Revision 2, R10). */
export const MONTH_AND_DAY_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(MONTHS),
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
])
const UNITS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
const MAGNITUDES: Readonly<Record<string, number>> = {
  k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
}
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  ltd: "limited", inc: "incorporated", corp: "corporation", co: "company", sr: "senior", jr: "junior",
  mgr: "manager", univ: "university", dept: "department",
}
const HEADING_STOPWORDS = new Set(["a", "an", "and", "the", "of", "at", "in", "for", "to", "with", "on", "&"])
export const GENERIC_SECTION_WORDS = new Set([
  "skills", "skill", "technical", "summary", "professional", "profile", "experience", "work", "education",
  "certifications", "certification", "projects", "languages", "other", "about", "core", "key", "competencies",
  "qualifications", "achievements", "employment", "history", "career", "objective", "interests", "awards",
  "publications", "volunteering", "volunteer", "tools", "technologies", "overview", "additional", "information",
])
/**
 * Words a fact may open with (at its start, or after . ! ? ; :) although its quote
 * doesn't contain them. Only these are exempt from the capitalised-word rule there;
 * every other capitalised opener (a title, skill, employer, school) must be in the
 * quote (SEC-213).
 *
 * Why this list and no more: CV bullets open with an action verb, and a model
 * rephrasing a bullet swaps the verb ("Shipped" for "built", "Led" for "managed"),
 * which carries no claim. The rest are function words that start a rephrased
 * sentence ("The", "In 2021,", "As", "With"). Titles such as "Lead", "Manager",
 * "Director" and "Head", and nouns such as "Engineer", are deliberately absent:
 * they are claims. Verbs that double as titles or skills ("Lead", "Architect",
 * "Program") are left out for the same reason. A real verb that isn't listed only
 * causes a false drop when the quote uses a different verb; the Candidate sees the
 * dropped count and can add the fact back.
 */
export const OPENING_WORDS: ReadonlySet<string> = new Set([
  // Action verbs, past tense, as CV bullets use them.
  "accelerated", "achieved", "added", "administered", "advised", "analysed", "analyzed", "assisted", "audited",
  "automated", "built", "championed", "co-founded", "collaborated", "configured", "consolidated", "contributed",
  "coordinated", "created", "cut", "debugged", "decreased", "defined", "delivered", "deployed", "designed",
  "developed", "directed", "doubled", "drove", "enabled", "engineered", "established", "expanded", "facilitated",
  "founded", "grew", "guided", "handled", "helped", "hired", "implemented", "improved", "increased", "integrated",
  "introduced", "launched", "led", "maintained", "managed", "mentored", "migrated", "modernised", "modernized",
  "monitored", "negotiated", "optimised", "optimized", "organised", "organized", "oversaw", "owned", "partnered",
  "pioneered", "planned", "presented", "produced", "prototyped", "published", "raised", "rebuilt", "redesigned",
  "reduced", "refactored", "replaced", "resolved", "restructured", "reviewed", "revamped", "rewrote", "ran", "saved",
  "scaled", "secured", "served", "set", "shipped", "simplified", "spearheaded", "standardised", "standardized",
  "started", "streamlined", "strengthened", "supervised", "supported", "taught", "tested", "trained", "transformed",
  "tripled", "upgraded", "wrote", "worked",
  // QA-2B-05 (2026-10-19): more past-tense CV verbs. "Architected" is a verb; the
  // title "Architect" stays a claim, as do "Lead", "Manager", "Principal", "Staff", "Head".
  "architected", "authored", "coached", "moved", "orchestrated", "drafted", "evangelised", "evangelized",
  "formalised", "formalized", "instrumented", "investigated", "mapped", "measured", "modelled",
  "modeled", "operated", "ported", "productionised", "productionized", "rolled", "shaped", "solved",
  "sped", "steered", "tracked", "translated", "unified", "unblocked", "validated", "wired",
  // Present tense, for a current role or a skills line ("Uses TypeScript daily").
  "uses", "builds", "leads", "owns", "maintains", "delivers", "designs", "develops", "manages", "mentors",
  "runs", "ships", "supports", "works", "writes", "coaches", "drives", "partners",
  // Verbs that open qualification and award facts.
  "awarded", "completed", "earned", "graduated", "held", "holds", "obtained", "received", "studied",
  // Function words that open a rephrased sentence.
  "a", "an", "the", "this", "that", "these", "those", "in", "on", "at", "for", "from", "with", "by", "as", "over",
  "under", "across", "after", "before", "during", "since", "while", "and", "also", "both", "then", "using", "via",
  // Cover-letter courtesy openers; they carry no claim.
  "thank", "thanks", "dear", "please", "i'm", "i've",
  // Openers that describe rather than name: "Skilled in …", "Experienced in …",
  // "Responsible for …", "Joined …", "Promoted to …" (what follows still has to match).
  "skilled", "experienced", "proficient", "familiar", "fluent", "certified", "responsible", "joined", "promoted",
  // F-QA4-07 (2026-10-19): sentence openers in cover-letter prose. Possessives and
  // pronouns, and discourse adverbs. None is a title, employer, skill or
  // qualification; every later capitalised word in the sentence is still a claim.
  // EPIC-0012 rule 4: a direction sentence opens with "Your" ("Your aim to ..."),
  // so the second-person pronouns join this group. They carry no claim either.
  "my", "our", "their", "its", "we", "it", "they", "there", "here", "what", "which", "when", "where",
  "you", "your",
  "earlier", "recently", "notably", "ultimately", "previously", "additionally", "together", "today", "most",
  "currently", "later", "now", "finally", "overall", "initially", "subsequently", "meanwhile", "however",
  "moreover", "furthermore", "similarly", "likewise", "besides", "still", "yet", "so", "but", "because",
  "although", "though", "outside", "beyond", "beside", "throughout", "within", "through", "alongside",
])

/**
 * F-QA4-07: a sentence-initial gerund is exempt only when it restates a verb from
 * the cited facts ("Mentoring …" citing "Mentored 6 engineers"). The verb must be
 * on OPENING_WORDS, so "Managing" or "Architecting" without that verb in the facts
 * is still a claim.
 */
function restatesSupportedVerb(word: string, support: ReadonlySet<string>): boolean {
  if (!word.endsWith("ing") || word.length < 6) return false
  const stem = word.slice(0, -3)
  for (const verb of support) if (verb !== word && verb.startsWith(stem) && OPENING_WORDS.has(verb)) return true
  return false
}

const PRESENT = "present"
const NUMBER_WORD = new RegExp(
  `\\b(?:(${Object.keys(TENS).join("|")})(?:[-\\s]+(${Object.keys(UNITS).slice(0, 9).join("|")}))?|(${Object.keys(UNITS).join("|")}))\\b`,
  "gi"
)
/** Count words that are claims even without a digit (SEC-405): "a hundred", "dozens of", "a score of". */
const COUNT_WORD = /\b(?:a|an|one|several|many|some)?\s*(hundreds?|thousands?|dozens?|scores?|millions?|billions?)\b/gi
const COUNT_VALUE: Readonly<Record<string, string>> = {
  hundred: "100", hundreds: "100+", thousand: "1000", thousands: "1000+", dozen: "12", dozens: "12+", score: "20",
  scores: "20+", million: "1000000", millions: "1000000+", billion: "1000000000", billions: "1000000000+",
}
const DIGITS = /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s*(k|thousand|million|bn|billion|m|b)\b)?/gi
const ONGOING = /\b((?:19|20)\d{2})\s*(?:-|to|until|till)\s*(present|current|now|today|date|ongoing)\b/gi
/** "co-" joins the next word ("co-founded", "co-led") so "co" isn't read as "company" (CR-02). */
const TOKEN = /(?:[Cc][Oo]-(?=\p{L}))?[\p{L}\p{N}][\p{L}\p{N}+#]*/gu

type Claim = Readonly<{ value: string; isWord: boolean; capitalised: boolean; acronymLike: boolean; sentenceStart: boolean }>

/**
 * Lower-case words that are still claims in a Tailored Document (slice 4, AC
 * 5.3): skills, titles and qualifications a model could add without a capital
 * ("10 years of kubernetes", "staff engineer", "certified"). Capitalised words
 * and numbers are claims anyway; this list only closes the lower-case gap.
 */
/** Titles and seniority words: claims in a document line. */
export const TITLE_WORDS: ReadonlySet<string> = new Set([
  "staff", "principal", "lead", "senior", "junior", "head", "director", "manager", "vp", "cto", "ceo", "founder",
  "architect", "intern", "chief", "president",
])

/** Qualification words: claims in a document line, and never part of a role or employer name (SEC-410). */
export const QUALIFICATION_WORDS: ReadonlySet<string> = new Set([
  "certified", "certification", "certificate", "degree", "bachelor", "bachelors", "master", "masters", "phd",
  "doctorate", "bsc", "msc", "mba", "diploma", "licensed",
])

export const DOCUMENT_CLAIM_WORDS: ReadonlySet<string> = new Set([
  ...TITLE_WORDS,
  ...QUALIFICATION_WORDS,
  // EPIC-0012 rule 2 (design Revision 1, R2): qualification acronyms that are claims even when the posting
  // does not name them and the line writes them in lower case.
  "cfa", "acca", "cpa", "aca", "cima", "pmp", "prince2", "cissp", "frm", "leed", "iema", "nebosh", "cips", "cfp",
  // Skills and tools commonly written in lower case.
  "kubernetes", "k8s", "docker", "terraform", "ansible", "aws", "gcp", "azure", "rust", "golang", "go", "python",
  "java", "kotlin", "swift", "scala", "ruby", "rails", "php", "laravel", "django", "flask", "c++", "c#", "dotnet",
  "react", "typescript", "javascript", "node", "nodejs", "vue", "angular", "svelte", "nextjs", "graphql", "redux",
  "postgres", "postgresql", "mysql", "mongodb", "redis", "kafka", "elasticsearch", "spark", "hadoop", "linux",
  "android", "ios", "flutter", "solidity", "blockchain", "ml", "ai", "tensorflow", "pytorch", "sql", "nosql",
])

/**
 * EPIC-0012 rule 2 (design Revision 1, R1): verbs that claim scope, seniority or ownership, as a closed list
 * of word forms mapped to their family. A tailored line that uses one of them counts as supported only when
 * a cited fact uses the same family as the Candidate's own verb (see `unsupportedScopeVerbs`): a stem
 * anywhere in the fact is not enough, because "led by the platform team" and "the team lead" are about
 * someone else. "found" alone is never here (it is the past of "find"); "co-led" is its own family.
 */
export const SCOPE_VERB_FAMILIES: ReadonlyMap<string, string> = new Map([
  ["lead", "lead"], ["leads", "lead"], ["led", "lead"], ["leading", "lead"],
  ["manage", "manage"], ["manages", "manage"], ["managed", "manage"], ["managing", "manage"],
  ["own", "own"], ["owns", "own"], ["owned", "own"], ["owning", "own"],
  ["direct", "direct"], ["directs", "direct"], ["directed", "direct"], ["directing", "direct"],
  ["oversee", "oversee"], ["oversees", "oversee"], ["oversaw", "oversee"], ["overseeing", "oversee"], ["overseen", "oversee"],
  ["supervise", "supervise"], ["supervises", "supervise"], ["supervised", "supervise"], ["supervising", "supervise"],
  ["head", "head"], ["heads", "head"], ["headed", "head"], ["heading", "head"],
  ["spearhead", "spearhead"], ["spearheads", "spearhead"], ["spearheaded", "spearhead"], ["spearheading", "spearhead"],
  ["founded", "found"], ["founding", "found"], ["co-founded", "found"],
  ["pioneer", "pioneer"], ["pioneers", "pioneer"], ["pioneered", "pioneer"], ["pioneering", "pioneer"],
  ["champion", "champion"], ["champions", "champion"], ["championed", "champion"], ["championing", "champion"],
  ["drive", "drive"], ["drives", "drive"], ["drove", "drive"], ["driving", "drive"], ["driven", "drive"],
  ["establish", "establish"], ["establishes", "establish"], ["established", "establish"], ["establishing", "establish"],
  ["hire", "hire"], ["hires", "hire"], ["hired", "hire"], ["hiring", "hire"],
  ["run", "run"], ["runs", "run"], ["ran", "run"], ["running", "run"],
  ["architected", "architect"], ["architecting", "architect"],
  ["orchestrate", "orchestrate"], ["orchestrates", "orchestrate"], ["orchestrated", "orchestrate"], ["orchestrating", "orchestrate"],
  ["steer", "steer"], ["steers", "steer"], ["steered", "steer"], ["steering", "steer"],
  // Co-led is the Candidate's own verb only when the fact says "co-led", never when it says "led".
  ["co-led", "co-lead"], ["co-leads", "co-lead"], ["co-leading", "co-lead"],
  // EPIC-0012 Revision 2, R8: the verbs from before the epic that claimed more scope than "supported".
  ["launch", "launch"], ["launches", "launch"], ["launched", "launch"], ["launching", "launch"],
  ["coordinate", "coordinate"], ["coordinates", "coordinate"], ["coordinated", "coordinate"], ["coordinating", "coordinate"],
  ["deliver", "deliver"], ["delivers", "deliver"], ["delivered", "deliver"], ["delivering", "deliver"],
  ["ship", "ship"], ["ships", "ship"], ["shipped", "ship"], ["shipping", "ship"],
  ["build", "build"], ["builds", "build"], ["built", "build"], ["building", "build"],
  ["create", "create"], ["creates", "create"], ["created", "create"], ["creating", "create"],
])

/**
 * EPIC-0012 Revision 2, R8: support roles. A line that claims a bigger verb than a fact which opens with
 * one of these is support-role inflation, a hard fail no judge answer can release.
 */
export const SUPPORT_VERBS: ReadonlySet<string> = new Set([
  "supported", "assisted", "helped", "contributed", "participated", "collaborated", "tested", "joined",
  "worked", "shadowed",
])

/**
 * Words that open a line but are not verbs, so the support-inflation test can find the line's first verb.
 * They are the function words, pronouns and discourse adverbs on `OPENING_WORDS`.
 */
const NON_VERB_OPENERS: ReadonlySet<string> = new Set([
  "a", "an", "the", "this", "that", "these", "those", "in", "on", "at", "for", "from", "with", "by", "as",
  "over", "under", "across", "after", "before", "during", "since", "while", "and", "also", "both", "then",
  "using", "via", "my", "our", "their", "its", "we", "it", "they", "there", "here", "what", "which", "when",
  "where", "you", "your", "earlier", "recently", "notably", "ultimately", "previously", "additionally",
  "together", "today", "most", "currently", "later", "now", "finally", "overall", "initially", "subsequently",
  "meanwhile", "however", "moreover", "furthermore", "similarly", "likewise", "besides", "still", "yet", "so",
  "but", "because", "although", "though", "outside", "beyond", "beside", "throughout", "within", "through",
  "alongside", "thank", "thanks", "dear", "please", "i'm", "i've", "skilled", "experienced", "proficient",
  "familiar", "fluent", "certified", "responsible",
])

/** The line's first verb, after an optional leading "I", or null when it opens with no verb at all. */
export function firstVerb(text: string): string | null {
  for (const word of claimWords(text)) {
    if (word === "i") continue
    if (NON_VERB_OPENERS.has(word)) continue
    if (SCOPE_VERB_FAMILIES.has(word) || SUPPORT_VERBS.has(word) || OPENING_WORDS.has(word)) return word
  }
  return null
}

/** True when the fact's own wording opens, after an optional "I", with a support verb (Revision 2, R8). */
export function opensWithSupportVerb(text: string): boolean {
  const words = claimWords(text)
  const first = words[0] === "i" ? words[1] : words[0]
  return first !== undefined && SUPPORT_VERBS.has(first)
}

/**
 * EPIC-0012 Revision 2, R8: the line's first verb when it inflates a support role. Every cited fact's
 * own wording must open with a `SUPPORT_VERBS` word, and the line's first verb must be a bigger one (a
 * scope verb, or any `OPENING_WORDS` verb that is not itself a support verb).
 */
export function supportInflationVerb(text: string, factWordings: readonly string[]): string | null {
  const facts = factWordings.filter((wording) => wording.trim() !== "")
  if (facts.length === 0 || !facts.every(opensWithSupportVerb)) return null
  const verb = firstVerb(text)
  return verb !== null && !SUPPORT_VERBS.has(verb) ? verb : null
}

/**
 * True when `line` is the whole text of one cited fact, not a run of its words. The fallback repair
 * prints a fact's own text, and the validator holds that text followed by its section heading
 * ("fact. Title, Employer, dates"), so the fact text is the entry itself or the prefix before ". ".
 * Case, runs of spaces and one trailing full stop are ignored.
 */
function sameFactText(line: string, support: string): boolean {
  const folded = foldedFactText(line)
  const fact = foldedFactText(support)
  return folded === fact || fact.startsWith(`${folded}. `)
}

function foldedFactText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/\.$/, "")
}

/** Fragments a contraction leaves after tokenising ("it's", "I've", "don't"). */
const CONTRACTION_FRAGMENTS = new Set(["s", "t", "d", "m", "ll", "ve", "re"])

/**
 * Claims in a fact that its quote does not support, in order of first appearance. Empty means keep.
 *
 * `documentWords` (Tailored Documents): DOCUMENT_CLAIM_WORDS are claims in any
 * case, and (SEC-404, Candidate default) so is every other lower-case word
 * that is not an everyday English word (EVERYDAY_WORDS), an opening verb, or
 * an inflection of a word in the quote ("dashboards" for "dashboard",
 * "serve" for "serving").
 */
export function factClaimsMissing(
  fact: string,
  quote: string,
  options: { documentWords?: boolean; meaningChecked?: boolean; extraOpeners?: ReadonlySet<string> } = {}
): string[] {
  const support = supportOf(quote)
  // Roots of the quote's words, with hyphenated words also read joined ("re-use" supports "reusable").
  const supportStems = stemsOf(quote)
  const claims = tokenise(fact).filter((claim) => {
    if (!claim.isWord) return claim.value !== "1" || !claim.fromWord
    if (claim.value === "i") return false
    if (options.documentWords && DOCUMENT_CLAIM_WORDS.has(claim.value)) return true
    // A line whose meaning was checked against its facts keeps only the hard rule for lower-case
    // words: listed skills, titles and qualifications (above). Numbers and capitalised names still apply.
    if (options.documentWords && !claim.capitalised) return options.meaningChecked ? false : isUnsupportedNoun(claim.value, support, supportStems)
    if (!claim.capitalised) return false
    // At a sentence start or after a colon, only a listed opening word or a generic
    // section label ("Skills: React") is exempt (SEC-213).
    // EPIC-0014 D5: `extraOpeners` lets Outreach exempt its own question openers ("Would", "Could") without
    // widening OPENING_WORDS, which would change document decisions. Absent, nothing differs.
    const exemptOpener =
      OPENING_WORDS.has(claim.value) ||
      options.extraOpeners?.has(claim.value) === true ||
      GENERIC_SECTION_WORDS.has(claim.value) ||
      restatesSupportedVerb(claim.value, support) ||
      (options.documentWords === true && PLAIN_VERBS.has(claim.value))
    return !(claim.sentenceStart && !claim.acronymLike && exemptOpener)
  })
  return missing(claims.map((claim) => claim.value), support)
}

function isUnsupportedNoun(word: string, support: ReadonlySet<string>, supportStems: ReadonlySet<string>): boolean {
  if (support.has(word) || CONTRACTION_FRAGMENTS.has(word) || OPENING_WORDS.has(word) || PLAIN_VERBS.has(word)) return false
  if (EVERYDAY_WORDS.has(word) || EVERYDAY_WORDS.has(stem(word)) || EVERYDAY_STEMS.has(stem(word))) return false
  return !supportStems.has(stem(word)) && !supportStems.has(root(word))
}

/** Stems and roots of a text's words, with hyphenated words also read joined ("re-use" supports "reusable"). */
function stemsOf(text: string): ReadonlySet<string> {
  return new Set([...supportOf(text), ...supportOf(text.replace(/(\p{L})-(\p{L})/gu, "$1$2"))].flatMap((word) => [stem(word), root(word)]))
}

/**
 * EPIC-0012 rule 2 (design 1a): the lower-case words of a tailored line that its cited facts do not
 * support, in order of first appearance and without duplicates. These are the only words a bridge may
 * lend; numbers, capitalised names, listed skills, titles and qualifications are claims, never bridge words.
 */
export function unsupportedDocumentWords(text: string, support: string): string[] {
  const supportWords = supportOf(support)
  const supportStems = stemsOf(support)
  return [
    ...new Set(
      tokenise(text)
        .filter((claim) => claim.isWord && !claim.capitalised && claim.value !== "i")
        .filter((claim) => !DOCUMENT_CLAIM_WORDS.has(claim.value))
        .filter((claim) => isUnsupportedNoun(claim.value, supportWords, supportStems))
        .map((claim) => claim.value)
    ),
  ]
}

/**
 * EPIC-0012 rule 2 (design 1a): the posting terms of a line: its unsupported lower-case words whose stem
 * the posting text states. The posting lends wording only. An empty posting text means no terms (risk R2:
 * a pasted posting has no keywords until it is evaluated).
 */
export function postingTermsIn(text: string, support: string, postingText: string): string[] {
  if (postingText === "") return []
  const postingStems = stemsOf(postingText)
  return unsupportedDocumentWords(text, support).filter((word) => postingStems.has(stem(word)) || postingStems.has(root(word)))
}

/**
 * EPIC-0012 Revision 2, R8 (replaces R1's doer-position test): the scope verbs a line uses. A scope
 * verb passes unjudged only when the whole line is mechanical (see `isMechanicalLine` in
 * document-claims.ts); the caller skips this test for such a line. The direct callers here keep the
 * narrower whole-fact exemption: only the whole text of one cited fact is that fact's own wording.
 * A shorter run is not exempt, because a cut can drop a negation or a "by", and the fact's section
 * heading or employer never counts.
 */
export function unsupportedScopeVerbs(text: string, support: readonly string[]): string[] {
  if (support.some((fact) => sameFactText(text, fact))) return []
  return [
    ...new Set(
      tokenise(text)
        .filter((claim) => claim.isWord && SCOPE_VERB_FAMILIES.has(claim.value))
        .map((claim) => claim.value)
    ),
  ]
}


/**
 * Plain past-tense verbs a rewording uses for what a fact already says ("fixed" for "resolved", "sped up"
 * for "accelerating"). They describe an action, never a skill, title or result, so they are not claims.
 */
const PLAIN_VERBS: ReadonlySet<string> = new Set([
  "fixed", "fixing", "flagged", "flagging", "raised", "raising", "sped", "turned", "turning", "worked", "working", "helped",
  "helping", "kept", "made", "making", "moved", "gave", "ran", "set", "brought", "took", "put", "got",
])

/** Derivational endings: "predictability", "predictable" and "predict" share one root. Root kept at 4+ letters. */
const DERIVATIONAL = ["ability", "ibility", "ation", "ition", "ments", "ment", "ness", "ency", "ancy", "ance", "ence", "ity", "ive", "able", "ible", "ent", "ant", "ally", "al", "ly"]

function root(word: string): string {
  // Tried on the word itself first: stem() drops a final "e", which would hide "-able" in "predictable".
  for (const base of [word.replace(/'s$/, ""), stem(word)]) {
    for (const ending of DERIVATIONAL) if (base.endsWith(ending) && base.length - ending.length >= 4) return base.slice(0, -ending.length)
  }
  return stem(word)
}

const EVERYDAY_STEMS: ReadonlySet<string> = new Set([...EVERYDAY_WORDS].map(stem))

/** A rough English stem for matching inflections: "dashboards", "handles", "handling" and "serve" lose their endings. */
export function stem(word: string): string {
  let base = word.replace(/'s$/, "")
  if (base.length > 4 && base.endsWith("ies")) base = `${base.slice(0, -3)}y`
  else {
    const ending = ["ing", "ed", "es", "s"].find((suffix) => base.endsWith(suffix) && base.length - suffix.length >= 3)
    if (ending) base = base.slice(0, -ending.length)
  }
  return base.length > 3 && base.endsWith("e") ? base.slice(0, -1) : base
}

/**
 * The numbers, months and "present" markers of `text`, in order (CR4-01). A
 * leading "one" read as a pronoun is left out, as in `factClaimsMissing`.
 */
export function numbersIn(text: string): string[] {
  return tokenise(text)
    .filter((claim) => !claim.isWord && (claim.value !== "1" || !claim.fromWord))
    .map((claim) => claim.value)
}

/** True when the text states a number, a count, a month or a date range in any form claim-check reads (SEC-410). */
export function statesNumber(text: string): boolean {
  return tokenise(text).some((claim) => !claim.isWord)
}

/** The claim-check words of `text`, lower case, after its normalisation (SEC-410). */
export function claimWords(text: string): string[] {
  return tokenise(text).filter((claim) => claim.isWord).map((claim) => claim.value)
}

/** Claims in a section heading that its quote does not support. Empty means keep. */
export function headingClaimsMissing(
  heading: Readonly<{ title: string; organization: string | null; period: string | null }>,
  quote: string
): string[] {
  const support = supportOf(quote)
  const words = [heading.title, heading.organization ?? ""].flatMap((part) =>
    tokenise(part)
      .filter((claim) => !claim.isWord || (!HEADING_STOPWORDS.has(claim.value) && !GENERIC_SECTION_WORDS.has(claim.value)))
      .map((claim) => claim.value)
  )
  const dates = tokenise(heading.period ?? "", { monthsAnyCase: true }).filter((claim) => !claim.isWord || claim.value === PRESENT)
  return missing([...words, ...dates.map((claim) => claim.value)], support)
}

function missing(claims: readonly string[], support: ReadonlySet<string>): string[] {
  return [...new Set(claims.filter((claim) => !support.has(claim)))]
}

function supportOf(quote: string): ReadonlySet<string> {
  return new Set(tokenise(quote).map((claim) => claim.value))
}

type Token = Claim & { fromWord?: boolean }

/**
 * EPIC-0009 D1: a claim as it is written in the source, with its UTF-16 span there. The blocked
 * alert shows these to the Candidate (PRD 1.2), because the claim values are normalised ("June"
 * is `6`, "1.5m" is `1500000`, "Ltd" is `limited`).
 */
export type WrittenClaim = Readonly<{ value: string; text: string; start: number; end: number }>

/** Every claim token of `text`, in order, each with the span of `raw` it was read from. */
function tokeniseSpans(raw: string, options: { monthsAnyCase?: boolean } = {}): { start: number; end: number; token: Token }[] {
  const spans: { start: number; end: number; token: Token }[] = []
  const folded = foldWithMap(raw)
  /** Push a token read from `length` folded characters at `offset`, mapped back to the raw span. */
  const push = (offset: number, length: number, token: Token) => {
    if (length <= 0) return
    const start = folded.toRaw[offset] ?? offset
    const end = folded.toRawEnd[offset + length - 1] ?? offset + length
    spans.push({ start, end, token })
  }
  let text = folded.text

  // Ongoing end dates first, so "Present" is not also read as a capitalised word.
  text = text.replace(ONGOING, (match: string, year: string, word: string, offset: number) => {
    push(offset, year.length, number(year))
    push(offset + match.length - word.length, word.length, { value: PRESENT, isWord: false, capitalised: false, acronymLike: false, sentenceStart: false })
    return " ".repeat(match.length)
  })
  // CR-01: read "month year" before DIGITS blanks the year, so "june 2021" is still a date.
  const beforeDigits = text
  text = text.replace(DIGITS, (match: string, whole: string, fraction: string | undefined, magnitude: string | undefined, offset: number) => {
    const value = Number(`${whole.replaceAll(",", "")}${fraction ?? ""}`) * (magnitude ? (MAGNITUDES[magnitude.toLowerCase()] ?? 1) : 1)
    push(offset, match.length, number(formatNumber(value)))
    return " ".repeat(match.length)
  })
  // SEC-405: count words left after DIGITS ("400 thousand" is already a number there).
  text = text.replace(COUNT_WORD, (match: string, word: string, offset: number) => {
    push(offset, match.length, number(COUNT_VALUE[word.toLowerCase()] ?? word.toLowerCase()))
    return " ".repeat(match.length)
  })
  text = text.replace(NUMBER_WORD, (match: string, tens: string | undefined, unit: string | undefined, single: string | undefined, offset: number) => {
    const value = tens ? (TENS[tens.toLowerCase()] ?? 0) + (unit ? (UNITS[unit.toLowerCase()] ?? 0) : 0) : (UNITS[(single ?? "").toLowerCase()] ?? 0)
    push(offset, match.length, { ...number(String(value)), fromWord: true })
    return " ".repeat(match.length)
  })

  for (const match of text.matchAll(TOKEN)) {
    const word = match[0]
    const offset = match.index
    const lower = word.toLowerCase()
    const capitalised = /\p{Lu}/u.test(word)
    const month = MONTHS[lower]
    const followedByYear = /^\s+(?:19|20)\d{2}\b/.test(beforeDigits.slice(offset + word.length))
    if (month !== undefined && (capitalised || followedByYear || options.monthsAnyCase)) {
      push(offset, word.length, number(String(month)))
      continue
    }
    push(offset, word.length, {
      value: ABBREVIATIONS[lower] ?? lower,
      isWord: true,
      capitalised,
      acronymLike: /^.+\p{Lu}/u.test(word) && word.length >= 2,
      sentenceStart: isSentenceStart(text, offset),
    })
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** Every claim-shaped token of `text`, with case information taken before lower-casing. */
function tokenise(raw: string, options: { monthsAnyCase?: boolean } = {}): Token[] {
  return tokeniseSpans(raw, options).map((span) => span.token)
}

/** Every claim of `raw` as it is written there, in order (EPIC-0009 D1). Tokens equal `tokenise`'s. */
export function writtenClaims(raw: string): WrittenClaim[] {
  return tokeniseSpans(raw).map(({ start, end, token }) => ({ value: token.value, text: raw.slice(start, end), start, end }))
}

function number(value: string): Token {
  return { value, isWord: false, capitalised: false, acronymLike: false, sentenceStart: false }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))
}

/** True for the first word of the text or of a sentence (after . ! ? ; : and a space). */
function isSentenceStart(text: string, offset: number): boolean {
  const before = text.slice(0, offset).trimEnd()
  return before === "" || /[.!?;:]$/.test(before)
}

/**
 * Every default-ignorable code point: zero-width characters, the soft hyphen,
 * bidi controls, invisible operators, tag characters and the rest. They render
 * as nothing and split words (SEC-214, SEC-219).
 */
/** For one code point at a time: a global regex would carry `lastIndex` between characters. */
const INVISIBLE_ONE = /\p{Default_Ignorable_Code_Point}/u
const MARK_ONE = /\p{M}/u
const DASH_ONE = /[\u2010-\u2015\u2212]/u

/**
 * `foldAccents`, also recording where each folded character was read from. `toRaw` and `toRawEnd`
 * are indexed by UTF-16 unit of the folded text (`toRaw.length === text.length`), the way the
 * callers index them: an astral part, or one that folds to several units, takes one slot per unit.
 */
function foldWithMap(raw: string): { text: string; toRaw: readonly number[]; toRawEnd: readonly number[] } {
  const text: string[] = []
  const toRaw: number[] = []
  const toRawEnd: number[] = []
  for (let index = 0; index < raw.length; ) {
    const char = String.fromCodePoint(raw.codePointAt(index) ?? 0)
    const start = index
    index += char.length
    if (INVISIBLE_ONE.test(char)) continue
    for (const part of (SMALL_CAPITALS[char] ?? char).normalize("NFKD")) {
      if (MARK_ONE.test(part)) continue
      const folded = asciiDigits(DASH_ONE.test(part) ? "-" : part)
      text.push(folded)
      for (let unit = 0; unit < folded.length; unit++) {
        toRaw.push(start)
        toRawEnd.push(index)
      }
    }
  }
  return { text: text.join(""), toRaw, toRawEnd }
}

/** Latin small capitals (U+1D00 block and a few in IPA Extensions) to the capital letters they look like (SEC-406). */
const SMALL_CAPITALS: Readonly<Record<string, string>> = {
  ᴀ: "A", ʙ: "B", ᴄ: "C", ᴅ: "D", ᴇ: "E", ꜰ: "F", ɢ: "G", ʜ: "H", ɪ: "I", ᴊ: "J", ᴋ: "K", ʟ: "L", ᴍ: "M",
  ɴ: "N", ᴏ: "O", ᴘ: "P", ꞯ: "Q", ʀ: "R", ꜱ: "S", ᴛ: "T", ᴜ: "U", ᴠ: "V", ᴡ: "W", ʏ: "Y", ᴢ: "Z",
}

/** Any Unicode decimal digit (Arabic-Indic ٤, Devanagari ४, ...) to its ASCII digit (SEC-405). */
export function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    if (/[0-9]/.test(digit)) return digit
    const code = digit.codePointAt(0) ?? 0
    // Every Unicode Nd block is a run of ten consecutive code points, 0 to 9.
    for (let zero = code; zero > code - 10; zero--) {
      if (!/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) return String(code - zero)
    }
    return digit
  })
}

