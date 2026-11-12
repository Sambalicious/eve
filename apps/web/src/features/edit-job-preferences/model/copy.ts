import type { IndustryKey, SeniorityLevel } from "@/entities/job-preferences"

/**
 * Job Preferences copy, byte-exact from `.runs/epic-0002-b1/reports/copy-b1.md`
 * (keys in comments; copy-deck.r6 "B1 interim" wins over r4).
 */
export const prefsCopy = {
  /** 94 `prefs.settings.title`. */
  settingsTitle: "Job preferences",
  /** 1 `C-PREF-CONFLICT` (D30). */
  conflict: {
    text: "Your preferences changed in another tab. Reload to see the latest. Your edits here aren't saved.",
    action: "Reload preferences",
  },
  /** 2 `C-PREF-SUM`. */
  summary: (n: number) => `Fix ${n} field(s) before saving:`,
  section: {
    /** 95 to 101. */
    locationHours: "Location and hours",
    workArrangement: "Work arrangement",
    exclusions: "Exclusions",
    pay: "Pay",
    seniorityEmployment: "Seniority and employment",
    dailyCap: "Daily cap",
    documentEmphasis: "Document emphasis",
  },
  /** 3 `C-PREF-1`. */
  home: { label: "Home country", help: "Where you live now.", error: "Choose your home country." },
  /** 4 `C-PREF-2`. */
  timeZone: { label: "Time zone", help: "Set from your home country. Change it if yours differs.", error: "Choose a time zone." },
  /** 5 `C-PREF-3`. */
  hour: {
    label: "Latest work hour",
    help: "Eve skips jobs whose regular hours end after this time. Work ending exactly at this time is fine.",
    error: "Choose a time from 01:00 to 23:59.",
  },
  /** 6 `C-PREF-4`, 7 `C-PREF-HOME-LOCK`. */
  workAuth: { label: "Countries you can work in without sponsorship", help: "Your home country is always included.", locked: "Your home country is always included." },
  /** 8 `C-PREF-HOME-CHANGED`. */
  homeChanged: (next: string, old: string) =>
    `${next} is now included in your work authorization. ${old} is still there; remove it if it no longer applies. Check your time zone and latest work hour.`,
  /** 9 `C-PREF-HOME-UNEXCLUDED`. */
  homeUnexcluded: (next: string) => `${next} was removed from countries you won't relocate to.`,
  /** 14 `C-PREF-5`. */
  arrangement: { label: "Work arrangement", remote: "Remote", relocation: "Relocation", both: "Both", error: "Choose remote, relocation or both." },
  /** 15 `C-PREF-6`. */
  sponsorship: { label: "Do you need visa sponsorship to relocate to other countries?", yes: "Yes", no: "No", help: "Only for countries outside your work authorization list." },
  /** 16 `C-PREF-7`. */
  excludedCountries: { label: "Countries you won't relocate to", error: "Your home country can't be excluded." },
  /** 17 `C-PREF-8`. */
  industries: {
    label: "Industries to avoid",
    option: {
      adult_content: "Adult content",
      video_games_and_gaming_platforms: "Video games and gaming platforms",
      gambling: "Gambling",
      betting: "Betting",
      crypto_and_web3: "Crypto and web3",
      weapons_and_defense: "Weapons and defense",
      tobacco_and_vaping: "Tobacco and vaping",
    } satisfies Record<IndustryKey, string>,
  },
  /** 18 `C-PREF-9`, 19 `C-PREF-10`, 20 `C-PREF-CUR-HELP`, 104 to 107. */
  pay: {
    /** `currencyLabel`: copy-deck.r6 `prefs.pay.*.currencyLabel` (DP-B1-05), the select's name and summary link. */
    floor: { label: "Lowest pay you'll accept (gross)", help: "Jobs whose published maximum is below this are skipped.", currencyLabel: "Currency for lowest pay you'll accept" },
    preferred: { label: "Pay you'd like (net)", help: "Used when a form asks for expected salary. Kept separate from the floor.", currencyLabel: "Currency for pay you'd like" },
    amountError: "Enter an amount above 0 with at most 2 decimals.",
    currencyError: "Choose a currency.",
    currencyHelp:
      "Only currencies Eve has an exchange rate for can be chosen. Jobs paying in other currencies are still found and marked Unverified for pay.",
    period: { month: "Month", year: "Year" },
    suffix: { gross: "gross", net: "net" },
  },
  /** 21 to 28. */
  families: {
    title: "Role families",
    help: "Tier 1 jobs rank first. Excluded families are skipped.",
    tier: { 1: "Tier 1", 2: "Tier 2", 3: "Tier 3", excluded: "Excluded" },
    excludedNote: "Postings in an excluded family go to the Not a match tab. Eve never applies to them.",
    /** copy-deck.r6 `prefs.families.b1.*` (B1 only; B2 removes). */
    hiddenTag: "Hidden",
    hiddenNote: (n: number) =>
      n === 1
        ? "1 family is hidden by Job criteria, so its tier has no effect until you select it there."
        : `${n} families are hidden by Job criteria, so their tier has no effect until you select them there.`,
    criteriaLink: "Go to Job criteria",
    criteriaHref: "/settings#job-criteria",
    noneTiered: "Put at least one role family in a tier.",
  },
  /** 38 to 45. */
  keyword: {
    label: "Job title must contain",
    optional: "Optional",
    help: "Eve skips jobs whose title doesn't contain this and never applies to them. Case and accents are ignored. Leave it blank to allow any title.",
    placeholder: "e.g. React",
    active: (keyword: string) => ({ before: "Eve only applies to jobs whose title contains \"", keyword, after: "\"." }),
    infoEmpty: "This has no letters or numbers to match, so no keyword rule applies.",
    tooLong: "Keep the keyword to 100 characters.",
    control: "Remove hidden control characters from the keyword.",
  },
  /** 46 `C-PREF-12`. */
  seniority: {
    label: "Seniority levels",
    option: { junior: "Junior", mid: "Mid", senior: "Senior", staff: "Staff", principal: "Principal" } satisfies Record<SeniorityLevel, string>,
    error: "Choose at least one seniority level.",
  },
  /** 47 `C-PREF-13`. */
  employment: {
    label: "Employment types",
    option: { direct: "Direct", employer_of_record: "Employer of record", contract: "Contract" },
    error: "Choose at least one employment type.",
  },
  /** 48 `C-PREF-14`, 49 `C-PREF-CAP-WARN`, 108 `prefs.cap.optionSr`. */
  cap: {
    label: "Automatic submissions per day",
    help: "Counted in your time zone. 1 to 5.",
    warn: (count: number) => `You've already had ${count} automatic submissions today. No more will be sent today.`,
    optionSr: (n: number) => `${n} per day`,
  },
  /** 50 `C-PREF-15`, 109 `prefs.themes.count`. */
  themes: {
    label: "Themes to lead with (optional)",
    help: "Up to 3 short phrases. Eve still only uses facts from your Career Profile.",
    error: "Keep each theme to 60 characters.",
    count: (n: number) => `${n}/60`,
  },
  save: {
    /** 51 (B1 interim). */
    /** `prefs.save.help` (wizard, B1). */
    help: "Saving re-checks the jobs Eve already found against your saved keyword and role families. It sends no applications.",
    /** `prefs.save.help` (Settings, B1): Settings has two other saves. */
    helpSettings: "This saves Job preferences only. It re-checks the jobs Eve already found against your saved keyword and role families. It sends no applications.",
    /** 52. */
    saving: "Saving…",
    /** 102, 103. */
    primarySettings: "Save preferences",
    primaryWizard: "Save and continue",
    /** 53 `C-PREF-SAVED`. */
    saved: "Preferences saved.",
    /** 54, 55. */
    applies: (when: string) => `Saved ${when}. Eve re-checked the jobs it already found. Jobs your changes let back in wait for their next check.`,
    appliesLater:
      "Eligibility changes, like pay or hours, apply from each job's next check. Queued jobs are checked again before they're sent; sent applications keep their results.",
    /** 56. */
    network: { text: "Couldn't save your preferences. Nothing changed, and your edits are still here. Try again.", action: "Try again" },
    /** 57. */
    rateLimited: "Too many saves this minute. Nothing changed. Wait up to a minute, then save again.",
  },
  /** 59 `C-CONFIRM-E2-1`. */
  leave: { title: "Leave without saving?", body: "Changes on this step aren't saved yet.", stay: "Stay", leave: "Leave without saving" },
  /** 60 to 62. */
  wizard: {
    title: "Job preferences",
    lead: "Eve only applies to jobs that fit these. You can change them later in Settings.",
    error: { text: "Couldn't save this step. Your answers are still here. Try again.", action: "Try again" },
    offline: "You're offline. Your answers are still here. Save again when you're back online.",
  },
} as const
