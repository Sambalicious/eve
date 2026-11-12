import type { PageAfterSubmit } from "./form-session.js"

/**
 * Deterministic page rules (architecture r1 journey 2 steps 3 and 10; AC 6.12
 * to 6.14). Code reads the page; no model judges a block or a confirmation.
 */

export type PageBlock = Readonly<{ reason: "login" | "email_verification" | "captcha" | "assessment"; detail: string }>

const LOGIN = /\b(sign in|log in|login|create an account|create account|register to (continue|apply)|password)\b/i
const VERIFY = /\b(verify (your )?email|verification code|enter the code (we|sent)|confirm your email)\b/i
// A visible challenge, not an invisible reCAPTCHA badge ("protected by reCAPTCHA").
const CAPTCHA = /\b(i'?m not a robot|complete the captcha|captcha challenge|solve the (puzzle|challenge)|select all (images|squares))\b/i
const ASSESSMENT = /\b(?:required )?(?:skills )?(assessment|coding (exercise|challenge|test)|skills test|take-home)\b[:\s"“]*([^"”\n.]{0,80})/i

/** A block the form shows before any click, or null. Login wins: the assistant never signs in or creates accounts. */
export function detectPageBlock(text: string): PageBlock | null {
  if (LOGIN.test(text)) return { reason: "login", detail: "The form needs you to sign in to an account. The assistant doesn't sign in or create accounts." }
  if (VERIFY.test(text)) return { reason: "email_verification", detail: "The form asks to verify an email address. The assistant doesn't complete verification." }
  if (CAPTCHA.test(text)) return { reason: "captcha", detail: "The form shows a CAPTCHA. The assistant doesn't solve CAPTCHAs." }
  const assessment = ASSESSMENT.exec(text)
  if (assessment) {
    const title = (assessment[3] ?? "").trim() || assessment[1] || "assessment"
    return { reason: "assessment", detail: `The form includes an assessment: "${title}". Only you can take it.` }
  }
  return null
}

export type Evidence = Readonly<{ kind: "confirmation_page" | "application_id"; text: string }>

export type ResultJudgement = Readonly<{ evidence: Evidence | null; offOriginHost: string | null }>

export type ResultInput = Readonly<{
  applicationHost: string
  applicationSystem: string
  /** Visible text of the form page just before the click (any whitespace). */
  textBeforeClick: string
  page: PageAfterSubmit
}>

/** An application-ID label; the token after it is checked separately, case-sensitively. */
const ID_LABEL = /\b(?:application (?:id|number|reference)|reference (?:number|id)|confirmation (?:number|id))[ \t]*[:#]?[ \t]*/gi
/** Upper-case letters, digits and hyphens, 4 to 40 characters, with at least one digit (SEC-501). */
const ID_TOKEN = /^([A-Z0-9][A-Z0-9-]{3,39})(?![A-Za-z0-9-])/
const COMMON_CONFIRMATIONS = [/^thank you for (applying|your application)\b/i, /^(your )?application (has been |was )?(received|submitted)\b/i]
/** Each Application System's own confirmation wording, matched only at the start of a new line. */
const CONFIRMATIONS: Readonly<Record<string, readonly RegExp[]>> = {
  greenhouse: [/^thank you for applying\b/i, /^(your )?application (has been )?received\b/i],
  lever: [/^application submitted\b/i, /^thank you for applying\b/i],
  ashby: [/^thank you for your application\b/i, /^(your )?application (was |has been )?submitted\b/i],
}
/** Wording of a form that came back with errors: the submit failed or is unknown. */
const VALIDATION_ERROR = /\b(is required|required field|this field is required|please (correct|fix|fill in|complete|enter)|there (was|were) (a )?(problem|error)s?|errors? below|is invalid|must be (a |an )?valid)\b/i

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()

/**
 * AC 6.13 and 6.14, SEC-501 and SEC-502: decides from the page after the
 * single click whether there is confirmation evidence. Evidence counts only
 * when the page is still on the application host, the form is gone, no
 * validation error shows, and it appears in text that was not on the page
 * before the click. An application ID needs the ID shape; a confirmation page
 * needs the Application System's wording at the start of a line. Anything else
 * is Uncertain.
 */
export function judgeResult(input: ResultInput): ResultJudgement {
  const { page } = input
  if (page.host === "") return { evidence: null, offOriginHost: null }
  if (page.host !== input.applicationHost) return { evidence: null, offOriginHost: page.host }
  if (page.formPresent || page.validationErrors) return { evidence: null, offOriginHost: null }
  const before = normalize(input.textBeforeClick)
  const added = page.text
    .split(/\r?\n/)
    .map(normalize)
    .filter((line) => line !== "" && !before.includes(line))
  if (added.some((line) => VALIDATION_ERROR.test(line))) return { evidence: null, offOriginHost: null }
  return { evidence: applicationId(added) ?? confirmationPage(added, input.applicationSystem), offOriginHost: null }
}

function applicationId(lines: readonly string[]): Evidence | null {
  for (const line of lines) {
    for (const label of line.matchAll(ID_LABEL)) {
      const token = ID_TOKEN.exec(line.slice(label.index + label[0].length))?.[1]
      if (token && /\d/.test(token)) return { kind: "application_id", text: token }
    }
  }
  return null
}

function confirmationPage(lines: readonly string[], system: string): Evidence | null {
  const patterns = CONFIRMATIONS[system] ?? COMMON_CONFIRMATIONS
  const line = lines.find((item) => patterns.some((pattern) => pattern.test(item)))
  return line ? { kind: "confirmation_page", text: line.slice(0, 160) } : null
}

/** OQ-A2: a CAPTCHA seen after the click is noted on the Uncertain Submission. */
export function captchaVisible(text: string): boolean {
  return CAPTCHA.test(text)
}
