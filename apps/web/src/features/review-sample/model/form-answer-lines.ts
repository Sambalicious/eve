import { blockedReasonLabel, submissionCopy, type FormAnswer, type FormAnswerSource } from "@/entities/application"

const f = submissionCopy.sample.formAnswers

/**
 * Source column labels. The design names "Settings: location", "Settings: work
 * authorization" and "Rule: sponsorship is always Yes"; it asks for the
 * Approved Answer topic, which the contract doesn't carry, so Approved Answers
 * are labelled by group.
 * OPEN[designer]: labels for the Approved Answer groups, salary, contact details and documents.
 */
const SOURCE_LABEL: Record<FormAnswerSource, string> = {
  approved_answer_standard: "Approved Answer",
  approved_answer_custom: "Approved Answer: custom question",
  approved_answer_skill: "Approved Answer: skill",
  approved_answer_sensitive: "Approved Answer: sensitive",
  salary_gross_policy: "Approved Answer: gross-salary policy",
  salary_current: "Approved Answer: current salary",
  settings_contact: "Career Profile: contact details",
  settings_location: "Settings: location",
  settings_work_authorization: "Settings: work authorization",
  rule_sponsorship: "Rule: sponsorship is always Yes",
  document_resume: "Tailored resume",
  document_cover_letter: "Tailored cover letter",
  missing: "None",
}

export function sourceLabel(answer: FormAnswer): string {
  return SOURCE_LABEL[answer.source]
}

export type AnswerCell = { kind: "hidden" } | { kind: "blocked"; text: string } | { kind: "text"; text: string }

/** What the Answer cell shows: C-SAMPLE-16 for a redacted value, "No Approved Answer" for a block, the file for a document. */
export function answerCell(answer: FormAnswer): AnswerCell {
  if (answer.redacted) return { kind: "hidden" }
  if (answer.source === "missing") {
    const reason = answer.blockedReason
    return { kind: "blocked", text: !reason || reason === "missing_approved_answer" ? f.noApprovedAnswer : blockedReasonLabel[reason] }
  }
  if (answer.source === "document_resume") return { kind: "text", text: "Resume (PDF)" }
  if (answer.source === "document_cover_letter") return { kind: "text", text: "Cover letter (PDF)" }
  return { kind: "text", text: answer.value ?? "" }
}

/**
 * The first required question with no Approved Answer, for C-SAMPLE-8 above
 * the action bar. `manualOnly` (CR5E-01) means no Approved Answer can fill it,
 * so the warning must not offer "Add Approved Answer".
 */
export function firstMissingAnswer(answers: readonly FormAnswer[]): { question: string; manualOnly: boolean } | null {
  const found = answers.find((a) => a.source === "missing" && (a.blockedReason === null || a.blockedReason === "missing_approved_answer"))
  return found ? { question: found.question, manualOnly: found.manualOnly } : null
}
