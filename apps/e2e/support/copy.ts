/**
 * Exact strings the Phase 2 journeys assert, byte for byte, from
 * epics/active/EPIC-0007-hiring-posts/copy-deck.r1.md (C-HP-*) and the built
 * copy the deck reuses (C-VAL-LINK-*, C-LINK-*, C-ERR-2) on origin/main c01f56b.
 * Tests import these instead of the web app's copy objects, so a wrong string in
 * the product fails the test instead of passing with it.
 */
export const COPY = {
  // EPIC-0011 R5: the Stack posts / Hiring view frame (tablist, two tabs) is gone. Both lists are sections of Find jobs.
  findTitle: "Find jobs", // find.title (EXACT); also the document title
  findPath: "/find-jobs", // architecture route table
  searchTab: "Search", // find.tabs.search (PROPOSAL, EPIC-0015): the first Find jobs tab
  setUpAlerts: "Set up alerts", // find.alerts.heading (EXACT); the fourth tab, holding both Alert feeds lists
  stackSectionTitle: "Posts from your field", // find.stack.heading (PROPOSAL), the former Stack posts "Posts"
  stackLinksSectionTitle: "Search links", // find.search.heading (PROPOSAL)

  // Section titles (fixed)
  checkTitle: "Check this job", // C-HP-CHECK-TITLE
  hiringLinksTitle: "Hiring search links", // C-HP-LINKS-TITLE (Phase 1, must be absent)
  hiringFeedsTitle: "Hiring alert feeds", // C-HP-FEEDS-SEC-TITLE (Phase 3, must be absent)
  hiringPostsTitle: "Hiring posts", // C-HP-POSTS-TITLE (Phase 3, must be absent)

  // Check this job
  checkHelp:
    "Paste the employer's application link from the post, not the LinkedIn post link. No link? Add the job description. Eve checks that job with your usual rules.", // C-HP-CHECK-HELP
  checkHelpSolo:
    "Eve can't check pay, hours or sponsorship in a LinkedIn post. Paste the employer's application link from the post, not the post link. No link? Add the job description. Eve checks that job with your usual rules.", // C-HP-CHECK-HELP-SOLO
  hint: "Search hints for LinkedIn and Google. Results will include posts that don't fit. Eve can't check pay, hours or sponsorship from a search or post.", // C-HP-HINT (must be absent)
  urlLabel: "Application link", // C-HP-CHECK-URL-LABEL
  submit: "Check link", // C-HP-CHECK-SUBMIT
  pending: "Checking…", // C-HP-CHECK-PENDING
  created: "Job Posting saved.", // C-HP-CHECK-CREATED (unchanged by EPIC-0011)
  view: "View it", // C-HP-CHECK-VIEW
  liWarn:
    "Eve can't read LinkedIn, so this link will be saved as not supported. Paste the employer's application link if the post has one, or add the job description.", // C-HP-LI-WARN
  liWarnSend: "Save it anyway", // C-HP-LI-WARN-SEND

  // Reused, built
  linkEmpty: "Paste a job link.", // C-VAL-LINK-1 = job_link_empty
  linkInvalid: "Enter a full link that starts with https:// or http://.", // C-VAL-LINK-2 = job_link_invalid
  linkAccepted:
    "Checking the link. It goes through the same Eligibility, Match, duplicate and cap rules as discovered postings.", // C-LINK-1
  alreadySaved: "You already have this Job Posting.", // C-LINK-2
  checkFailed: "Couldn't check the link. Nothing changed. Try again.", // C-ERR-2 via toastActionFailed("check the link")
  addJobLinkTitle: "Add a job link", // existing paste form section on /postings

  // EPIC-0006 B7 hidden result (check-this-job.feature r3, owner decision D10), from EPIC-0006 copy-deck.r1.md
  hiddenCreated: (reason: string) => `Saved, but hidden: ${reason}.`, // addJobLink.hidden.created
  hiddenExisting: (reason: string) => `You already have this Job Posting. It's hidden: ${reason}.`, // addJobLink.hidden.existing
  hiddenView: "View it", // addJobLink.hidden.view
  hiddenUndated: "no posted date", // addJobLink.hidden.reason.undated
  detailHiddenUndated: "Hidden from your board: no posted date.", // postingDetail.hidden.reason.undated
  statusWaiting: "Checking", // posting status badge; EPIC-0011 ST:15 maps waiting_to_be_checked to the posting word "Checking"

  // EPIC-0005 Stack posts view (unchanged)
  stackLinksTitle: "Search links",
  stackFeedsTitle: "Alert feeds",
  stackPostsTitle: "Posts from your field", // was "Posts" before EPIC-0011 (find.stack.heading)

  // Sign-in (EPIC-0001 design-spec.r4.md copy catalogue)
  sessionEnded: "Your session ended. Sign in with Google again to continue where you left off.", // C-AUTH-2

  // API messages
  unauthenticated: "Sign in to continue.",
  csrfInvalid: "The request is missing a valid CSRF token.",
  badRequest: "The request is not valid.",
} as const

/** Words that must never appear as a placeholder for an unshipped section (AC 1.2). */
export const PLACEHOLDER_PATTERN = /coming soon|not available yet|placeholder/i
