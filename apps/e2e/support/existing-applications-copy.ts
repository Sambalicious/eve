/**
 * Exact strings the Existing applications journeys assert, byte for byte, from
 * epics/active/EPIC-0001-job-application-assistant/design-spec.r4.md (2026-10-30
 * addendum, F1 step 6a, copy catalogue) and the Gherkin in
 * gherkin/daily-cap-and-duplicates.feature and activation-gate.feature.
 * Retyped here, not imported from apps/web, so a wrong product string fails.
 */
export const EXIST = {
  path: "/existing-applications",
  apiPath: "/v1/existing-applications",
  apiCompletePath: "/v1/existing-applications/complete",

  navGroup: "Setup",
  navItem: "Existing applications", // nav table, design-spec.r4.md:540

  title: "Existing applications", // C-EXIST-4 title
  description: "Jobs you applied to before Eve, so it never applies to them twice.", // C-EXIST-4 description
  docTitle: "Existing applications · Eve", // useDocumentTitle pattern

  emptyTitle: "No existing applications recorded", // C-EXIST-1 title
  emptyText: "Add every role you've already applied to so the assistant doesn't apply twice. If there are none, mark this step complete.", // C-EXIST-1 text
  notComplete: "Not marked complete. Automatic submission stays off until you mark it.", // C-EXIST-8
  completedOn: (date: string) => `Marked complete on ${date}.`, // C-EXIST-2
  markComplete: "Mark this step complete",

  confirmTitle: "Mark existing applications complete?", // C-CONFIRM-2
  confirmBody: "This is needed before automatic submission can be turned on. You can still add more later.",
  confirmCancel: "Cancel",
  confirmAction: "Mark complete",

  formHeading: "Add existing application", // C-EXIST-5 (heading and sheet title)
  submit: "Add existing application", // submit button and mobile opening button
  labels: { company: "Company", role: "Role", url: "Employer application URL", requisition: "Requisition ID (optional)", date: "Date applied" },
  requisitionHelp: "Leave it empty if the posting didn't show one.", // C-EXIST-6
  columns: ["Company", "Role", "Employer application URL", "Requisition ID", "Date applied"],
  noRequisition: "None", // C-EXIST-7

  added: "Existing application added.", // toast
  duplicate: (role: string, company: string, date: string) => `You already recorded this application: ${role} at ${company}, applied ${date}. Nothing new was added.`, // C-EXIST-3
  viewIt: "View it",

  // C-VAL-EXIST-1, contract field order (api-contract.md:103-106)
  missing: { company: "Enter the company.", role: "Enter the role.", url: "Enter the employer application URL.", date: "Enter the date you applied." },
  // C-VAL-EXIST-2
  badUrl: "Enter a full link that starts with https:// or http://.",

  // Activation Gate (C-GATE-6, C-GATE-7 retired)
  gateRow: "Jobs you've already applied to",
  gateHint: "Mark this either way. If you haven't applied anywhere yet, mark it complete.",
  gateHowTitle: "How this works",
  gateRowOld: "Existing applications marked complete",
  gate7Fragment: "You'll be able to add them here in a later update.",

  // Home setup checklist item 4 (F1 step 1)
  checklistItem: "Record existing applications and mark the step complete",
  checklistRequired: "Required for automatic submission",
} as const
