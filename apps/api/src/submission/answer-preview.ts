import type { BlockedReasonValue, FormAnswer } from "@eve/contracts"

import { type AnswerSources, type FormField, answerFor } from "./answer-assignment.js"

/**
 * What a form will receive (AC 2.1, design C-SAMPLE-14 to 17), from the same
 * `answerFor` the submission uses, so the preview and the fill cannot differ.
 * Unlike the submission it keeps going after a blocking field so the Candidate
 * sees every question. Sensitive values are redacted here: the response never
 * carries them. Optional questions with no answer are left out because nothing
 * is filled into them.
 */
export function previewAnswers(fields: readonly FormField[], sources: AnswerSources): FormAnswer[] {
  const rows: FormAnswer[] = []
  for (const pageField of fields) {
    const outcome = answerFor(pageField, sources)
    // The question shown is the schema's text when backend code matched one, else the page label.
    const field = pageField.schemaQuestion ? { ...pageField, label: pageField.schemaQuestion.text } : pageField
    if (outcome === "skip") continue
    if ("leftover" in outcome) rows.push(missing(field, outcome.leftover.reason))
    else if ("reason" in outcome) rows.push({ ...missing(field, outcome.reason), ...(outcome.manualOnly ? { manualOnly: true } : {}) })
    else if (outcome.kind === "document") rows.push({ question: field.label, source: outcome.source, value: null, redacted: false, blockedReason: null })
    else {
      const redacted = outcome.source === "approved_answer_sensitive"
      rows.push({ question: field.label, source: outcome.source, value: redacted ? null : outcome.value, redacted, blockedReason: null })
    }
  }
  return rows
}

function missing(field: FormField, reason: BlockedReasonValue): FormAnswer {
  return { question: field.label, source: "missing", value: null, redacted: false, blockedReason: reason }
}
