import { ALERT_FEED_LIMIT, alertFeedFailurePhrase } from "@eve/contracts"

import { formatWatDate, formatWatDateTime } from "@/shared/lib/format-wat"

const NEW_TAB = "(opens in a new tab)"

/** "6 5 4 3 2 1": mask digits read one by one (copy deck, Accessibility text). */
function spacedDigits(maskedUrl: string): string {
  return maskedUrl.replace(/[^0-9]/g, "").split("").join(" ")
}

/**
 * EPIC-0005 copy deck (`copy-deck.md`), keyed by slot ID. Strings are exact;
 * fixed strings match the PRD byte for byte. Built strings are reused where the
 * deck says "built". Reason phrases come from the shared contracts map.
 */
export const stackPostsCopy = {
  /** C-SP-NAV, C-SP-PAGE-TITLE. */
  pageTitle: "Stack posts",
  /** C-SP-NEWTAB. */
  newTab: NEW_TAB,

  // Search links
  /** C-SP-LINKS-TITLE. */
  linksTitle: "Search links",
  /** C-SP-LINKS-DESC. */
  linksDesc:
    "Past-week searches from your job criteria. Excluding hiring posts is a hint to LinkedIn and Google, so some results will still be hiring posts or job ads.",
  /** C-SP-LINKS-EDIT. */
  linksEdit: "Change job criteria",
  /** C-SP-GROUP-N. */
  groupN: (i: number, n: number) => `Group ${i} of ${n}`,
  /** C-SP-LINK-LI, -G-POSTS, -G-ARTICLES. */
  linkLinkedIn: "LinkedIn posts",
  linkGooglePosts: "Google posts",
  linkGoogleArticles: "Google articles",
  /** C-SP-LINK-*-SR. */
  linkSr: (label: string, group: string) => `${label} for ${group} ${NEW_TAB}`,
  /** C-SP-ALERTQ-TOGGLE, C-SP-ALERTQ-TOGGLE-SR. */
  alertsToggle: "Google Alerts queries",
  alertsToggleSr: (group: string) => `Google Alerts queries for ${group}`,
  /** C-SP-ALERTQ-HOWTO. */
  alertsHowTo: 'Create an alert with a query, set "Deliver to" to "RSS feed", then paste the feed URL under Alert feeds.',
  /** C-SP-ALERTQ-OPEN. */
  alertsOpen: "Open Google Alerts",
  /** C-SP-ALERTQ-POSTS-LABEL, C-SP-ALERTQ-ARTICLES-LABEL. */
  queryLabel: { posts: "Posts query", articles: "Articles query" },
  queryBlockSr: { posts: (group: string) => `Posts query for ${group}`, articles: (group: string) => `Articles query for ${group}` },
  /** C-SP-COPY, C-SP-COPY-SR, C-SP-COPIED. */
  copy: "Copy",
  copySr: { posts: (group: string) => `Copy posts query for ${group}`, articles: (group: string) => `Copy articles query for ${group}` },
  copied: "Copied",
  /** C-SP-LIVE-COPIED. */
  liveCopied: { posts: "Posts query copied.", articles: "Articles query copied." },
  /** C-SP-COPY-ERR. */
  copyFailed: "Couldn't copy. The query is selected, so press Ctrl+C or Cmd+C.",
  /** C-SP-LINKS-EMPTY-*. */
  linksEmptyTitle: "No frameworks or technologies saved",
  linksEmptyBody: "Search links are built from the Frameworks and Technologies in your job criteria.",
  linksEmptyAction: "Add job criteria",

  // Alert feeds: section and verification
  /** C-SP-FEEDS-SEC-TITLE. */
  feedsSectionTitle: "Alert feeds",
  /** C-SP-FEEDS-DESC. */
  feedsDesc: "Eve reads your Google Alerts feeds at 02:00, 08:00, 14:00 and 20:00 WAT. It never opens LinkedIn.",
  /** C-SP-PAUSED (EPIC-0008 copy deck: an invitee can't lift the global pause, so it never says "you resume"). */
  paused: "Scheduled reads are paused. Your changes here still save. Reads restart at the next scheduled time after automation resumes.",
  /**
   * EPIC-0008 copy deck: the session Candidate's own permitted-use record. Nothing is chosen by
   * role and no string names another person, a shared record or the Hiring list (AC 7.1).
   * C-SP-VERIFY-MISSING-TITLE, -BODY (0 feeds), -BODY-HASFEEDS (1 to 10 feeds), -ACTION.
   */
  verifyMissingTitle: "You haven't recorded permitted use",
  verifyMissingBody:
    "Eve reads your Alert feeds only after you record that reading them is permitted. Then you can add feeds. Search links still work.",
  verifyMissingBodyHasFeeds: (n: number) =>
    n === 1
      ? "Your 1 saved feed is kept, but Eve doesn't read it until you confirm you may use these feeds. Search links still work."
      : `Your ${n} saved feeds are kept, but Eve doesn't read them until you confirm you may use these feeds. Search links still work.`,
  verifyMissingAction: "Record permitted use",
  /** C-SP-VERIFY-RECORDED: the date only, never the basis (AC 1.6). */
  verifyRecorded: (verifiedOn: string) => `Confirmed on ${formatWatDate(verifiedOn)}`,
  /** C-SP-VERIFY-UPDATE, C-SP-VERIFY-UPDATE-SR. */
  verifyUpdate: "Update",
  verifyUpdateSr: "Update your confirmation for Alert feeds",
  /** C-SP-VERIFY-DIALOG-TITLE, C-SP-VERIFY-DIALOG-HELP. */
  verifyDialogTitle: "Confirm you may use these feeds",
  verifyDialogHelp:
    "Eve reads these feeds for you. Confirm that you are allowed to use them. Only you see the basis.",
  /** C-SP-VERIFY-DATE-LABEL, C-SP-VERIFY-BASIS-LABEL (built strings, repeated: entities cannot import another entity), plus the built "(Required)" marker. */
  verifyDateLabel: "Verification date",
  verifyBasisLabel: "Basis for your confirmation",
  required: "(Required)",
  /** C-SP-VERIFY-BASIS-HELP. */
  verifyBasisHelp: "What you checked and where, for example the Google Alerts terms you reviewed.",
  /** C-SP-VERIFY-BASIS-COUNT: {n} is code points after trimming. */
  verifyBasisCount: (n: number) => `${n} of 500`,
  /** C-SP-VERIFY-DATE-ERR (built C-VAL-SRC-1), -DATE-FUTURE, -BASIS-ERR (built), -BASIS-LONG. */
  verifyDateErr: "Enter the verification date.",
  verifyDateFuture: "Enter today or an earlier date.",
  verifyBasisErr: "Enter the basis for your confirmation.",
  verifyBasisLong: "Use 500 characters or fewer.",
  /** C-SP-VERIFY-BASIS-ERR-CHARS (copy deck r1). */
  verifyBasisErrChars: "The basis has hidden characters Eve can't save. Type it again or paste it as plain text.",
  /** C-SP-VERIFY-SUBMIT, C-SP-SAVING, C-SP-CANCEL. */
  verifySubmit: "I confirm",
  saving: "Saving…",
  cancel: "Cancel",
  /** The dialog header's close control (sr-only, "Close"). */
  close: "Close",
  /** C-SP-VERIFY-SAVED. */
  verifySaved: "Confirmation saved.",
  /** C-SP-VERIFY-ERR-NET. */
  verifyErrNet: "Couldn't save your confirmation. Nothing changed. Try again.",

  // Alert feeds: list, form and removal
  /** C-SP-FEEDS-TITLE, C-SP-FEEDS-COUNT. */
  feedsTitle: "Your feeds",
  feedsCount: (n: number) => `${n} of ${ALERT_FEED_LIMIT}`,
  /** C-SP-FEEDS-CHANGE-HELP. */
  feedsChangeHelp: "Saved URLs stay hidden. To change one, remove the feed and add the new URL.",
  /** C-SP-FEEDS-NONE. */
  feedsNone: "No alert feeds yet. Add a Google Alerts feed to see posts from your field.",
  /** C-SP-FEED-URL-LABEL, -PLACEHOLDER, -HELP. */
  feedUrlLabel: "Feed URL",
  feedUrlPlaceholder: "https://www.google.com/alerts/feeds/…",
  feedUrlHelp: "The feed link from your Google Alert. The search behind it is in Search links.",
  /** C-SP-FEED-LABEL-LABEL, C-SP-OPTIONAL, C-SP-FEED-LABEL-HELP. */
  feedLabelLabel: "Label",
  optional: "(optional)",
  feedLabelHelp: "Shown in the list and the daily email. Up to 60 characters.",
  /** C-SP-FEED-ADD, C-SP-FEED-CHECKING. */
  feedAdd: "Add feed",
  feedChecking: "Checking feed…",
  /** Registration field errors (C-SP-FEED-URL-ERR-*, C-SP-FEED-ERR-*, C-SP-FEED-LABEL-ERR-LONG). */
  feedUrlErrFormat: "This isn't a Google Alerts feed URL. Those start with https://www.google.com/alerts/feeds/",
  feedUrlErrDup: "This feed is already registered.",
  feedErrLimit: "The limit is 10 Alert feeds. Remove one to add another.",
  feedLabelErrLong: "Use 60 characters or fewer.",
  /** C-SP-FEED-LABEL-ERR-CHARS (copy deck r1). */
  feedLabelErrChars: "The label has a tab or hidden character. Type it again.",
  feedErrUnreachable: "Not reachable. Eve couldn't connect to Google. Nothing was saved. Try again shortly.",
  feedErrUnexpected: "Unexpected response. Google didn't send the feed. Nothing was saved. Check the alert's RSS link.",
  feedErrRedirect:
    "Redirected (not followed). Google pointed Eve elsewhere. Nothing was saved. Copy the RSS link again from Google Alerts.",
  feedErrNotFeed: "Not a feed. Google sent back a page, not a feed. Nothing was saved. Check the RSS link.",
  feedErrTooLarge: "Too large. The feed is over Eve's size limit. Nothing was saved.",
  feedErrTimeout: "Timed out. Google didn't answer in time. Nothing was saved. Try again.",
  /** C-SP-FEED-ERR-OTHER-LIST (EPIC-0007 copy-deck r1, SA-3): `url/in_other_list` from the Stack posts endpoint. */
  feedErrOtherList: "This feed is already a hiring alert feed. Remove it there to add it here.",
  /** C-SP-FEED-ERR-NET. */
  feedErrNet: "Couldn't add the Alert feed. Nothing was saved. Try again.",
  /** C-SP-FEED-ERR-BUSY (copy-deck r2): registration 503 `service_unavailable`. */
  feedErrBusy: "Eve was busy for a moment. Nothing was saved. Try again in a few seconds.",
  /** C-SP-FEED-ADDED. */
  feedAdded: "Alert feed added.",
  /** C-SP-FEED-FALLBACK-NAME. */
  feedFallbackName: "Alert feed",
  /** C-SP-FEED-MASKED screen reader text and the row name. */
  feedEnding: (maskedUrl: string) => `feed ending ${spacedDigits(maskedUrl)}`,
  feedRowName: (name: string, maskedUrl: string) => `${name}, feed ending ${spacedDigits(maskedUrl)}`,
  /** C-SP-FEED-LASTREAD. */
  feedLastRead: (at: string) => `Last read ${formatWatDateTime(at)}`,
  /** C-SP-FEED-FAILING, C-SP-FEED-FAIL-REASON with C-SP-FAIL-*. */
  feedFailing: "Failing",
  feedFailReason: (reason: string, at: string) => `${alertFeedFailurePhrase(reason)} · ${formatWatDateTime(at)}`,
  /** C-SP-FEED-REMOVE, C-SP-FEED-REMOVE-SR. */
  feedRemove: "Remove",
  feedRemoveSr: (name: string, maskedUrl: string) => `Remove ${name}, feed ending ${spacedDigits(maskedUrl)}`,
  /** C-SP-REMOVE-TITLE, -BODY, -CONFIRM, -DONE, -ERR-NET. */
  removeTitle: "Remove this Alert feed?",
  removeBody: (name: string, maskedUrl: string) =>
    `Eve stops reading ${name} ${maskedUrl} now. Its posts stay until they age out. Adding it back needs its RSS link from Google Alerts, because Eve can't show the URL again.`,
  removeConfirm: "Remove feed",
  removeDone: "Alert feed removed.",
  removeErrNet: "Couldn't remove the Alert feed. Eve still reads it. Try again.",

  // Posts
  /** C-SP-POSTS-TITLE, C-SP-POSTS-DESC. */
  postsTitle: "Posts",
  postsDesc: "LinkedIn posts and articles from your Alert feeds, newest first.",
  /** C-SP-KIND-POST, C-SP-KIND-ARTICLE. */
  kind: { post: "Post", article: "Article" },
  /** C-SP-UNTITLED-POST, C-SP-UNTITLED-ARTICLE (final in copy deck r1, D-E5-10). */
  untitled: { post: "Untitled LinkedIn post", article: "Untitled LinkedIn article" },
  /** C-SP-POSTED, C-SP-FOUND. */
  posted: (date: string) => `Posted ${formatWatDate(date)}`,
  found: (date: string) => `Found ${formatWatDate(date)}`,
  /** C-SP-TECH-SR, C-SP-TECH-MORE. */
  techSr: "Mentions:",
  techMore: (n: number) => `+${n}`,
  techMoreSr: (n: number) => `and ${n} more`,
  /** C-SP-NO-TECH. */
  noTech: "No listed technology in the snippet",
  /** C-SP-SOURCE, C-SP-SOURCE-REMOVED. */
  source: (name: string) => `from ${name}`,
  sourceRemoved: "Removed feed",
  /** C-SP-PAGE-PREV, -NEXT, -STATUS, -NAV-SR. */
  pagePrev: "Previous",
  pageNext: "Next",
  pageStatus: (page: number, pages: number) => `Page ${page} of ${pages}`,
  pageNavSr: "Posts pages",
  /** C-SP-POSTS-UNVERIFIED-NOTE: above the rows while there is no record and at least 1 post (EPIC-0008). */
  postsUnverifiedNote: "No new posts until you confirm you may use these feeds. These posts stay until they age out.",
  /** C-SP-POSTS-EMPTY-*. */
  postsEmptyUnverifiedTitle: "Posts start after you record permitted use",
  postsEmptyUnverifiedBody: "Eve reads no Alert feed until then. Search links still work.",
  postsEmptyUnverifiedAction: "Go to Alert feeds",
  postsEmptyNoFeedsTitle: "No Alert feeds yet",
  postsEmptyNoFeedsBody: "Create an alert from a query in Search links, then add its feed URL under Alert feeds.",
  postsEmptyWaitingTitle: "No posts yet",
  postsEmptyWaitingBody: "Eve reads your feeds at 02:00, 08:00, 14:00 and 20:00 WAT and keeps only LinkedIn posts and articles.",
} as const
