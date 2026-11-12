/** Approved Answers copy from design-spec.r3.md, copy catalogue. Exact strings. */
export const approvedAnswerCopy = {
  pageTitle: "Form answers",
  emptyTitle: "No Approved Answers yet", // C-ANS-1
  emptyText: "A required question without an Approved Answer blocks the Application. Add the ones you know now.",
  addAnswer: "Add answer",
  sensitiveHelp:
    "Used only where a form asks. If a sensitive question has no answer here, the Application is blocked. Nothing is inferred.", // C-ANS-2
  grossHelp:
    "Entered when a form asks for expected gross salary. Questions this policy doesn't cover block the Application.", // C-ANS-3
  netHelp: "Your target take-home pay. Kept for reference and never entered into a gross-salary field.", // C-ANS-4
  currentHelp: "Leave empty to keep it private. Forms that require it will be blocked.", // C-ANS-5
  currentEmpty: "Not approved. Forms that require it will be blocked.",
  grossEmpty: "No policy yet. Forms that ask for expected gross salary will be blocked.", // C-ANS-7
  netEmpty: "Not set. It's only for your reference, so nothing is blocked without it.", // C-ANS-8
  emptyValue: "Enter an answer.", // C-VAL-ANS-1
  emptySkill: "Enter the skill.", // C-VAL-ANS-3
  badLink: "Enter each link on its own line, starting with https:// or http://.", // C-VAL-ANS-4
  answerExists: "You already have an Approved Answer for this question. Edit that one instead.", // C-ANS-6
  editExisting: "Edit it", // C-ANS-6 link
  profileLinksHelp: "One link per line, for example your GitHub and LinkedIn.", // C-ANS-9
  relocationLegend: "Are you willing to relocate?", // C-ANS-10
  relocationOptions: ["Yes, with employer visa sponsorship", "No"], // C-ANS-10
  lastEdited: (date: string) => `Last edited ${date}`, // C-ANS-11
  emptyQuestion: "Enter the question as the form asks it.", // C-VAL-ANS-2
  confirmDelete: {
    title: "Delete this Approved Answer?",
    body: "Forms that ask this question will be blocked until you add it again.",
    confirm: "Delete answer",
  }, // C-CONFIRM-14
  saved: "Saved.",
  saveAnswer: "Save answer",
  cancel: "Cancel",
  edit: "Edit",
  delete: "Delete",
  grossCardTitle: "Gross-salary policy",
  currentCardTitle: "Current salary",
  netCardTitle: "Preferred pay (net)",
  netBadge: "Never entered into a form",
  perYear: "per year",
  perMonth: "per month",
  perMonthNet: "per month net",
} as const
