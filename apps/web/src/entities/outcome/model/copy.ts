import type { OutcomeType } from "./outcome"

/** Outcome copy from design-spec.r4.md (F9, Outcomes list, Record Outcome dialog, status vocabulary, C-OUT-1). Exact strings. */
export const outcomeCopy = {
  heading: "Outcomes",
  record: "Record Outcome",
  edit: "Edit",
  save: "Save Outcome",
  saving: "Saving…",
  typeLabel: "Outcome type",
  recordedByYou: "Recorded by you",
  /** C-OUT-1. */
  empty: "No Outcomes yet.",
  saved: "Outcome saved.",
  /** Badge labels (status vocabulary). */
  type: {
    confirmation: "Confirmation",
    rejection: "Rejection",
    interview_invitation: "Interview invitation",
    request_for_action: "Request for action",
    offer: "Offer",
  } satisfies Record<OutcomeType, string>,
  /** Select options (Record Outcome dialog). */
  option: {
    confirmation: "Confirmation",
    rejection: "Rejection",
    interview_invitation: "Interview invitation",
    request_for_action: "Request for action",
    offer: "Offer",
  } satisfies Record<OutcomeType, string>,
} as const
