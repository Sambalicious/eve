/**
 * Answer assignment in backend code only (AC 6.7 to 6.11, 6.15; architecture
 * r1 journey 2 step 4). Each form field is classified by its label into a
 * category, and a value is chosen only from the Candidate's Approved Answers,
 * salary answers and settings. Nothing is inferred or written by a model.
 * The first field that cannot be answered decides the Blocked reason.
 */

import { type RoleLocation, type WorkContext, compiledPlaces, qualifiedPlace } from "./work-context.js"

export type FieldKind = "text" | "textarea" | "select" | "radio" | "checkbox" | "file"

export type FormField = Readonly<{
  ref: string
  label: string
  kind: FieldKind
  required: boolean
  options?: readonly string[]
  /** SEC-513: the other readings of the label and READ_FORM's tamper flags, when the browser read them. */
  labelCheck?: LabelCheck
  /** The control's name and id attributes, read by READ_FORM. Used to match the question schema and to detect a swapped field (SEC-514). */
  fieldName?: string
  fieldId?: string
  /** The employer's question as backend code fetched it from the ATS API, matched to this control by name or id. Never page text. */
  schemaQuestion?: SchemaQuestion
  /** A text input that offers choices (role=combobox, a datalist, aria-autocomplete). Never free text (repair wave 3). */
  combobox?: boolean
}>

/** One field of a question schema the ATS publishes (Greenhouse job board API `questions=true`). */
export type SchemaQuestion = Readonly<{ text: string; fieldName: string; options?: readonly string[] }>

/**
 * SEC-513: what READ_FORM saw besides `label`. `readings` are the rendered
 * text (innerText) of every label source and the aria-label; `flags` name
 * content inside a label source that `label` may not show (hidden or
 * aria-hidden nodes, interactive roles, nested controls, a shadow root,
 * ::before/::after content, an off-screen or invisible source).
 */
export type LabelCheck = Readonly<{ readings: readonly string[]; flags: readonly string[] }>

export type ApprovedAnswerRecord = Readonly<{
  group: "standard" | "sensitive" | "custom"
  topic: string | null
  skill: string | null
  question: string | null
  value: string
}>

export type SalaryAnswer = Readonly<{ amount: string; currency: string; period: "year" | "month" }>

export type AnswerSources = Readonly<{
  fullName: string
  contactLines: readonly string[]
  /** EPIC-0002 B1: the Candidate's countries from Job Preferences; null with no record (every work question blocks). */
  work: WorkContext | null
  /** EPIC-0002 B1 (PRD E5): where the role is, for a sponsorship-only answer. */
  roleLocation: RoleLocation
  answers: readonly ApprovedAnswerRecord[]
  grossSalaryPolicy: SalaryAnswer | null
  currentSalary: SalaryAnswer | null
}>

export type FieldAnswer =
  | Readonly<{ ref: string; kind: "value"; value: string }>
  | Readonly<{ ref: string; kind: "document"; document: "resume" | "cover_letter" }>

export type AssignmentBlock = Readonly<{
  reason: "missing_approved_answer" | "personal_data_request" | "declaration" | "assessment"
  /** The Candidate-facing detail line (design-spec C-BLOCK-*), quoting the form's own label. */
  detail: string
  field: string
  /** CR5D-01: no Approved Answer can ever fill this field, so the card offers only the Manual Application path (no blocked question is stored). */
  manualOnly?: true
}>

/** The question a Blocked card offers to answer: none for a manual-only block (CR5D-01). */
export function blockedQuestion(block: AssignmentBlock): string | null {
  return block.manualOnly ? null : block.field
}

export type Assignment = Readonly<{
  answers: readonly FieldAnswer[]
  block: AssignmentBlock | null
  /** AC 5.5: the cover letter is uploaded only where the form accepts one. */
  coverLetterField: boolean
}>


/** Labels that ask for data a job application doesn't need (C-BLOCK-8). */
const PERSONAL_DATA = /\b(bank|account number|iban|sort code|routing number|bvn|bank verification|nin\b|national identification|national id|social security|ssn|passport number|tax (id|number)|credit card|mother'?s maiden)\b/
const DECLARATION = /\b(i certify|i declare|i hereby|sign below|signature|sign here|attest)\b/
const ASSESSMENT = /\b(assessment|coding (exercise|challenge|test)|skills test|take-home|take home|exercise)\b/
const LOCATION = /^location\b|\b(where are you (currently )?(located|based)|current location|city of residence|where do you live)\b/
const RESUME = /\b(resume|résumé|cv|curriculum vitae)\b/
const COVER_LETTER = /\bcover letter\b/
const FIRST_NAME = /\b(first|given) name\b/
const LAST_NAME = /\b(last|family) name\b|\bsurname\b/
const FULL_NAME = /^(full )?name\b|\bfull name\b|\byour name\b/
const EMAIL = /\be-?mail\b/
const PHONE = /\b(phone|mobile|telephone)\b/
const CURRENT_SALARY = /\b(current|present) (salary|compensation|pay)\b/
const EXPECTED_SALARY = /\b(salary|compensation|pay)\b/
const SENSITIVE: ReadonlyArray<readonly [topic: string, pattern: RegExp]> = [
  ["veteran_status", /\bveteran\b/],
  ["disability", /\bdisabilit(y|ies)\b/],
  ["demographic", /\b(gender|race|ethnicity|ethnic|sexual orientation|pronouns|hispanic|latino)\b/],
]
const STANDARD: ReadonlyArray<readonly [topic: string, pattern: RegExp]> = [
  ["notice_period", /\bnotice period\b/],
  ["start_date", /\b(start date|when can you start|earliest start|available to start)\b/],
  ["profile_links", /\b(linkedin|github|portfolio|personal website|website)\b/],
  ["relocation_willingness", /\brelocat(e|ion)\b/],
]
const SKILL_YEARS = /\byears of ([\p{L}\p{N}.+#/ -]+?) experience\b|\bexperience (?:do you have )?(?:with|in) ([\p{L}\p{N}.+#/ -]+?)\b(?:\?|$)/u

export type Leftover = Readonly<{ field: FormField; block: AssignmentBlock }>

export type AnswerPlan = Readonly<{
  /** Fields backend code answers itself (deterministic fill). */
  answers: readonly FieldAnswer[]
  /**
   * Required free questions code could not answer from an Approved Answer
   * ("Nothing was guessed"). Only these may go to the form agent; each keeps
   * the Missing Approved Answer block it gets if the agent leaves it empty.
   */
  leftovers: readonly Leftover[]
  /** A block no agent may resolve: sensitive, salary, personal data, declaration, assessment, missing contact data. */
  block: AssignmentBlock | null
  coverLetterField: boolean
}>

/** Deterministic-first (architecture r1 journey 2 steps 4, 6, 7): code answers, agent leftovers, hard blocks. */
export function planAnswers(fields: readonly FormField[], sources: AnswerSources): AnswerPlan {
  const answers: FieldAnswer[] = []
  const leftovers: Leftover[] = []
  let coverLetterField = false
  for (const field of fields) {
    const outcome = answerFor(field, sources)
    if (outcome === "skip") continue
    if ("leftover" in outcome) {
      leftovers.push({ field, block: outcome.leftover })
      continue
    }
    if ("reason" in outcome) return { answers, leftovers, block: outcome, coverLetterField }
    if (outcome.kind === "document" && outcome.document === "cover_letter") coverLetterField = true
    answers.push(withoutSource(outcome))
  }
  return { answers, leftovers, block: null, coverLetterField }
}

/** Code only, no agent: the first unanswerable field (leftover or hard block, in form order) decides the Blocked reason. */
export function assignAnswers(fields: readonly FormField[], sources: AnswerSources): Assignment {
  const answers: FieldAnswer[] = []
  let coverLetterField = false
  for (const field of fields) {
    const outcome = answerFor(field, sources)
    if (outcome === "skip") continue
    if ("leftover" in outcome) return { answers, block: outcome.leftover, coverLetterField }
    if ("reason" in outcome) return { answers, block: outcome, coverLetterField }
    if (outcome.kind === "document" && outcome.document === "cover_letter") coverLetterField = true
    answers.push(withoutSource(outcome))
  }
  return { answers, block: null, coverLetterField }
}

export type CatalogEntry = Readonly<{ key: string; description: string }>

/**
 * The answer keys the form agent may choose from: standard, skill-years and
 * custom Approved Answers, described without their values. Sensitive answers,
 * salary, contact details and settings are never in it.
 */
export function agentCatalog(sources: AnswerSources): readonly CatalogEntry[] {
  return catalogRecords(sources).map(({ key, description }) => ({ key, description }))
}

/** Backend-side lookup: the value behind a catalog key, or null. Never sent to a model. */
export function catalogValue(sources: AnswerSources, key: string): string | null {
  return catalogRecords(sources).find((record) => record.key === key)?.value ?? null
}

/**
 * SEC-515: a work-authorization or sponsorship Approved Answer, judged by its
 * own category and by the question text the Candidate saved, through the same
 * work-question detection and classifier. Such an answer is used only for its
 * exact question or the schema, never offered to the form agent.
 */
export function isWorkAnswer(answer: ApprovedAnswerRecord): boolean {
  if (/work|author|sponsor|visa|permit|right_to/.test(answer.topic ?? "")) return true
  const question = answer.question ?? ""
  return mentionsWork(question) || classifyWorkQuestion(question, null) !== null || SAVED_WORK_WORDING.test(normalise(stripIgnorable(question)))
}

/** SEC-515 residual wordings for the Candidate's own saved questions only (fail-safe: such an answer then fills only a schema question). */
const SAVED_WORK_WORDING = /\b(right to (live and |reside and )?work|work rights|(eligible|eligibility) for employment|legally employable|take up employment|immigration|work pass|employment pass|residence permit)\b/

function catalogRecords(sources: AnswerSources): ReadonlyArray<CatalogEntry & { value: string }> {
  return sources.answers.flatMap((answer, index) => {
    if (answer.group === "sensitive" || isWorkAnswer(answer)) return []
    const key = `A${index + 1}`
    const description =
      answer.group === "custom"
        ? `Custom answer to "${answer.question ?? ""}"`
        : answer.topic === "skill_years"
          ? `Years of experience with ${answer.skill ?? ""}`
          : `Standard answer: ${(answer.topic ?? "").replace(/_/g, " ")}`
    return [{ key, description, value: answer.value }]
  })
}

/** Where a planned value comes from (contract `FormAnswerSource`, sample review). */
export type AnswerSource =
  | "approved_answer_standard"
  | "approved_answer_custom"
  | "approved_answer_skill"
  | "approved_answer_sensitive"
  | "salary_gross_policy"
  | "salary_current"
  | "settings_contact"
  | "settings_location"
  | "settings_work_authorization"
  | "rule_sponsorship"
  | "document_resume"
  | "document_cover_letter"

export type SourcedAnswer = FieldAnswer & Readonly<{ source: AnswerSource; /** A work-authorization or sponsorship answer (identity re-checked before the click, SEC-514). */ work?: true }>
export type Outcome = SourcedAnswer | AssignmentBlock | Readonly<{ leftover: AssignmentBlock }> | "skip"

/** One field's outcome with its source; `planAnswers` and `assignAnswers` drop the source. */
export function answerFor(pageField: FormField, sources: AnswerSources): Outcome {
  // A schema-matched control is asked by the schema's text, never by its rendered label.
  const schema = pageField.schemaQuestion
  const field: FormField = schema ? { ...pageField, label: schema.text } : pageField
  const label = normalise(field.label)
  const value = (text: string, source: AnswerSource): SourcedAnswer => ({ ref: field.ref, kind: "value", value: text, source })
  const contact = (text: string) => value(text, "settings_contact")
  const missing = (detail: string): AssignmentBlock | "skip" =>
    field.required ? { reason: "missing_approved_answer", detail, field: field.label } : "skip"
  const askedFor = `The form asks "${field.label}" and you have no Approved Answer for it. Nothing was guessed.`
  // CR5D-01: a work question read from the page is never answered by code, so it blocks for manual completion only.
  // OPEN[designer]: no C-BLOCK line for this case; the detail extends C-BLOCK-1 with the page-text marker.
  const manualWork = (): AssignmentBlock | "skip" =>
    field.required
      ? {
          reason: "missing_approved_answer",
          detail: `The form asks "${field.label}" (as shown on the page). Work-authorization answers are used only on questions read from the employer's Greenhouse API, so complete this one manually. Nothing was entered.`,
          field: field.label,
          manualOnly: true,
        }
      : "skip"
  // A free question code could not answer: the form agent may pick an approved key for it.
  const free = (): Outcome => {
    if (!field.required) return "skip"
    // SEC-515: a required field whose label says next to nothing is unclear; the agent never guesses what it asks.
    if (nearEmptyLabel(field.label)) return { reason: "missing_approved_answer", detail: askedFor, field: field.label }
    // Repair wave 3: the agent fills free text only (and attaches documents); a choice field it could fill blocks now.
    if (field.kind !== "file" && !isFreeTextField(field)) return { reason: "missing_approved_answer", detail: askedFor, field: field.label }
    return { leftover: { reason: "missing_approved_answer", detail: askedFor, field: field.label } }
  }

  if (field.kind === "file") {
    if (COVER_LETTER.test(label)) return { ref: field.ref, kind: "document", document: "cover_letter", source: "document_cover_letter" }
    if (RESUME.test(label)) return { ref: field.ref, kind: "document", document: "resume", source: "document_resume" }
    return free()
  }
  if (DECLARATION.test(label)) {
    return { reason: "declaration", detail: `The form asks you to sign a declaration: "${field.label}". Only you can sign it.`, field: field.label }
  }
  if (ASSESSMENT.test(label)) {
    return { reason: "assessment", detail: `The form includes an assessment: "${field.label}". Only you can take it.`, field: field.label }
  }
  const customRecord = customAnswerRecord(field.label, sources.answers)
  // Late review of 705dede (c7c/e7b): a saved work answer fills only a Greenhouse field matched to the
  // API schema by name or id, whose schema text is the saved question. A page-read label never decides it.
  if (customRecord && isWorkAnswer(customRecord) && !schema) return manualWork()
  const custom = customRecord?.value ?? null
  if (PERSONAL_DATA.test(label)) {
    if (custom !== null) return value(custom, "approved_answer_custom")
    return { reason: "personal_data_request", detail: `The form asks for "${field.label}", which a job application doesn't need. Nothing was entered.`, field: field.label }
  }
  for (const [topic, pattern] of SENSITIVE) {
    if (!pattern.test(label)) continue
    const answer = sources.answers.find((item) => item.group === "sensitive" && item.topic === topic)
    if (answer) return value(answer.value, "approved_answer_sensitive")
    // AC 6.8: a sensitive question with no Approved Answer blocks even when it is voluntary.
    return {
      reason: "missing_approved_answer",
      detail: `The form asks a sensitive question, "${field.label}", and you have no Approved Answer for it. Nothing was inferred.`,
      field: field.label,
    }
  }
  // Scope 05d: work authorization and sponsorship are answered only from the
  // fetched schema's text or an exact custom Approved Answer; never from page text.
  const work = (text: string, source: AnswerSource): SourcedAnswer => ({ ...value(text, source), work: true })
  if (schema) {
    const workQuestion = classifyWorkQuestion(label, sources.work)
    const sponsorship = workQuestion === "sponsorship" && sources.work !== null ? sponsorshipAnswer(sources.work, sources.roleLocation) : null
    if (sponsorship !== null) return work(sponsorship, "rule_sponsorship")
    if (workQuestion === "authorized") return work("Yes", "settings_work_authorization")
    if (workQuestion === "not_authorized") return work("No", "settings_work_authorization")
    if (workQuestion === "unclear" || workQuestion === "sponsorship") {
      if (custom !== null) return work(custom, "approved_answer_custom")
      // Hard block, never an agent leftover: a wrong answer here is a false legal statement.
      return missing(askedFor)
    }
  } else if (pageWorkQuestion(field)) {
    // SEC-513: a label whose sources disagree or hide content never matches an Approved Answer.
    if (custom !== null && !labelTampered(field, sources.work)) return work(custom, "approved_answer_custom")
    // CR5D-01: a saved answer for this label would be a work answer, which page text never uses, so offer no Approved Answer.
    return manualWork()
  }
  if (CURRENT_SALARY.test(label)) {
    if (sources.currentSalary) return value(salaryText(sources.currentSalary, " gross"), "salary_current")
    return missing("The form asks for your current salary and you haven't approved a current-salary answer.")
  }
  if (EXPECTED_SALARY.test(label)) {
    if (sources.grossSalaryPolicy && policyCovers(label, sources.grossSalaryPolicy)) return value(salaryText(sources.grossSalaryPolicy, ""), "salary_gross_policy")
    return missing(`The form asks "${field.label}", which your gross-salary policy doesn't cover.`)
  }
  if (FIRST_NAME.test(label)) return nonEmpty(sources.fullName.split(/\s+/)[0], contact, missing, askedFor)
  if (LAST_NAME.test(label)) return nonEmpty(sources.fullName.split(/\s+/).slice(1).join(" "), contact, missing, askedFor)
  if (EMAIL.test(label)) return nonEmpty(sources.contactLines.find((line) => /\S+@\S+\.\S+/.test(line)), contact, missing, askedFor)
  if (PHONE.test(label)) return nonEmpty(sources.contactLines.find((line) => /\d[\d\s()+-]{6,}\d/.test(line) && !/@/.test(line)), contact, missing, askedFor)
  if (LOCATION.test(label)) return nonEmpty(locationLine(sources.contactLines), (text) => value(text, "settings_location"), missing, askedFor)
  if (FULL_NAME.test(label)) return nonEmpty(sources.fullName, contact, missing, askedFor)
  // A work answer reaching here is on a schema-matched field whose schema text is its saved question; its identity is re-read before the click.
  if (custom !== null) return customRecord && isWorkAnswer(customRecord) ? work(custom, "approved_answer_custom") : value(custom, "approved_answer_custom")
  const skill = SKILL_YEARS.exec(label)
  if (skill) {
    const name = normalise(skill[1] ?? skill[2] ?? "")
    const answer = sources.answers.find((item) => item.topic === "skill_years" && normalise(item.skill ?? "") === name)
    return answer ? value(answer.value, "approved_answer_skill") : free()
  }
  for (const [topic, pattern] of STANDARD) {
    if (!pattern.test(label)) continue
    const answer = sources.answers.find((item) => item.group === "standard" && item.topic === topic)
    return answer ? value(answer.value, "approved_answer_standard") : free()
  }
  // AC 6.15: anything else is a custom question, answered only from a custom Approved Answer key.
  return free()
}

/** The fields answered with a work-authorization or sponsorship answer; their identity is re-read before the click (SEC-514). */
export function answeredWorkFields(fields: readonly FormField[], sources: AnswerSources): readonly FormField[] {
  return fields.filter((field) => {
    const outcome = answerFor(field, sources)
    return typeof outcome === "object" && "work" in outcome && outcome.work === true
  })
}

/** True when the label or any other reading of it asks about work authorization or sponsorship. Detection only: it never chooses a value. */
export function pageWorkQuestion(field: FormField): boolean {
  return [field.label, ...(field.labelCheck?.readings ?? [])].some((text) => mentionsWork(text))
}

/** SEC-515, F-QA5I-01: fewer than two letters in any script (\p{L}) once invisible characters are removed. 姓名 is not near-empty. */
function nearEmptyLabel(label: string): boolean {
  return (stripIgnorable(label).match(/\p{L}/gu) ?? []).length < 2
}

/**
 * Repair wave 3 (SEC-515): the only fields the form agent may fill. A plain
 * text input or a textarea with no options. Choice, radio, checkbox, select,
 * Yes/No and combobox fields are never free text, so they block as Missing
 * Approved Answer when code and exact Approved Answers can't fill them.
 */
export function isFreeTextField(field: Pick<FormField, "kind" | "options" | "combobox">): boolean {
  return (field.kind === "text" || field.kind === "textarea") && field.combobox !== true && (field.options ?? []).length === 0
}

/** Repair wave 3: a bare Yes/No-style value. The agent never types one, whatever the field. */
export function isYesNoValue(value: string): boolean {
  return /^(yes|no|y|n|true|false)$/.test(value.normalize("NFKC").toLowerCase().replace(/[\s.!]+/g, ""))
}

/** SEC-515: zero-width and other default-ignorable code points, removed before a label is classified. */
function stripIgnorable(text: string): string {
  return text.replace(/\p{Default_Ignorable_Code_Point}/gu, "")
}

function mentionsWork(text: string): boolean {
  const folded = normalise(stripIgnorable(text)).replace(/[\u0370-\u03ff\u0400-\u052f]/g, (ch) => LOOK_ALIKES[ch] ?? ch)
  return AUTHORIZATION.test(folded) || SPONSORSHIP.test(folded) || /\b(visa|work permit|work authori[sz]ation|right to work)\b/.test(folded)
}

function withoutSource(answer: SourcedAnswer): FieldAnswer {
  return answer.kind === "value" ? { ref: answer.ref, kind: "value", value: answer.value } : { ref: answer.ref, kind: "document", document: answer.document }
}

function nonEmpty(
  text: string | undefined,
  value: (text: string) => SourcedAnswer,
  missing: (detail: string) => AssignmentBlock | "skip",
  detail: string
): SourcedAnswer | AssignmentBlock | "skip" {
  return text && text.trim() !== "" ? value(text.trim()) : missing(detail)
}

/** AC 6.15: a custom question matches its Approved Answer case- and space-insensitively, and nothing else does. */
function customAnswerRecord(label: string, answers: readonly ApprovedAnswerRecord[]): ApprovedAnswerRecord | null {
  const wanted = normalise(label)
  return answers.find((item) => item.group === "custom" && normalise(item.question ?? "") === wanted) ?? null
}

/**
 * AC 6.11, CR5-01, CR5-02: work-authorization and sponsorship questions.
 * Authorization is decided before sponsorship: a question about being able to
 * work somewhere "without sponsorship" is an authorization question, answered
 * from the setting. A question only about needing sponsorship is always "Yes".
 * Anything that can't be classified safely (negations, two questions in one
 * label, no named country, Nigeria mixed with another country, a setting the
 * code can't read) is "unclear" and blocks; nothing is guessed.
 */
export type WorkQuestion = "authorized" | "not_authorized" | "sponsorship" | "unclear" | null

const AUTHORIZATION = /\b(authori[sz]ed|eligible|legally (able|allowed|permitted)|permitted|(legal )?right) to (work|be employed)\b|\bauthori[sz]ed to work\b|\b(can|could) you (legally )?work in\b|\bable to (legally )?work in\b|\bhold an? (valid |current )?(work permit|work visa|work authori[sz]ation)\b|\bwork authori[sz]ation\b/
const SPONSORSHIP = /\bsponsor(s|ed|ing|ship)?\b|\b(require|need|needs|requiring|needing)\b.*\b(work permit|work visa|visa)\b/
const WITHOUT_SPONSORSHIP = /\bwithout (the need for |needing |requiring |any |a |an |employer |company |visa |or |future |current )*(sponsorship|sponsor|visa|work visa|work permit)\b/
const NEGATION = /\b(not|never|no longer|neither|nor)\b|n't\b/
const SECOND_QUESTION = /\?.*\S.*\?|\b(or|and) (will|would|do|does|are|have|can) you\b/


/** SEC-512: Cyrillic and Greek letters that look like Latin ones, folded only to detect a work question. */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u04bb": "h", "\u0501": "d", "\u051b": "q", "\u051d": "w",
  "\u03b1": "a", "\u03bf": "o", "\u03b9": "i", "\u03bd": "v", "\u03ba": "k", "\u03c1": "p", "\u03c4": "t", "\u03c5": "u", "\u03b5": "e",
}

export function classifyWorkQuestion(rawLabel: string, ctx: WorkContext | null): WorkQuestion {
  // SEC-515: invisible characters are removed first, so they cannot hide a work question.
  const label = stripIgnorable(rawLabel).replace(/[\u0370-\u03ff\u0400-\u052f]/g, (ch) => LOOK_ALIKES[ch] ?? ch)
  const work = classifyFolded(label, ctx)
  // A work question written with any non-ASCII letter (or an invisible one) can't be read safely.
  return work !== null && /[^ -~\t\n\r]/.test(rawLabel) ? "unclear" : work
}

/**
 * Decision order as slice 5 (r4), with the place patterns compiled for the
 * Candidate's countries (`compiledPlaces`) and step 6 as amended in r6
 * (CR-B1-01). No context (no Job Preferences record): every work question
 * is unclear and blocks.
 */
function classifyFolded(label: string, ctx: WorkContext | null): WorkQuestion {
  const authorization = AUTHORIZATION.test(label)
  const sponsorship = SPONSORSHIP.test(label)
  if (!authorization && !sponsorship) return null
  if (NEGATION.test(label) || SECOND_QUESTION.test(label)) return "unclear"
  if (ctx === null) return "unclear"
  const places = compiledPlaces(ctx)
  const excluded = places.excluded.test(label)
  // F-02 (architecture r6, CR-B1-01): only the first exclusion is stripped, as slice 5 did; a later one stays in the remainder and step 5 blocks it.
  const remainder = label.replace(places.excluded, " ")
  if (!authorization) {
    // SEC-512: a sponsorship-only label naming an authorized country's place blocks; otherwise answered from the role's location.
    return places.sponsorPlace.test(remainder) ? "unclear" : "sponsorship"
  }
  if (sponsorship && !WITHOUT_SPONSORSHIP.test(label)) return "unclear"
  const whole = label.replace(/[\s?*.!:]+$/, "")
  if (places.authOrWider.test(remainder)) return !excluded && places.purelyAuth.some((shape) => shape.test(whole)) ? "authorized" : "unclear"
  // Step 6 (architecture r6 "B1 amendment (code review CR-B1-01)"): "No" only when the places the label names provably include none of the
  // Candidate's authorized countries; never "Yes". 6a: an exclusion is "No" only with one authorized country (then it is the excluded one).
  if (excluded) return ctx.authorized.length === 1 ? "not_authorized" : "unclear"
  // 6b: an OTHER_PLACES name is "No" only when no matched entry covers an authorized country. 6c: otherwise unclear.
  if (!places.otherPlaces.test(remainder)) return "unclear"
  // 6b qualified-name guard (r6, SEC-B1-2-01), before the coverage check and in every context: "New Mexico", "Northern Ireland" → unclear.
  if (qualifiedPlace(remainder, places)) return "unclear"
  return places.coveringPlaces?.test(remainder) ? "unclear" : "not_authorized"
}

/**
 * PRD r4 E5 (r4 "Answer values"): a sponsorship-only question is answered
 * from the role's location. Every role country authorized → "No"; none
 * authorized → the sponsorship need; unclear, empty or mixed → null (blocks
 * as unclear; code never guesses a location).
 */
function sponsorshipAnswer(ctx: WorkContext, role: RoleLocation): "Yes" | "No" | null {
  if (role.kind !== "countries" || role.codes.length === 0) return null
  const inside = role.codes.filter((code) => ctx.authorized.includes(code)).length
  if (inside === role.codes.length) return "No"
  if (inside === 0) return ctx.sponsorshipNeeded ? "Yes" : "No"
  return null
}

/**
 * SEC-513: true when any reading of the label is a work question and either
 * READ_FORM flagged hidden or overriding content, or the readings do not all
 * classify the same. A reading may end with the control's own option texts
 * (a select nested in its label); only those exact options are removed.
 */
export function labelTampered(field: FormField, ctx: WorkContext | null): boolean {
  const check = field.labelCheck
  if (!check) return false
  const own = (field.options ?? []).join(" ")
  const strip = (text: string) => {
    const reading = normalise(text)
    const tail = normalise(own)
    return tail !== "" && reading.endsWith(" " + tail) ? reading.slice(0, -tail.length - 1).trim() : reading
  }
  const classes = [normalise(field.label), ...check.readings.map(strip)].map((text) => classifyWorkQuestion(text, ctx))
  if (classes.every((item) => item === null)) return false
  return check.flags.length > 0 || classes.some((item) => item !== classes[0])
}

/** The contact line that names a place: no digit, "@" or link. */
function locationLine(lines: readonly string[]): string | undefined {
  return lines.find((line) => !/[\d@]|https?:|www\.|\.com\b|linkedin/i.test(line))
}

/**
 * AC 6.10: the policy covers a question only when the question's currency and
 * period, where it states them, are the policy's, and it does not ask for a
 * total that includes bonus, equity or benefits, or for net pay.
 */
function policyCovers(label: string, policy: SalaryAnswer): boolean {
  if (/\b(bonus|equity|stock|total compensation|ote|on-target|benefits|net|take-home)\b/.test(label)) return false
  const currencies = label.match(/\b(usd|eur|gbp|ngn|cad|aud|chf)\b/g) ?? []
  if (currencies.some((currency) => currency !== policy.currency.toLowerCase())) return false
  if (/\b(month|monthly)\b/.test(label) && policy.period !== "month") return false
  if (/\b(annual|annually|year|yearly|per annum)\b/.test(label) && policy.period !== "year") return false
  if (/\b(hour|hourly|day rate|daily)\b/.test(label)) return false
  return true
}

function salaryText(salary: SalaryAnswer, suffix: string): string {
  const amount = Number(salary.amount).toLocaleString("en-US", { maximumFractionDigits: 2 })
  return `${salary.currency} ${amount} per ${salary.period}${suffix}`
}

function normalise(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim()
}
