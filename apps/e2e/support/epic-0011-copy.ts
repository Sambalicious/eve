/**
 * QA test authoring, EPIC-0011 (Simplify Eve). The ONE place the e2e journeys read
 * product strings from. Source: epics/active/EPIC-0011-simplify-eve/copy-deck.md.
 * Strings marked PROPOSAL are pending the owner's copy review: when the owner changes
 * one, change it here only. EXACT strings come from the PRD and do not change.
 */
export const E11 = {
  // Nav (copy-deck nav.*). EXACT unless marked.
  navDefault: ["Home", "Jobs", "Find jobs", "Applications", "Profile", "Settings"] as const,
  navGroup: "Automatic applying",
  navGate: "Check first sends", // PROPOSAL
  navBlocked: "Blocked", // PROPOSAL
  navUncertain: "Unsure sends", // PROPOSAL
  navFormAnswers: "Form answers",
  navPauseCost: "Pause and cost",
  navRemoved: ["Documents", "Job Sources", "Stack posts", "Approved Answers", "Existing applications"] as const,
  needsYou: "Needs you",
  seeNeedsYou: "See what needs you", // board card link on a Needs you card (FE wave 3; PROPOSAL)
  notAvailable: "Automatic applying isn't available on your account yet.", // single not-available note on automation pages for a non-Operator (F-02 decision; PROPOSAL)
  documentsRegion: "Documents", // Application detail: the region that holds the tailored documents
  // Advanced switch (settings.advanced.*, hidden.*)
  advancedHeading: "Advanced: automatic applying", // EXACT
  switchLabel: "Show automatic applying", // PROPOSAL
  lockedNote: "Automatic applying is on. Turn it off first to switch Advanced off.", // PROPOSAL
  lockedLink: "Go to automatic applying", // PROPOSAL
  advancedError: "Couldn't save that change. Try again.", // PROPOSAL
  hiddenNote: "This is part of Advanced: automatic applying.", // EXACT
  hiddenTurnOn: "Turn on Advanced", // EXACT
  privacyLink: "Data and privacy", // EXACT
  // Hidden controls (ADV:48 table)
  hiddenControls: ["Check first sends", "Blocked", "Unsure sends", "Form answers", "Pause and cost", "Today's cap", "Monthly cost"] as const,
  // Home
  simplerTitle: "Eve is simpler now", // EXACT
  simplerDismiss: "Got it", // PROPOSAL
  improveHeading: "Improve your results", // EXACT
  recentHeading: "Recent applications", // EXACT
  pasteSubmit: "Check this job", // PROPOSAL
  // Applications board
  boardRegion: "Applications board", // EXACT
  viewBoard: "Board",
  viewList: "List",
  columns: ["Draft", "Applied", "Interview", "Offer", "Closed"] as const, // EXACT
  moveTo: "Move to…", // EXACT
  moveApplied: "I applied", // EXACT
  moveInterview: "Interview",
  moveOffer: "Offer",
  moveClosed: "Closed",
  backToApplied: "Back to Applied", // PROPOSAL
  backToInterview: "Back to Interview", // PROPOSAL
  confirmAppliedTitle: "Mark as applied?", // PROPOSAL
  confirmAppliedBody: "This records that you applied. It can't be undone.", // PROPOSAL
  // Find jobs
  findTitle: "Find jobs", // EXACT
  findSections: ["Search links", "Hiring posts", "Posts from your field", "Set up alerts"] as const, // PROPOSAL except Hiring posts / Set up alerts
  jobBoards: "Job boards", // PROPOSAL (Operator only)
  jobBoardsDescription: "Eve checks these job boards every morning", // EXACT
  forbiddenWords: ["Job Sources", "Activation Gate", "Uncertain Submission"] as const,
  // Status words (status.*)
  postingWords: ["Good match", "Not a match", "Checking", "Couldn't check", "Hidden"] as const, // EXACT
  retiredPostingWords: ["Skipped", "Excluded", "Eligible", "Unverified"] as const,
  // Upload / onboarding
  uploadTitle: "Upload your resume", // PROPOSAL
  consentApprove: "Approve", // PROPOSAL
  consentOperatorApproved: "The person who runs your Eve has approved the AI provider for this Eve.", // PROPOSAL
  useProfile: "Use this profile", // EXACT
  // Not found
  // QA gate: the 404 page heading (pages/not-found). The broader /not found|can't find|doesn't exist/ also matched
  // Find jobs' intro ("it can't find LinkedIn posts") and a record-not-found line inside a page that did load.
  notFoundHeading: /^Page Not Found$/,
} as const

/** Every in-app route that must still resolve after the upgrade (UPG:122, AC-7.5). */
export const EXISTING_ROUTES = [
  "/dashboard", "/postings", "/applications", "/documents", "/stack-posts", "/profile", "/answers", "/sources",
  "/existing-applications", "/settings", "/privacy", "/activation", "/activation/abc123", "/blocked", "/uncertain",
] as const

/** Routes that, with Advanced off, load with the hidden-route note (ADV:125). */
export const HIDDEN_ROUTES = ["/activation", "/activation/abc123", "/blocked", "/uncertain", "/answers"] as const

/**
 * QA gate (step 6a): the app sidebar's item area (the Needs-you strip and the nav groups, without the wordmark
 * and the account button). The sidebar renders no `navigation` landmark (shared/ui/sidebar.tsx, unchanged from
 * main), so the journeys locate the item area by its `data-sidebar` slot.
 */
export const SIDEBAR_NAV = '[data-sidebar="content"]'
