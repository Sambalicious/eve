/** Copy deck: Shell and navigation (nav.*, needs.*). Labels marked PROPOSAL in the deck stay editable here. */
export const navCopy = {
  item: {
    home: "Home",
    jobs: "Jobs",
    findJobs: "Find jobs",
    applications: "Applications",
    pipeline: "Pipeline",
    profile: "Profile",
    settings: "Settings",
    /** PROPOSAL */
    gate: "Check first sends",
    /** PROPOSAL */
    blocked: "Blocked",
    /** PROPOSAL */
    uncertain: "Unsure sends",
    formAnswers: "Form answers",
    pauseCost: "Pause and cost",
  },
  groupAutomatic: "Automatic applying",
  needsYouEntry: "Needs you",
} as const

/** `needs.*.label` and `.link` (PROPOSAL; the links name no automation page, because this list shows with Advanced off, owner decision 2): one row per kind. */
export const needsCopy = {
  blocked: {
    label: (n: number) => (n === 1 ? "1 application is stuck" : `${n} applications are stuck`),
    link: "See what needs you",
  },
  uncertain: {
    label: (n: number) => (n === 1 ? "1 send Eve is unsure about" : `${n} sends Eve is unsure about`),
    link: "See what Eve is unsure about",
  },
  sameCompany: {
    label: (n: number) =>
      n === 1 ? "1 application is on hold for the same company" : `${n} applications are on hold for the same company`,
    link: "See what needs you",
  },
  sample: {
    label: (n: number) => (n === 1 ? "1 application is waiting for your review" : `${n} applications are waiting for your review`),
    link: "Review applications",
  },
} as const
