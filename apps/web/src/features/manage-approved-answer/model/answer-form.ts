import {
  approvedAnswerCopy,
  type ApprovedAnswer,
  type NewApprovedAnswer,
  type SensitiveTopic,
  type StandardTopic,
} from "@/entities/approved-answer"

/** The group the sheet was opened from. Salary has its own cards. */
export type AnswerGroup = "standard" | "sensitive" | "custom"

/** What the sheet is doing: adding to a group, or editing one answer's value. */
export type AnswerSheetMode =
  | { kind: "create"; group: AnswerGroup; /** Custom question pre-filled from a Blocked Application (F6). */ question?: string }
  | { kind: "edit"; answer: ApprovedAnswer }

export interface AnswerFormValues {
  standardTopic: StandardTopic | ""
  sensitiveTopic: SensitiveTopic | ""
  skill: string
  question: string
  value: string
}

export type AnswerFormErrors = Partial<Record<"topic" | "skill" | "question" | "value", string>>

export const emptyAnswerForm: AnswerFormValues = {
  standardTopic: "",
  sensitiveTopic: "",
  skill: "",
  question: "",
  value: "",
}

export function initialAnswerForm(mode: AnswerSheetMode): AnswerFormValues {
  return mode.kind === "edit" ? { ...emptyAnswerForm, value: mode.answer.value } : { ...emptyAnswerForm, question: mode.question ?? "" }
}

/** The standard topic the form is answering: the chosen topic on create, the answer's topic on edit. */
export function formTopic(mode: AnswerSheetMode, values: AnswerFormValues): StandardTopic | null {
  if (mode.kind === "edit") return mode.answer.group === "standard" ? mode.answer.topic : null
  return mode.group === "standard" && values.standardTopic !== "" ? values.standardTopic : null
}

/**
 * Client checks before sending, with the catalogue's copy: C-VAL-ANS-1 (value),
 * C-VAL-ANS-2 (custom question), C-VAL-ANS-3 (skill name), C-VAL-ANS-4 (a
 * profile-links line that isn't an http(s) link). The backend checks the first
 * two and answers with the same strings.
 */
export function validateAnswerForm(mode: AnswerSheetMode, values: AnswerFormValues): AnswerFormErrors {
  const errors: AnswerFormErrors = {}
  const topic = formTopic(mode, values)
  if (mode.kind === "create" && mode.group === "custom" && values.question.trim() === "") {
    errors.question = approvedAnswerCopy.emptyQuestion
  }
  if (mode.kind === "create" && topic === "skill_years" && values.skill.trim() === "") {
    errors.skill = approvedAnswerCopy.emptySkill
  }
  if (values.value.trim() === "") errors.value = approvedAnswerCopy.emptyValue
  else if (topic === "profile_links" && !areProfileLinks(values.value)) errors.value = approvedAnswerCopy.badLink
  return errors
}

/** Every non-empty line is an http(s) URL. */
export function areProfileLinks(value: string): boolean {
  return profileLinkLines(value).every((line) => {
    try {
      const url = new URL(line)
      return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== ""
    } catch {
      return false
    }
  })
}

/** Stored form of profile links: trimmed non-empty lines joined by a line break. */
export function profileLinkLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

/** The value as sent: profile links are normalised to one link per line. */
export function valueToSend(topic: StandardTopic | null, value: string): string {
  return topic === "profile_links" ? profileLinkLines(value).join("\n") : value
}

/** The create request for a valid form. */
export function toNewAnswer(group: AnswerGroup, values: AnswerFormValues): NewApprovedAnswer {
  switch (group) {
    case "standard": {
      const topic = values.standardTopic || "notice_period"
      const value = valueToSend(topic, values.value)
      return topic === "skill_years"
        ? { group, topic, skill: values.skill.trim(), value }
        : { group, topic, value }
    }
    case "sensitive":
      return { group, topic: values.sensitiveTopic || "demographic", value: values.value }
    case "custom":
      return { group, question: values.question, value: values.value }
    default: {
      const exhaustive: never = group
      return exhaustive
    }
  }
}

/**
 * The existing answer for the same question as `candidate`, matched the way
 * the backend matches (contract: one answer per standard topic, per skill for
 * skill years, per sensitive topic, per normalised custom question).
 */
export function findSameQuestion(answers: readonly ApprovedAnswer[], candidate: NewApprovedAnswer): ApprovedAnswer | null {
  const norm = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase()
  return (
    answers.find((answer) => {
      if (answer.group !== candidate.group) return false
      if (answer.group === "custom" && candidate.group === "custom") return norm(answer.question) === norm(candidate.question)
      if (answer.group === "sensitive" && candidate.group === "sensitive") return answer.topic === candidate.topic
      if (answer.group === "standard" && candidate.group === "standard") {
        if (answer.topic !== candidate.topic) return false
        return answer.topic !== "skill_years" || norm(answer.skill ?? "") === norm(candidate.skill ?? "")
      }
      return false
    }) ?? null
  )
}
