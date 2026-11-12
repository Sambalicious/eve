import type { RuleNameValue } from "@eve/contracts"

/**
 * EPIC-0002 B1 (D44): a rule's name inside a sentence, as the dashboard's
 * `ruleInlineLabel` writes it (copy deck r6, commit 8f0eb00). The daily summary
 * ("violated {rule} rule") and the E1 "Unverified:" line use it, so an email
 * never prints a raw key such as `employment_type`.
 */
const INLINE: Readonly<Record<RuleNameValue, string>> = {
  location: "location",
  sponsorship: "sponsorship",
  pay: "pay",
  hours: "hours",
  industry: "industry",
  seniority: "seniority",
  employment_type: "employment type",
}

/** The inline words for a stored rule name; an unknown name (a later rule) is printed as stored. */
export function ruleInlineLabel(rule: string): string {
  return (INLINE as Record<string, string>)[rule] ?? rule
}
