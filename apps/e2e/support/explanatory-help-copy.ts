/**
 * EPIC-0009 explanatory help strings, byte for byte from
 * epics/active/EPIC-0009-explanatory-help/copy-deck.md (C-EH-*, revised C-SRC-3)
 * and the built strings the help sits next to (jobSourceCopy on 91109b4,
 * C-ERR-2). Tests compare against these, never against the web app's copy
 * objects, so a wrong string in the product fails the test.
 */
export const EH = {
  // S1. Mark verified dialog
  verifyDesc:
    "Once enabled, Eve reads this board on its own every day. Its terms need to allow that. Saving here records that you checked them.", // C-EH-VERIFY-DESC
  verifyTrigger: "Why Eve asks you to verify", // C-EH-VERIFY-WHY-TRIGGER-SR
  verifyTitle: "Why Eve needs this record", // C-EH-VERIFY-WHY-TITLE
  verifyP1: "A site's terms can forbid programs from reading it automatically. Eve won't read this board until you save this record.", // C-EH-VERIFY-WHY-P1
  verifyP2: "The record notes the date and what you checked, so you can look back later. It covers only this board.", // C-EH-VERIFY-WHY-P2
  verifyExamples: "Examples of a basis", // C-EH-VERIFY-WHY-EXAMPLES
  verifyEx1: 'A terms page and its section: "Terms page, section 4 allows API use with credit."', // C-EH-VERIFY-WHY-EX-1
  verifyEx2: 'A permission email: "Email from support, 27 Oct 2026, says daily reading is OK."', // C-EH-VERIFY-WHY-EX-2
  verifyEx3: 'A public feed or API policy: "API policy page allows public feed use."', // C-EH-VERIFY-WHY-EX-3
  verifyNote: "These show how to write a basis. They don't mean any board allows it. Eve doesn't check terms for you, and this isn't legal advice.", // C-EH-VERIFY-WHY-NOTE
  verifyBasisHelp: 'Where you checked and what it says, for example "Terms page, section 4 allows API use with credit."', // C-EH-VERIFY-BASIS-HELP
  /** The one example basis inside C-EH-VERIFY-BASIS-HELP (AC-2). */
  verifyBasisHelpExample: "Terms page, section 4 allows API use with credit.",

  // S2. Job Sources, Remote-job boards
  srcHelp: 'Each board must be verified before you can enable it. "Mark verified" records that you checked its terms.', // C-EH-SRC-HELP
  srcTrigger: "Why verify a board first", // C-EH-SRC-WHY-TRIGGER-SR
  srcTitle: "Why boards need verifying first", // C-EH-SRC-WHY-TITLE
  srcP1:
    "Eve reads each enabled board by itself every day. A site's terms can forbid that kind of automatic reading, so you check the terms first and note what you found.", // C-EH-SRC-WHY-P1
  srcP2:
    "Once a board is verified, you can enable it. Eve then reads it in the daily 08:00 WAT discovery, which runs once you approve the employer list.", // C-EH-SRC-WHY-P2
  srcNote: "Eve doesn't check the terms for you. The record notes what you found. It isn't legal advice.", // C-EH-SRC-WHY-NOTE
  enableRefused: "Verify this board before you enable it. Eve reads only verified boards.", // C-SRC-3 (revised)

  // S3. Hiring view
  hiringLine:
    "Eve doesn't open or read LinkedIn, so it can't find LinkedIn posts that match your job criteria by itself. The sections below help you find them.", // C-EH-HIRING-LINE
  hiringTrigger: "Why Eve doesn't show LinkedIn posts", // C-EH-HIRING-WHY-TRIGGER-SR
  hiringTitle: "Why Eve can't read LinkedIn", // C-EH-HIRING-WHY-TITLE
  hiringReason: "LinkedIn's terms restrict automated access, so Eve never sends a request to linkedin.com.", // C-EH-HIRING-WHY-REASON
  hiringWays: "Three ways to find them", // C-EH-HIRING-WHY-WAYS
  hiringLinks: "Hiring search links open LinkedIn and Google searches in your own browser, where you're signed in. Eve doesn't see the results.", // C-EH-HIRING-WHY-LINKS
  hiringLinksGo: "Go to Hiring search links", // C-EH-HIRING-WHY-LINKS-GO
  hiringCheck: "Check this job needs the employer's application link from a post, not the post link. Eve checks it with your usual rules.", // C-EH-HIRING-WHY-CHECK
  hiringCheckGo: "Go to Check this job", // C-EH-HIRING-WHY-CHECK-GO
  hiringFeeds:
    "Hiring alert feeds bring in short previews of posts Google Alerts found. Eve reads them four times a day, only after you confirm you may use these feeds. They miss some posts, and Eve hasn't vetted them.", // C-EH-HIRING-WHY-FEEDS
  hiringFeedsGo: "Go to Hiring alert feeds", // C-EH-HIRING-WHY-FEEDS-GO

  // Shared
  popoverClose: "Close help", // C-EH-POPOVER-CLOSE
} as const

/** jobSourceCopy strings on origin/main 91109b4 that EPIC-0009 must keep byte for byte (AC-8, AC-18). */
export const SRC = {
  pageTitle: "Job Sources",
  sectionTitle: "Remote-job boards",
  boardType: "Remote-job board",
  notVerified: "Not verified",
  verified: (date: string, basis: string) => `Verified ${date}: ${basis}`, // C-SRC-2 (date as formatWatDate)
  oldEnableRefused: "Verify this Job Source for permitted use before enabling it.", // C-SRC-3 before EPIC-0009: must be gone
  markVerified: "Mark verified",
  dialogTitle: (board: string) => `Mark verified: ${board}`,
  dateLabel: "Verification date",
  basisLabel: "Basis for permitted use",
  dateMissing: "Enter the verification date.", // C-VAL-SRC-1
  basisMissing: "Enter the basis for permitted use.", // C-VAL-SRC-1
  cancel: "Cancel",
  enabled: "Enabled",
  verifyFailed: "Couldn't mark this Job Source verified. Nothing changed. Try again.", // C-ERR-2 via toastActionFailed
  loadError: "Couldn't load this page.", // C-ERR-1 (LoadErrorAlert default)
  retry: "Try again", // C-ERR-1 retry
} as const

/** The three help surfaces (help-accessibility-and-invariants.feature header). */
export type Surface = "verify" | "sources" | "hiring"

export const SURFACES: Readonly<Record<Surface, { trigger: string; title: string; line: string }>> = {
  verify: { trigger: EH.verifyTrigger, title: EH.verifyTitle, line: EH.verifyDesc },
  sources: { trigger: EH.srcTrigger, title: EH.srcTitle, line: EH.srcHelp },
  hiring: { trigger: EH.hiringTrigger, title: EH.hiringTitle, line: EH.hiringLine },
}

/** Every new user-visible EPIC-0009 string (C-EH-* and the revised C-SRC-3). */
export const ALL_HELP_STRINGS: readonly string[] = Object.entries(EH)
  .filter(([key]) => key !== "verifyBasisHelpExample")
  .map(([, value]) => value)

/** AC-19 forbidden phrases (help-accessibility-and-invariants.feature, "An automated copy check rejects forbidden phrases"). */
export const FORBIDDEN_PHRASES = ["is permitted", "are permitted", "Eve checked", "Eve verified", "we checked", "this is legal advice"] as const

/** The forbidden phrases found in `text`, case-insensitively. */
export function forbiddenIn(text: string): string[] {
  const folded = text.toLowerCase()
  return FORBIDDEN_PHRASES.filter((phrase) => folded.includes(phrase.toLowerCase()))
}

/** PRD Q2 / architecture: help may never say who else sees the recorded basis. */
export const OWNERSHIP_CLAIMS = [/\bonly you\b/i, /\byours\b/i, /\byour boards\b/i, /\bshared\b/i, /\banyone\b/i] as const

export function ownershipClaimsIn(text: string): string[] {
  return OWNERSHIP_CLAIMS.filter((pattern) => pattern.test(text)).map(String)
}
