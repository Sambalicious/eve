/**
 * EPIC-0008 Stack posts strings, byte for byte from
 * epics/active/EPIC-0008-stack-feeds-per-user/copy-deck.md (C-SP-*, new and
 * changed rows) and the EPIC-0005 strings it reuses as built. Tests compare
 * against these, never against the web app's copy objects.
 */
export const SP8 = {
  feedsSectionTitle: "Alert feeds", // C-SP-FEEDS-SEC-TITLE
  feedsDesc: "Eve reads your Google Alerts feeds at 02:00, 08:00, 14:00 and 20:00 WAT. It never opens LinkedIn.", // C-SP-FEEDS-DESC
  paused: "Scheduled reads are paused. Your changes here still save. Reads restart at the next scheduled time after automation resumes.", // C-SP-PAUSED
  // EPIC-0011 repair wave 1 (TD-RW1): no per-section panel or "Record permitted use" button. The one confirm step at the
  // top of Set up alerts is in confirmTitle / confirmButton; an unconfirmed list shows feedsEmpty (or the saved-feeds
  // line) plus unconfirmedHint, with no form.
  confirmTitle: "Confirm you may use these feeds", // find.alerts.confirm.title (EXACT)
  confirmButton: "I confirm", // find.alerts.confirm.button
  feedsEmpty: "No alert feeds yet. Add a Google Alerts feed to see posts from your field.", // find.alerts.feedsEmpty
  unconfirmedHint: "Confirm above to add feeds.", // find.alerts.unconfirmedHint
  verifyMissingBodyHasFeeds: (n: number) =>
    n === 1
      ? "Your 1 saved feed is kept, but Eve doesn't read it until you confirm you may use these feeds. Search links still work."
      : `Your ${n} saved feeds are kept, but Eve doesn't read them until you confirm you may use these feeds. Search links still work.`, // C-SP-VERIFY-MISSING-BODY-HASFEEDS
  verifyRecorded: (date: string) => `Confirmed on ${date}`, // C-SP-VERIFY-RECORDED
  verifyUpdate: "Update", // C-SP-VERIFY-UPDATE
  verifyUpdateSr: "Update your confirmation for Alert feeds", // C-SP-VERIFY-UPDATE-SR
  feedsTitle: "Your feeds", // C-SP-FEEDS-TITLE
  feedsCount: (n: number) => `${n} of 10`, // C-SP-FEEDS-COUNT
  feedsChangeHelp: "Saved URLs stay hidden. To change one, remove the feed and add the new URL.", // C-SP-FEEDS-CHANGE-HELP
  dialogTitle: "Confirm you may use these feeds", // C-SP-VERIFY-DIALOG-TITLE
  dialogHelp: "Eve reads these feeds for you. Confirm that you are allowed to use them. Only you see the basis.", // C-SP-VERIFY-DIALOG-HELP
  verifyDateLabel: "Verification date", // C-SP-VERIFY-DATE-LABEL
  verifyBasisLabel: "Basis for your confirmation", // C-SP-VERIFY-BASIS-LABEL
  basisCount: (n: number) => `${n} of 500`, // C-SP-VERIFY-BASIS-COUNT
  verifyDateErr: "Enter the verification date.", // C-SP-VERIFY-DATE-ERR
  verifyDateFuture: "Enter today or an earlier date.", // C-SP-VERIFY-DATE-FUTURE
  verifyBasisErr: "Enter the basis for your confirmation.", // C-SP-VERIFY-BASIS-ERR
  verifyBasisErrChars: "The basis has hidden characters Eve can't save. Type it again or paste it as plain text.", // C-SP-VERIFY-BASIS-ERR-CHARS
  verifyBasisLong: "Use 500 characters or fewer.", // C-SP-VERIFY-BASIS-LONG
  cancel: "Cancel", // C-SP-CANCEL
  verifySubmit: "I confirm", // C-SP-VERIFY-SUBMIT
  verifySaved: "Confirmation saved.", // C-SP-VERIFY-SAVED
  verifyErrNet: "Couldn't save your confirmation. Nothing changed. Try again.", // C-SP-VERIFY-ERR-NET
  notVerifiedMessage: "Record the permitted-use verification for Google Alerts feeds before registering a feed.", // C-SP-ERR-NOT-VERIFIED
  feedUrlLabel: "Feed URL", // C-SP-FEED-URL-LABEL
  feedLabelLabel: "Label (optional)", // C-SP-FEED-LABEL-LABEL + C-SP-OPTIONAL
  feedAdd: "Add feed", // C-SP-FEED-ADD
  feedAdded: "Alert feed added.", // C-SP-FEED-ADDED
  feedErrLimit: "The limit is 10 Alert feeds. Remove one to add another.", // C-SP-FEED-ERR-LIMIT
  feedFallbackName: "Alert feed", // C-SP-FEED-FALLBACK-NAME
  feedRowName: (name: string, digits: string) => `${name}, feed ending ${digits.split("").join(" ")}`, // FeedRow aria-label
  feedRemoveSr: (name: string, digits: string) => `Remove ${name}, feed ending ${digits.split("").join(" ")}`, // C-SP-FEED-REMOVE-SR
  removeConfirm: "Remove feed", // C-SP-REMOVE-CONFIRM
  removeDone: "Alert feed removed.", // C-SP-REMOVE-DONE
  postsTitle: "Posts from your field", // C-SP-POSTS-TITLE, renamed by EPIC-0011 find.stack.heading (was "Posts")
  postsUnverifiedNote: "No new posts until you confirm you may use these feeds. These posts stay until they age out.", // C-SP-POSTS-UNVERIFIED-NOTE
  postsEmpty: "Posts from your field appear here once you set up job alerts.", // find.stack.empty (not confirmed and no feeds read the same)
  setUpAlertsAction: "Set up alerts", // find.alerts.action
  postsEmptyUnverifiedTitle: "Posts start after you record permitted use", // C-SP-POSTS-EMPTY-UNVERIFIED-TITLE
  postsEmptyUnverifiedBody: "Eve reads no Alert feed until then. Search links still work.", // C-SP-POSTS-EMPTY-UNVERIFIED-BODY
  postsEmptyUnverifiedAction: "Go to Alert feeds", // C-SP-POSTS-EMPTY-UNVERIFIED-ACTION
} as const

/** Retired EPIC-0005 slots (copy deck "Retired"): never shown after EPIC-0008. */
export const RETIRED = ["Google Alerts feeds", "Not verified", "Verified", "Record verification", "the same rule as every Job Source", "Update verification", "Posts start after verification", "Record permitted use under Alert feeds, then add a feed."] as const

/**
 * The retired slots found in a surface's text (CR-E8-03). Two approved, unchanged deck strings
 * (C-SP-FEEDS-DESC, C-SP-ERR-NOT-VERIFIED) contain the retired row name "Google Alerts feeds",
 * so exactly those whole strings are removed first; the standalone retired name is still caught.
 * "Verified" is matched as a whole, case-sensitive word, so it is caught next to "Permitted use
 * recorded" and is not confused with "verified" inside another word. No other exemption.
 */
export function retiredIn(text: string): string[] {
  const scan = [SP8.feedsDesc, SP8.notVerifiedMessage].reduce((t, approved) => t.split(approved).join("\n"), text)
  return RETIRED.filter((retired) => (retired === "Verified" ? /\bVerified\b/.test(scan) : scan.includes(retired)))
}

/**
 * GH-2 banned wording on Stack posts surfaces (stack-feed-copy-and-unchanged.feature header),
 * case-insensitive, whole words where a word could appear inside an allowed one.
 */
export const BANNED = [
  /\boperator\b/i,
  /the person who runs (your )?eve/i,
  /\badmin(istrator)?\b/i,
  /shared record/i,
  /shared verification/i,
  /shared with hiring/i,
  /on behalf of/i,
  /\bowner\b/i,
  /\bteam\b/i,
  /\binstallation\b/i,
  /job source/i,
  /after you resume automation/i,
] as const

export function bannedIn(text: string): string[] {
  return BANNED.filter((pattern) => pattern.test(text)).map(String)
}
