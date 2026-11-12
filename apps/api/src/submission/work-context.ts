import { codeOfCountry } from "../discovery/rules/locations.js"
import { PLACES, REGION_MEMBERS, areasIn, escapeRegExp } from "../discovery/rules/places.js"

/**
 * EPIC-0002 B1 (architecture r4 "Work-authorization and sponsorship answers
 * under Job Preferences", AC 5.18, 5.19): the countries the work-question
 * classifier reads, built from the Candidate's Job Preferences version, never
 * from free text. `candidate_setting.work_authorization` is no longer read.
 */
export type WorkContext = Readonly<{
  home: string
  /** ISO codes; always includes `home`, home first (AC 4). */
  authorized: readonly string[]
  sponsorshipNeeded: boolean
}>

/** The role's location for a sponsorship answer: the countries the Eligibility location rule resolved, or unclear. */
export type RoleLocation = Readonly<{ kind: "countries"; codes: readonly string[] }> | Readonly<{ kind: "unclear" }>

/**
 * The context for a Candidate's preferences. Null without a home country (no
 * record: `STEP3_DEFAULTS`): there is no country to answer for, so every work
 * question is unclear and blocks. Code never guesses a country.
 */
export function workContextOf(values: Readonly<{ homeCountry: string | null; workAuthorizedCountries: readonly string[]; sponsorshipNeededForRelocation: boolean }>): WorkContext | null {
  if (values.homeCountry === null) return null
  return {
    home: values.homeCountry,
    authorized: [values.homeCountry, ...values.workAuthorizedCountries.filter((code) => code !== values.homeCountry)],
    sponsorshipNeeded: values.sponsorshipNeededForRelocation,
  }
}

/**
 * The role's location from the stored Eligibility result (r4 "Answer values":
 * the facts the location rule resolved). A relocation role is its destination
 * country. A remote or onsite role is the countries its location quote names,
 * only when every named area is one country (a region, or nothing, is unclear).
 * No stored result is unclear. Code never guesses a location.
 */
export function roleLocationOf(result: Readonly<{ arrangement: string; relocation_country: string | null; rules: ReadonlyArray<{ rule: string; quote: string | null }> }> | null): RoleLocation {
  if (result === null) return { kind: "unclear" }
  if (result.arrangement === "relocation") {
    const code = result.relocation_country === null ? null : codeOfCountry(result.relocation_country)
    return code === null ? { kind: "unclear" } : { kind: "countries", codes: [code] }
  }
  const quote = result.rules.find((rule) => rule.rule === "location")?.quote ?? null
  if (quote === null) return { kind: "unclear" }
  const areas = areasIn(quote.toLowerCase())
  if (areas.length === 0 || areas.some((area) => area.members.length !== 1)) return { kind: "unclear" }
  return { kind: "countries", codes: [...new Set(areas.map((area) => area.members[0]!))] }
}

/** The Operator's migrated values (0018 + 0027 v2): home Nigeria, authorized in Nigeria only, sponsorship needed. */
export const OWNER_WORK_CONTEXT: WorkContext = { home: "NG", authorized: ["NG"], sponsorshipNeeded: true }

/**
 * The three place lists per country (r4): `formalNames` (the country's names a
 * label uses for the place of work), `workPlaces` (cities read as that country
 * in an authorization label) and `sponsorshipPlaces` (names that make a
 * sponsorship-only label block). Nigeria's are exactly the slice 5 lists, so
 * the A0 golden is byte-equal; other countries come from the location catalog
 * (`places.ts`): the first name is formal, the rest are places.
 */
type CountryLists = Readonly<{ formalNames: readonly string[]; workPlaces: readonly string[]; sponsorshipPlaces: readonly string[] }>

const NIGERIA: CountryLists = {
  formalNames: ["nigeria", "the federal republic of nigeria"],
  workPlaces: ["lagos", "abuja", "port harcourt", "ibadan", "kano"],
  sponsorshipPlaces: ["nigeria", "nigerian", "lagos", "abuja", "port harcourt", "ibadan", "kano", "benin city", "enugu", "kaduna", "jos", "warri", "calabar", "uyo", "owerri", "abeokuta", "ilorin", "onitsha", "aba"],
}

/** Catalog names that are nationalities, not places of work: never an authorization place, but a sponsorship label naming one blocks (as "nigerian"). */
const NATIONALITIES: ReadonlySet<string> = new Set(["nigerian", "ghanaian", "kenyan", "egyptian"])

/** Extra formal names a label may use for a country beyond its catalog name. */
const FORMAL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  US: ["united states", "united states of america", "usa", "the united states"],
  GB: ["united kingdom", "the united kingdom", "uk", "great britain", "britain"],
  AE: ["united arab emirates", "the united arab emirates", "uae"],
  NL: ["netherlands", "the netherlands"],
}

function listsOf(code: string): CountryLists {
  if (code === "NG") return NIGERIA
  const place = PLACES.find((entry) => entry.code === code)
  const names = place?.names ?? []
  const formal = FORMAL_ALIASES[code] ?? names.slice(0, 1)
  const cities = names.filter((name) => !formal.includes(name) && !NATIONALITIES.has(name))
  const nationality = names.filter((name) => NATIONALITIES.has(name))
  return { formalNames: formal, workPlaces: cities, sponsorshipPlaces: [...formal, ...nationality, ...cities] }
}

/** Region aliases for the classifier: the PRD region table's names, plus ECOWAS (r4: this classifier only). */
const CLASSIFIER_REGIONS: ReadonlyArray<readonly [names: readonly string[], members: readonly string[]]> = [
  [["africa", "african"], REGION_MEMBERS.africa],
  [["emea"], REGION_MEMBERS.emea],
  [["ecowas"], ["BJ", "BF", "CV", "CI", "GM", "GH", "GN", "GW", "LR", "ML", "NE", "NG", "SN", "SL", "TG"]],
]

const EUROPE_ENTRY = String.raw`european union|europe|eea|schengen`
const ANY_COUNTRY_ENTRY = String.raw`any (other )?country`

/**
 * Today's `OTHER_PLACES` entries, each with the country it names (null for a
 * region or "any other country"). An entry naming an authorized country is
 * removed for that context (r4).
 */
const OTHER_PLACE_ENTRIES: ReadonlyArray<readonly [pattern: string, code: string | null]> = [
  [String.raw`united states( of america)?|usa|u\.s\.a?\.?`, "US"],
  [String.raw`united kingdom|u\.k\.|great britain|britain|england|scotland|wales|northern ireland`, "GB"],
  ["ireland", "IE"],
  [EUROPE_ENTRY, null],
  ["canada", "CA"], ["germany", "DE"], ["france", "FR"], ["spain", "ES"], ["portugal", "PT"], ["italy", null], ["netherlands", "NL"], ["belgium", null],
  ["switzerland", "CH"], ["austria", null], ["poland", "PL"], ["sweden", "SE"], ["norway", "NO"], ["denmark", "DK"], ["finland", null], ["australia", null],
  ["new zealand", null], ["singapore", "SG"], ["india", null], ["japan", null], ["south africa", "ZA"], ["kenya", "KE"], ["ghana", "GH"], ["egypt", "EG"],
  [String.raw`uae|united arab emirates`, "AE"], ["israel", null], ["brazil", null], ["mexico", null], [ANY_COUNTRY_ENTRY, null],
]
/** Today's trailing `OTHER_PLACES` alternatives for the short forms; each names US, GB or none (EU). */
const SHORT_FORMS: ReadonlyArray<readonly [form: string, code: string | null]> = [["us", "US"], ["uk", "GB"], ["eu", null]]

/** Single-country `OTHER_PLACES` entries kept for every context (code null above), with the country each names. */
const NAMED_COUNTRY: Readonly<Record<string, string>> = {
  italy: "IT", belgium: "BE", austria: "AT", finland: "FI", australia: "AU", "new zealand": "NZ", india: "IN", japan: "JP", israel: "IL", brazil: "BR", mexico: "MX",
}

/**
 * The places an `OTHER_PLACES` entry (or short form) covers, read against the
 * context (architecture r6 "B1 amendment (code review CR-B1-01)", step 6b): a
 * country entry covers that country; europe, european union, eea, schengen and
 * eu cover REGION_MEMBERS.europe; "any (other )?country" covers every country
 * except home.
 */
function coversAuthorized(entry: string, code: string | null, ctx: WorkContext): boolean {
  if (entry === ANY_COUNTRY_ENTRY) return ctx.authorized.some((authorized) => authorized !== ctx.home)
  const covered = entry === EUROPE_ENTRY || entry === "eu" ? REGION_MEMBERS.europe : [code ?? NAMED_COUNTRY[entry]].filter((named): named is string => named !== undefined)
  return covered.some((country) => ctx.authorized.includes(country))
}

/** The `OTHER_PLACES` pattern (slice 5 shape) for some entries and short forms. */
function otherPlacesPattern(entries: readonly string[], shorts: readonly string[], flags = ""): RegExp {
  const shortAlternatives = shorts.length === 0 ? "" : String.raw`|\b(in|the) (${shorts.join("|")})\b|\b(${shorts.join("|")})\)|\((${shorts.join("|")})\b`
  const main = entries.length === 0 ? String.raw`(?!)` : String.raw`\b(the )?(${entries.join("|")})\b`
  return new RegExp(`${main}${shortAlternatives}`, flags)
}

/** r6 step 6b (SEC-B1-2-01): a place qualifier and the whitespace or hyphen after it, at the end of the text before a match. */
const PLACE_QUALIFIER = /\b(new|north|northern|south|southern|east|eastern|west|western|upper|lower|central|greater|little)[\s-]+$/

/**
 * Architecture r6 step 6b, qualified-name guard (SEC-B1-2-01): true when any
 * `OTHER_PLACES` match in the remainder, scanned left to right as the regex
 * finds them (each a whole, word-bounded place name), is immediately preceded
 * by a place qualifier. "New Mexico" or "Northern Ireland" with GB authorized
 * may name a place inside an authorized country, so the answer is unclear.
 * The qualifier is read from the text before the match, never from the match:
 * "northern ireland" matched whole by the GB entry is preceded by "in".
 */
export function qualifiedPlace(remainder: string, places: CompiledPlaces): boolean {
  for (const match of remainder.matchAll(places.otherPlacesAll)) {
    if (PLACE_QUALIFIER.test(remainder.slice(0, match.index))) return true
  }
  return false
}

const EXCLUDED_PREFIX = String.raw`(other than|outside( of)?|except( for)?|besides|apart from|excluding|beyond) (the )?`
const PURELY_PREFIX = String.raw`^(are you (currently |presently )?(legally |lawfully )?(authori[sz]ed|eligible|permitted|allowed) to (legally |lawfully )?work|do you (currently )?have (the )?(legal )?right to work|(can|could) you (legally )?work|are you (legally )?able to (legally )?work) in `

export type CompiledPlaces = Readonly<{
  sponsorPlace: RegExp
  authOrWider: RegExp
  excluded: RegExp
  otherPlaces: RegExp
  /** `otherPlaces` with the `g` flag, for the qualified-name guard (r6 step 6b, SEC-B1-2-01). */
  otherPlacesAll: RegExp
  /** The `OTHER_PLACES` entries that cover an authorized country (r6 step 6b), or null when none does. */
  coveringPlaces: RegExp | null
  purelyAuth: readonly RegExp[]
}>

const alternation = (names: readonly string[]) => [...new Set(names)].map(escapeRegExp).join("|")
const cache = new Map<string, CompiledPlaces>()

/**
 * The place patterns for one context, memoised by `(home, authorized)`. For
 * `[NG]` each equals the slice 5 constant it replaces (asserted in
 * `work-context.spec.ts`): SPONSOR_PLACE = NIGERIAN_PLACE, AUTH_OR_WIDER =
 * NIGERIA_OR_WIDER, EXCLUDED = NIGERIA_EXCLUDED, OTHER_PLACES unchanged,
 * PURELY_AUTH = PURELY_NIGERIA.
 */
export function compiledPlaces(ctx: WorkContext): CompiledPlaces {
  const key = `${ctx.home}|${ctx.authorized.join(",")}`
  const hit = cache.get(key)
  if (hit) return hit
  const lists = ctx.authorized.map(listsOf)
  const formal = lists.flatMap((list) => list.formalNames)
  const regions = CLASSIFIER_REGIONS.filter(([, members]) => members.some((code) => ctx.authorized.includes(code))).flatMap(([names]) => names)
  const others = OTHER_PLACE_ENTRIES.filter(([, code]) => code === null || !ctx.authorized.includes(code))
  const shorts = SHORT_FORMS.filter(([, code]) => code === null || !ctx.authorized.includes(code))
  const coveringEntries = others.filter(([entry, code]) => coversAuthorized(entry, code, ctx)).map(([entry]) => entry)
  const coveringShorts = shorts.filter(([form, code]) => coversAuthorized(form, code, ctx)).map(([form]) => form)
  const compiled: CompiledPlaces = {
    sponsorPlace: new RegExp(String.raw`\b(${alternation(lists.flatMap((list) => list.sponsorshipPlaces))})\b`),
    authOrWider: new RegExp(String.raw`\b(${alternation([...lists.flatMap((list) => [...list.formalNames, ...list.workPlaces]), ...regions, "worldwide", "anywhere", "globally"])})\b`),
    excluded: new RegExp(String.raw`\b${EXCLUDED_PREFIX}(${formalAlternation(formal)})\b`),
    otherPlaces: otherPlacesPattern(others.map(([entry]) => entry), shorts.map(([form]) => form)),
    otherPlacesAll: otherPlacesPattern(others.map(([entry]) => entry), shorts.map(([form]) => form), "g"),
    coveringPlaces: coveringEntries.length + coveringShorts.length === 0 ? null : otherPlacesPattern(coveringEntries, coveringShorts),
    purelyAuth: lists.map((list) => new RegExp(String.raw`${PURELY_PREFIX}(${alternation([...list.formalNames].sort((x, y) => y.length - x.length))})( without (visa )?sponsorship)?$`)),
  }
  cache.set(key, compiled)
  return compiled
}

/** Formal names as one group, where "the federal republic of nigeria" reads as today's `(federal republic of )?nigeria` after an optional "the". */
function formalAlternation(names: readonly string[]): string {
  return alternation(names.map((name) => name.replace(/^the /, "")).sort((a, b) => b.length - a.length))
}
