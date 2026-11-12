import type { FxTable } from "../fx-rates.js"
import { evaluateHours } from "./hours.js"
import { evaluateIndustry } from "./industry.js"
import { codeOfCountry, countriesIn, countryAtStart } from "./locations.js"
import { type PayFloorPreference, type PayOutcome, type PayRange, evaluatePay } from "./pay.js"
import { areasIn, escapeRegExp, namesOf } from "./places.js"
import { evaluateEmploymentType, evaluateSeniority } from "./seniority.js"
import { type RuleName, type RuleOutcome, RULE_NAMES, foldForKeywords, sentencesOf } from "./rule-result.js"

export type WorkArrangement = "remote" | "relocation" | "onsite" | "unclear"
export type EmploymentType = "direct" | "employer_of_record" | "contract"

/**
 * What the model extracted. Every quote has already been checked to be a
 * substring of the posting (others were set to null). These are pointers and
 * labels only: no field here can set a rule result on its own.
 */
export type PostingFacts = Readonly<{
  workArrangement: WorkArrangement
  locationQuote: string | null
  relocationCountry: string | null
  relocationQuote: string | null
  sponsorshipQuote: string | null
  payQuote: string | null
  hoursQuote: string | null
  employerBusiness: string | null
  businessQuote: string | null
  employmentType: EmploymentType | null
}>

/** Fields read straight from the board API, preferred over anything parsed from text. */
export type StructuredFields = Readonly<{
  workplace: "remote" | "onsite" | "hybrid" | null
  /** Countries or regions the board says the role is limited to. Empty means worldwide; null means not given. */
  locationRestrictions: readonly string[] | null
  pay: PayRange | null
  employmentType: EmploymentType | null
}>

/**
 * EPIC-0002 B1: the evaluated Candidate's Job Preferences fields the
 * Eligibility rules read (contract v1.25.0 field table). Country values are
 * ISO 3166-1 alpha-2 codes; `excludedIndustries` are `industryKeySchema` keys.
 * A Candidate with no record is evaluated with `STEP3_DEFAULTS` (no home
 * country, no time zone, no pay floor), so every rule still has a result.
 */
export type EligibilityPreferences = Readonly<{
  homeCountry: string | null
  workAuthorizedCountries: readonly string[]
  remoteAccepted: boolean
  relocationAccepted: boolean
  sponsorshipNeededForRelocation: boolean
  excludedRelocationCountries: readonly string[]
  excludedIndustries: readonly string[]
  payFloor: PayFloorPreference | null
  timeZone: string | null
  latestWorkHour: string
  /** D44: accepted levels (`seniorityLevelSchema`) and employment types (`employmentTypeSchema`). */
  seniorityLevels: readonly string[]
  employmentTypes: readonly string[]
}>

/**
 * The Eligibility fields of a Job Preferences value. With no record, the
 * caller passes `STEP3_DEFAULTS` (the contract's no-record GET values).
 */
export function eligibilityPreferencesOf(values: Readonly<{
  homeCountry: string | null
  workAuthorizedCountries: readonly string[]
  remoteAccepted: boolean
  relocationAccepted: boolean
  sponsorshipNeededForRelocation: boolean
  excludedRelocationCountries: readonly string[]
  excludedIndustries: readonly string[]
  payFloor: Readonly<{ amount: string; currency: string; period: "month" | "year" }> | null
  timeZone: string | null
  latestWorkHour: string
  seniorityLevels: readonly string[]
  employmentTypes: readonly string[]
}>): EligibilityPreferences {
  return {
    homeCountry: values.homeCountry,
    workAuthorizedCountries: values.workAuthorizedCountries,
    remoteAccepted: values.remoteAccepted,
    relocationAccepted: values.relocationAccepted,
    sponsorshipNeededForRelocation: values.sponsorshipNeededForRelocation,
    excludedRelocationCountries: values.excludedRelocationCountries,
    excludedIndustries: values.excludedIndustries,
    payFloor: values.payFloor === null ? null : { amount: values.payFloor.amount, currency: values.payFloor.currency, period: values.payFloor.period },
    timeZone: values.timeZone,
    latestWorkHour: values.latestWorkHour,
    seniorityLevels: values.seniorityLevels,
    employmentTypes: values.employmentTypes,
  }
}

export type EligibilityInput = Readonly<{
  /** D44: the seniority rule reads the title only, as `seniorityMarker` does. Null for an untitled posting. */
  title: string | null
  postingText: string
  facts: PostingFacts
  structured: StructuredFields
  preferences: EligibilityPreferences
  rates: FxTable
  evaluatedOn: Date
}>

export type EligibilityOutcome = Readonly<{
  arrangement: "remote" | "relocation" | "onsite"
  relocationCountry: string | null
  employmentType: EmploymentType | null
  rules: Readonly<Record<Exclude<RuleName, "pay">, RuleOutcome>> & Readonly<{ pay: PayOutcome }>
}>

export type EligibilityDecision = Readonly<{
  eligible: boolean
  violatedRules: RuleName[]
  /** Rules shown as "Unverified: {rule}" labels, in AC order. Never includes a not-applicable rule. */
  unverifiedLabels: RuleName[]
}>

/**
 * A move of the worker to a place that the posting requires (CR3B-01, SEC-311):
 * a requirement word straight before the verb ("must move to X", "be willing to
 * relocate to X", "you will be relocating to X"), or "Relocate to X" opening a
 * sentence. A bare "move to" or "relocate to" ("our engineers move to Austin
 * eventually", "help customers relocate to Germany") is not a relocation.
 */
const REQUIRED_MOVE_TO =
  /(?:\b(?:must|will need to|need to|needs to|required to|have to|has to|be willing to|expected to|you will|you'll|will) (?:be willing to )?(?:move|relocate|be relocating|be based)|^(?:please )?relocate) to\b/
/**
 * "relocation to X" names a move without saying who must make it. It counts as
 * the posting's relocation, but only a required move lifts a remote
 * restriction (SEC-311): see `locationForRelocation`.
 */
const RELOCATION_NOUN_TO = /\brelocation to\b/
/** A sentence that says the move is required, wherever the word sits ("relocation to Dubai required"). */
const REQUIRED_WORD = /\b(required|requires|mandatory|must)\b/
/** A relocation stated as a requirement with no destination ("Relocation required", "willing to relocate"). */
const RELOCATION_REQUIRED = /\b(relocation (is )?required|must (be willing to )?relocate|(willing|required|expected|need) to relocate)\b/
/** Wording that makes a stated move optional or not needed. */
const RELOCATION_OPTIONAL =
  /\b(optional|if you (ever|choose|want|wish)|not (needed|required|necessary)|no relocation|isn't required|not a requirement|later|eventually|someday|one day|in the future|could|may|might)\b/
/** Words a destination may follow ("relocate to our Lisbon hub", "relocation to the Netherlands"). */
const DESTINATION_LEAD = /^\s*(?:(?:our|the|a|an|beautiful|sunny|lovely|new|central|downtown)\s+)*/
/** A positive remote statement. "Distributed systems" or "remote" inside a negation is not one. */
const REMOTE = /\b(remote|work from (home|anywhere)|fully distributed|distributed (team|company)|home[- ]based)\b/
/** Onsite and office floors that win over any remote reading, structured board data included (SEC-302, F-QA3B-03, SEC-309). */
const ONSITE = [
  /\b(from|at|in|into|to|visit|visiting|based (in|at|out of)) (the |our )?([a-z]+ )?(hq|headquarters)\b/,
  /\boffice attendance\b/,
  /\bcome in(to)?\b/,
  /\bcommut(e|ing) (distance|to|into)\b/,
  /\b(will|must|to|need to|required to|have to) commute\b/,
  /\bhybrid\s*[:(,;/-]/,
  /\bhybrid (role|position|working|work|model|schedule|arrangement|setup|basis|environment)\b/,
  /\b(is|are|be|role is) hybrid\b/,
  /\b(not|isn't|is not|no)( a| an)? (fully )?remote\b/,
  /\bremote (work )?(is )?not (possible|available|offered|an option)\b/,
  /\b(on-?site|in-?person|in the office|in office|office-based|office based)\b/,
  /\b\d+ days? (a|per) week\b/,
  /\bdays? (a|per) week in\b/,
  /\bbased (in|at|out of) (our|the) [a-z .'-]*office\b/,
  /\b(our|the) [a-z .'-]+ office\b(?! (is|are) optional)/,
  /\b[a-z]+ office, \d/,
]
/** A negation in a clause that names a place excludes it (F-QA3-03). */
const NEGATION =
  /\b(not|no|never|cannot|can't|can ?not|unable|don't|do not|doesn't|does not|won't|will not|aren't|isn't|excluding|excluded|exclude|except|outside( of)?|other than|barring|besides|apart from|unsupported|ineligible|restricted|prohibited|unavailable)\b/
/** Words that say a clause includes a place. */
const INCLUSION =
  /\b(open to|including|includes|include|welcome[sd]?|eligible|accepted|accept|hire|hiring|hires|considered|consider|available|based in|located in|living in|residing in|work from|from anywhere in|candidates in|applicants in|anywhere in)\b/
/** Stand-in for a named area (catalog country, city or table region) in a masked clause. */
const AREA = "qqareaqq"
/** A bare location list once areas are masked ("Remote, Lagos, Nigeria", "Location: Nigeria", "Remote, Nairobi or Lagos", "Remote, Accra time zone"). */
const LOCATION_LIST = new RegExp(String.raw`^(location: ?)?((remote|hybrid|on-?site|worldwide|global|or|and|only|time ?zones?|${AREA})[ ,/|()&-]*)+$`)

const WORLDWIDE = /\b(anywhere in the world|worldwide|work from anywhere|globally|global remote|any country)\b/
/** One area or a list of them ("north america or africa") once masked. Areas come from the catalog and region table (`places.ts`). */
const RESTRICTED_REGION = String.raw`(${AREA}(?:(?:,? (?:and|or) |, |/| & )${AREA})*)`
const RESTRICTIONS = [
  new RegExp(String.raw`\b${RESTRICTED_REGION}[- ](only|based only|residents only)\b`),
  new RegExp(String.raw`\b(only|must be|must live|must reside|located|based|residing) (in|within) (the )?${RESTRICTED_REGION}\b`),
  new RegExp(String.raw`\bremote within (the )?${RESTRICTED_REGION}\b`),
  new RegExp(String.raw`\b${RESTRICTED_REGION}[- ]based\b`),
  new RegExp(String.raw`\b(open to|for) (the )?${RESTRICTED_REGION} (residents|citizens|nationals|persons|candidates)( only)?\b`),
  new RegExp(String.raw`\b${RESTRICTED_REGION} (residents|citizens|nationals) only\b`),
  new RegExp(String.raw`\b${RESTRICTED_REGION} only\b`),
]
const SPONSORSHIP_REFUSED = [
  /\b(unable to|cannot|can't|can ?not|do not|don't|won't|will not|not able to|does not|doesn't)( offer| provide)?( visa)? sponsor/,
  /\bsponsorship (is |will )?not (be )?(available|offered|provided|possible)\b/,
  /\bno (visa )?sponsorship\b/,
  /\bwithout (visa )?sponsorship\b/,
]
const SPONSORSHIP_OFFERED = [/\bvisa sponsorship\b/, /\bsponsor(ship)? (is )?(provided|available|offered)\b/, /\bwe (will )?sponsor\b/, /\bwith (visa )?sponsorship\b/]
const EMPLOYMENT_TYPES: ReadonlyArray<readonly [EmploymentType, RegExp]> = [
  ["employer_of_record", /\b(employer[- ]of[- ]record|eor)\b/],
  ["contract", /\b(contract(or|ing)?|freelance|independent contractor)\b/],
  ["direct", /\b(direct employment|full[- ]time|permanent|employee)\b/],
]

/**
 * Computes every Eligibility rule in code (AC 4.1 to 4.8). Structured board
 * fields come first, then keyword floors over the posting text. Model output is
 * used only for the employer's business and to fill a quote the code found no
 * better text for; it can never turn a violated result into anything else.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityOutcome {
  const sentences = sentencesOf(input.postingText)
  const relocation = findRelocation(sentences, input)
  const remoteLocation = () => locationForRemote(sentences, input)
  const arrangement = relocation ? "relocation" : isRemote(input) ? "remote" : "onsite"
  const relocationCountry = relocation?.country ?? null
  const employmentType = input.structured.employmentType ?? employmentTypeIn(input.postingText) ?? input.facts.employmentType
  return {
    arrangement,
    relocationCountry,
    employmentType,
    rules: {
      location: relocation ? locationForRelocation(relocation, remoteLocation, input.preferences) : remoteLocation(),
      sponsorship: sponsorshipFor(arrangement, relocationCountry, sentences, input.preferences),
      pay: evaluatePay({ structured: input.structured.pay, quote: input.facts.payQuote, postingText: input.postingText }, input.rates, input.preferences.payFloor),
      hours: evaluateHours(input.postingText, { latestWorkHour: input.preferences.latestWorkHour, timeZone: input.preferences.timeZone }, input.evaluatedOn),
      industry: evaluateIndustry({
        postingText: input.postingText,
        employerBusiness: input.facts.employerBusiness,
        businessQuote: input.facts.businessQuote,
        excludedIndustries: input.preferences.excludedIndustries,
      }),
      seniority: evaluateSeniority(input.title, input.preferences.seniorityLevels),
      employment_type: evaluateEmploymentType(employmentType, input.preferences.employmentTypes),
    },
  }
}

/** AC 4.9: any violated rule excludes; Unverified rules never block and become labels. */
export function decideEligibility(outcome: EligibilityOutcome): EligibilityDecision {
  const violatedRules = RULE_NAMES.filter((rule) => outcome.rules[rule].result === "violated")
  const unverifiedLabels = RULE_NAMES.filter((rule) => outcome.rules[rule].result === "unverified")
  return { eligible: violatedRules.length === 0, violatedRules, unverifiedLabels }
}

/** `required`: the posting says the worker must move (SEC-311). Only then does the destination replace remote restrictions. */
type Relocation = Readonly<{ country: string | null; quote: string; required: boolean }>

/**
 * Relocation from the text needs a required move to a named place (CR3B-01).
 * A destination found this way wins over board remote data, because the
 * posting itself asks the worker to move. A required relocation with no
 * destination never overrides board remote data or a positive remote
 * statement; it is ignored then, and counts only when nothing says remote.
 */
function findRelocation(sentences: readonly string[], input: EligibilityInput): Relocation | null {
  let undirected: Relocation | null = null
  for (const sentence of sentences) {
    const folded = foldForKeywords(sentence)
    if (RELOCATION_OPTIONAL.test(folded)) continue
    const destination = destinationIn(folded)
    if (destination !== null) return { ...destination, quote: sentence }
    if (undirected === null && RELOCATION_REQUIRED.test(folded)) undirected = { country: null, quote: sentence, required: true }
  }
  const { structured } = input
  if (structured.workplace === "onsite" || structured.workplace === "hybrid") {
    const country = (structured.locationRestrictions ?? []).flatMap((place) => countriesIn(foldForKeywords(place)))[0]
    const home = homePattern(input.preferences)
    const atHome = home !== null && (structured.locationRestrictions ?? []).some((place) => home.test(foldForKeywords(place)))
    if (country && !atHome) return { country, quote: (structured.locationRestrictions ?? []).join(", "), required: true }
  }
  if (undirected !== null && !isRemote(input)) return undirected
  return null
}

/**
 * The country named straight after a move phrase, or null. "Our move to React"
 * names no country. A required move wins over a "relocation to" noun phrase.
 */
function destinationIn(folded: string): Readonly<{ country: string; required: boolean }> | null {
  const required = countryAfter(folded, REQUIRED_MOVE_TO)
  if (required) return { country: required, required: true }
  const named = countryAfter(folded, RELOCATION_NOUN_TO)
  return named ? { country: named, required: REQUIRED_WORD.test(folded) } : null
}

function countryAfter(folded: string, phrase: RegExp): string | null {
  for (const match of folded.matchAll(new RegExp(phrase.source, "g"))) {
    const after = folded.slice(match.index + match[0].length).replace(DESTINATION_LEAD, "")
    const country = countryAtStart(after)
    if (country) return country
  }
  return null
}

/**
 * F-QA3B-03: a structured "remote" no longer decides alone. Explicit onsite or
 * office text, or the model reading the posting as onsite or relocation, wins
 * over it (exclusion direction only). A structured onsite or hybrid is never remote.
 */
function isRemote(input: EligibilityInput): boolean {
  if (input.structured.workplace !== null && input.structured.workplace !== "remote") return false
  const sentences = sentencesOf(input.postingText).map(foldForKeywords)
  if (sentences.some((sentence) => ONSITE.some((pattern) => pattern.test(sentence)))) return false
  if (input.facts.workArrangement === "onsite" || input.facts.workArrangement === "relocation") return false
  return input.structured.workplace === "remote" || sentences.some((sentence) => REMOTE.test(sentence))
}

/**
 * The destination decides location. SEC-311: when the move is not clearly
 * required, a remote restriction the posting states (Nigeria refused, "<region>
 * only", board restrictions) stays in force and wins.
 */
function locationForRelocation(relocation: Relocation, remoteLocation: () => RuleOutcome, preferences: EligibilityPreferences): RuleOutcome {
  // AC 5.6: a relocation posting is violated for a Candidate who accepts remote work only.
  if (!preferences.relocationAccepted) return { result: "violated", quote: relocation.quote }
  if (!relocation.required) {
    const remote = remoteLocation()
    if (remote.result === "violated") return remote
  }
  if (relocation.country === null) return { result: "unverified", quote: relocation.quote }
  const code = codeOfCountry(relocation.country)
  return { result: code !== null && preferences.excludedRelocationCountries.includes(code) ? "violated" : "met", quote: relocation.quote }
}

/**
 * The remote location rule over the Candidate's countries (AC 5.2 to 5.5). The
 * order is EPIC-0001's, with Nigeria replaced by the home country and its
 * places, and a region read through the table (E1):
 * 1. an explicit exclusion of the home country is violated (it wins, :208);
 * 2. structured board restrictions: met when one names an own country or a region holding one;
 * 3. a positive statement naming an own country or a region holding one is met;
 * 4. a stated restriction to areas holding none of them is violated;
 * 5. otherwise Unverified. An excluded work-authorized country that is not the
 *    home country is not an own country here (E6), so it neither meets nor violates.
 */
function locationForRemote(sentences: readonly string[], input: EligibilityInput): RuleOutcome {
  const { preferences } = input
  // AC 5.2: a remote posting is violated for a Candidate who accepts relocation only.
  if (!preferences.remoteAccepted) return { result: "violated", quote: sentences.find((sentence) => REMOTE.test(foldForKeywords(sentence))) ?? input.facts.locationQuote }
  const home = homePattern(preferences)
  if (home !== null) {
    for (const sentence of sentences) {
      const folded = foldForKeywords(sentence)
      if (refusedPatterns(home).some((pattern) => pattern.test(folded)) || negatedIn(folded, home)) return { result: "violated", quote: sentence }
    }
  }
  const own = ownCountries(sentences, preferences)
  const holdsOwn = (members: readonly string[]) => members.some((code) => own.has(code))
  const restrictions = input.structured.locationRestrictions
  if (restrictions && restrictions.length > 0) {
    const label = restrictions.join(", ")
    const met = restrictions.some((place) => areasIn(foldForKeywords(place)).some((area) => holdsOwn(area.members)))
    return { result: met ? "met" : "violated", quote: label }
  }
  for (const sentence of sentences) {
    if (includesOwn(foldForKeywords(withoutPronounUs(sentence)), holdsOwn)) return { result: "met", quote: sentence }
  }
  for (const sentence of sentences) {
    const masked = maskAreas(foldForKeywords(withoutPronounUs(sentence)))
    if (RESTRICTIONS.some((pattern) => pattern.test(masked.text))) return { result: "violated", quote: sentence }
  }
  const worldwide = sentences.find((sentence) => WORLDWIDE.test(foldForKeywords(sentence)))
  return { result: "unverified", quote: worldwide ?? input.facts.locationQuote }
}

/** `\b(home names)\b` for the home country, or null without one (no record). The Operator's is EPIC-0001's Nigeria pattern. */
function homePattern(preferences: EligibilityPreferences): RegExp | null {
  const names = preferences.homeCountry === null ? [] : namesOf(preferences.homeCountry)
  return names.length === 0 ? null : new RegExp(String.raw`\b(${names.map(escapeRegExp).join("|")})\b`)
}

/** EPIC-0001's refusal phrasings, over the home country's names. */
function refusedPatterns(home: RegExp): RegExp[] {
  const names = home.source.slice(2, -2)
  return [
    new RegExp(String.raw`\b(cannot|can't|can ?not|unable to|do not|don't|not able to|won't|will not) (hire|employ|accept|consider)\b[^.;]*\b${names}\b`),
    new RegExp(String.raw`\b(excluding|except|not including|not open to|not available in|outside of)\b[^.;]*\b${names}\b`),
  ]
}

/** The home country and every work-authorized country the posting does not explicitly exclude (E6). */
function ownCountries(sentences: readonly string[], preferences: EligibilityPreferences): Set<string> {
  const own = new Set<string>([...(preferences.homeCountry === null ? [] : [preferences.homeCountry]), ...preferences.workAuthorizedCountries])
  for (const code of preferences.workAuthorizedCountries) {
    if (code === preferences.homeCountry) continue
    const names = namesOf(code)
    if (names.length === 0) continue
    const pattern = new RegExp(String.raw`\b(${names.map(escapeRegExp).join("|")})\b`)
    if (sentences.some((sentence) => {
      const folded = foldForKeywords(withoutPronounUs(sentence))
      return refusedPatterns(pattern).some((refused) => refused.test(folded)) || negatedIn(folded, pattern)
    })) own.delete(code)
  }
  return own
}

/** The folded text with every catalog area replaced by `AREA`, and the areas in order. */
function maskAreas(folded: string): Readonly<{ text: string; members: ReadonlyArray<readonly string[]> }> {
  const areas = areasIn(folded)
  let text = ""
  let at = 0
  for (const area of areas) {
    text += `${folded.slice(at, area.index)}${AREA}`
    at = area.index + area.text.length
  }
  return { text: text + folded.slice(at), members: areas.map((area) => area.members) }
}

/**
 * True when a clause that is not negated names an own country or a region
 * holding one, and says so: an inclusion word, a bare location list, or a
 * stated restriction ("Remote, South Africa only" for a South Africa-authorized Candidate).
 */
function includesOwn(folded: string, holdsOwn: (members: readonly string[]) => boolean): boolean {
  return clausesOf(folded).some((clause) => {
    if (NEGATION.test(clause)) return false
    const masked = maskAreas(clause)
    if (!masked.members.some(holdsOwn)) return false
    return INCLUSION.test(clause) || LOCATION_LIST.test(masked.text) || restrictionHoldsOwn(masked, holdsOwn)
  })
}

/** "<areas> only" restrictions: an own area limited this way includes the Candidate. "Lagos-based" is a preference, not a limit. */
const ONLY_RESTRICTIONS = [
  new RegExp(String.raw`\b${RESTRICTED_REGION}[- ](only|based only|residents only)\b`),
  new RegExp(String.raw`\b${RESTRICTED_REGION} only\b`),
  new RegExp(String.raw`\b(only|must be|must live|must reside|located|based|residing) (in|within) (the )?${RESTRICTED_REGION}\b`),
  new RegExp(String.raw`\bremote within (the )?${RESTRICTED_REGION}\b`),
]

/** True when a stated "only" restriction's own areas hold an own country ("South Africa only"), not another area in the clause ("Lagos-based …, U.S. only"). */
function restrictionHoldsOwn(masked: Readonly<{ text: string; members: ReadonlyArray<readonly string[]> }>, holdsOwn: (members: readonly string[]) => boolean): boolean {
  for (const pattern of ONLY_RESTRICTIONS) {
    for (const match of masked.text.matchAll(new RegExp(pattern.source, "g"))) {
      const first = masked.text.slice(0, match.index).split(AREA).length - 1
      const count = match[0].split(AREA).length - 1
      if (masked.members.slice(first, first + count).some(holdsOwn)) return true
    }
  }
  return false
}

/**
 * CR3B-07: lower-case "us" is the pronoun ("send your CV to us only"), not the
 * country, unless a place word comes before it ("the us", "remote, us",
 * "within us"). "US", "U.S." and "USA" are untouched.
 */
function withoutPronounUs(sentence: string): string {
  return sentence.replace(/\bus\b/g, (word, offset: number) =>
    /\b(the|remote|in|within|from|across|outside)[\s,(/-]*$/i.test(sentence.slice(0, offset)) ? word : "we"
  )
}

/**
 * Clauses of a folded sentence, split on ";", "but", "however" and commas that
 * start a new clause. A list of places ("Nigeria, Ghana or Kenya") stays with
 * its clause because a comma followed by a place name does not split.
 */
function clausesOf(folded: string): string[] {
  return folded
    .split(/;|\bbut\b|\bhowever\b|,(?=\s*(?:we|you|they|this|the role|it|and we|which|although|though)\b)/)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "")
}

/** True when a clause names the place and is negated (F-QA3-03). */
function negatedIn(folded: string, place: RegExp): boolean {
  return clausesOf(folded).some((clause) => place.test(clause) && NEGATION.test(clause))
}

/**
 * AC 5.6, 5.9 (E5): sponsorship is not applicable on a remote posting, for a
 * Candidate who needs no sponsorship, and for relocation to the home country
 * or a work-authorized country. Otherwise EPIC-0001's sponsorship rule.
 */
function sponsorshipFor(arrangement: string, relocationCountry: string | null, sentences: readonly string[], preferences: EligibilityPreferences): RuleOutcome {
  if (arrangement === "remote" || !preferences.sponsorshipNeededForRelocation) return { result: "not_applicable", quote: null }
  const code = relocationCountry === null ? null : codeOfCountry(relocationCountry)
  if (code !== null && (code === preferences.homeCountry || preferences.workAuthorizedCountries.includes(code))) return { result: "not_applicable", quote: null }
  return sponsorship(sentences)
}

function sponsorship(sentences: readonly string[]): RuleOutcome {
  for (const sentence of sentences) {
    if (SPONSORSHIP_REFUSED.some((pattern) => pattern.test(foldForKeywords(sentence)))) return { result: "violated", quote: sentence }
  }
  for (const sentence of sentences) {
    if (SPONSORSHIP_OFFERED.some((pattern) => pattern.test(foldForKeywords(sentence)))) return { result: "met", quote: sentence }
  }
  return { result: "unverified", quote: null }
}

function employmentTypeIn(text: string): EmploymentType | null {
  const folded = foldForKeywords(text)
  for (const [type, pattern] of EMPLOYMENT_TYPES) if (pattern.test(folded)) return type
  return null
}
