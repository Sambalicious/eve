/**
 * Phase 1 strings, byte for byte from epics/active/EPIC-0007-hiring-posts/copy-deck.r1.md
 * (C-HP-*) and the EPIC-0005 strings it reuses (C-SP-*). Tests compare against
 * these, never against the web app's copy objects.
 */
export const LINKS_COPY = {
  title: "Hiring search links", // C-HP-LINKS-TITLE
  edit: "Change job criteria", // C-HP-LINKS-EDIT
  hint: "Search hints for LinkedIn and Google. Results will include posts that don't fit. Eve can't check pay, hours or sponsorship from a search or post.", // C-HP-HINT
  hintLink: "Paste job links in Check this job", // C-HP-HINT-LINK
  familyLabel: "Role family", // C-HP-FAMILY-LABEL
  familySingle: (family: string) => `Role family: ${family}`, // C-HP-FAMILY-SINGLE
  liveFamily: (family: string) => `Links now search for ${family} roles.`, // C-HP-LIVE-FAMILY
  titlesLabel: "Job titles", // C-HP-TITLES-LABEL
  hintsLabel: "Plus any of", // C-HP-HINTS-LABEL
  groupAny: "Any technology", // C-HP-GROUP-ANY
  anyTechNote: "No frameworks or technologies saved, so these links match any technology.", // C-HP-ANYTECH-NOTE
  anyTechLink: "Add job criteria", // C-HP-ANYTECH-NOTE-LINK
  linkLi: "LinkedIn posts", // C-HP-LINK-LI
  linkG: "Google posts", // C-HP-LINK-G
  newTab: "(opens in a new tab)", // C-SP-NEWTAB
  linkLiSr: (family: string, group: string) => `LinkedIn posts for ${family} roles, ${group} (opens in a new tab)`, // C-HP-LINK-LI-SR
  linkGSr: (family: string, group: string) => `Google posts for ${family} roles, ${group} (opens in a new tab)`, // C-HP-LINK-G-SR
  alertsToggle: "Google Alerts query", // C-HP-ALERTQ-TOGGLE
  alertsHowTo: 'Create an alert with this query and set "Deliver to" to "RSS feed".', // C-HP-ALERTQ-HOWTO (before Phase 3)
  alertsHowToFeeds: 'Create an alert with this query, set "Deliver to" to "RSS feed", then paste the feed URL under Hiring alert feeds.', // C-HP-ALERTQ-HOWTO-FEEDS (Phase 3, must be absent)
  alertsOpen: "Open Google Alerts", // C-SP-ALERTQ-OPEN
  queryLabel: "Hiring query", // C-HP-ALERTQ-LABEL
  copySr: (group: string) => `Copy hiring query for ${group}`, // C-HP-COPY-SR
  copy: "Copy", // C-SP-COPY
  copied: "Copied", // C-SP-COPIED
  liveCopied: "Hiring query copied.", // C-HP-LIVE-COPIED
  copyErr: "Couldn't copy. The query is selected, so press Ctrl+C or Cmd+C.", // C-SP-COPY-ERR
  noFamilyTitle: "No role family to search for", // C-HP-NOFAMILY-TITLE
  noFamilyBody: "Hiring searches need job titles, and Other has none. Choose another role family in your job criteria.", // C-HP-NOFAMILY-BODY
  noFamilyAction: "Choose role families", // C-HP-NOFAMILY-ACTION
  groupN: (i: number, n: number) => `Group ${i} of ${n}`, // C-SP-GROUP-N (rendered uppercase by CSS)
} as const

/** /settings#job-criteria: where C-HP-ANYTECH-NOTE-LINK and C-HP-NOFAMILY-ACTION lead. */
export const JOB_CRITERIA_HREF = /\/settings#job-criteria$/
