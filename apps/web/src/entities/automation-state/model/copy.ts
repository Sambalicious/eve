/** Pause, cost and ceiling copy from design-spec.r4.md (F10, C-PAUSE-*, C-COST-*, C-VAL-COST-*, C-CONFIRM-10, C-CONFIRM-18). Exact strings. */
export const automationCopy = {
  pause: {
    pause: "Pause automation",
    resume: "Resume automation",
    /** C-PAUSE-1. */
    paused: "Automation paused. Running work stops within a minute.",
    /** C-PAUSE-2. */
    banner: "Automation is paused. No discovery, document generation or submission runs until you resume.",
    /** C-PAUSE-3. */
    resumed: "Automation resumed.",
    /** C-CONFIRM-10. */
    confirmResume: {
      title: "Resume automation?",
      body: "Discovery, document generation and submission start again under your current rules and today's cap.",
      confirm: "Resume automation",
    },
  },
  cost: {
    /** C-COST-1. */
    banner: (ceiling: string, resumes: string) =>
      `Paid automation is paused because the next paid action would have taken this month's spend over USD ${ceiling}. It resumes on its own at 00:00 WAT on ${resumes}. Your other pause setting is unchanged.`,
    raise: "Raise this month's ceiling",
    seeSpend: "See spend",
    /** C-COST-2. */
    ofCeiling: (spent: string, ceiling: string) => `USD ${spent} of USD ${ceiling} this month`,
    /** Spend card second line. */
    ofCeilingShort: (ceiling: string) => `of USD ${ceiling} this month`,
    /** Accessibility: spend bar name. */
    barLabel: (spent: string, ceiling: string) => `USD ${spent} of USD ${ceiling} spent this month`,
    /** C-COST-3. */
    nearCeiling: (percent: number, ceiling: string) =>
      `You've used ${percent}% of this month's ceiling. Paid automation pauses before it goes over USD ${ceiling}.`,
    /** Home status card title while cost-paused, and C-COST-4. */
    pausedForCost: "Paused for cost",
    resumesLine: (resumes: string) => `Resumes 00:00 WAT on ${resumes}, or when you raise this month's ceiling.`,
    /** C-COST-5. */
    ceilingRow: "This month's ceiling",
    ceilingValue: (ceiling: string) => `USD ${ceiling} this month`,
    defaultHelp: (defaultCeiling: string, month: string) => `USD ${defaultCeiling} is the monthly ceiling. Raising it applies to ${month} only.`,
    raisedHelp: (month: string, defaultCeiling: string, returns: string) => `Raised for ${month}. It returns to USD ${defaultCeiling} on ${returns}.`,
    /** C-COST-8. */
    raisedToast: (ceiling: string) => `This month's ceiling is now USD ${ceiling}.`,
    title: "Monthly cost",
    spendTitle: "Spend",
    seeBreakdown: "See breakdown",
    categories: { hosting: "Hosting", ai: "AI", browser: "Browser", discovery: "Discovery", email: "Email" },
    categoryColumn: "Category",
    amountColumn: "USD",
  },
  raise: {
    title: "Raise this month's ceiling",
    spent: (spent: string) => `Spent this month: USD ${spent}`,
    current: (ceiling: string) => `Current ceiling: USD ${ceiling}`,
    field: (month: string) => `New ceiling for ${month}`,
    fieldSr: (month: string) => `New ceiling for ${month}, in US dollars`,
    /** C-COST-7. */
    help: (max: string, month: string, returns: string, defaultCeiling: string) =>
      `You can raise it to at most USD ${max}. It applies until the end of ${month}, and on ${returns} the ceiling returns to USD ${defaultCeiling}. If the new ceiling leaves room for the next paid action, paid automation resumes now.`,
    continue: "Continue",
    close: "Close",
    /** C-COST-9. */
    atLimit: (max: string, resumes: string) => `This month's ceiling is already USD ${max}, the most it can be. Paid automation resumes at 00:00 WAT on ${resumes}.`,
    spendAtLimit: (spent: string, max: string, resumes: string) =>
      `This month's spend is USD ${spent}, which is at or above the USD ${max} limit, so the ceiling can't be raised. Paid automation resumes at 00:00 WAT on ${resumes}.`,
    /** C-CONFIRM-18. */
    confirm: {
      title: (next: string) => `Raise this month's ceiling to USD ${next}?`,
      body: (next: string, month: string, difference: string, returns: string, defaultCeiling: string) =>
        `Paid automation can spend up to USD ${next} in ${month}, USD ${difference} more than now. On ${returns} the ceiling returns to USD ${defaultCeiling}.`,
      action: "Raise ceiling",
    },
  },
  /** C-VAL-COST-1 to 5. */
  validation: {
    empty: "Enter the new ceiling in USD.",
    invalid: "Enter an amount like 60 or 62.50.",
    notAboveCurrent: (ceiling: string) => `Enter more than USD ${ceiling}, this month's current ceiling.`,
    aboveLimit: "Enter USD 100.00 or less. That's the most this month's ceiling can be.",
    notAboveSpend: (spent: string, ceiling: string) =>
      `This month's spend is already USD ${spent}, above the current ceiling of USD ${ceiling}. Enter more than USD ${spent} so there's room for the next paid action.`,
  },
} as const
