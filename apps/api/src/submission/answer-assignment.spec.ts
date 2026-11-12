import { describe, expect, it } from "vitest"

import { type AnswerSources, type FormField, agentCatalog, answerFor, answeredWorkFields, assignAnswers, catalogValue, isWorkAnswer, planAnswers } from "./answer-assignment.js"

const SOURCES: AnswerSources = {
  fullName: "Ada Okafor",
  contactLines: ["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"],
  work: { home: "NG", authorized: ["NG"], sponsorshipNeeded: true },
  roleLocation: { kind: "countries", codes: ["US"] },
  answers: [
    { group: "sensitive", topic: "veteran_status", skill: null, question: null, value: "I am not a veteran" },
    { group: "standard", topic: "notice_period", skill: null, question: null, value: "4 weeks" },
    { group: "standard", topic: "skill_years", skill: "React", question: null, value: "7" },
    { group: "custom", topic: null, skill: null, question: "Why do you want to work at Northwind Health?", value: "I want to build patient-facing tools that ship weekly." },
  ],
  grossSalaryPolicy: { amount: "48000.00", currency: "USD", period: "year" },
  currentSalary: null,
}

const field = (label: string, extra: Partial<FormField> = {}): FormField => ({ ref: "f1", label, kind: "text", required: true, ...extra })
/** Scope 05d: the classifier only sees schema text, so classifier rows are asked through a matched schema question. */
const schemaField = (text: string, extra: Partial<FormField> = {}): FormField =>
  field("(page label ignored)", { fieldName: "question_1", schemaQuestion: { text, fieldName: "question_1" }, ...extra })
const answerTo = (label: string, sources: AnswerSources = SOURCES) => {
  const result = assignAnswers([schemaField(label)], sources)
  return result.block ?? result.answers[0]
}

describe("location, work authorization and sponsorship (AC 6.11, submission.feature)", () => {
  it.each([
    ["Where are you currently located?", "Lagos, Nigeria"],
    ["Are you authorized to work in the United Kingdom?", "No"],
    ["Will you now or in the future require visa sponsorship?", "Yes"],
    ["Do you require sponsorship to work in Germany?", "Yes"],
    ["Are you legally authorized to work in Nigeria?", "Yes"],
  ])("%s -> %s", (label, value) => {
    expect(answerTo(label)).toMatchObject({ kind: "value", value })
  })
})

describe("work authorization before sponsorship (CR5-01, CR5-02; AC 6.11)", () => {
  // Real-world phrasings from Greenhouse, Lever and Ashby forms. Setting: "none outside Nigeria".
  const MISSING = "missing_approved_answer"
  it.each([
    // Combined authorization + "without sponsorship": answered from authorization.
    ["Are you legally authorized to work in the United States without sponsorship?", "No"],
    ["Are you authorized to work in the US without visa sponsorship?", "No"],
    ["Can you work in the UK without requiring sponsorship?", "No"],
    ["Are you legally authorized to work in the country in which this job is located without the need for visa sponsorship? (United States)", "No"],
    ["Are you currently eligible to work in Canada without employer sponsorship?", "No"],
    ["Are you able to work in Germany without a visa or sponsorship?", "No"],
    ["Are you authorized to work in Nigeria without sponsorship?", "Yes"],
    ["Are You Legally Authorized To Work In The United States Without Sponsorship?", "No"],
    // Authorization only.
    ["Are you legally authorized to work in the United States?", "No"],
    ["Are you authorized to work lawfully in the United Kingdom?", "No"],
    ["Do you have the right to work in the UK?", "No"],
    ["Do you have the legal right to work in the EU?", "No"],
    ["Do you currently have the right to work in the European Union?", "No"],
    ["Are you legally eligible to work in Australia?", "No"],
    ["Do you hold a valid work permit for Switzerland?", "No"],
    ["Are you authorized to work in any country other than Nigeria?", "No"],
    ["Are you authorized to work outside of Nigeria?", "No"],
    ["Are you legally permitted to work in Nigeria?", "Yes"],
    ["Are you eligible to work in Nigeria?", "Yes"],
    // Sponsorship need only: always Yes.
    ["Will you now or in the future require sponsorship for employment visa status (e.g. H-1B visa status)?", "Yes"],
    ["Will you now, or in the future, require sponsorship to work in the United States?", "Yes"],
    ["Do you require visa sponsorship?", "Yes"],
    ["Will you require Lyft to sponsor a visa for you to work in the US?", "Yes"],
    ["Would you need visa sponsorship to work in Ireland?", "Yes"],
    ["Visa sponsorship required?", "Yes"],
    ["Will you require a work permit to work in Spain?", "Yes"],
  ])("%s -> %s", (label, value) => {
    expect(answerTo(label)).toMatchObject({ kind: "value", value })
  })

  it.each([
    // Both questions in one label, negations, and missing or mixed countries: never guessed.
    "Are you authorized to work in the US, or will you require sponsorship?",
    "Are you authorized to work in the United States? Will you require sponsorship now or in the future?",
    "Do you not require sponsorship to work in the US?",
    "Please confirm you don't need visa sponsorship",
    "Are you not authorized to work in the UK?",
    "Are you legally authorized to work in the country where this role is based?",
    "Are you authorized to work without sponsorship?",
    "Are you authorized to work in Nigeria and the United Kingdom?",
    "Do you require sponsorship to work in Nigeria?",
  ])("%s blocks as Missing Approved Answer", (label) => {
    expect(answerTo(label)).toMatchObject({ reason: MISSING, field: label })
  })

  it.each([
    // SEC-509 reviewer probes: Nigeria named with another place, a region, an unnamed place or a nationality.
    "Are you authorized to work in Nigeria and Togo?",
    "Are you authorized to work in Nigeria or Cameroon?",
    "Are you authorized to work in Nigeria and Benin?",
    "Are you authorized to work in Nigeria and Dubai?",
    "Are you authorized to work in Nigeria and America?",
    "Are you authorized to work in Nigeria and NYC?",
    "Are you authorized to work in Nigeria and EMEA?",
    "Are you authorized to work in Nigeria and London?",
    "Are you authorized to work in Nigeria and the U.S.?",
    "Are you authorized to work in Nigeria/UK?",
    "As a Nigerian, are you authorized to work in Togo?",
    "Are you authorized to work in Africa, including Nigeria?",
    "Are you authorized to work in West Africa (e.g. Nigeria)?",
    "Are you authorized to work in Nigeria, and in the country where this role is based?",
    "Are you authorized to work in Nigeria and the location of this role?",
    "Are you eligible to work in Nigeria and Togo without sponsorship?",
    "Are you authorized to work in Nigeria, Ghana and Togo?",
    "Are you authorized to work in Nigeria and the US?",
    "Are you authorized to work in Nigeria & the UK?",
    "Are you authorized to work in Nigeria and the Netherlands?",
    "Are you authorized to work in America?",
    "Are you authorized to work in London?",
    // SEC-509 fresh adversarial rows.
    "Are you authorized to work in the UK or Lagos?",
    "Are you authorized to work in the US or anywhere in Africa?",
    "Are you authorized to work in Nigeria or any country other than Nigeria?",
    "Are you authorized to work in Nigeria and other countries?",
    "Are you authorized to work in Nigeria (and the EU)?",
    "Are you authorized to work in Nigeria-Togo?",
    "Are you authorized to work in Nigeria for a US employer?",
    "Are you, a Nigerian citizen, authorized to work in the role's country?",
    "Are you authorized to work in Nigeria in Accra?",
    "Are you authorized to work in Nigeria without sponsorship in Ghana?",
  ])("%s blocks as Missing Approved Answer (SEC-509)", (label) => {
    expect(answerTo(label)).toMatchObject({ reason: MISSING, field: label })
  })

  it.each([
    "Are you authorized to work in the Federal Republic of Nigeria?",
    "Are you authorized to work in Nigeria without visa sponsorship?",
    "Do you have the right to work in Nigeria?",
    "Are you authorized to work in Nigeria? *",
  ])("%s -> Yes (purely about Nigeria, SEC-509)", (label) => {
    expect(answerTo(label)).toMatchObject({ kind: "value", value: "Yes" })
  })

  it("an optional ambiguous question is left empty, not guessed", () => {
    const result = assignAnswers([schemaField("Are you authorized to work without sponsorship?", { required: false })], SOURCES)
    expect(result).toMatchObject({ block: null, answers: [] })
  })

  it("an ambiguous authorization question is a hard block, never an agent leftover", () => {
    const plan = planAnswers([schemaField("Are you authorized to work in the US, or will you require sponsorship?")], { ...SOURCES, answers: [] })
    expect(plan.leftovers).toEqual([])
    expect(plan.block?.reason).toBe(MISSING)
  })

  // EPIC-0002 B1: the countries are structured, so a second country is read instead of blocking.
  it("structured countries NG and CA: Canada reads Yes and a Canada role reads No", () => {
    const sources: AnswerSources = { ...SOURCES, work: { home: "NG", authorized: ["NG", "CA"], sponsorshipNeeded: true }, roleLocation: { kind: "countries", codes: ["CA"] } }
    expect(answerTo("Are you authorized to work in Canada?", sources)).toMatchObject({ value: "Yes" })
    expect(answerTo("Will you require visa sponsorship?", sources)).toMatchObject({ value: "No" })
  })

  it("the Operator's context means authorized only in Nigeria", () => {
    expect(answerTo("Are you authorized to work in Nigeria?")).toMatchObject({ value: "Yes" })
    expect(answerTo("Are you authorized to work in the UK?")).toMatchObject({ value: "No" })
  })
})

describe("location questions only (CR5-03)", () => {
  it.each([
    ["Location (City)", "Lagos, Nigeria"],
    ["Current location", "Lagos, Nigeria"],
    ["Location", "Lagos, Nigeria"],
    ["Where are you based?", "Lagos, Nigeria"],
    ["City of residence", "Lagos, Nigeria"],
  ])("%s -> %s", (label, value) => {
    expect(answerTo(label)).toMatchObject({ value })
  })

  it("a yes/no question that mentions an office location is not answered with the city", () => {
    expect(answerTo("Are you able to work from our London office location?")).toMatchObject({ reason: "missing_approved_answer" })
  })
})

describe("identity and contact from settings", () => {
  it.each([
    ["First name", "Ada"],
    ["Last name", "Okafor"],
    ["Full name", "Ada Okafor"],
    ["Email", "ada@example.com"],
    ["Phone", "+234 800 000 0000"],
  ])("%s -> %s", (label, value) => {
    expect(answerTo(label)).toMatchObject({ value })
  })
})

describe("sensitive and salary questions (AC 6.8 to 6.10)", () => {
  it("a sensitive question is answered from its Approved Answer", () => {
    expect(answerTo("Veteran status")).toMatchObject({ value: "I am not a veteran" })
  })

  it.each(["Gender identity", "Do you have a disability?", "Are you a protected veteran?"])("no Approved Answer for %s blocks, even voluntary", (label) => {
    const sources = { ...SOURCES, answers: SOURCES.answers.filter((answer) => answer.group !== "sensitive") }
    const result = assignAnswers([field(label, { required: false })], sources)
    expect(result.block).toEqual({
      reason: "missing_approved_answer",
      field: label,
      detail: `The form asks a sensitive question, "${label}", and you have no Approved Answer for it. Nothing was inferred.`,
    })
  })

  it("current salary only from an explicitly approved answer", () => {
    expect(answerTo("What is your current salary?")).toMatchObject({
      reason: "missing_approved_answer",
      detail: "The form asks for your current salary and you haven't approved a current-salary answer.",
    })
    expect(answerTo("What is your current salary?", { ...SOURCES, currentSalary: { amount: "3000", currency: "USD", period: "month" } })).toMatchObject({
      value: "USD 3,000 per month gross",
    })
  })

  it("gross salary within the policy is answered from the policy", () => {
    expect(answerTo("Expected annual gross salary (USD)")).toMatchObject({ value: "USD 48,000 per year" })
  })

  it("gross salary outside the policy blocks", () => {
    expect(answerTo("Expected monthly salary in EUR, including bonus")).toMatchObject({
      reason: "missing_approved_answer",
      detail: 'The form asks "Expected monthly salary in EUR, including bonus", which your gross-salary policy doesn\'t cover.',
    })
  })
})

describe("missing answers, custom questions, personal data, declarations, assessments", () => {
  it("a required question with no Approved Answer blocks with the C-BLOCK-1 detail", () => {
    expect(answerTo("How many years of Vue.js experience do you have?")).toEqual({
      reason: "missing_approved_answer",
      field: "How many years of Vue.js experience do you have?",
      detail: 'The form asks "How many years of Vue.js experience do you have?" and you have no Approved Answer for it. Nothing was guessed.',
    })
  })

  it("a skill-years question with its Approved Answer is answered", () => {
    expect(answerTo("How many years of React experience do you have?")).toMatchObject({ value: "7" })
  })

  it("a custom question is answered only from its custom Approved Answer", () => {
    expect(answerTo("Why do you want to work at  northwind health?")).toMatchObject({ value: "I want to build patient-facing tools that ship weekly." })
    expect(answerTo("What is your favourite design system and why?")).toMatchObject({ reason: "missing_approved_answer" })
    expect(answerTo("Describe a project you are proud of.")).toMatchObject({ reason: "missing_approved_answer" })
  })

  it("an optional question with no answer is left empty", () => {
    const result = assignAnswers([field("Notice period"), field("Anything else?", { ref: "f2", required: false })], SOURCES)
    expect(result.block).toBeNull()
    expect(result.answers).toEqual([{ ref: "f1", kind: "value", value: "4 weeks" }])
  })

  it.each(["Bank account number for salary payments", "National Identification Number (NIN)", "Bank Verification Number (BVN)"])(
    "%s blocks as a personal data request",
    (label) => {
      expect(answerTo(label)).toEqual({
        reason: "personal_data_request",
        field: label,
        detail: `The form asks for "${label}", which a job application doesn't need. Nothing was entered.`,
      })
    }
  )

  it("a declaration and an assessment block", () => {
    expect(answerTo("I certify the information above is true and sign below")).toMatchObject({ reason: "declaration" })
    expect(answerTo("Complete this 60-minute React exercise")).toMatchObject({ reason: "assessment" })
  })

  it("the first blocking field stops assignment", () => {
    const result = assignAnswers([field("Email"), field("Bank Verification Number (BVN)", { ref: "f2" }), field("Notice period", { ref: "f3" })], SOURCES)
    expect(result.block?.reason).toBe("personal_data_request")
  })
})

describe("documents (AC 5.5)", () => {
  it("resume and cover letter file inputs get their documents; the cover letter flag follows the form", () => {
    const withLetter = assignAnswers([field("Resume/CV", { kind: "file" }), field("Cover Letter", { ref: "f2", kind: "file", required: false })], SOURCES)
    expect(withLetter.answers).toEqual([
      { ref: "f1", kind: "document", document: "resume" },
      { ref: "f2", kind: "document", document: "cover_letter" },
    ])
    expect(withLetter.coverLetterField).toBe(true)
    expect(assignAnswers([field("Resume", { kind: "file" })], SOURCES).coverLetterField).toBe(false)
  })
})

describe("deterministic-first plan (architecture r1 journey 2 steps 4, 6, 7)", () => {
  it("free questions with no Approved Answer become agent leftovers; code-answered fields are filled by code", () => {
    const plan = planAnswers([field("Email"), field("Why do you want to join Acme Payments?", { ref: "f2", kind: "textarea" }), field("Notice period", { ref: "f3" })], { ...SOURCES, answers: [] })
    expect(plan.block).toBeNull()
    expect(plan.answers).toEqual([{ ref: "f1", kind: "value", value: "ada@example.com" }])
    expect(plan.leftovers.map((item) => item.field.ref)).toEqual(["f2", "f3"])
    expect(plan.leftovers[0]?.block.reason).toBe("missing_approved_answer")
  })

  it.each([
    ["Gender identity", "missing_approved_answer"],
    ["What is your current salary?", "missing_approved_answer"],
    ["Bank Verification Number (BVN)", "personal_data_request"],
    ["I certify the information above is true and sign below", "declaration"],
  ])("'%s' never goes to the agent: it is a hard block (%s)", (label, reason) => {
    const plan = planAnswers([field(label)], { ...SOURCES, answers: [] })
    expect(plan.leftovers).toEqual([])
    expect(plan.block?.reason).toBe(reason)
  })

  it("optional unanswered questions are skipped, not sent to the agent", () => {
    expect(planAnswers([field("Anything else?", { required: false })], SOURCES).leftovers).toEqual([])
  })

  it("assignAnswers still blocks on the first leftover (no agent)", () => {
    expect(assignAnswers([field("Why us?"), field("BVN number", { ref: "f2" })], { ...SOURCES, answers: [] }).block?.field).toBe("Why us?")
  })

  it("the agent catalog lists standard, skill and custom answers by backend key with no values", () => {
    const catalog = agentCatalog({ ...SOURCES, answers: [...SOURCES.answers, { group: "standard", topic: "profile_links", skill: null, question: null, value: "https://github.com/ada-okafor" }] })
    expect(catalog.map((entry) => entry.key)).toEqual(["A2", "A3", "A4", "A5"])
    expect(catalog.map((entry) => entry.description)).toEqual([
      "Standard answer: notice period",
      "Years of experience with React",
      'Custom answer to "Why do you want to work at Northwind Health?"',
      "Standard answer: profile links",
    ])
    expect(JSON.stringify(catalog)).not.toContain("github.com")
    expect(JSON.stringify(catalog)).not.toContain("4 weeks")
  })
})

describe("catalogValue", () => {
  it("returns the value behind a key, and null for sensitive or unknown keys", () => {
    expect(catalogValue(SOURCES, "A2")).toBe("4 weeks")
    expect(catalogValue(SOURCES, "A1")).toBeNull()
    expect(catalogValue(SOURCES, "A99")).toBeNull()
  })
})

describe("labels as READ_FORM reads them (F-QA5E-01)", () => {
  const select = { kind: "select" as const, options: ["Please select", "Yes", "No"] }
  const ask = (label: string) => {
    const result = assignAnswers([field(label, select)], SOURCES)
    return result.block ?? result.answers[0]
  }
  it.each([
    // labelText output for the Lever, Greenhouse and Ashby shapes of the same question.
    // Scope 05d: was "Yes"; a page label alone never answers a work question now.
    "Are you legally authorized to work in Nigeria?",
    "Are you legally authorized to work in Nigeria? *",
    "Will you now or in the future require sponsorship for employment visa status?",
  ])("%s blocks: page text only (scope 05d)", (label) => {
    expect(ask(label)).toMatchObject({ reason: "missing_approved_answer", field: label })
  })
  it.each([
    "Are you legally authorized to work in Nigeria and Togo?",
    // The pre-fix innerText read still blocks: the allow-list is not loosened.
    "Are you legally authorized to work in Nigeria? Please select Yes No",
  ])("%s blocks", (label) => {
    expect(ask(label)).toMatchObject({ reason: "missing_approved_answer" })
  })
})

describe("sponsorship-only labels naming a Nigerian place or using look-alike letters block (SEC-512)", () => {
  it.each([
    "Will you require visa sponsorship to work in Port Harcourt?",
    "Do you need sponsorship to work in Ibadan or Kano?",
    "Will you require sponsorship as a Nigerian citizen?",
    "Will you require visa sponsorship to work in N\u0456geria?",
    "Will you require visa sp\u043Ensorship?",
  ])("%s blocks", (label) => {
    expect(answerTo(label)).toMatchObject({ reason: "missing_approved_answer" })
  })
  it("authorization label with a look-alike letter blocks rather than answering No", () => {
    expect(answerTo("Are you authorized to work in the UK or N\u0456geria?")).toMatchObject({ reason: "missing_approved_answer" })
  })
})

describe("work questions read through more than one label source (SEC-513)", () => {
  const select = { kind: "select" as const, options: ["Please select", "Yes", "No"] }
  const QUESTION = "Are you legally authorized to work in Nigeria?"
  const ask = (label: string, readings: readonly string[], flags: readonly string[] = []) => {
    const result = assignAnswers([field(label, { ...select, labelCheck: { readings, flags } })], SOURCES)
    return result.block ?? result.answers[0]
  }
  it.each([
    ["Lever: wrapping label innerText includes its own select's options", [QUESTION, `${QUESTION} Please select Yes No`]],
    ["Greenhouse: label for= text", [QUESTION, QUESTION]],
    ["Ashby: aria-labelledby heading", [QUESTION, QUESTION]],
  ])("%s blocks without an Approved Answer (scope 05d; was Yes)", (_name, readings) => {
    expect(ask(QUESTION, readings)).toMatchObject({ reason: "missing_approved_answer" })
  })
  it("a sponsorship question whose readings agree blocks without an Approved Answer (scope 05d; was Yes)", () => {
    const q = "Will you now or in the future require visa sponsorship?"
    expect(ask(q, [q, q])).toMatchObject({ reason: "missing_approved_answer" })
  })
  it.each([
    ["rendered text names a second country", [QUESTION, "Are you legally authorized to work in Nigeria and Togo?"]],
    ["aria-label differs from the visible label", [QUESTION, "Are you legally authorized to work in Togo?"]],
    ["one reading is not a work question", [QUESTION, "Nigeria"]],
    ["a nested select's options are not the control's own", [QUESTION, `${QUESTION} and Togo`]],
  ])("blocks when %s", (_name, readings) => {
    expect(ask(QUESTION, readings)).toMatchObject({ reason: "missing_approved_answer" })
  })
  it.each(["hidden_node", "interactive_role", "nested_control", "shadow", "pseudo_content", "offscreen_source", "opaque_content"])(
    "blocks a work question when READ_FORM flags %s",
    (flag) => {
      expect(ask(QUESTION, [QUESTION, QUESTION], [flag])).toMatchObject({ reason: "missing_approved_answer" })
    }
  )
  it("blocks a flagged sponsorship question too, never guessing Yes", () => {
    const q = "Will you now or in the future require visa sponsorship?"
    expect(ask(q, [q], ["pseudo_content"])).toMatchObject({ reason: "missing_approved_answer" })
  })
  it("blocks when only a secondary reading is a work question", () => {
    expect(ask("Additional information", ["Additional information", QUESTION])).toMatchObject({ reason: "missing_approved_answer" })
  })
  it("a flagged label that is not a work question keeps its normal outcome", () => {
    expect(ask("Email", ["Email"], ["pseudo_content"])).toMatchObject({ kind: "value", value: "ada@example.com" })
  })
  it("a flagged work question blocks even when a custom Approved Answer matches its label", () => {
    const sources = { ...SOURCES, answers: [...SOURCES.answers, { group: "custom" as const, topic: null, skill: null, question: "Are you authorized to work in Nigeria and Togo?", value: "Yes" }] }
    const label = "Are you authorized to work in Nigeria and Togo?"
    const result = assignAnswers([field(label, { ...select, labelCheck: { readings: [label], flags: ["hidden_node"] } })], sources)
    expect(result.block).toMatchObject({ reason: "missing_approved_answer" })
  })
})

describe("work questions route by source: schema, exact Approved Answer, or block (scope 05d)", () => {
  const select = { kind: "select" as const, options: ["Please select", "Yes", "No"] }
  const NIGERIA = "Are you legally authorized to work in Nigeria?"
  const TOGO = "Are you legally authorized to work in Nigeria and Togo?"
  const custom = (question: string, value: string): AnswerSources => ({ ...SOURCES, answers: [...SOURCES.answers, { group: "custom", topic: null, skill: null, question, value }] })
  const PAGE_WORK_DETAIL = (label: string) =>
    `The form asks "${label}" (as shown on the page). Work-authorization answers are used only on questions read from the employer's Greenhouse API, so complete this one manually. Nothing was entered.`
  const one = (f: FormField, sources: AnswerSources = SOURCES) => {
    const result = assignAnswers([f], sources)
    return result.block ?? result.answers[0]
  }

  it("a schema-matched field is answered from the schema text, whatever the page label says", () => {
    const f = field(TOGO, { ...select, fieldName: "question_9", schemaQuestion: { text: NIGERIA, fieldName: "question_9" }, labelCheck: { readings: [TOGO], flags: ["hidden_node"] } })
    expect(one(f)).toEqual({ ref: "f1", kind: "value", value: "Yes" })
  })

  it("a schema question about another country answers No even when the page says Nigeria", () => {
    const f = field(NIGERIA, { ...select, schemaQuestion: { text: "Are you legally authorized to work in the United States?", fieldName: "q" } })
    expect(one(f)).toMatchObject({ value: "No" })
  })

  it("an unclear schema question blocks with the schema text as the question", () => {
    const f = field(NIGERIA, { ...select, schemaQuestion: { text: TOGO, fieldName: "q" } })
    expect(one(f)).toMatchObject({ reason: "missing_approved_answer", field: TOGO })
  })

  it.each([
    ["Lever (label wraps select)", { labelCheck: { readings: [NIGERIA, `${NIGERIA} Please select Yes No`], flags: [] } }],
    ["Ashby (aria-labelledby)", { labelCheck: { readings: [NIGERIA], flags: [] } }],
    ["unmatched Greenhouse field", { fieldName: "question_77", fieldId: "question_77" }],
    ["DOM-only label, no label check", {}],
  ])("%s: a pure-Nigeria page question blocks, marked as page text", (_name, extra) => {
    // CR5D-01: a saved answer can never be used here, so the block is manual-only (no "Add Approved Answer").
    expect(one(field(NIGERIA, { ...select, ...extra }))).toEqual({
      reason: "missing_approved_answer",
      field: NIGERIA,
      manualOnly: true,
      detail: PAGE_WORK_DETAIL(NIGERIA),
    })
  })

  it("an optional page work question is left empty", () => {
    expect(assignAnswers([field(NIGERIA, { ...select, required: false })], SOURCES)).toMatchObject({ block: null, answers: [] })
  })

  it("late 705dede review: an exact saved work answer never fills a page-read work question (Lever, Ashby, DOM-only); the Candidate completes it manually", () => {
    for (const [label, saved] of [[NIGERIA, "  are you legally AUTHORIZED to work in nigeria? "], [TOGO, TOGO]] as const) {
      const outcome = one(field(label, select), custom(saved, "Yes"))
      // CR5D-01: the same manual-only block and detail as with no saved answer.
      expect(outcome).toEqual({ reason: "missing_approved_answer", field: label, manualOnly: true, detail: PAGE_WORK_DETAIL(label) })
    }
  })

  it("late 705dede review: a saved work answer outside the classifier wording also blocks on a page-read field", () => {
    const saved = "Do you have the right to live and work in Nigeria?"
    expect(one(field(saved, select), custom(saved, "Yes"))).toMatchObject({ reason: "missing_approved_answer" })
    expect(one(field(saved), custom(saved, "Yes"))).toMatchObject({ reason: "missing_approved_answer" })
  })

  it("late 705dede review: a Greenhouse schema-matched field whose schema text is the saved question fills from the saved answer", () => {
    const saved = "Do you have the right to live and work in Nigeria?"
    expect(answerFor(field("x", { ...select, schemaQuestion: { text: saved, fieldName: "q" } }), custom(saved, "Yes"))).toMatchObject({ value: "Yes", work: true })
    expect(answerFor(field("x", { ...select, schemaQuestion: { text: TOGO, fieldName: "q" } }), custom(TOGO, "No"))).toMatchObject({ value: "No", work: true })
  })

  it("late 705dede review: a schema-matched field with different schema text does not take the saved work answer", () => {
    expect(one(field(NIGERIA, { ...select, schemaQuestion: { text: TOGO, fieldName: "q" } }), custom(NIGERIA, "Yes"))).toMatchObject({ reason: "missing_approved_answer" })
  })

  it("non-work exact custom answers still fill a page-read field", () => {
    expect(one(field("Why do you want to join?"), custom("Why do you want to join?", "Shipping weekly"))).toMatchObject({ value: "Shipping weekly" })
  })

  it("a near-miss custom Approved Answer does not fill a page work question", () => {
    expect(one(field(TOGO, select), custom(NIGERIA, "Yes"))).toMatchObject({ reason: "missing_approved_answer" })
  })

  it("a work question in a secondary reading only also blocks", () => {
    expect(one(field("Additional information", { labelCheck: { readings: ["Additional information", NIGERIA], flags: [] } }))).toMatchObject({ reason: "missing_approved_answer" })
  })

  it("planAnswers never sends a page work question to the agent", () => {
    const plan = planAnswers([field(NIGERIA, select)], SOURCES)
    expect(plan.leftovers).toEqual([])
    expect(plan.block).toMatchObject({ reason: "missing_approved_answer", field: NIGERIA })
  })

  it("answeredWorkFields lists only fields answered with a work answer", () => {
    const fields = [field("Email", { ref: "f1" }), field("x", { ref: "f2", ...select, schemaQuestion: { text: NIGERIA, fieldName: "q" } }), field("Notice period", { ref: "f3" })]
    expect(answeredWorkFields(fields, SOURCES).map((f) => f.ref)).toEqual(["f2"])
  })
})

describe("work answers never reach the form agent (SEC-515)", () => {
  const WORK_AAS: AnswerSources["answers"] = [
    { group: "custom", topic: null, skill: null, question: "Are you authorized to work in Nigeria?", value: "Yes" },
    { group: "custom", topic: null, skill: null, question: "Will you now or in the future require visa sponsorship?", value: "No" },
    { group: "custom", topic: null, skill: null, question: "Do you have the right to w\u200Bork in the UK?", value: "Yes" },
    { group: "custom", topic: null, skill: null, question: "Do you hold a valid work permit?", value: "Yes" },
  ]
  const withWork: AnswerSources = { ...SOURCES, answers: [...SOURCES.answers, ...WORK_AAS] }

  it("the agent catalog and catalogValue leave out work-authorization and sponsorship Approved Answers", () => {
    expect(agentCatalog(withWork).map((entry) => entry.key)).toEqual(["A2", "A3", "A4"])
    for (const key of ["A5", "A6", "A7", "A8"]) expect(catalogValue(withWork, key)).toBeNull()
    expect(JSON.stringify(agentCatalog(withWork))).not.toMatch(/authori|sponsor|permit|right to/)
  })

  it("isWorkAnswer reads the answer's category and its saved question", () => {
    for (const answer of WORK_AAS) expect(isWorkAnswer(answer)).toBe(true)
    for (const answer of SOURCES.answers) expect(isWorkAnswer(answer)).toBe(false)
  })

  it("a zero-width character inside a page work label is stripped, so the label is a work question and hard-blocks", () => {
    for (const label of ["Are you auth\u200Borized to work in the US?", "Will you require visa spon\u00ADsorship?", "Are you authorized\u2060 to work in Canada?"]) {
      const plan = planAnswers([field(label)], withWork)
      expect(plan.leftovers).toEqual([])
      expect(plan.block?.reason).toBe("missing_approved_answer")
    }
  })

  it.each([[""], ["   "], ["*"], ["\u200B\u200B"], ["?:"], ["Q1"], ["Q"], ["\u200B名"]])("a required field with near-empty label %j blocks instead of going to the agent", (label) => {
    for (const kind of ["text", "radio", "file"] as const) {
      const plan = planAnswers([field(label, { kind, options: kind === "radio" ? ["Yes", "No"] : undefined })], withWork)
      expect(plan.leftovers).toEqual([])
      expect(plan.block?.reason).toBe("missing_approved_answer")
    }
  })

  it.each([["姓名"], ["职位"], ["Hi"], ["\u200BAB"]])("F-QA5I-01: a required free-text label with two or more letters in any script (%j) goes to the agent, not a block", (label) => {
    const plan = planAnswers([field(label)], withWork)
    expect(plan.block).toBeNull()
    expect(plan.leftovers.map((item) => item.field.label)).toEqual([label])
  })

  it.each([
    ["a Yes/No select", { kind: "select" as const, options: ["Yes", "No"] }],
    ["a radio", { kind: "radio" as const, options: ["Yes", "No"] }],
    ["a checkbox", { kind: "checkbox" as const }],
    ["a combobox text input", { kind: "text" as const, combobox: true }],
    ["a text input with options", { kind: "text" as const, options: ["Yes", "No"] }],
  ])("repair wave 3: %s with no exact Approved Answer blocks as Missing Approved Answer, never an agent leftover", (_name, extra) => {
    const plan = planAnswers([field("Do you have the right to live and work here?", extra), field("Please answer", { ref: "f2", ...extra })], withWork)
    expect(plan.leftovers).toEqual([])
    expect(plan.block).toMatchObject({ reason: "missing_approved_answer" })
  })

  it("repair wave 3: a choice field with an exact custom Approved Answer still fills deterministically", () => {
    const sources = { ...withWork, answers: [...withWork.answers, { group: "custom" as const, topic: null, skill: null, question: "Open to a hybrid schedule?", value: "Yes" }] }
    const plan = planAnswers([field("Open to a hybrid schedule?", { kind: "radio", options: ["Yes", "No"] })], sources)
    expect(plan.block).toBeNull()
    expect(plan.answers).toEqual([{ ref: "f1", kind: "value", value: "Yes" }])
  })

  it("an optional field with an empty label is skipped", () => {
    expect(planAnswers([field("", { required: false })], withWork)).toMatchObject({ leftovers: [], block: null })
  })
})
