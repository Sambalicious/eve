/**
 * Phase 3 strings, byte for byte from
 * epics/active/EPIC-0007-hiring-posts/copy-deck.r2.md (C-HP-*) and the EPIC-0005
 * strings it reuses (C-SP-*, apps/web entities/stack-post copy on 412ee14).
 * Tests compare against these, never against the web app's copy objects.
 */
export const P3 = {
  // Hiring Alert feeds section
  feedsTitle: "Hiring alert feeds", // C-HP-FEEDS-SEC-TITLE (lower-case "alert" since EPIC-0011 repair wave 1)
  // EPIC-0011 repair wave 1 (TD-RW1): the per-section "You haven't recorded permitted use" panel and its "Record
  // permitted use" button are gone. One step at the top of Set up alerts ("Confirm you may use these feeds",
  // button "I confirm") opens the date-and-basis dialog and records every list that is still unconfirmed.
  confirmTitle: "Confirm you may use these feeds", // find.alerts.confirm.title (EXACT)
  confirmButton: "I confirm", // find.alerts.confirm.button
  unconfirmedHint: "Confirm above to add feeds.", // find.alerts.unconfirmedHint
  hiringFeedsEmpty: "No hiring alert feeds yet. Add one to see hiring posts.", // find.alerts.hiringFeedsEmpty
  verifyDone: (date: string) => `Confirmed on ${date}`, // C-HP-VERIFY-DONE
  verifyUpdate: "Update", // C-HP-VERIFY-UPDATE
  verifyUpdateSr: "Update your confirmation for hiring alert feeds", // C-HP-VERIFY-UPDATE-SR
  dialogTitle: "Confirm you may use these feeds", // C-HP-VERIFY-DIALOG-TITLE
  dialogHelp: "Eve reads these feeds for you. Confirm that you are allowed to use them. Only you see the basis.", // C-HP-VERIFY-DIALOG-HELP
  verifySubmit: "I confirm", // C-HP-VERIFY-SUBMIT
  verifySaved: "Confirmation saved.", // C-HP-VERIFY-SAVED
  verifyErrNet: "Couldn't save your confirmation. Nothing changed. Try again.", // C-HP-VERIFY-ERR-NET
  feedsListTitle: "Your feeds", // C-HP-FEEDS-TITLE
  feedsCount: (n: number) => `${n} of 10`, // C-HP-FEEDS-COUNT
  feedsNone: "No hiring alert feeds yet. Add one to see hiring posts.", // C-HP-FEEDS-NONE
  feedAdd: "Add feed", // C-HP-FEED-ADD
  feedErrLimit: "The limit is 10 Hiring alert feeds. Remove one to add another.", // C-HP-FEED-ERR-LIMIT
  feedErrOtherList: "This feed is already one of your other alert feeds. Remove it there to add it here.", // C-HP-FEED-ERR-OTHER-LIST
  feedFallbackName: "Hiring alert feed", // C-HP-FEED-FALLBACK-NAME
  feedAdded: "Hiring alert feed added.", // C-HP-FEED-ADDED
  removeTitle: "Remove this Hiring alert feed?", // C-HP-REMOVE-TITLE
  removeDone: "Hiring alert feed removed.", // C-HP-REMOVE-DONE

  // Reused EPIC-0005 strings
  verifyDateLabel: "Verification date", // C-SP-VERIFY-DATE-LABEL
  verifyBasisLabel: "Basis for your confirmation", // C-SP-VERIFY-BASIS-LABEL
  verifyDateErr: "Enter the verification date.", // C-SP-VERIFY-DATE-ERR
  verifyDateFuture: "Enter today or an earlier date.", // C-SP-VERIFY-DATE-FUTURE
  verifyBasisErr: "Enter the basis for your confirmation.", // C-SP-VERIFY-BASIS-ERR
  verifyBasisLong: "Use 500 characters or fewer.", // C-SP-VERIFY-BASIS-LONG
  cancel: "Cancel", // C-SP-CANCEL
  feedUrlLabel: "Feed URL", // C-SP-FEED-URL-LABEL
  feedLabelLabel: "Label (optional)", // C-SP-FEED-LABEL-LABEL + C-SP-OPTIONAL
  feedUrlErrDup: "This feed is already registered.", // C-SP-FEED-URL-ERR-DUP
  feedUrlErrFormat: "This isn't a Google Alerts feed URL. Those start with https://www.google.com/alerts/feeds/", // C-SP-FEED-URL-ERR-FORMAT
  feedRemove: "Remove", // C-SP-FEED-REMOVE
  removeConfirm: "Remove feed", // C-SP-REMOVE-CONFIRM
  feedRemoveSr: (name: string, digits: string) => `Remove ${name}, feed ending ${digits.split("").join(" ")}`, // C-SP-FEED-REMOVE-SR
  feedRowName: (name: string, digits: string) => `${name}, feed ending ${digits.split("").join(" ")}`, // FeedRow aria-label
  stackFeedErrOtherList: "This feed is already a hiring alert feed. Remove it there to add it here.", // C-SP-FEED-ERR-OTHER-LIST
  stackFeedAdd: "Add feed", // C-SP-FEED-ADD
  stackFeedsTitle: "Alert feeds", // C-SP-FEEDS-SEC-TITLE

  // Hiring posts section
  postsTitle: "Hiring posts", // C-HP-POSTS-TITLE
  notVetted: "Not vetted", // C-HP-NOTCHECKED
  rowCheck: "Check this job", // C-HP-ROW-CHECK
  rowCheckSr: (title: string) => `Check this job from ${title}`, // C-HP-ROW-CHECK-SR
  rowHelp: "Paste the employer's application link from this post, or add the job description. Eve doesn't open the post.", // C-HP-ROW-HELP
  rowUrlLabel: (title: string) => `Application link for ${title}`, // C-HP-ROW-URL-LABEL
  rowClose: "Close", // C-HP-ROW-CLOSE
  checkLink: "Check link", // reused C-HP-CHECK-SUBMIT
  pageNav: "Hiring posts pages", // C-HP-PAGE-NAV-SR
  pageStatus: (page: number, pages: number) => `Page ${page} of ${pages}`, // C-SP-PAGE-STATUS
  pageNext: "Next", // C-SP-PAGE-NEXT
  pagePrev: "Previous", // C-SP-PAGE-PREV
  sourceRemoved: "Removed feed", // C-SP-SOURCE-REMOVED
  source: (name: string) => `from ${name}`, // C-SP-SOURCE
  // EPIC-0011 repair wave 1 (find.hiring.empty): "not confirmed" and "no feeds" read the same, with one action that opens Set up alerts.
  postsEmptyHiring: "Hiring posts appear here once you set up job alerts. You can also use the Search tab.", // find.hiring.empty
  setUpAlertsAction: "Set up alerts", // find.alerts.action
  stackPostsEmpty: "Posts from your field appear here once you set up job alerts.", // find.stack.empty
  postsEmptyUnverifiedTitle: "Hiring posts start after you record permitted use", // C-HP-POSTS-EMPTY-UNVERIFIED-TITLE
  postsEmptyUnverifiedBody: "Until then, you can't add Hiring alert feeds. Hiring search links still work.", // C-HP-POSTS-EMPTY-UNVERIFIED-BODY
  postsEmptyUnverifiedAction: "Go to Hiring alert feeds", // C-HP-POSTS-EMPTY-UNVERIFIED-ACTION
  postsEmptyNoFeedsTitle: "No Hiring alert feeds yet", // C-HP-POSTS-EMPTY-NOFEEDS-TITLE
  postsEmptyNoFeedsBody: "Create an alert from a hiring query, then add its feed URL under Hiring alert feeds.", // C-HP-POSTS-EMPTY-NOFEEDS-BODY
  postsEmptyNoFeedsAction: "Go to hiring queries", // C-HP-POSTS-EMPTY-NOFEEDS-ACTION
  postsEmptyWaitingTitle: "No Hiring posts yet", // C-HP-POSTS-EMPTY-WAITING-TITLE
  postsEmptyWaitingBody:
    "Eve reads your Hiring alert feeds at 02:00, 08:00, 14:00 and 20:00 WAT and keeps only LinkedIn posts and articles.", // C-HP-POSTS-EMPTY-WAITING-BODY

  // API
  notVerifiedMessage: "Record the permitted-use verification for Google Alerts feeds before registering a feed.", // 409 alert_feeds_not_verified
} as const

/** Text no Phase 3 surface may show (HAF:333, D12). */
export const FORBIDDEN_ROLE_TEXT = ["the person who runs your Eve", "Operator", "shared with Stack posts", "Record it under Stack posts"] as const

/** EPIC-0006 posting status wording the Hiring post label must not reuse (HP:245). */
export const FORBIDDEN_LABELS = ["Not checked yet", "Not checked", "Unchecked"] as const
