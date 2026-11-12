import type { JobCriteriaListName, SeniorityFloor, TargetRoleFamily } from "@/entities/candidate-settings"

/** EPIC-0004 copy deck, keyed by slot (copy-deck.md). Fixed strings are byte-exact. */
export const jobCriteriaCopy = {
  /** C-JC-SEC-TITLE */
  title: "Job criteria",
  /** EPIC-0006 jobCriteria.section.desc (replaces C-JC-SEC-DESC) */
  description: "These criteria decide which postings Eve shows and ranks. Saving applies them to postings Eve already found.",
  /** EPIC-0006 copy-deck.r1 `jobCriteria.families.*`. Labels come from `roleFamilyLabel` (`family.*`). */
  families: {
    /** EPIC-0002 copy-deck.r6 `settings.jc.b1.families.legend` (B1 only; B2 removes the section). */
    legend: "Families on your board",
    count: (n: number) => `${n} of 13`,
    /** `settings.jc.b1.families.help` (B1). */
    help: "Unselected families are hidden and get no AI check. Select one again and its postings return unchanged. Job preferences ranks or excludes visible families.",
    /** `settings.jc.b1.families.prefsLink` (B1), to `#preferences`. */
    prefsLink: "Go to Job preferences",
    prefsHref: "/settings#preferences",
    errorNone: "Choose at least one role family.",
    errorServer: "Couldn't save your role families. Reload the page and choose them again.",
    example: {
      senior_frontend: "e.g. Senior Frontend Engineer, UI Engineer",
      technical_lead: "e.g. Tech Lead, Lead Engineer, Team Lead",
      fullstack: "e.g. Full Stack Developer",
      product_engineering: "e.g. Product Engineer",
      software_engineering: "e.g. Software Engineer, Staff Engineer, Principal Engineer",
      backend: "e.g. Backend Engineer",
      mobile: "e.g. iOS Engineer, Android Developer",
      platform_engineering: "e.g. Platform Engineer",
      devops_platform: "e.g. DevOps Engineer, Site Reliability Engineer",
      people_management: "e.g. Engineering Manager, Director, Head of Engineering",
      data_ml: "e.g. Data Engineer, Data Scientist, ML Engineer",
      solutions_customer: "e.g. Solutions Architect, Technical Account Manager",
      other: "Anything else, e.g. QA or Hardware Engineer",
    } satisfies Record<TargetRoleFamily, string>,
  },
  /** EPIC-0006 copy-deck.r1 `jobCriteria.seniority.*`. */
  seniority: {
    /** `settings.jc.b1.seniority.legend` (B1). */
    legend: "Entry-level roles on your board",
    option: {
      all_levels: "Show all levels",
      hide_entry_level: "Hide intern, junior, graduate and entry-level roles",
    } satisfies Record<SeniorityFloor, string>,
    hideEntryHelp: "Mid-level titles and titles with no level stay on your board.",
  },
  /** C-JC-MATCH-LABEL */
  matchLabel: "Minimum core Match",
  /** C-JC-MATCH-SUFFIX */
  matchSuffix: "%",
  /** C-JC-MATCH-HELP */
  matchHelp: "Percent of a role's core responsibilities your Career Profile must cover. The default is 70.",
  /** C-JC-MATCH-ERR */
  matchError: "Enter a whole number from 1 to 100.",
  listLabel: {
    /** C-JC-FW-LABEL */
    frameworks: "Frameworks",
    /** C-JC-TECH-LABEL */
    technologies: "Technologies",
  } satisfies Record<JobCriteriaListName, string>,
  listHelp: {
    /** C-JC-FW-HELP */
    frameworks: "Eve ranks postings that mention any one entry from either list. Spellings like React.js count as React.",
    /** C-JC-TECH-HELP */
    technologies: "Languages, platforms and tools. Same rule as Frameworks.",
  } satisfies Record<JobCriteriaListName, string>,
  placeholder: {
    /** C-JC-FW-PLACEHOLDER */
    frameworks: "e.g. React",
    /** C-JC-TECH-PLACEHOLDER */
    technologies: "e.g. TypeScript",
  } satisfies Record<JobCriteriaListName, string>,
  /** C-JC-LIST-COUNT */
  count: (n: number) => `${n} of 20`,
  /** C-JC-LIST-ADD */
  add: "Add",
  /** C-JC-LIST-ADD-SR */
  addTo: (list: string) => `Add to ${list}`,
  /** C-JC-LIST-EMPTY */
  listEmpty: "None added.",
  /** C-JC-TECH-OFF */
  technologyOff: "With both lists empty, Eve doesn't skip postings for technology.",
  /** C-JC-CHIP-REMOVE-SR */
  remove: (entry: string, list: string) => `Remove ${entry} from ${list}`,
  /** C-JC-LIVE-ADDED */
  liveAdded: (entry: string, list: string, n: number) => `Added ${entry} to ${list}. ${n} of 20.`,
  /** C-JC-LIVE-REMOVED */
  liveRemoved: (entry: string, list: string, n: number) => `Removed ${entry} from ${list}. ${n} of 20.`,
  entryError: {
    /** C-JC-ERR-EMPTY */
    empty: "Enter a name to add.",
    /** C-JC-ERR-FULL */
    full: "This list is full at 20 entries. Remove one to add another.",
    /** C-JC-ERR-LONG */
    long: "Use 40 characters or fewer for each entry.",
    /** C-JC-ERR-CHARS (no final full stop, on purpose) */
    chars: "Use only letters, digits, spaces and these symbols: . + # - / _",
    /** C-JC-ERR-DUP */
    duplicate: "Already in your list.",
  },
  /** C-JC-ERR-DUP-SERVER */
  duplicateServer: (entry: string) => `"${entry}" repeats another entry. Remove one to save.`,
  /** `settings.jc.b1.save` (B1, replaces C-JC-SAVE). */
  save: "Save job criteria",
  /** `settings.jc.b1.saveScope` (B1), muted line above the button. */
  saveScope: "This saves Job criteria only. Job preferences has its own save.",
  /** C-JC-SAVING */
  saving: "Saving…",
  /** `settings.jc.b1.saved` (B1, replaces C-JC-SAVED). */
  saved: "Job criteria saved.",
  /** C-JC-SAVE-ERR-NET */
  saveFailed: "Couldn't save your job criteria. Nothing changed. Try again.",
  /** C-JC-CONFLICT */
  conflict: "Job criteria changed elsewhere. Reload to see the saved values. Your edits here aren't saved.",
  /** C-JC-CONFLICT-ACTION */
  conflictAction: "Reload job criteria",
} as const
