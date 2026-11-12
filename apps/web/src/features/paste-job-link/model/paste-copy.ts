import { PASTE_DESCRIPTION_ERROR_MESSAGES, PASTED_DESCRIPTION_MAX_LENGTH } from "@eve/contracts"

const grouped = new Intl.NumberFormat("en-US")

/**
 * EPIC-0010 copy-deck.r1 strings for the paste form's description panel, byte
 * for byte. Refusal messages that the contract exports (C-PD-21 to 25b, 27, 28)
 * come from `@eve/contracts`, so the form and the API say the same words.
 */
export const pasteCopy = {
  /** C-PD-1 */
  toggle: "Add the job description",
  /** C-PD-2 */
  remove: "Remove description",
  /** C-PD-3 */
  optional: "Optional",
  /** C-PD-4 */
  descriptionLabel: "Job description",
  /** C-PD-5, `{min}` = 200 */
  descriptionHelp: "Paste the full text if Eve can't read the link, at least 200 characters. You apply yourself. Eve never sends it.",
  /** C-PD-6 `{count} / {max}` with grouped digits. */
  count: (count: number) => `${grouped.format(count)} / ${grouped.format(PASTED_DESCRIPTION_MAX_LENGTH)}`,
  /** C-PD-7, the counter's accessible text. */
  countSr: (count: number) => `${grouped.format(count)} of ${grouped.format(PASTED_DESCRIPTION_MAX_LENGTH)} characters`,
  /** C-PD-9 */
  titleLabel: "Job title",
  /** C-PD-10 */
  companyLabel: "Company",
  /** C-PD-11 */
  namesHelp: "Needed unless the link is a Greenhouse, Lever or Ashby job. Eve uses what you type, not the text.",
  /** C-PD-12; the pending label stays "Checking…". */
  submit: "Check this job",
  /** C-PD-20 */
  nothing: "Paste a link or the job description.",
  /** C-PD-26: `{action}` inside C-ERR-2. */
  failedVerb: "check the job",
  error: PASTE_DESCRIPTION_ERROR_MESSAGES,
  result: {
    /** C-PD-30 */
    created: "Saved from your description. Eve is checking it.",
    /** C-PD-31 */
    employerPage: "Eve read the job from the employer's page and used that. Your description wasn't saved.",
    /** C-PD-32 */
    updated: "Your description is now on the Job Posting you already had. Eve is checking it again.",
    /** C-PD-33 */
    alreadyPasted: "You already have this Job Posting. Nothing changed.",
    /** C-PD-34 */
    hasApplication: "You already have an Application for this job. Its description, documents and ATS score are unchanged.",
    /** C-PD-35 */
    viewApplication: "Go to that Application",
    /** C-PD-36, `{date}` via `formatWatDate`. */
    waitingCost: (date: string) => `Saved. Eve checks it when paid automation resumes on ${date}, or sooner if the ceiling is raised.`,
    /** C-PD-37 */
    waitingInvitee: "Saved. It's checked once the person who runs your Eve turns on checks for you.",
    /** C-PD-38 */
    lookupFailed: "Eve couldn't read the employer's page, so it used your description. You'll apply to this one yourself.",
  },
} as const
