import type { CoverLetterStatus, DocumentFailure, DocumentKind } from "./application"

/** The two words the blocked copy substitutes for `{document}` (copy deck: lower case, mid-sentence). */
export type BlockedDocumentLabel = "resume" | "cover letter"

/** Copy from design-spec.r4.md (F5, C-DOC-1 to C-DOC-31, status vocabulary). Exact strings. */
export const applicationCopy = {
  documentsHeading: "Documents",
  documentsPageTitle: "Documents",
  applicationsBreadcrumb: "Applications",
  tabs: { resume: "Resume", cover_letter: "Cover letter" } satisfies Record<DocumentKind, string>,
  downloadPdf: "Download PDF",
  downloadDocx: "Download DOCX",
  openPdf: "Open PDF",
  /** Header item, AC 5.1 r2. */
  profileVersion: (n: number) => `Profile version ${n}`,
  /** C-DOC-1, C-DOC-2. */
  coverLetterUploaded: "Uploaded with the Application.",
  coverLetterNotUploaded: "Not uploaded. The form had no cover letter field. Stored here for your records.",
  /** Short forms for the Documents table. */
  coverLetterShort: { uploaded: "Uploaded", no_field: "Not uploaded" },
  /** C-DOC-3 (EPIC-0009): the reason, the flagged terms and the blocked text. Copy: copy-deck.md. */
  blocked: {
    title: "Document blocked",
    /** One message per cause (OD-1); `fallback` for a row blocked before this release or an unknown cause. */
    reason: {
      unsupportedTerms: (document: BlockedDocumentLabel) =>
        `Part of the ${document} claims more than the facts it cites can back up, so the Application didn't go ahead.`,
      numberOrder: (document: BlockedDocumentLabel) =>
        `Part of the ${document} has numbers that don't all come from one cited fact, in that fact's order, so the Application didn't go ahead.`,
      noFact: (document: BlockedDocumentLabel) =>
        `Part of the ${document} cited no Career Profile fact, so nothing backs up what it says. The Application didn't go ahead.`,
      contactDetail: (document: BlockedDocumentLabel) =>
        `Part of the ${document} included contact details, and Eve adds those only in its header. The Application didn't go ahead.`,
      namesTarget: (document: BlockedDocumentLabel) =>
        `Part of the ${document} named the employer or the role, and Eve writes those names itself. The Application didn't go ahead.`,
      unknownFact: (document: BlockedDocumentLabel) =>
        `Part of the ${document} cited a fact that wasn't among the approved facts Eve wrote from. The Application didn't go ahead.`,
      notConfirmed: (document: BlockedDocumentLabel) =>
        `Eve couldn't confirm the meaning of this part of the ${document}, so the Application didn't go ahead. A new run can give a different result.`,
      fallback: (document: BlockedDocumentLabel) =>
        `The ${document} didn't pass one of Eve's checks, so the Application didn't go ahead. This page can't say which one.`,
    },
    /** Neutral: one label covers eight rules, and three of them may name a word the facts do contain. */
    termsLabel: { one: "Flagged by Eve", other: "Flagged by Eve" },
    /** Every number in the text is listed here, not only the out-of-order ones. */
    numbersLabel: { one: "Number Eve checked", other: "Numbers Eve checked" },
    overflow: {
      one: (count: number) => `${count} flagged item isn't shown.`,
      other: (count: number) => `${count} flagged items aren't shown.`,
    },
    claimLabel: "The part that was blocked",
  },
  /** C-DOC-4. */
  empty: {
    title: "No Tailored Documents yet",
    text: "Each Application gets its own resume and cover letter, generated from your approved Career Profile.",
  },
  /** C-DOC-5 to C-DOC-8: status badges. */
  badge: {
    draft: "Draft",
  },
  /** C-DOC-11: label, and the accessible name with the posting. */
  prepare: "Prepare documents",
  prepareFor: (role: string, company: string) => `Prepare documents for ${role} at ${company}`,
  /** Apply anyway: the same action on a skipped or excluded posting. */
  prepareAnyway: "Prepare documents anyway",
  prepareAnywayFor: (role: string, company: string) => `Prepare documents anyway for ${role} at ${company}`,
  /** C-DOC-12. */
  noDocumentsYet: "No documents yet. Generate a resume and cover letter for this posting from your approved Career Profile.",
  /** C-DOC-13. */
  generate: "Generate documents",
  generateAgain: "Generate again",
  starting: "Starting…",
  /** C-DOC-14. */
  writing: "Writing your resume and cover letter. This usually takes under a minute.",
  /** C-DOC-15. */
  emptyTab: (kind: DocumentKind) => `No ${kind === "resume" ? "resume" : "cover letter"} for this Application yet.`,
  /** C-DOC-16. */
  previewFailed: "The preview couldn't load. The downloads below still work.",
  /** C-DOC-17. */
  coverLetterStatusHeader: "Cover letter status",
  /** C-DOC-30 and C-DOC-31. */
  contactMissing: "Add your name to your contact details before generating documents. Nothing was sent.",
  addContactDetails: "Add contact details",
  /** Same as the contract's application_not_eligible message. */
  notEligible: "This Job Posting is still being checked or couldn't be checked, so it can't become an Application yet.",
  notFound: {
    title: "Not found",
    text: "This Application doesn't exist or its records were cleared.",
  },
} as const

/**
 * Apply anyway, bounds and consent: copy-deck-apply-anyway.md, byte for byte.
 * Keys follow the deck (`C-AA-n`, deck key in the comment). `{reason}` short
 * forms come from the deck's reason mapping (`overrideReasonShort`).
 */
export const overrideCopy = {
  /** C-AA-3 `posting.anyway.dialog.title`. */
  dialogTitle: "Apply to this posting anyway?",
  /**
   * v1.28.0 manual lane: the same flow where nothing is being overridden. Eve cannot submit
   * through the employer's system, so it prepares the documents and the Candidate applies there.
   */
  manualDialogTitle: "Prepare documents for a manual application?",
  manualReasonLead: "Eve can't submit to this employer's system, so you apply on their site. Eve will prepare:",
  manualBound: "Eve never sends or queues a manual application. The documents use only facts from your profile, as always.",
  manualConfirm: "Prepare documents",
  manualActionLabel: "Prepare documents",
  /** C-AA-4 `posting.anyway.dialog.reasonLead`. */
  reasonLead: "You're overriding this reason:",
  /** C-AA-5 `posting.anyway.dialog.autoSend`: `{cap}` from `SubmissionStatus.cap`; the deck's no-cap form while it is unknown. */
  autoSend: (cap: number | null) =>
    cap === null
      ? "Eve may send this Application automatically. It counts toward the daily cap like any other."
      : `Eve may send this Application automatically. It counts toward the daily cap of ${cap} automatic submissions.`,
  /** C-AA-6 `posting.anyway.dialog.bound`. */
  bound: "This covers only the reason above. If the posting's decision changes, Eve won't send it automatically.",
  /** C-AA-7 `posting.anyway.dialog.confirm`. */
  confirm: "Prepare anyway",
  /** C-AA-8 `posting.anyway.dialog.pending`. */
  pending: "Preparing…",
  /** C-AA-13 `posting.anyway.actionPhrase`, for C-ERR-2. */
  actionPhrase: "prepare the Application",
  /** C-AA-14 `application.override.becameRanked`. */
  becameRanked: "This posting is now ranked, so Eve prepared it normally. No override was recorded.",
  /** C-AA-15 `application.override.badge`. */
  badge: "Override",
  /** C-AA-16 `application.override.label`. */
  label: "Override",
  /** C-AA-17 `application.override.value`. */
  value: (date: string, reason: string) => `Chosen on ${date} despite ${reason}`,
  /** C-AA-18 `application.override.legacyValue`. */
  legacyValue: (date: string) => `Chosen on ${date}. The reason wasn't recorded.`,
  /** C-AA-20 `application.override.inactive.title`. */
  inactiveTitle: "This override no longer applies",
  /** C-AA-21 / C-AA-38 / C-AA-39, by `notAppliesReason` (C-AA-21 is also the fallback). */
  inactiveBody: {
    decision_changed: "The posting's decision changed after you chose this, so Eve won't send it automatically. Decide again from the posting.",
    hidden: "The posting is now hidden from your board, so Eve won't send this Application automatically.",
    legacy_no_decision:
      "You chose this before Eve recorded reasons, so Eve won't send it automatically. Decide again from the posting to confirm the current reason.",
  },
  /** C-AA-22 `application.override.inactive.link`. */
  inactiveLink: "Open the posting",
  /** C-AA-40 `application.dropped.closed`, with its no-date form. */
  droppedClosed: (date: string | null) =>
    date
      ? `Left the automatic queue on ${date} because the posting closed. Nothing was sent, and its documents are kept.`
      : "Left the automatic queue because the posting closed. Nothing was sent, and its documents are kept.",
  /** C-AA-41 `application.dropped.notSubmittable`, with its no-date form. */
  droppedNotSubmittable: (date: string | null) =>
    date
      ? `Left the automatic queue on ${date} because the posting no longer qualifies. Nothing was sent, and its documents are kept.`
      : "Left the automatic queue because the posting no longer qualifies. Nothing was sent, and its documents are kept.",
  /** C-AA-36 `sample.result.notRanked`. */
  sampleNotRanked: "Not submitted. This Job Posting isn't ranked any more, so nothing was sent.",
  /** C-AA-37 `api.error.sample_not_allowed` (also the contract message). */
  sampleNotAllowed: "An Application with an override, or for a Job Posting that isn't ranked, can't be an Activation Gate sample. Nothing changed.",
  queue: {
    /** C-AA-23 `application.queue.remove.button`. */
    remove: "Remove from queue",
    /** C-AA-24 `application.queue.remove.name`. */
    removeFor: (role: string, company: string) => `Remove from queue for ${role} at ${company}`,
    /** C-AA-25. */
    dialogTitle: "Remove from the automatic queue?",
    /** C-AA-26. */
    dialogBody:
      "Eve won't send this Application automatically. Its documents, answers and any override are kept. You can't queue it again in Eve, but you can still apply on the employer's site.",
    /** C-AA-27. */
    confirm: "Remove from queue",
    /** C-AA-28. */
    pending: "Removing…",
    /** C-AA-29. */
    success: "Removed from the queue. Nothing was sent, and its documents are kept.",
    /** C-AA-30. */
    conflict: "It already left the queue, so it can't be removed. Its status shows where it is now.",
    /** C-AA-31, for C-ERR-2. */
    actionPhrase: "remove it from the queue",
  },
} as const

/** The stored decision an override covers (`ApplicationSummary.override` stored fields). */
export interface OverrideReasonInput {
  readonly status: "skipped" | "excluded" | null
  readonly skipReason: string | null
  readonly skipDetail: string | null
  readonly violatedRules: readonly string[] | null
}

/**
 * Deck reason mapping, `{reason}` short form for C-AA-17: C-SKIP-4, C-SKIP-4a,
 * C-AA-19 (`override.reason.uncovered`) and C-SKIP-1 with industry. Null for a
 * legacy override (no stored decision) or a decision outside the mapping.
 */
export function overrideReasonShort(o: OverrideReasonInput): string | null {
  if (o.status === "skipped") {
    if (o.skipReason === "weak_core_match") return "your profile backing too few of the core responsibilities"
    if (o.skipReason === "no_core_responsibilities") return "no core responsibilities found"
    if (o.skipReason === "uncovered_mandatory_prerequisite") {
      return o.skipDetail ? `your profile not showing a required prerequisite "${o.skipDetail}"` : "your profile not showing a required prerequisite"
    }
  }
  if (o.status === "excluded") {
    return o.skipDetail ? `the posting not fitting your ${overrideRuleInline(o.skipDetail)} rule` : "the posting not fitting one of your rules"
  }
  return null
}

const OVERRIDE_RULE_INLINE: Readonly<Record<string, string>> = {
  location: "location",
  sponsorship: "sponsorship",
  pay: "pay",
  hours: "hours",
  industry: "industry",
  seniority: "seniority",
  employment_type: "employment type",
}

function overrideRuleInline(rule: string): string {
  return OVERRIDE_RULE_INLINE[rule] ?? rule
}

/** Cover letter line under its tab, or null before submission (slice 5 sets it). */
export function coverLetterLine(status: CoverLetterStatus): string | null {
  if (status === "uploaded") return applicationCopy.coverLetterUploaded
  if (status === "no_field") return applicationCopy.coverLetterNotUploaded
  return null
}

/** What the Candidate can do about a failure: generate again, or follow a link. */
export type FailureAction =
  | { readonly kind: "generate" }
  | { readonly kind: "link"; readonly label: string; readonly to: string }
  | { readonly kind: "none" }

export interface FailureCopy {
  readonly line: string
  /** Muted second line (C-DOC-28 only). */
  readonly detail: string | null
  readonly action: FailureAction
}

const GENERATE: FailureAction = { kind: "generate" }

/** C-DOC-20 to C-DOC-29 (design-spec.r4.md), one per `failure` value. */
export const documentFailureCopy: Record<DocumentFailure, FailureCopy> = {
  not_approved: {
    line: "Documents weren't generated: Anthropic isn't approved, so nothing was sent.",
    detail: null,
    action: { kind: "link", label: "Review and approve", to: "/privacy#ai-provider" },
  },
  not_configured: {
    line: "Documents weren't generated: the Anthropic API key is missing on the server, so nothing was sent. Add it to the server's environment, then generate again.",
    detail: null,
    action: { kind: "none" },
  },
  provider_error: { line: "Documents weren't generated: Anthropic didn't answer. Try again in a few minutes.", detail: null, action: GENERATE },
  invalid_output: {
    line: "Documents weren't generated: Anthropic's reply couldn't be turned into a resume and cover letter, so nothing was kept. Generate again.",
    detail: null,
    action: GENERATE,
  },
  timed_out: { line: "Documents weren't generated: Anthropic took too long. Try again in a few minutes.", detail: null, action: GENERATE },
  no_career_profile: {
    line: "Documents weren't generated: you don't have an approved Career Profile yet.",
    detail: null,
    action: { kind: "link", label: "Go to Career Profile", to: "/profile" },
  },
  render_check_failed: {
    line: "Documents weren't generated: the PDF's text didn't match what was written, so it wasn't kept. Generate again.",
    detail: null,
    action: GENERATE,
  },
  storage_error: {
    line: "Couldn't save your documents on the server. Nothing was lost; try again later.",
    detail: "Your Career Profile and this posting are fine. The server's storage needs fixing, so another try may fail the same way until it is.",
    action: GENERATE,
  },
  interrupted: {
    line: "Documents weren't generated: the server restarted while they were being written. Nothing was lost.",
    detail: null,
    action: GENERATE,
  },
}

/** C-DOC-27: any failure without its own copy, including `documents_failed` with no reason. */
export const UNKNOWN_FAILURE: FailureCopy = { line: "Documents weren't generated. Generate again.", detail: null, action: GENERATE }

export function failureCopy(failure: DocumentFailure | null): FailureCopy {
  return (failure && documentFailureCopy[failure]) ?? UNKNOWN_FAILURE
}
