/**
 * Exact strings the EPIC-0002 B1 journeys assert, byte for byte, from
 * .runs/epic-0002-b1/reports/copy-b1.md (keys in comments, final at deck
 * commit 4f89545). Tests import these instead of the web app's copy objects, so
 * a wrong string in the product fails the test instead of passing with it.
 */
export const B1 = {
  // Settings Job Preferences form
  settingsTitle: "Job preferences", // 94 prefs.settings.title
  conflict: "Your preferences changed in another tab. Reload to see the latest. Your edits here aren't saved.", // 1 C-PREF-CONFLICT (D30)
  conflictButton: "Reload preferences", // 1 C-PREF-CONFLICT button
  homeCountry: "Home country", // 3 C-PREF-1
  timeZone: "Time zone", // 4 C-PREF-2
  latestWorkHour: "Latest work hour", // 5 C-PREF-3
  latestWorkHourError: "Choose a time from 01:00 to 23:59.", // 5 C-VAL-PREF-3
  workAuth: "Countries you can work in without sponsorship", // 6 C-PREF-4
  homeChanged: (next: string, old: string) =>
    `${next} is now included in your work authorization. ${old} is still there; remove it if it no longer applies. Check your time zone and latest work hour.`, // 8 C-PREF-HOME-CHANGED
  homeUnexcluded: (next: string) => `${next} was removed from countries you won't relocate to.`, // 9 C-PREF-HOME-UNEXCLUDED
  sponsorship: "Do you need visa sponsorship to relocate to other countries?", // 15 C-PREF-6
  excludedRelocation: "Countries you won't relocate to", // 16 C-PREF-7
  payFloor: "Lowest pay you'll accept (gross)", // 18 C-PREF-9
  currencyError: "Choose a currency.", // 18 C-PREF-9
  currencyHelp: "Only currencies Eve has an exchange rate for can be chosen. Jobs paying in other currencies are still found and marked Unverified for pay.", // 20 C-PREF-CUR-HELP
  familiesTitle: "Role families", // 21 prefs.families.title
  tier: { 1: "Tier 1", 2: "Tier 2", 3: "Tier 3", excluded: "Excluded" }, // 23 to 26
  keywordLabel: "Job title must contain", // 38 prefs.keyword.label
  keywordActive: (keyword: string) => `Eve only applies to jobs whose title contains "${keyword}".`, // 42 prefs.keyword.active
  keywordInfoEmpty: "This has no letters or numbers to match, so no keyword rule applies.", // 43 prefs.keyword.info.empty
  seniority: "Seniority levels", // 46 C-PREF-12
  seniorityOptions: ["Junior", "Mid", "Senior", "Staff", "Principal"], // 46
  employment: "Employment types", // 47 C-PREF-13
  employmentOptions: ["Direct", "Employer of record", "Contract"], // 47
  dailyCap: "Automatic submissions per day", // 48 C-PREF-14
  capOption: (n: number) => `${n} per day`, // 108 prefs.cap.optionSr
  saveHelp: "Saving re-checks the jobs Eve already found against your saved keyword and role families. It sends no applications.", // 51 prefs.save.help (B1 interim)
  saveHelpSettings:
    "This saves Job preferences only. It re-checks the jobs Eve already found against your saved keyword and role families. It sends no applications.", // 51 prefs.save.help, Settings variant (copy-b1.md; settings-b1.feature:127)
  saved: "Preferences saved.", // 53 C-PREF-SAVED
  appliesPattern: /^Saved .+\. Eve re-checked the jobs it already found\. Jobs your changes let back in wait for their next check\.$/, // 54 prefs.save.applies
  appliesLater:
    "Eligibility changes, like pay or hours, apply from each job's next check. Queued jobs are checked again before they're sent; sent applications keep their results.", // 55 prefs.save.appliesLater
  retiredApplies: "Changes apply to the next check", // C-PREF-APPLIES (retired in B1; must be absent)
  errorNetwork: "Couldn't save your preferences. Nothing changed, and your edits are still here. Try again.", // 56 prefs.save.error.network
  errorNetworkButton: "Try again", // 56
  errorRateLimited: "Too many saves this minute. Nothing changed. Wait up to a minute, then save again.", // 57 prefs.save.error.rateLimited
  saveSettings: "Save preferences", // 102 prefs.save.primary.settings
  saveWizard: "Save and continue", // 103 prefs.save.primary.wizard
  wizardTitle: "Job preferences", // 60 C-WIZ-S3-T

  // Jobs: four tabs since the manual-apply lane (AC-4.5; Manual apply added after EPIC-0011 R4), copy deck jobs.*
  // (PROPOSAL except where noted). The old four tabs (Ranked, Skipped by rules, Excluded families, All) are now
  // Good matches, Manual apply, Not a match (two stacked lists: the old Skipped by rules, then the old Excluded
  // families) and All.
  tabs: ["Good matches", "Manual apply", "Not a match", "All"], // jobs.tab.good / .manual / .notMatch / .all (EXACT)
  retiredTabs: ["Ranked", "Skipped by rules", "Excluded families"],
  retiredSkippedTab: "Skipped and excluded",
  notMatchRulesHeading: "Doesn't fit your criteria", // PROPOSAL (FE copy gap, progress-fe.md)
  notMatchFamiliesHeading: "Outside your role families", // PROPOSAL (FE copy gap)
  rankedEmptyTitle: "No good matches yet", // jobs.empty.good title
  rankedEmptyText: "Jobs that fit your profile appear here. Paste one on Home or set up alerts.", // jobs.empty.good
  skippedEmptyTitle: "Nothing ruled out", // jobs.empty.notMatch title
  skippedEmptyText: "Jobs Eve rules out appear here, with the reason.", // jobs.empty.notMatch
  excludedNoneTitle: "No excluded role families", // 71
  excludedNoneText: "Set a role family to Excluded in your job preferences and its postings move here. Eve never applies to them.", // 72
  excludedSomeTitle: "No postings in your excluded families", // 73
  excludedSomeText: "Postings in a role family you excluded show here. Eve never applies to them.", // 74
  allExcludedHint: "Postings in excluded role families aren't listed here. See Not a match.", // 75 (link opens Not a match)
  allExcludedHintLink: "Not a match", // 75 link text
  restarted: (countLine: string) => `The list started over from the top. ${countLine}.`, // 76
  countPartial: (loaded: number, n: number) => `Showing ${loaded} of ${n} postings`, // 79
  filterEmptyTitle: "No postings match these filters", // 83
  filterEmptyText: "Try fewer words in the title search or more role families.", // 84
  // EPIC-0011 R4 reworded the reason lines to drop "Skipped:" (the five posting words; copy deck status.reason.*).
  rowSkipFamily: (family: string) => `${family} is outside the role families you picked.`, // 86
  rowSkipKeyword: "The title doesn't contain your saved keyword.", // 87
  detailSkipFamily: (family: string) => `${family} is outside the role families you picked, so Eve won't apply to it.`, // 88
  detailSkipKeyword: (keyword: string) => `The title doesn't contain "${keyword}", your saved keyword, so Eve won't apply to it.`, // 89
  changePrefs: "Change job preferences", // 91 postingDetail.changePrefs
  familyFrontend: "Frontend", // 29 postings.family.senior_frontend
  familyMobile: "Mobile", // 34
  retiredFrontend: "Senior frontend",

  // Built Job Postings controls (slice 8, unchanged)
  searchLabel: "Search job titles",
  familyTrigger: "Role family",
  loadMore: "Load more",
  // Slice 8 deck (copy-deck-slice-08-postings-paging-filter.r2.md, latest revision of these slots)
  loadMoreRetry: "Try again", // postings.loadMore.retry
  loadMoreError: "Couldn't load more postings. The ones above are still here.", // postings.loadMore.error
  announceLoadFailed: "Couldn't load more postings. The ones above are still here.", // postings.announce.loadFailed
} as const
