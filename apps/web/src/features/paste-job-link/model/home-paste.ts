import { normalisePastedDescription, PASTED_DESCRIPTION_MIN_LENGTH } from "@eve/contracts"

import type { PasteRequest } from "@/entities/job-posting"
import { homeCopy } from "@/entities/job-posting"
import { jobLinkProblem } from "./job-link"
import { fieldMessages, pasteFieldProblems, type PasteFieldMessages } from "./description"

/** A single token that starts like a link is a link; anything else is a pasted description. */
export function looksLikeLink(text: string): boolean {
  const value = text.trim()
  return /^https?:\/\/\S+$/i.test(value) || (!/\s/.test(value) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value))
}

export interface HomePasteValues {
  readonly text: string
  readonly title: string
  readonly company: string
}

/** Client checks before sending. The server decides the rest (its refusals reuse the same field messages). */
export function homePasteProblems(values: HomePasteValues): PasteFieldMessages {
  const text = values.text.trim()
  if (text === "") return { link: homeCopy.paste.errorInvalid }
  if (looksLikeLink(text)) {
    const problem = jobLinkProblem(/^https?:/i.test(text) ? text : `https://${text}`)
    return problem ? { link: problem } : {}
  }
  if (normalisePastedDescription(text).length < PASTED_DESCRIPTION_MIN_LENGTH && text.length < 40) return { link: homeCopy.paste.errorInvalid }
  return pasteFieldProblems({ link: "", description: text, title: values.title, company: values.company })
}

export function homePasteRequest(values: HomePasteValues): PasteRequest {
  const text = values.text.trim()
  if (looksLikeLink(text)) return { url: /^https?:/i.test(text) ? text : `https://${text}` }
  return {
    description: values.text,
    ...(values.title.trim() !== "" && { title: values.title }),
    ...(values.company.trim() !== "" && { company: values.company }),
  }
}

export { fieldMessages }
