import {
  SENSITIVE_TOPIC_LABELS,
  STANDARD_TOPIC_LABELS,
  type ApprovedAnswer,
  type SensitiveTopic,
  type StandardTopic,
} from "@/entities/approved-answer"

type Standard = Extract<ApprovedAnswer, { group: "standard" }>
type Sensitive = Extract<ApprovedAnswer, { group: "sensitive" }>
type Custom = Extract<ApprovedAnswer, { group: "custom" }>

export interface AnswerGroups {
  standard: Standard[]
  sensitive: Sensitive[]
  custom: Custom[]
}

const STANDARD_ORDER = Object.keys(STANDARD_TOPIC_LABELS) as StandardTopic[]
const SENSITIVE_ORDER = Object.keys(SENSITIVE_TOPIC_LABELS) as SensitiveTopic[]

/** Splits answers into their sections, in the topic order the design lists them. */
export function groupAnswers(answers: readonly ApprovedAnswer[]): AnswerGroups {
  const groups: AnswerGroups = { standard: [], sensitive: [], custom: [] }
  for (const answer of answers) {
    if (answer.group === "standard") groups.standard.push(answer)
    else if (answer.group === "sensitive") groups.sensitive.push(answer)
    else groups.custom.push(answer)
  }
  groups.standard.sort(
    (a, b) =>
      STANDARD_ORDER.indexOf(a.topic) - STANDARD_ORDER.indexOf(b.topic) ||
      (a.skill ?? "").localeCompare(b.skill ?? "")
  )
  groups.sensitive.sort((a, b) => SENSITIVE_ORDER.indexOf(a.topic) - SENSITIVE_ORDER.indexOf(b.topic))
  groups.custom.sort((a, b) => a.question.localeCompare(b.question))
  return groups
}

/** Topics with an answer already; the sheet leaves them out (skill years can repeat per skill). */
export function answeredTopics(groups: AnswerGroups) {
  return {
    standard: groups.standard.filter((a) => a.topic !== "skill_years").map((a) => a.topic),
    sensitive: groups.sensitive.map((a) => a.topic),
  }
}

/** False once every fixed topic in a group has an answer, so "Add answer" has nothing to add. */
export function canAddTo(group: "standard" | "sensitive", groups: AnswerGroups): boolean {
  if (group === "standard") return true
  return groups.sensitive.length < SENSITIVE_ORDER.length
}
