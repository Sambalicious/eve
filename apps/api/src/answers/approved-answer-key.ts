import type { CreateApprovedAnswerRequest } from "@eve/contracts"

/**
 * The identity of the question an answer covers, so the same question cannot be
 * answered twice. Custom questions compare case- and space-insensitively.
 */
export function approvedAnswerKey(request: CreateApprovedAnswerRequest): string {
  switch (request.group) {
    case "standard":
      return request.topic === "skill_years"
        ? `standard:skill_years:${normalise(request.skill ?? "")}`
        : `standard:${request.topic}`
    case "sensitive":
      return `sensitive:${request.topic}`
    case "custom":
      return `custom:${normalise(request.question)}`
  }
}

function normalise(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()
}
