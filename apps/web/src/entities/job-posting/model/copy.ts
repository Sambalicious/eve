import { coveragePercent, type EmploymentType, type EvaluationFailure, type JobPosting, type RoleFamily, type RuleName, type RuleResult } from "./job-posting"

/** Copy from design-spec.r4.md (copy catalogue, status vocabulary). Exact strings. */
export const jobPostingCopy = {
  pageTitle: "Jobs",
  /** Copy deck jobs.description (PROPOSAL). */
  pageDescription: "Jobs Eve found and jobs you pasted, with how well each fits your profile.",
  /** Headings when Not a match shows two stacked sections (PROPOSAL). */
  notMatchSections: { rules: "Doesn't fit your criteria", families: "Outside your role families" },
  /** copy-b1 keys 63 to 66 (`postings.tabs.*`, D17). */
  tabs: { good: "Good matches", manual: "Manual apply", not_a_match: "Not a match", all: "All" },
  ruleLabel: {
    location: "Location",
    sponsorship: "Sponsorship",
    pay: "Pay",
    hours: "Hours",
    industry: "Industry",
    /** copy-b1 keys 122, 123 (D44). */
    seniority: "Seniority",
    employment_type: "Employment type",
  } satisfies Record<RuleName, string>,
  /** copy-b1 key 124: `{rule}` inside "Unverified: {rule}" and "Excluded: violated {rule} rule.". */
  ruleInlineLabel: {
    location: "location",
    sponsorship: "sponsorship",
    pay: "pay",
    hours: "hours",
    industry: "industry",
    seniority: "seniority",
    employment_type: "employment type",
  } satisfies Record<RuleName, string>,
  resultLabel: {
    met: "Met",
    unverified: "Unverified",
    violated: "Violated",
    not_applicable: "Not applicable",
  } satisfies Record<RuleResult, string>,
  /** "Unverified: {rule}" labels (eligibility.feature). */
  unverified: (rule: RuleName) => `Unverified: ${ruleInline(rule)}`,
  allRulesMet: "All rules met",
  postingDoesntSay: "The posting doesn't say.",
  /** C-ELIG-1. */
  sponsorshipNotApplicable: "Remote from Nigeria, so sponsorship doesn't apply.",
  /** copy-b1 keys 125 to 128 (D44). */
  seniorityNotApplicable: "You accept every seniority level, so this doesn't apply.",
  seniorityNoLevel: "The job title doesn't state a level.",
  employmentTypeNotApplicable: "You accept every employment type, so this doesn't apply.",
  employmentTypeStated: (type: string) => `Stated in the posting: ${type}.`,
  normalizedPay: (usd: string) => `Normalized: USD ${formatUsd(usd)} per month gross`,
  strongMatch: "Strong core Match",
  weakMatch: "Weak core Match",
  notCovered: "Not covered",
  noCoreFound: "None found in the posting.",
  /** C-MATCH-1. */
  matchRule: (threshold: number) =>
    `A strong core Match needs at least ${threshold}% of the core responsibilities backed by a fact in your Career Profile, and no unmet mandatory requirement.`,
  /** C-MATCH-2. */
  matchCoverage: (covered: number, total: number, percent: number) =>
    `${covered} of ${total} core responsibilities backed by a fact (${percent}%).`,
  /** C-MATCH-3, singular and plural forms. */
  weakUnmet: (requirement: string, count: number) =>
    count > 1
      ? `Weak because ${count} mandatory requirements aren't met, starting with "${requirement}". No fact in your Career Profile covers them.`
      : `Weak because a mandatory requirement isn't met: "${requirement}". No fact in your Career Profile covers it.`,
  /** C-MATCH-4. */
  weakCoverage: (percent: number, threshold: number) =>
    `Weak because only ${percent}% of the core responsibilities are backed by a fact. It needs ${threshold}%.`,
  /** C-MATCH-5. */
  weakNoCore:
    "Weak because the assistant couldn't find any core responsibilities in this posting, so there's nothing to match against.",
  matchGroups: {
    core: "Core responsibilities",
    mandatory: "Mandatory prerequisites",
    niceToHave: "Nice-to-have",
  },
  status: {
    checking: "Checking",
    waiting: "Waiting to be checked",
  },
  /** C-SKIP-1 to C-SKIP-4a. */
  skip: {
    violated: (rule: string) => violatedRuleLine(rule),
    uncovered: (prerequisite: string) => `Your profile doesn't show a required prerequisite for this job: "${prerequisite}".`,
    /** Copy deck posting.detail.applyOnSite (EXACT). The Application System name is no longer shown. */
    unsupported: () => "You'll apply on the employer's site",
    /** C-SKIP-4: now only the fallback when a weak_core_match row has no numbers. */
    weak: "Your profile doesn't back enough of the core responsibilities.",
    /** EPIC-0004 C-JC-SKIP-WEAK (fixed). {p} = floor(covered × 100 / total), {t} = the decision's threshold. */
    weakBelow: (percent: number, threshold: number) => `Your profile backs only ${percent}% of the core responsibilities. Your minimum is ${threshold}%.`,
    /** EPIC-0004 C-JC-SKIP-TECH (fixed). */
    technology: "This job doesn't mention the technologies you told Eve to look for.",
    noCore: "Eve found no core responsibilities in this job, so it can't check the match.",
  },
  /** Status vocabulary: "Manual Application", secondary badge. */
  manualApplication: "Manual Application",
  via: (name: string) => `via ${name}`,
  openEmployerPage: "Open employer page",
  showFullPosting: "Show full posting",
  showLess: "Show less",
  employmentTypeLabel: "Employment type",
  roleFamilyLabel: "Role family",
  applicationSystemLabel: "Application System",
  requisitionLabel: "Requisition ID",
  /** C-EMPTY-2. */
  emptyFirstRun: {
    title: "No jobs yet",
    /** Copy deck jobs.empty.all (PROPOSAL). */
    text: "Every job Eve finds or you paste appears here. Paste one on Home to start.",
    action: "Find jobs",
  },
  /** Ranked tab empty, later. */
  emptyRanked: {
    title: "No good matches yet",
    /** Copy deck jobs.empty.good (PROPOSAL). */
    text: "Jobs that fit your profile appear here. Paste one on Home or set up alerts.",
  },
  /** copy-b1 keys 69 to 75 (EPIC-0002 B1, F18a). */
  emptyManual: {
    title: "No manual applications",
    /** v1.28.0 manual lane: jobs Eve cannot submit for the Candidate, kept as work they can do by hand. */
    text: "Jobs Eve can't submit for you appear here. Eve prepares the documents; you apply on the employer's site.",
  },
  emptySkipped: {
    title: "Nothing ruled out",
    /** Copy deck jobs.empty.notMatch (PROPOSAL). */
    text: "Jobs Eve rules out appear here, with the reason.",
  },
  emptyExcludedNone: {
    title: "No excluded role families",
    text: "Set a role family to Excluded in your job preferences and its postings move here. Eve never applies to them.",
  },
  emptyExcludedSome: {
    title: "No postings in your excluded families",
    text: "Postings in a role family you excluded show here. Eve never applies to them.",
  },
  /** `postings.allExcludedHint`: "Not a match" is the link text. */
  allExcludedHint: { before: "Postings in excluded role families aren't listed here. See ", link: "Not a match", after: "." },
  /** copy-b1 keys 88 to 91 (B-POST-2). */
  detailSkip: {
    excludedFamily: (family: string) => `${family} is outside the role families you picked, so Eve won't apply to it.`,
    keyword: (keyword: string) => `The title doesn't contain "${keyword}", your saved keyword, so Eve won't apply to it.`,
    keywordNoDetail: "The title doesn't contain your saved keyword, so Eve won't apply to it.",
  },
  changePrefs: "Change job preferences",
  /** Where "Change job preferences" leads. */
  prefsHref: "/settings#preferences",
  /** C-ERR-3 for a posting. */
  notFound: {
    title: "Not found",
    text: "This Job Posting doesn't exist or its records were cleared.",
    action: "Back to Job Postings",
  },
  /** C-ERR-4. */
  pollTimedOut: "This is taking longer than usual. Refresh later to see the result.",
  /** EPIC-0004 copy deck (copy-deck.md). Fixed strings are byte-exact. */
  criteria: {
    /** C-JC-ROW-NOTCHECKED and C-JC-TECH-NOTCHECKED. */
    notChecked: "Technologies not checked",
    /** C-JC-TECH-NOTCHECKED-BODY. */
    notCheckedBody:
      "Eve checked this posting before it read technologies, so the technology rule wasn't applied. It gets them on its next check.",
    /** C-JC-EMPTY-TITLE, C-JC-EMPTY-BODY, C-JC-EMPTY-ACTION. */
    emptyTitle: "No postings meet your job criteria.",
    /** copy-deck.r6 "B1 interim": names the renamed tab. */
    emptyBody: "Postings Eve ruled out are on the Not a match tab, each with its reason. Nothing was deleted.",
    change: "Change job criteria",
    /** Where "Change job criteria" leads. */
    settingsHref: "/settings#job-criteria",
    /** C-JC-TECH-TITLE. */
    technologiesTitle: "Technologies mentioned",
    /** C-JC-TECH-IN. */
    inCriteria: "In your criteria",
    /** C-JC-TECH-MATCHCOUNT, singular when m = 1. */
    matchCount: (m: number, n: number) => (m === 1 ? `1 of ${n} is in your criteria.` : `${m} of ${n} are in your criteria.`),
    /** C-JC-TECH-NOMATCH. */
    noMatch: "None of these is in your criteria.",
    /** C-JC-TECH-NONE. */
    none: "None found in the posting.",
    /** C-JC-TECH-SHOWALL / C-JC-TECH-SHOWLESS. */
    showAll: (n: number) => `Show all ${n}`,
    showLess: "Show less",
    /** C-JC-TECH-QUOTE-SR. */
    quotePrefix: "From the posting:",
    /** Matched-row accessible name (copy-deck Accessibility text). */
    rowLabelInCriteria: (name: string) => `${name}, in your criteria`,
  },
} as const

/** EPIC-0006 copy deck `family.*` (AC-1.2): one label per family, the same on every surface. */
export const roleFamilyLabel: Record<RoleFamily, string> = {
  senior_frontend: "Frontend",
  technical_lead: "Hands-on technical lead",
  fullstack: "Fullstack",
  product_engineering: "Product engineering",
  software_engineering: "Software engineering",
  backend: "Backend",
  mobile: "Mobile",
  platform_engineering: "Platform engineering",
  devops_platform: "DevOps and SRE",
  people_management: "Engineering management",
  data_ml: "Data and ML",
  solutions_customer: "Solutions and customer engineering",
  other: "Other",
}

/** From the E1 email template line "Employment type: …". */
export const employmentTypeLabel: Record<EmploymentType, string> = {
  direct: "Direct employment",
  employer_of_record: "Employer of record",
  contract: "Independent contractor",
}

/** EPIC-0006 copy deck `posting.failure.*` (AC-7.7): retryable kinds name Check again, never "paste the link again". */
export const evaluationFailureLine: Record<EvaluationFailure, string> = {
  not_approved: "Not checked: Anthropic isn't approved yet.",
  not_configured: "Not checked: the Anthropic API key isn't set on the server. Set it there, then use Check again.",
  provider_error: "Not checked: Anthropic didn't answer. Use Check again on Jobs to retry.",
  invalid_output: "Not checked: the AI answer couldn't be used. Use Check again on Jobs to retry.",
  timed_out: "Not checked: the check took too long. Use Check again on Jobs to retry.",
  no_career_profile: "Not checked: the Career Profile isn't approved. Approve it, then use Check again.",
  posting_unavailable: "Not checked: the posting couldn't be read.",
}

/**
 * The skip line a posting shows, or null when it has no reason. A
 * `weak_core_match` line names the stored coverage and the decision's
 * threshold (C-JC-SKIP-WEAK); without numbers it falls back to C-SKIP-4.
 */
export /** Copy deck home.result.reason.* (PROPOSAL): the four rules that can't be overridden keep their own line. */
const RULE_LINES: Readonly<Record<string, string>> = {
  location: "This job needs a location that doesn't fit your criteria.",
  sponsorship: "This job doesn't offer the sponsorship you need.",
  pay: "The pay is below your minimum.",
  hours: "The hours don't fit your criteria.",
}

function violatedRuleLine(rule: string): string {
  return RULE_LINES[rule.trim().toLowerCase()] ?? `This job doesn't fit your ${ruleInline(rule)} rule.`
}

export function skipLine(
  posting: Pick<JobPosting, "skipReason" | "skipDetail" | "applicationSystem" | "coverage"> & Partial<Pick<JobPosting, "roleFamily">>
): string | null {
  const { skipReason: reason, skipDetail: detail, coverage } = posting
  switch (reason) {
    case "violated_rule":
      return jobPostingCopy.skip.violated(detail ?? "")
    case "uncovered_mandatory_prerequisite":
      return jobPostingCopy.skip.uncovered(detail ?? "")
    case "unsupported_application_system":
      return jobPostingCopy.skip.unsupported()
    case "weak_core_match":
      return coverage && coverage.total > 0
        ? jobPostingCopy.skip.weakBelow(coveragePercent(coverage.covered, coverage.total), coverage.thresholdPercent)
        : jobPostingCopy.skip.weak
    case "no_core_responsibilities":
      return jobPostingCopy.skip.noCore
    case "technology_mismatch":
      return jobPostingCopy.skip.technology
    case "not_software_role":
      return NOT_SOFTWARE_LINE
    // Contract v1.25.0 (EPIC-0002 B1), copy-b1 keys 86 and 87 (`postings.list.skipExcludedFamily`, `postings.list.skipKeyword`).
    case "excluded_role_family":
      return `${posting.roleFamily ? roleFamilyLabel[posting.roleFamily] : "This role"} is outside the role families you picked.`
    case "keyword_mismatch":
      return "The title doesn't contain your saved keyword."
    case null:
      return null
  }
}

/** OPEN[designer] FE3-1: contract says "(none)" for this reason; a row still needs a reason line. */
const NOT_SOFTWARE_LINE = "This isn't a software engineering role."

/** "2000.27" to "2,000.27". */
function formatUsd(value: string): string {
  const [whole, cents = "00"] = value.split(".")
  return `${Number(whole).toLocaleString("en-US")}.${cents.padEnd(2, "0")}`
}

/** The inline rule name (copy-b1 key 124); an unknown detail stays as sent. */
function ruleInline(rule: string): string {
  return (jobPostingCopy.ruleInlineLabel as Record<string, string>)[rule] ?? rule
}
