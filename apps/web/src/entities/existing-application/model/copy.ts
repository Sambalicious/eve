import { formatWatDate } from "@/shared/lib/format-wat"

/**
 * Copy from design-spec.r4.md, F1 step 6a and the catalogue (C-EXIST-1 to
 * C-EXIST-8, C-CONFIRM-2, C-VAL-EXIST-1, C-VAL-EXIST-2, the "Existing
 * application added." toast). Exact strings.
 */
export const existingApplicationCopy = {
  /** C-EXIST-4. */
  pageTitle: "Existing applications",
  pageDescription:
    "Jobs you applied to before Eve, so it never applies to them twice.",
  /** C-EXIST-1. */
  empty: {
    title: "No existing applications recorded",
    text: "Add every role you've already applied to so the assistant doesn't apply twice. If there are none, mark this step complete.",
  },
  /** C-EXIST-8. */
  notComplete:
    "Not marked complete. Automatic submission stays off until you mark it.",
  /** C-EXIST-2, `completedAt` shown as "17 Oct 2026". */
  completedOn: (completedAt: string) =>
    `Marked complete on ${formatWatDate(completedAt)}.`,
  markComplete: "Mark this step complete",
  /** C-CONFIRM-2. */
  confirm: {
    title: "Mark existing applications complete?",
    body: "This is needed before automatic submission can be turned on. You can still add more later.",
    confirm: "Mark complete",
    pending: "Marking complete…",
  },
  /** C-EXIST-5: form heading, mobile sheet title and the buttons that open or submit it. */
  addHeading: "Add existing application",
  addButton: "Add existing application",
  addPending: "Adding…",
  fields: {
    company: "Company",
    roleTitle: "Role",
    applicationUrl: "Employer application URL",
    requisitionId: "Requisition ID (optional)",
    appliedOn: "Date applied",
  },
  /** C-EXIST-6. */
  requisitionHelp: "Leave it empty if the posting didn't show one.",
  columns: {
    company: "Company",
    roleTitle: "Role",
    applicationUrl: "Employer application URL",
    requisitionId: "Requisition ID",
    appliedOn: "Date applied",
  },
  /** C-EXIST-7. */
  noRequisition: "None",
  added: "Existing application added.",
  /** C-EXIST-3, `appliedOn` of the stored record. */
  alreadyRecorded: (role: string, company: string, appliedOn: string) =>
    `You already recorded this application: ${role} at ${company}, applied ${formatWatDate(appliedOn)}. Nothing new was added.`,
  viewIt: "View it",
  /** C-VAL-EXIST-1, in the contract's field order. */
  empties: {
    company: "Enter the company.",
    roleTitle: "Enter the role.",
    applicationUrl: "Enter the employer application URL.",
    appliedOn: "Enter the date you applied.",
  },
  /** C-VAL-EXIST-2. */
  malformed: {
    applicationUrl: "Enter a full link that starts with https:// or http://.",
    appliedOn: "Enter a real date.",
    badRequest: "Check the employer application URL and the date applied.",
  },
  /** The `{action}` in C-ERR-2. */
  failedActions: {
    add: "add this application",
    complete: "mark this step complete",
  },
  /** The shared overlay close control's label (shared/ui sheet). */
  close: "Close",
} as const
