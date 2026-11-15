/**
 * How the review step presents a plan. The page's labels are untrusted text,
 * so every caller writes them with `textContent`; nothing here builds markup.
 */

/** A label that asks for data worth hiding from a shoulder or a screenshot. */
const SENSITIVE_LABEL = /gender|sexual|\bsex\b|pronoun|race|ethnic|hispanic|latino|religio|disabilit|veteran|citizenship|criminal|social security|\bssn\b|salary|date of birth|sponsor|visa|\bage\b|how old/i

export function isSensitiveLabel(label: string): boolean {
  return SENSITIVE_LABEL.test(label)
}

/** The mask shown for a sensitive value: always eight dots, so it does not reveal how long the value is. */
export function maskedValue(value: string): string {
  return value === "" ? "" : "•".repeat(8)
}
