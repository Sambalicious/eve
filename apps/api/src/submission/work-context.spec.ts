import { describe, expect, it } from "vitest"

import { type AnswerSources, type FormField, answerFor, classifyWorkQuestion, labelTampered } from "./answer-assignment.js"
import { OWNER_WORK_CONTEXT, type WorkContext, compiledPlaces, roleLocationOf, workContextOf } from "./work-context.js"

/**
 * EPIC-0002 B1 unit 6 (architecture r4 "Work-authorization and sponsorship
 * answers under Job Preferences"; eligibility-under-job-preferences.feature
 * :558 to :668). The classifier reads the Candidate's countries, never free text.
 */
const KOFI: WorkContext = { home: "GH", authorized: ["GH"], sponsorshipNeeded: true }
const KOFI_UK: WorkContext = { home: "GH", authorized: ["GH", "GB"], sponsorshipNeeded: true }
const WANJIRU_ZA: WorkContext = { home: "KE", authorized: ["KE", "ZA"], sponsorshipNeeded: true }
const SELECT = { kind: "select" as const, options: ["Please select", "Yes", "No"] }

function sources(work: WorkContext, roleLocation: AnswerSources["roleLocation"] = { kind: "countries", codes: ["US"] }): AnswerSources {
  return { fullName: "Kofi Mensah", contactLines: ["Accra, Ghana"], work, roleLocation, answers: [], grossSalaryPolicy: null, currentSalary: null }
}
const schemaAnswer = (label: string, src: AnswerSources) =>
  answerFor({ ref: "f1", label: "(page label ignored)", required: true, ...SELECT, fieldName: "question_1", schemaQuestion: { text: label, fieldName: "question_1" } }, src)

describe("workContextOf (from Job Preferences)", () => {
  it("authorized always includes home, home first, no duplicates", () => {
    expect(workContextOf({ homeCountry: "GH", workAuthorizedCountries: ["GB", "GH"], sponsorshipNeededForRelocation: false })).toEqual({ home: "GH", authorized: ["GH", "GB"], sponsorshipNeeded: false })
  })

  it("no home country (no record, STEP3_DEFAULTS): null, so every work question blocks", () => {
    expect(workContextOf({ homeCountry: null, workAuthorizedCountries: [], sponsorshipNeededForRelocation: true })).toBeNull()
  })

  it("OWNER_WORK_CONTEXT is the Operator's 0027 values: NG only, sponsorship needed", () => {
    expect(OWNER_WORK_CONTEXT).toEqual({ home: "NG", authorized: ["NG"], sponsorshipNeeded: true })
  })
})

describe(":581 the converted classifier places authorization labels against the Candidate's countries (GH; GH, GB)", () => {
  it.each([
    ["are you legally authorized to work in ghana?", "authorized"],
    ["are you authorized to work in the united kingdom?", "authorized"],
    ["are you legally authorized to work in the united states?", "not_authorized"],
  ])("%s: %s", (label, result) => {
    expect(classifyWorkQuestion(label, KOFI_UK)).toBe(result)
  })
})

describe(":605 an authorization naming more than the home country no longer blocks", () => {
  it("South Africa for KE, ZA", () => {
    expect(classifyWorkQuestion("are you legally authorized to work in south africa?", WANJIRU_ZA)).toBe("authorized")
  })
})

describe(":611 a label the classifier cannot place blocks as unclear (GH)", () => {
  it.each([
    "are you authorized to work in africa?",
    "are you authorized to work in ghana and the united kingdom?",
    "do you require sponsorship to work in accra?",
    "are you authorized to work in your country of residence?",
    "are you authorized to work in accra without sponsorship?",
    "are you authorized to work in nigeria?",
  ])("%s", (label) => {
    expect(classifyWorkQuestion(label, KOFI)).toBe("unclear")
  })
})

describe(":626 the slice 5 safety limits block for every Candidate", () => {
  it.each([
    ["Are you not authorized to work in Ghana?", KOFI],
    ["Are you authorized to work in Ghana? Do you need a visa?", KOFI],
    ["\u0410re you authorized to work in Ghana?", KOFI],
    ["Are you not authorized to work in Nigeria?", OWNER_WORK_CONTEXT],
  ] as const)("%s", (label, ctx) => {
    expect(classifyWorkQuestion(label, ctx)).toBe("unclear")
    expect(schemaAnswer(label, sources(ctx))).toMatchObject({ reason: "missing_approved_answer" })
  })

  it("tampered hidden content blocks a page-read answer", () => {
    const field: FormField = { ref: "f1", label: "Are you authorized to work in Ghana?", required: true, ...SELECT, labelCheck: { readings: ["Are you authorized to work in Ghana?"], flags: ["hidden_node"] } }
    expect(labelTampered(field, KOFI)).toBe(true)
  })
})

describe(":573/:668 authorization answers from each Candidate's own countries", () => {
  it("Kofi (GH): the UK is No; Kenya is No for Kofi and Yes for Wanjiru", () => {
    expect(schemaAnswer("Are you authorized to work in the United Kingdom?", sources(KOFI))).toMatchObject({ kind: "value", value: "No", source: "settings_work_authorization" })
    expect(schemaAnswer("Are you authorized to work in Kenya?", sources(KOFI))).toMatchObject({ value: "No" })
    expect(schemaAnswer("Are you authorized to work in Kenya?", sources({ home: "KE", authorized: ["KE"], sponsorshipNeeded: true }))).toMatchObject({ value: "Yes" })
  })
})

describe(":558/:593 a sponsorship-only question is answered from the need and the role's location", () => {
  const label = "Will you now or in the future require visa sponsorship?"
  it.each([
    [true, ["DE"], "Yes"],
    [false, ["DE"], "No"],
    [true, ["GH"], "No"],
  ] as const)("need %s, role in %j: %s", (need, codes, answer) => {
    expect(schemaAnswer(label, sources({ ...KOFI, sponsorshipNeeded: need }, { kind: "countries", codes }))).toMatchObject({ kind: "value", value: answer, source: "rule_sponsorship" })
  })

  it.each([
    [true, ["NL"], "Yes"],
    [true, ["ZA"], "No"],
    [true, ["KE"], "No"],
    [false, ["NL"], "No"],
  ] as const)("Wanjiru (KE; KE, ZA) need %s, role in %j: %s", (need, codes, answer) => {
    expect(schemaAnswer(label, sources({ ...WANJIRU_ZA, sponsorshipNeeded: need }, { kind: "countries", codes }))).toMatchObject({ value: answer })
  })

  it("an unclear role location, no countries, or a mix of authorized and other countries blocks", () => {
    for (const roleLocation of [{ kind: "unclear" as const }, { kind: "countries" as const, codes: [] }, { kind: "countries" as const, codes: ["GH", "DE"] }]) {
      expect(schemaAnswer(label, sources(KOFI, roleLocation))).toMatchObject({ reason: "missing_approved_answer" })
    }
  })

  it("the Operator: a role outside Nigeria is Yes, a Nigeria-located role is No (PRD E5)", () => {
    expect(schemaAnswer(label, sources(OWNER_WORK_CONTEXT, { kind: "countries", codes: ["US"] }))).toMatchObject({ value: "Yes" })
    expect(schemaAnswer(label, sources(OWNER_WORK_CONTEXT, { kind: "countries", codes: ["NG"] }))).toMatchObject({ value: "No" })
  })
})

describe("no Job Preferences record: every work question blocks", () => {
  it.each(["Are you authorized to work in Nigeria?", "Are you authorized to work in the United States?", "Will you require visa sponsorship?"])("%s", (label) => {
    expect(classifyWorkQuestion(label.toLowerCase(), null)).toBe("unclear")
    expect(schemaAnswer(label, { ...sources(KOFI), work: null })).toMatchObject({ reason: "missing_approved_answer" })
  })
})

describe("structured countries replace the slice 5 free-text setting", () => {
  it("NG and CA: Canada is Yes; a role in Canada needs no sponsorship (slice 5 blocked any setting other than Nigeria only)", () => {
    const ctx: WorkContext = { home: "NG", authorized: ["NG", "CA"], sponsorshipNeeded: true }
    expect(schemaAnswer("Are you authorized to work in Canada?", sources(ctx))).toMatchObject({ value: "Yes" })
    expect(schemaAnswer("Will you require visa sponsorship?", sources(ctx, { kind: "countries", codes: ["CA"] }))).toMatchObject({ value: "No" })
  })
})

describe("roleLocationOf (the facts the Eligibility location rule resolved)", () => {
  const rules = (quote: string | null) => [{ rule: "location", result: "met", quote }]
  it("relocation: the destination country; remote: the one-country areas the location quote names", () => {
    expect(roleLocationOf({ arrangement: "relocation", relocation_country: "Netherlands", rules: rules("Relocation to Amsterdam") })).toEqual({ kind: "countries", codes: ["NL"] })
    expect(roleLocationOf({ arrangement: "remote", relocation_country: null, rules: rules("Remote, open to candidates in Nigeria") })).toEqual({ kind: "countries", codes: ["NG"] })
    expect(roleLocationOf({ arrangement: "remote", relocation_country: null, rules: rules("Remote, Nairobi or Lagos") })).toEqual({ kind: "countries", codes: ["KE", "NG"] })
  })

  it("a region, no named place, no quote or no stored result is unclear", () => {
    expect(roleLocationOf({ arrangement: "remote", relocation_country: null, rules: rules("Remote, EMEA") })).toEqual({ kind: "unclear" })
    expect(roleLocationOf({ arrangement: "remote", relocation_country: null, rules: rules("Remote") })).toEqual({ kind: "unclear" })
    expect(roleLocationOf({ arrangement: "remote", relocation_country: null, rules: rules(null) })).toEqual({ kind: "unclear" })
    expect(roleLocationOf({ arrangement: "relocation", relocation_country: null, rules: rules(null) })).toEqual({ kind: "unclear" })
    expect(roleLocationOf(null)).toEqual({ kind: "unclear" })
  })
})

describe("compiled places for the Operator equal the slice 5 constants", () => {
  it("each pattern source is the constant it replaced", () => {
    const places = compiledPlaces(OWNER_WORK_CONTEXT)
    expect(places.authOrWider.source).toBe(String.raw`\b(nigeria|the federal republic of nigeria|lagos|abuja|port harcourt|ibadan|kano|africa|african|emea|ecowas|worldwide|anywhere|globally)\b`)
    expect(places.excluded.source).toBe(String.raw`\b(other than|outside( of)?|except( for)?|besides|apart from|excluding|beyond) (the )?(federal republic of nigeria|nigeria)\b`)
    expect(places.sponsorPlace.source).toBe(String.raw`\b(nigeria|nigerian|lagos|abuja|port harcourt|ibadan|kano|benin city|enugu|kaduna|jos|warri|calabar|uyo|owerri|abeokuta|ilorin|onitsha|aba)\b`)
  })
})

/**
 * Architecture r6 "B1 amendment (code review CR-B1-01)": step 6 answers "No"
 * only when the places the label names provably include none of the
 * Candidate's authorized countries; any doubt is unclear. F-02: only the first
 * exclusion is stripped, as slice 5 did.
 */
describe("CR-B1-01 step 6: an exclusion or another place is No only when no authorized country is covered", () => {
  const NG: WorkContext = OWNER_WORK_CONTEXT
  const NG_GB: WorkContext = { home: "NG", authorized: ["NG", "GB"], sponsorshipNeeded: true }
  const NG_DE: WorkContext = { home: "NG", authorized: ["NG", "DE"], sponsorshipNeeded: true }
  const KE: WorkContext = { home: "KE", authorized: ["KE"], sponsorshipNeeded: true }
  const KE_ZA = WANJIRU_ZA
  const P1 = (x: string) => `Are you authorized to work outside ${x}?`
  const P2 = (x: string) => `Are you authorized to work in any country other than ${x}?`
  const P3 = (x: string) => `Are you authorized to work apart from ${x}?`
  const classify = (label: string, ctx: WorkContext) => classifyWorkQuestion(label.toLowerCase(), ctx)

  it.each([
    ["[NG]", NG, "Nigeria", "not_authorized"],
    ["[NG, GB]", NG_GB, "Nigeria", "unclear"],
    ["[KE, ZA]", KE_ZA, "Kenya", "unclear"],
    ["[KE] (all authorized countries excluded)", KE, "Kenya", "not_authorized"],
  ] as const)("%s P1, P2, P3 with X = %s: %s", (_name, ctx, x, expected) => {
    for (const phrase of [P1, P2, P3]) expect(classify(phrase(x), ctx)).toBe(expected)
  })

  it.each([
    ["[KE, ZA] P1 with X = South Africa", P1("South Africa"), KE_ZA, "unclear"],
    ["[KE, ZA] several exclusions", "Are you authorized to work outside Kenya or apart from South Africa?", KE_ZA, "unclear"],
    ["[NG] F-02 a second exclusion stays in the remainder", "Are you authorized to work outside Nigeria, apart from Nigeria?", NG, "unclear"],
    ["[NG] any other country", "Are you authorized to work in any other country?", NG, "not_authorized"],
    ["[NG, GB] any other country", "Are you authorized to work in any other country?", NG_GB, "unclear"],
    ["[NG] the EU", "Are you authorized to work in the EU?", NG, "not_authorized"],
    ["[NG, DE] the EU", "Are you authorized to work in the EU?", NG_DE, "unclear"],
    ["[NG] Europe", "Are you authorized to work in Europe?", NG, "not_authorized"],
    ["[NG, DE] Europe", "Are you authorized to work in Europe?", NG_DE, "unclear"],
    ["[NG, GB] a country entry (unchanged)", "Are you authorized to work in the United States?", NG_GB, "not_authorized"],
    ["[KE, ZA] a country entry (unchanged)", "Are you legally authorized to work in Germany?", KE_ZA, "not_authorized"],
  ] as const)("%s: %s", (_name, label, ctx, expected) => {
    expect(classify(label, ctx)).toBe(expected)
  })

  it("[NG, GB] P1 through a schema-matched answerFor takes the unclear path, never No", () => {
    const label = P1("Nigeria")
    expect(schemaAnswer(label, sources(NG_GB))).toMatchObject({ reason: "missing_approved_answer" })
    expect(schemaAnswer(label, { ...sources(NG_GB), answers: [{ group: "custom", topic: null, skill: null, question: label, value: "Yes" }] })).toMatchObject({ kind: "value", value: "Yes" })
    expect(schemaAnswer(label, sources(NG))).toMatchObject({ kind: "value", value: "No", source: "settings_work_authorization" })
  })
})

/**
 * Architecture r6 step 6b, qualified-name guard (SEC-B1-2-01): an
 * `OTHER_PLACES` match immediately preceded by a place qualifier is unclear in
 * every context, [NG] included. The fixture rows are r6's table.
 */
describe("SEC-B1-2-01 qualified-name guard: a qualified place name is unclear, never a false No", () => {
  const NG: WorkContext = OWNER_WORK_CONTEXT
  const GB: WorkContext = { home: "GB", authorized: ["GB"], sponsorshipNeeded: true }
  const NG_GB: WorkContext = { home: "NG", authorized: ["NG", "GB"], sponsorshipNeeded: true }
  const NG_IE: WorkContext = { home: "NG", authorized: ["NG", "IE"], sponsorshipNeeded: true }
  const NG_US: WorkContext = { home: "NG", authorized: ["NG", "US"], sponsorshipNeeded: true }
  const AU: WorkContext = { home: "AU", authorized: ["AU"], sponsorshipNeeded: true }
  const NG_AU: WorkContext = { home: "NG", authorized: ["NG", "AU"], sponsorshipNeeded: true }
  const IN = (place: string) => `Are you authorized to work in ${place}?`
  const classify = (label: string, ctx: WorkContext) => classifyWorkQuestion(label.toLowerCase(), ctx)

  it.each([
    ["[GB] Northern Ireland", IN("Northern Ireland"), GB, "unclear"],
    ["[NG, GB] Northern Ireland", IN("Northern Ireland"), NG_GB, "unclear"],
    ["[NG, IE] Northern Ireland", IN("Northern Ireland"), NG_IE, "unclear"],
    ["[NG] Northern Ireland (whole GB entry, unchanged)", IN("Northern Ireland"), NG, "not_authorized"],
    ["[NG, US] New Mexico", IN("New Mexico"), NG_US, "unclear"],
    ["[NG, US] New England", IN("New England"), NG_US, "unclear"],
    ["[NG] New Mexico (guard; slice 5 was No)", IN("New Mexico"), NG, "unclear"],
    ["[AU] New South Wales", IN("New South Wales"), AU, "unclear"],
    ["[NG, AU] New South Wales", IN("New South Wales"), NG_AU, "unclear"],
    ["[NG] New Zealand (qualifier inside the entry, unchanged)", IN("New Zealand"), NG, "not_authorized"],
    // r6's table says not_authorized here, but step 5 decides this label before step 6: "africa" is in [NG]'s AUTH_OR_WIDER
    // (NG is an African country), so it was unclear before the guard and in slice 5, and still is. The guard does not reach it.
    // Confirmed by the QA author and the coordinator (2026-11-01): product behaviour stays; the architect corrects r6's table row.
    ["[NG] South Africa (step 5, unchanged: africa is an [NG] region)", IN("South Africa"), NG, "unclear"],
    ["[NG, US] north-western Canada (hyphenated qualifier)", IN("north-western Canada"), NG_US, "unclear"],
  ] as const)("%s: %s", (_name, label, ctx, expected) => {
    expect(classify(label, ctx)).toBe(expected)
  })
})
