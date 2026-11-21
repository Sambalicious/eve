/**
 * FEAT-0017 copy, keyed by the copy deck's `C-AF-n` (copy-deck.md plus "Addendum r1"). Every visible
 * string in the added-facts feature comes from here; the keys in comments are the deck's.
 */

/** C-AF-1 and the ATS card's tick list. The label is the existing one. */
export const atsAddedCopy = {
  /** C-AF-1: the existing label; the count is appended by the card. */
  gapsLabel: "Not in your profile",
  /** C-AF-2. */
  hint: "Tick the ones you have used.",
  /** C-AF-3: the Affirmation. Same string in the card and the form. */
  affirmation: "I have done this in real work, a project or study. It is not something I plan to learn.",
  /** C-AF-4.one / C-AF-4.other. */
  addOne: (n: number) => `Add ${n} skill to this job`,
  addOther: (n: number) => `Add ${n} skills to this job`,
  add: (n: number) => (n === 1 ? atsAddedCopy.addOne(n) : atsAddedCopy.addOther(n)),
  /** C-AF-5. */
  clear: "Clear ticks",
  /** C-AF-6. */
  saveToProfile: "Also add to my Career Profile (needs your approval)",
  /** C-AF-7 r2: description, the term. The accessible name is the visible label, C-AF-6. */
  profileDescription: (term: string) => term,
  /** C-AF-9. */
  allAdded: "Every missing term is added for this job.",
  /** C-AF-10 / C-AF-11, one line, first five. */
  summary: (terms: string) => `Added for this job: ${terms}`,
  summaryMore: (n: number) => `and ${n} more`,
  /** C-AF-12. */
  manage: "Manage added facts",
  /** C-AF-13. */
  frozen: "Terms can't be ticked: this Application is locked.",
  /** C-AF-14. */
  busy: "Wait for the documents to finish, then tick terms.",
  /** C-AF-15. */
  stale: "This score is from before your added facts.",
  /** C-AF-22 / C-AF-23: the kind labels. */
  kind: { skillOnly: "skill only", oneLiner: "sentence" },
  /** C-AF-74: the accessible name of a tick row. */
  tickName: ", I have used this",
  /** C-AF-77. */
  groupLabel: "Terms not in your profile",
  /** C-AF-73.one / .other, after 600 ms of no change. */
  tickedOne: (n: number) => `${n} term ticked`,
  tickedOther: (n: number) => `${n} terms ticked`,
  /** C-AF-70.one / .other, once a save succeeds. */
  addedOne: (n: number) => `${n} skill added to this job`,
  addedOther: (n: number) => `${n} skills added to this job`,
} as const

export const addedFactsCopy = {
  /** C-AF-16. */
  heading: "Added for this job",
  /** C-AF-17. */
  description: "Things you have really done, for this job only.",
  /** C-AF-18. */
  addFact: "Add a fact",
  /** C-AF-19. */
  count: (n: number) => `${n} of 10 sentences`,
  /** C-AF-20. */
  emptyWithGaps: "Nothing added yet. Tick terms on the score card, or add a fact.",
  /** C-AF-21. */
  emptyNoList: "Terms from the posting appear after Eve writes the documents. You can add a fact now.",
  /** C-AF-24; `{role}` is "{title}, {employer}" in this slot. */
  role: (role: string) => `at ${role}`,
  /** C-AF-25. */
  term: (term: string) => `Posting term: ${term}`,
  /** C-AF-26 / C-AF-27. */
  used: "Used in the documents",
  unused: "Not used in the documents yet",
  /** C-AF-28.approved / C-AF-28.draft. */
  inProfileVersion: (version: number) => `also in Career Profile version ${version}`,
  inProfileDraft: "also in your Career Profile draft",
  /** C-AF-29, C-AF-30, C-AF-92, C-AF-93: the notes a profile-save outcome leaves on its row. */
  profilePartial: "Saved to this job only: your Career Profile draft is full.",
  profileDuplicate: "Already in your Career Profile.",
  profileDraftUnavailable: "Saved to this job only: your Career Profile can't take a draft right now.",
  profileFailed: "Saved to this job only: adding it to your Career Profile failed. You can add it there yourself.",
  /** C-AF-31 / C-AF-32 / C-AF-33. */
  edit: "Edit",
  addSentence: "Add a sentence",
  remove: "Remove",
  /** C-AF-34 / C-AF-35. */
  frozen: "Added facts are locked: this Application was submitted or marked complete.",
  busy: "Wait until the documents finish, then change facts.",
  /** C-AF-36. */
  outreachNote: "Texts you copy to send are written from your Career Profile only.",
  /** C-AF-37. */
  removeProfileNote: "Removing it here doesn't remove it from your Career Profile.",
  /** C-AF-39 to C-AF-49. */
  form: {
    titleAdd: "Add a fact",
    titleAddSentence: "Add a sentence",
    titleEdit: "Edit sentence",
    textLabel: "What you did",
    helper: "Say what you did and, if you can, with what and where. For example: Set up GitHub Actions CI/CD at Acme.",
    helperFromAlert: (term: string) => `The documents mentioned ${term}. If you have done this, say what you did.`,
    roleLabel: "Role",
    noRole: "Add a role to your Career Profile first. Sentences print under a role. Ticking terms still works.",
    goToProfile: "Go to Career Profile",
    chooseRole: "Choose a role",
    save: "Add fact",
    saving: "Adding…",
    editSave: "Save",
    editSaving: "Saving…",
    cancel: "Cancel",
    count: (n: number) => `${n} of 300`,
    about: (term: string) => `About ${term}`,
    regionLabel: { add: "Add a fact form", addSentence: "Add a sentence form", edit: "Edit sentence form" },
  },
  /** C-AF-50 to C-AF-59, plus the Addendum's `C-AF-59.characters`. */
  errors: {
    empty: "Write a sentence about what you did.",
    termNotInList: "That term is not in this job's list. The list is refreshed.",
    skillCeiling: "You can add up to 40 skills for one job.",
    aspiration: "Write only what you have done.",
    mustName: (term: string) => `Say what you did with ${term}.`,
    oneLinerLimit: "You can add up to 10 sentences for one job.",
    tooLong: (n: number) => `That is ${n} characters. The limit is 300.`,
    conflict: "This job's facts changed elsewhere. The list is refreshed. Check it, then save again.",
    network: "Eve couldn't save that. Nothing you entered was lost. Try again.",
    tryAgain: "Try again",
    contact: "Leave out emails, phone numbers, links and your address.",
    duplicate: "That is already added for this job.",
    duplicateTerm: (term: string) => `${term} is already added.`,
    role: "Choose a role.",
    affirm: "Tick the box to say you have done this.",
    frozen: "This Application is locked, so facts can't change.",
    busy: "Eve is writing the documents. Try again when they finish.",
    gone: "That fact is gone. The list is refreshed.",
    characters: "Remove hidden or control characters from this text.",
  },
  /** C-AF-60 / C-AF-61. */
  stale: {
    notice: "Your added facts changed after these documents were written. Regenerate to use them.",
    queue: "It won't be submitted automatically until you generate again.",
  },
  /** C-AF-62 to C-AF-68. */
  lift: {
    title: "Strong match with your added facts",
    coversHeading: "What lifted it",
    helper: "It joins the automatic queue. No new documents are written.",
    action: "Submit with your added skills",
    pending: "Confirming…",
    confirmed: "Confirmed. It joins the automatic queue.",
    staleReason: "Generate again first, so the documents match.",
    voided: "Your confirmation was cleared because the facts changed. Generate again, then confirm again.",
  },
  /** C-AF-69 to C-AF-73: the one live region. */
  announce: {
    formOpened: (term: string) => `Add a fact form opened for ${term}.`,
    saved: "Fact saved.",
    removed: "Fact removed.",
    removedTerm: (term: string) => `Fact removed. ${term} is back in the list.`,
  },
  /** C-AF-75, C-AF-76, C-AF-78, C-AF-79. */
  a11y: {
    listLabel: "Facts added for this job",
    kind: "Kind",
    role: "Role",
    noRoleReason: "Needs a role in your Career Profile first.",
  },
  /** C-AF-80 to C-AF-84. */
  match: {
    profile: (n: number, m: number) => `Match with your Career Profile: ${n}/${m}`,
    withAdded: (n: number, m: number) => `With the facts you added: ${n}/${m}`,
    skillOnly: "skill only",
    coverageHeading: "What your added facts cover",
    overrideNote: "The Override stays as you saw it. Your added facts now make it strong.",
  },
  /** C-AF-85 to C-AF-88. */
  sample: {
    marker: "Added skills used",
    heading: "Added facts in this sample",
    editLink: "Edit on the Application page",
    voided: "The facts changed, so this sample needs a new review.",
  },
  /** C-AF-89. */
  evidence: { heading: "Added facts used" },
} as const

/** "at Frontend Engineer, Acme Ltd" from the wire's snapshot. */
export function roleLabel(role: { title: string; employer: string | null }): string {
  return role.employer === null || role.employer === "" ? role.title : `${role.title}, ${role.employer}`
}

/** "{title} at {employer}" for the role picker (C-AF-46's options). */
export function roleOptionLabel(role: { title: string; employer: string | null }): string {
  return role.employer === null || role.employer === "" ? role.title : `${role.title} at ${role.employer}`
}
