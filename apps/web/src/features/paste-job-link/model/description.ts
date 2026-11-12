import {
  normalisePastedDescription,
  PASTE_FIELD_MESSAGES,
  pasteFieldErrors,
  PASTED_DESCRIPTION_MAX_LENGTH,
  type PasteField,
  type PasteFieldError,
} from "@eve/contracts"

import type { PasteRequest } from "@/entities/job-posting"
import { jobLinkProblem } from "./job-link"
import { pasteCopy } from "./paste-copy"

/** What the open panel holds. */
export interface PasteFields {
  readonly link: string
  readonly description: string
  readonly title: string
  readonly company: string
}

export type PasteFieldName = "link" | PasteField
export type PasteFieldMessages = Partial<Record<PasteFieldName, string>>

/** The counter and the over-limit check measure the stored form (contract `normalisePastedDescription`). */
export function descriptionLength(description: string): number {
  return normalisePastedDescription(description).length
}

export function isDescriptionOverLimit(description: string): boolean {
  return descriptionLength(description) > PASTED_DESCRIPTION_MAX_LENGTH
}

/** The message for each refused field, from the contract's `fieldErrors` entries. */
export function fieldMessages(errors: readonly PasteFieldError[]): PasteFieldMessages {
  const messages: PasteFieldMessages = {}
  for (const { field, problem } of errors) {
    const byProblem: Partial<Record<string, string>> = PASTE_FIELD_MESSAGES[field]
    messages[field] ??= byProblem[problem]
  }
  return messages
}

/**
 * Design r1 "Client validation order on send": (1) both blank → C-PD-20 on the
 * link; (2) a non-blank link that is invalid; (3) description length; (4) names,
 * required only for a description-only paste (the server decides with a link),
 * and over 200 after cleaning either way. Empty object: nothing to fix.
 */
export function pasteFieldProblems(fields: PasteFields): PasteFieldMessages {
  const link = fields.link.trim()
  const hasDescription = normalisePastedDescription(fields.description) !== ""
  if (link === "" && !hasDescription) return { link: pasteCopy.nothing }
  const problems: PasteFieldMessages = {}
  if (link !== "") {
    const problem = jobLinkProblem(link)
    if (problem) problems.link = problem
  }
  if (!hasDescription) return problems
  const errors = pasteFieldErrors({ description: fields.description, title: fields.title, company: fields.company, namesRequired: link === "" })
  return { ...problems, ...fieldMessages(errors) }
}

/**
 * The request for the open panel. A blank description is never sent (I-1), so
 * that paste is link-only `{ url }`; names go only with a description, and only
 * when typed.
 */
export function pasteRequestOf(fields: PasteFields): PasteRequest {
  const url = fields.link.trim()
  if (normalisePastedDescription(fields.description) === "") return { url }
  return {
    ...(url !== "" && { url }),
    description: fields.description,
    ...(fields.title.trim() !== "" && { title: fields.title }),
    ...(fields.company.trim() !== "" && { company: fields.company }),
  }
}
