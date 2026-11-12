import { formatWatDate } from "@/shared/lib/format-wat"

/**
 * Copy from design-spec.r4.md (C-SRC-*, C-CONFIRM-20, C-VAL-SRC-1) and the
 * EPIC-0009 copy deck (C-EH-VERIFY-*, C-EH-SRC-*, revised C-SRC-3). Exact strings.
 */
export const jobSourceCopy = {
  employerListHeading: "Employer list",
  /** C-SRC-5. */
  employerListHelp:
    "Companies on Greenhouse, Lever or Ashby that hire senior frontend or lead roles remotely. The assistant checks their job boards every morning once you approve the list.",
  /** C-SRC-6. */
  notApproved: "Not approved yet. The daily 08:00 WAT discovery stays off until you approve this list. Pasted links still work.",
  /** C-SRC-7. */
  approved: (approvedAt: string, n: number) =>
    `Approved on ${formatWatDate(approvedAt)}. Discovery checks these ${n} companies every day at 08:00 WAT.`,
  companyCount: (n: number) => `${n} companies`,
  approveButton: "Approve employer list",
  /** C-CONFIRM-20. */
  confirm: {
    title: "Approve this employer list?",
    body: (n: number) =>
      `The assistant will check these ${n} companies' job boards every day at 08:00 WAT and apply to eligible, strong-Match roles under your rules.`,
    confirm: "Approve list",
  },
  /** C-SRC-9. */
  approvedToast: "Employer list approved. Discovery starts at 08:00 WAT.",
  /** C-SRC-8 and its link. */
  discoveryOff: "Daily discovery is off until you approve the employer list.",
  reviewTheList: "Review the list",
  nextDiscovery: "Next discovery: 08:00 WAT",
  remoteBoardsHeading: "Remote-job boards",
  remoteBoardType: "Remote-job board",
  /** C-SRC-2 and C-SRC-4. */
  verified: (date: string, basis: string) => `Verified ${formatWatDate(date)}: ${basis}`,
  notVerified: "Not verified",
  /** C-EH-SRC-HELP (EPIC-0009 copy deck): the Remote-job boards section description. */
  remoteBoardsHelp: 'Each board must be verified before you can enable it. "Mark verified" records that you checked its terms.',
  /** The Remote-job boards section (i) popover (EPIC-0009, C-EH-SRC-WHY-*). */
  remoteBoardsWhy: {
    /** C-EH-SRC-WHY-TRIGGER-SR. */
    triggerSr: "Why verify a board first",
    /** C-EH-SRC-WHY-TITLE. */
    title: "Why boards need verifying first",
    /** C-EH-SRC-WHY-P1. */
    p1: "Eve reads each enabled board by itself every day. A site's terms can forbid that kind of automatic reading, so you check the terms first and note what you found.",
    /** C-EH-SRC-WHY-P2. */
    p2: "Once a board is verified, you can enable it. Eve then reads it in the daily 08:00 WAT discovery, which runs once you approve the employer list.",
    /** C-EH-SRC-WHY-NOTE. */
    note: "Eve doesn't check the terms for you. The record notes what you found. It isn't legal advice.",
  },
  /** C-SRC-3 (revised, EPIC-0009 copy deck). */
  enableRefused: "Verify this board before you enable it. Eve reads only verified boards.",
  markVerified: "Mark verified",
  verifyDialog: {
    date: "Verification date",
    basis: "Basis for permitted use",
    /** C-VAL-SRC-1. */
    dateMissing: "Enter the verification date.",
    basisMissing: "Enter the basis for permitted use.",
    /** C-EH-VERIFY-DESC (EPIC-0009 copy deck): the dialog description. */
    description:
      "Once enabled, Eve reads this board on its own every day. Its terms need to allow that. Saving here records that you checked them.",
    /** C-EH-VERIFY-BASIS-HELP: the help line under the basis field. */
    basisHelp: 'Where you checked and what it says, for example "Terms page, section 4 allows API use with credit."',
    /** The dialog's (i) popover (C-EH-VERIFY-WHY-*). */
    why: {
      /** C-EH-VERIFY-WHY-TRIGGER-SR. */
      triggerSr: "Why Eve asks you to verify",
      /** C-EH-VERIFY-WHY-TITLE. */
      title: "Why Eve needs this record",
      /** C-EH-VERIFY-WHY-P1. */
      p1: "A site's terms can forbid programs from reading it automatically. Eve won't read this board until you save this record.",
      /** C-EH-VERIFY-WHY-P2. */
      p2: "The record notes the date and what you checked, so you can look back later. It covers only this board.",
      /** C-EH-VERIFY-WHY-EXAMPLES. */
      examplesLead: "Examples of a basis",
      /** C-EH-VERIFY-WHY-EX-1, C-EH-VERIFY-WHY-EX-2 and C-EH-VERIFY-WHY-EX-3, in order. */
      examples: [
        'A terms page and its section: "Terms page, section 4 allows API use with credit."',
        'A permission email: "Email from support, 27 Oct 2026, says daily reading is OK."',
        'A public feed or API policy: "API policy page allows public feed use."',
      ],
      /** C-EH-VERIFY-WHY-NOTE. */
      note: "These show how to write a basis. They don't mean any board allows it. Eve doesn't check terms for you, and this isn't legal advice.",
    },
  },
} as const
