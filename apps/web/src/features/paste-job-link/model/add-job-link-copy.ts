/**
 * "Add a job link" strings, byte for byte: the dialog's title, its trigger's
 * name, the field label and the help line, which is the dialog's description.
 * The help has no copy-deck slot: it stays a proposal, with no automation or
 * Manual Application wording.
 */
export const addJobLinkCopy = {
  /** The dialog title and its trigger's name. */
  title: "Add a job link",
  /** The field's label, read by assistive tech. */
  label: "Job link",
  help: "Paste a link to a job. Eve checks how well it fits your profile.",
} as const
