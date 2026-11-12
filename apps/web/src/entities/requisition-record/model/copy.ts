/**
 * Deletion copy from design-spec.r4.md (F10, C-DATA-2 to 6, C-CONFIRM-11 to 13,
 * C-EMPTY-6). Exact strings. C-DATA-1 is retired by slice 9: the Retention
 * section uses C-RET-1 from `@/entities/retention`.
 */
export const recordCopy = {
  recordsHeading: "Minimal requisition records",
  /** C-DATA-2. */
  recordsHelp:
    "After detailed records are deleted, a minimal record (company, URL, requisition ID, date, final status) stays so the assistant never applies to the same requisition twice. Clear it to allow a new Application.",
  /** C-DATA-3. */
  deletedOn: (date: string) => `Detailed records were deleted on ${date}. This minimal record still blocks duplicate Applications.`,
  /** C-DATA-6: an email link to an Application whose detailed records were deleted. */
  emailLinkDeleted: (date: string) => `The documents and answers for this Application were deleted on ${date}.`,
  /** C-DATA-4. */
  deletedToast: (n: number) => `Detailed records deleted for ${n} Application(s).`,
  /** C-DATA-5. */
  clearedToast: "Record cleared. This requisition is no longer blocked.",
  /** C-EMPTY-6. */
  empty: "No minimal records.",
  columns: { company: "Company", url: "URL", requisitionId: "Requisition ID", date: "Date", finalStatus: "Final status" },
  clear: "Clear",
  clearRecord: "Clear record",
  clearing: "Clearing…",
  deleteDetails: "Delete detailed records",
  deleteDetailsCount: (n: number) => `Delete detailed records (${n})`,
  deleting: "Deleting…",
  /** OPEN[designer]: no copy yet for a later batch of a bulk deletion failing. */
  restNotDeleted: "Couldn't delete the rest of the detailed records. Try again.",
  moreActions: "More actions",
  /** C-CONFIRM-11. */
  confirmOne: {
    title: "Delete detailed records?",
    body: (role: string, company: string) =>
      `This deletes the Application record, documents, answers and Outcomes for ${role} at ${company}. A minimal record stays to prevent duplicates. This can't be undone.`,
    confirm: "Delete records",
  },
  /** C-CONFIRM-12. */
  confirmBulk: {
    title: (n: number) => `Delete detailed records for ${n} Applications?`,
    body: "Documents, answers and Outcomes are deleted. Minimal records stay to prevent duplicates. This can't be undone.",
    confirm: "Delete records",
  },
  /** C-CONFIRM-13. */
  confirmClear: {
    title: "Clear this record?",
    body: (requisitionId: string, company: string) => `The assistant could then apply to requisition ${requisitionId} at ${company} again.`,
    confirm: "Clear record",
  },
} as const
