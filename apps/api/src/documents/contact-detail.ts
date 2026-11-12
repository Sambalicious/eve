import type { ContactHeader } from "./document-model.js"

/**
 * SEC-401: contact details are inserted by the backend after generation and
 * must never be sent to the model or appear in a document body. A text holds a
 * contact detail when it has an email address, a phone-like run of digits, or
 * one of the Candidate's own contact lines that identifies them (see
 * IDENTIFYING: a street address, email, phone, profile link or host). A city or
 * country line alone ("Lagos, Nigeria") is not identifying and is allowed.
 */
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i
const PHONE = /\+?\(?\d[\d\s().-]{6,}\d/g
const YEAR_RANGE = /^\(?(?:19|20)\d{2}\)?\s*[-.]\s*\(?(?:19|20)\d{2}\)?$/
/**
 * A contact line that identifies the Candidate: it has a digit, "@", a link
 * scheme, a dotted host ("ada.dev", "linkedin.com") or a "/" path
 * ("linkedin.com/in/x"; SEC-401 residual).
 */
const IDENTIFYING = /\d|@|https?:\/\/|www\.|[\p{L}\p{N}-]\.[a-z]{2,}\b|\//iu

export function containsContactDetail(text: string, contact: ContactHeader | null): boolean {
  if (EMAIL.test(text)) return true
  for (const match of text.matchAll(PHONE)) {
    const digits = match[0].replace(/\D/g, "")
    if (digits.length >= 7 && !YEAR_RANGE.test(match[0].trim())) return true
  }
  if (contact === null) return false
  const folded = fold(text)
  return contact.lines.some((line) => IDENTIFYING.test(line) && fold(line) !== "" && folded.includes(fold(line)))
}

function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
}
