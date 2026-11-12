import { formatWatDate } from "@/shared/lib/format-wat"

const NEW_TAB = "(opens in a new tab)"

/**
 * EPIC-0007 copy deck (`copy-deck.r2.md`), keyed by slot ID: the strings the
 * Hiring view uses (view frame, Hiring search links (Phase 1), Check this job
 * (Phase 2), Hiring alert feeds and Hiring posts (Phase 3)). No Phase 3 string
 * names another person or a shared record (D12, D14). Strings are exact; fixed strings match the PRD byte for
 * byte. "Check link", "Checking…", C-LINK-*, C-VAL-LINK-* and C-ERR-2 are
 * reused from the paste form unchanged; C-SP-GROUP-N, C-SP-NEWTAB,
 * C-SP-ALERTQ-OPEN, C-SP-COPY, C-SP-COPIED and C-SP-COPY-ERR from `stackPostsCopy`.
 */
export const hiringCopy = {
  // View frame
  /** C-HP-VIEW-STACK. */
  viewStack: "Stack posts",
  /** C-HP-VIEW-HIRING. */
  viewHiring: "Hiring",
  /** C-HP-VIEWS-SR. */
  viewsSr: "Stack posts views",
  /** C-HP-DOC-TITLE. */
  docTitle: "Hiring · Stack posts",

  // Hiring search links (Phase 1)
  /** C-HP-LINKS-TITLE. */
  linksTitle: "Hiring search links",
  /** C-HP-LINKS-EDIT. */
  linksEdit: "Change job criteria",
  /** C-HP-HINT: must not be shortened. */
  hint: "Search hints for LinkedIn and Google. Results will include posts that don't fit. Eve can't check pay, hours or sponsorship from a search or post.",
  /** C-HP-HINT-LINK, to `#check-this-job`. */
  hintLink: "Paste job links in Check this job",
  /** C-HP-FAMILY-LABEL. */
  familyLabel: "Role family",
  /** C-HP-FAMILY-SINGLE. */
  familySingle: (family: string) => `Role family: ${family}`,
  /** C-HP-LIVE-FAMILY. */
  liveFamily: (family: string) => `Links now search for ${family} roles.`,
  /** C-HP-TITLES-LABEL. */
  titlesLabel: "Job titles",
  /** C-HP-TITLES-VALUE: each phrase in straight double quotes, joined by ", ". */
  titlesValue: (phrases: readonly string[]) => phrases.map((phrase) => `"${phrase}"`).join(", "),
  /** C-HP-HINTS-LABEL. */
  hintsLabel: "Plus any of",
  /** C-HP-HINTS-VALUE: AC 2.5 order, unquoted, joined by ", ". */
  hintsValue: (terms: readonly string[]) => terms.join(", "),
  /** C-HP-GROUP-ANY. */
  groupAny: "Any technology",
  /** C-HP-ANYTECH-NOTE. */
  anyTechNote: "No frameworks or technologies saved, so these links match any technology.",
  /** C-HP-ANYTECH-NOTE-LINK, to `/settings#job-criteria`. */
  anyTechNoteLink: "Add job criteria",
  /** C-HP-LINK-LI. */
  linkLinkedIn: "LinkedIn posts",
  /** C-HP-LINK-G. */
  linkGoogle: "Google posts",
  /** C-HP-LINK-LI-SR. */
  linkLinkedInSr: (family: string, group: string) => `LinkedIn posts for ${family} roles, ${group} ${NEW_TAB}`,
  /** C-HP-LINK-G-SR. */
  linkGoogleSr: (family: string, group: string) => `Google posts for ${family} roles, ${group} ${NEW_TAB}`,
  /** C-HP-ALERTQ-TOGGLE. */
  alertsToggle: "Google Alerts query",
  /** C-HP-ALERTQ-TOGGLE-SR. */
  alertsToggleSr: (group: string) => `Google Alerts query for ${group}`,
  /** C-HP-ALERTQ-HOWTO (before Phase 3). */
  alertsHowTo: 'Create an alert with this query and set "Deliver to" to "RSS feed".',
  /**
   * C-HP-ALERTQ-HOWTO-FEEDS (from Phase 3), split around its in-page link:
   * 'Create an alert with this query, set "Deliver to" to "RSS feed", then paste the feed URL under Hiring alert feeds.'
   */
  alertsHowToFeeds: {
    before: 'Create an alert with this query, set "Deliver to" to "RSS feed", then paste the feed URL under ',
    link: "Hiring alert feeds",
    after: ".",
  },
  /** C-HP-ALERTQ-LABEL. */
  queryLabel: "Hiring query",
  /** C-HP-ALERTQ-BLOCK-SR. */
  queryBlockSr: (group: string) => `Hiring query for ${group}`,
  /** C-HP-COPY-SR. */
  copySr: (group: string) => `Copy hiring query for ${group}`,
  /** C-HP-LIVE-COPIED. */
  liveCopied: "Hiring query copied.",
  /** C-HP-NOFAMILY-TITLE. */
  noFamilyTitle: "No role family to search for",
  /** C-HP-NOFAMILY-BODY. */
  noFamilyBody: "Hiring searches need job titles, and Other has none. Choose another role family in your job criteria.",
  /** C-HP-NOFAMILY-ACTION, to `/settings#job-criteria`. */
  noFamilyAction: "Choose role families",

  // Check this job
  /** C-HP-CHECK-TITLE. */
  checkTitle: "Check this job",
  /** EPIC-0011: the button in the section that opens the check form in a dialog. */
  checkOpen: "Check this job",  /** C-HP-CHECK-HELP: only while C-HP-HINT is on screen (Phase 1). */
  checkHelp:
    "Paste the employer's application link from the post, not the LinkedIn post link. No link? Add the job description. Eve checks that job with your usual rules.",
  /** C-HP-CHECK-HELP-SOLO: whenever C-HP-HINT is not on screen. */
  checkHelpSolo:
    "Eve can't check pay, hours or sponsorship in a LinkedIn post. Paste the employer's application link from the post, not the post link. No link? Add the job description. Eve checks that job with your usual rules.",
  /** C-HP-CHECK-URL-LABEL. */
  checkUrlLabel: "Application link",
  /** C-HP-CHECK-CREATED. */
  checkCreated: "Job Posting saved.",
  /** C-HP-CHECK-VIEW. */
  checkView: "View it",
  /** C-HP-LI-WARN. */
  linkedInWarning:
    "Eve can't read LinkedIn, so this link will be saved as not supported. Paste the employer's application link if the post has one, or add the job description.",
  /** C-HP-LI-WARN-SEND. */
  linkedInSend: "Save it anyway",

  // Hiring alert feeds (Phase 3)
  /** C-HP-FEEDS-SEC-TITLE. */
  feedsSectionTitle: "Hiring alert feeds",
  /** C-HP-FEEDS-DESC. */
  feedsDesc:
    "Eve reads these feeds at 02:00, 08:00, 14:00 and 20:00 WAT and never opens LinkedIn. They're separate from your other alert feeds.",
  /** C-HP-PAUSED. */
  paused: "Scheduled reads are paused. You can still add feeds. Reads restart at the next scheduled time after automation resumes.",
  /** C-HP-VERIFY-MISSING-TITLE. */
  verifyMissingTitle: "You haven't recorded permitted use",
  /** C-HP-VERIFY-MISSING-BODY. */
  verifyMissingBody:
    "Eve reads your Hiring alert feeds only after you record that reading them is permitted. Hiring search links and Check this job still work.",
  /** C-HP-VERIFY-MISSING-ACTION. */
  verifyMissingAction: "Record permitted use",
  /** C-HP-VERIFY-DONE: {date} from `verification.verifiedOn`. */
  verifyDone: (verifiedOn: string) => `Confirmed on ${formatWatDate(verifiedOn)}`,
  /** C-HP-VERIFY-UPDATE. */
  verifyUpdate: "Update",
  /** C-HP-VERIFY-UPDATE-SR. */
  verifyUpdateSr: "Update your confirmation for hiring alert feeds",
  /** C-HP-VERIFY-DIALOG-TITLE. */
  verifyDialogTitle: "Confirm you may use these feeds",
  /** C-HP-VERIFY-DIALOG-HELP. */
  verifyDialogHelp:
    "Eve reads these feeds for you. Confirm that you are allowed to use them. Only you see the basis.",
  /** C-HP-VERIFY-SUBMIT. */
  verifySubmit: "I confirm",
  /** C-HP-VERIFY-SAVED. */
  verifySaved: "Confirmation saved.",
  /** C-HP-VERIFY-ERR-NET. */
  verifyErrNet: "Couldn't save your confirmation. Nothing changed. Try again.",
  /** C-HP-FEEDS-NONE. */
  feedsNone: "No hiring alert feeds yet. Add one to see hiring posts.",
  /** C-HP-FEED-URL-HELP. */
  feedUrlHelp: "The feed link from your Google Alert. The search behind it is in Hiring search links.",
  /** C-HP-FEED-ERR-LIMIT. */
  feedErrLimit: "The limit is 10 Hiring alert feeds. Remove one to add another.",
  /** C-HP-FEED-ERR-NET. */
  feedErrNet: "Couldn't add the Hiring alert feed. Nothing was saved. Try again.",
  /** C-HP-FEED-ERR-OTHER-LIST. */
  feedErrOtherList: "This feed is already one of your other alert feeds. Remove it there to add it here.",
  /** C-HP-FEED-FALLBACK-NAME. */
  feedFallbackName: "Hiring alert feed",
  /** C-HP-FEED-ADDED. */
  feedAdded: "Hiring alert feed added.",
  /** C-HP-REMOVE-TITLE. */
  removeTitle: "Remove this Hiring alert feed?",
  /** C-HP-REMOVE-BODY. */
  removeBody: (name: string, maskedUrl: string) =>
    `Eve stops reading ${name} ${maskedUrl} now. Its posts stay until they age out. Adding it back needs its RSS link from Google Alerts.`,
  /** C-HP-REMOVE-DONE. */
  removeDone: "Hiring alert feed removed.",
  /** C-HP-REMOVE-ERR-NET. */
  removeErrNet: "Couldn't remove the Hiring alert feed. Eve still reads it. Try again.",

  /**
   * C-DATA-1 (copy-deck r2, "from Phase 3"), second sentence only. The first sentence ("Application records,
   * documents, answers and Outcomes stay until you delete them.") is not shown: C-RET-1 (12-month expiry)
   * already replaced it on the privacy page and says the opposite. See frontend-spec BLOCKER[copywriter].
   */
  dataRetentionPosts:
    "Eve deletes posts from your field and Hiring posts 90 days after it first finds them, and keeps no more than your newest 2,000 of each.",

  // Hiring posts (Phase 3)
  /** C-HP-POSTS-TITLE. */
  postsTitle: "Hiring posts",
  /** C-HP-POSTS-DESC. */
  postsDesc:
    "LinkedIn posts and articles from your Hiring alert feeds, newest first. Eve hasn't vetted them. To check a job from one, use Check this job.",
  /** C-HP-NOTCHECKED: never "Not checked yet", "Not checked" or "Unchecked". */
  notVetted: "Not vetted",
  /** C-HP-ROW-CHECK. */
  rowCheck: "Check this job",
  /** C-HP-ROW-CHECK-SR. */
  rowCheckSr: (title: string) => `Check this job from ${title}`,
  /** C-HP-ROW-HELP. */
  rowHelp: "Paste the employer's application link from this post, or add the job description. Eve doesn't open the post.",
  /** C-HP-ROW-URL-LABEL. */
  rowUrlLabel: (title: string) => `Application link for ${title}`,
  /** C-HP-ROW-CLOSE. */
  rowClose: "Close",
  /** C-HP-PAGE-NAV-SR. */
  pageNavSr: "Hiring posts pages",
  /** C-HP-POSTS-EMPTY-UNVERIFIED-TITLE. */
  postsEmptyUnverifiedTitle: "Hiring posts start after you record permitted use",
  /** C-HP-POSTS-EMPTY-UNVERIFIED-BODY. */
  postsEmptyUnverifiedBody: "Until then, you can't add Hiring alert feeds. Hiring search links still work.",
  /** C-HP-POSTS-EMPTY-UNVERIFIED-ACTION, to `#hiring-alert-feeds`. */
  postsEmptyUnverifiedAction: "Go to Hiring alert feeds",
  /** C-HP-POSTS-EMPTY-NOFEEDS-TITLE. */
  postsEmptyNoFeedsTitle: "No Hiring alert feeds yet",
  /** C-HP-POSTS-EMPTY-NOFEEDS-BODY. */
  postsEmptyNoFeedsBody: "Create an alert from a hiring query, then add its feed URL under Hiring alert feeds.",
  /** C-HP-POSTS-EMPTY-NOFEEDS-ACTION, to `#hiring-search-links`. */
  postsEmptyNoFeedsAction: "Go to hiring queries",
  /** C-HP-POSTS-EMPTY-WAITING-TITLE. */
  postsEmptyWaitingTitle: "No Hiring posts yet",
  /** C-HP-POSTS-EMPTY-WAITING-BODY. */
  postsEmptyWaitingBody:
    "Eve reads your Hiring alert feeds at 02:00, 08:00, 14:00 and 20:00 WAT and keeps only LinkedIn posts and articles.",

  // Explanatory help (EPIC-0009 copy deck, C-EH-HIRING-*)
  /** C-EH-HIRING-LINE: under the view tabs, in every links-section state. */
  helpLine:
    "Eve doesn't open or read LinkedIn, so it can't find LinkedIn posts that match your job criteria by itself. The sections below help you find them.",
  /** The Hiring view (i) popover. */
  helpWhy: {
    /** C-EH-HIRING-WHY-TRIGGER-SR. */
    triggerSr: "Why Eve doesn't show LinkedIn posts",
    /** C-EH-HIRING-WHY-TITLE. */
    title: "Why Eve can't read LinkedIn",
    /** C-EH-HIRING-WHY-REASON. */
    reason: "LinkedIn's terms restrict automated access, so Eve never sends a request to linkedin.com.",
    /** C-EH-HIRING-WHY-WAYS. */
    waysLead: "Three ways to find them",
    /** C-EH-HIRING-WHY-LINKS. */
    links:
      "Hiring search links open LinkedIn and Google searches in your own browser, where you're signed in. Eve doesn't see the results.",
    /** C-EH-HIRING-WHY-LINKS-GO, to `#hiring-search-links`. */
    linksGo: "Go to Hiring search links",
    /** C-EH-HIRING-WHY-CHECK. */
    check:
      "Check this job needs the employer's application link from a post, not the post link. Eve checks it with your usual rules.",
    /** C-EH-HIRING-WHY-CHECK-GO, to `#check-this-job`. */
    checkGo: "Go to Check this job",
    /** C-EH-HIRING-WHY-FEEDS. */
    feeds:
      "Hiring alert feeds bring in short previews of posts Google Alerts found. Eve reads them four times a day, only after you confirm you may use these feeds. They miss some posts, and Eve hasn't vetted them.",
    /** C-EH-HIRING-WHY-FEEDS-GO, to `#hiring-alert-feeds`. Same text as C-HP-POSTS-EMPTY-UNVERIFIED-ACTION; kept as its own key. */
    feedsGo: "Go to Hiring alert feeds",
  },
} as const
