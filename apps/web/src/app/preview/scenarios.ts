import type { ApplicationDetail, JobPostingDetail, MeResponse, Submission } from "@eve/contracts"
import { inviteeMe, operatorMe } from "@/shared/testing/me-api"

import { approvedState, defaultJobCriteria, version, type CareerSetupState } from "@/shared/testing/career-setup-api"
import { storedOverride } from "@/shared/testing/apply-anyway-fake"
import { dated, pastedPosting, rankedPosting, strongMatch, UNDATED, type DiscoveryState } from "@/shared/testing/discovery-api"
import { preferencesRecord, type PreferencesApiState } from "@/shared/testing/preferences-api"
import { DEFAULT_ROLE_FAMILY_TIERS } from "@eve/contracts"
import { readyApplication } from "@/shared/testing/documents-api"
import { submission } from "@/shared/testing/submission-api"
import { FEED_A, FEED_B, HFEED_A, HFEED_B, storedFeed, storedPost, verifiedOn20Oct, type StackPostsApiState } from "@/shared/testing/stack-posts-api"

/**
 * Designer-preview scenarios for EPIC-0006 (dev only, never in a build). Each
 * seeds the contract fakes; open `/<route>?scenario=<name>` on the preview server
 * (`EVE_PREVIEW=1 vite`) or the links in `frontend-spec.md`.
 */
export interface PreviewScenario {
  readonly description: string
  /** EPIC-0011: the `GET /v1/me` body (default: the Operator with Advanced on). */
  readonly me?: MeResponse
  /** EPIC-0011: Outcomes seeded by Application id, oldest first, so the board has cards in every column. */
  readonly outcomes?: readonly { applicationId: string; type: "confirmation" | "rejection" | "interview_invitation" | "request_for_action" | "offer" }[]
  readonly discovery: Partial<DiscoveryState>
  readonly career?: Partial<CareerSetupState>
  /** EPIC-0007 Phase 3: Stack posts and Hiring feeds, record and posts. */
  readonly stack?: Partial<StackPostsApiState>
  /** EPIC-0002 B1: the session Candidate's Job Preferences. */
  readonly preferences?: Partial<PreferencesApiState>
  /** Apply anyway (v1.24.0): Applications with their Submissions, and a forced answer for the next create. */
  readonly applications?: readonly { readonly app: ApplicationDetail; readonly submission: Submission }[]
  /** EPIC-0011 F8: `GET /v1/me` answers writes (`PUT /v1/me/advanced`) with a server error. */
  readonly meFailWrites?: boolean
  /** EPIC-0011 F8: `POST /v1/applications/:id/outcomes` (board moves) fails with a server error. */
  readonly outcomeWritesFail?: boolean
  /** EPIC-0011 F8: a failed email in `GET /v1/notifications/status` (Home alert). */
  readonly emailFailure?: "confirmed_submission" | "blocked_application" | "daily_summary" | "cost_pause"
  /** EPIC-0011 F8: background resume drafting finishes this long after the upload, so Upload step 2 can be seen. */
  readonly finishDraftingAfterMs?: number
  readonly nextCreate?: "network" | "override_decision_changed" | "override_not_allowed" | "posting_hidden" | "override_application_state"
  /** The next remove-from-queue answers this way once. */
  readonly nextRemove?: "network" | "conflict"
}

/** The stored, hidden link the `paste-hidden` scenario answers as "already have". */
export const PASTE_KNOWN_URL = "https://jobs.lever.co/hooli/junior-fe"

/** Fixed ids so frontend-spec.md can link to each hidden detail page. */
export const previewIds = {
  hiddenOff: "60000000-0000-4000-8000-000000000001",
  hiddenEntry: "60000000-0000-4000-8000-000000000002",
  hiddenUndated: "60000000-0000-4000-8000-000000000003",
  hiddenOld: "60000000-0000-4000-8000-000000000004",
  visible: "60000000-0000-4000-8000-000000000005",
  notChecked: "60000000-0000-4000-8000-000000000006",
} as const

function board(): JobPostingDetail[] {
  const visible = rankedPosting({
    id: previewIds.visible,
    title: "Senior Frontend Engineer",
    company: "Globex",
    rank: 1,
    match: strongMatch(),
    attribution: { name: "Himalayas", url: "https://himalayas.app" },
    ...dated(45),
  })
  return [
    visible,
    rankedPosting({ title: "Staff Engineer", company: "Initech", rank: 2, roleFamily: "software_engineering", ...dated(38, "updated") }),
    rankedPosting({ title: "Hands-on Tech Lead", company: "Hooli", rank: 3, roleFamily: "technical_lead", attribution: { name: "We Work Remotely", url: "https://weworkremotely.com" }, ...dated(60, "updated") }),
    rankedPosting({ title: "Product Engineer", company: "Contoso", rank: 4, roleFamily: "product_engineering", ...dated(3) }),
    rankedPosting({ title: "Backend Engineer", company: "Umbrella", status: "skipped", rank: null, roleFamily: "backend", skipReason: "weak_core_match", match: { ...strongMatch(), verdict: "weak", weakReason: "coverage_below_threshold", coveredCount: 6, totalCount: 10 }, ...dated(12) }),
    rankedPosting({ id: previewIds.notChecked, title: "Platform Engineer", company: "Acme", status: "not_checked", rank: null, roleFamily: "platform_engineering", eligibility: null, ...dated(33) }),
    rankedPosting({ title: "Senior Fullstack Engineer", company: "Lumon", status: "evaluation_failed", rank: null, roleFamily: "fullstack", evaluationFailure: "provider_error", eligibility: null, ...dated(9) }),
    rankedPosting({ title: "iOS Engineer", company: "Pied Piper", status: "evaluation_failed", rank: null, roleFamily: "mobile", evaluationFailure: "not_configured", eligibility: null, ...dated(20) }),
    rankedPosting({ title: "Engineering Manager", company: "Vandelay", status: "evaluation_failed", rank: null, roleFamily: "people_management", evaluationFailure: "no_career_profile", eligibility: null, ...dated(2) }),
  ]
}

function hiddenOnes(): JobPostingDetail[] {
  const off = rankedPosting({ id: previewIds.hiddenOff, title: "Senior Data Engineer", company: "Initech", roleFamily: "data_ml", hiddenReason: "off_target", ...dated(4) })
  const entry = rankedPosting({ id: previewIds.hiddenEntry, title: "Junior Frontend Developer", company: "Hooli", hiddenReason: "below_seniority_floor", ...dated(4) })
  const undated = rankedPosting({ id: previewIds.hiddenUndated, title: "Senior Frontend Engineer", company: "Contoso", hiddenReason: "undated", ...UNDATED })
  const old = rankedPosting({
    id: previewIds.hiddenOld,
    title: "Solutions Architect",
    company: "Acme",
    roleFamily: "solutions_customer",
    status: "evaluation_failed",
    evaluationFailure: "not_configured",
    eligibility: null,
    hiddenReason: "older_than_60_days",
    ...dated(84),
  })
  return [off, entry, undated, old]
}

/** Fixed ids for the apply-anyway preview links (frontend report). */
export const aaIds = {
  weak: "70000000-0000-4000-8000-000000000001",
  uncovered: "70000000-0000-4000-8000-000000000002",
  noCore: "70000000-0000-4000-8000-000000000003",
  industry: "70000000-0000-4000-8000-000000000004",
  location: "70000000-0000-4000-8000-000000000005",
  rankedWithApp: "70000000-0000-4000-8000-000000000006",
  appOverride: "71000000-0000-4000-8000-000000000001",
  appInactive: "71000000-0000-4000-8000-000000000002",
  appHidden: "71000000-0000-4000-8000-000000000003",
  appLegacy: "71000000-0000-4000-8000-000000000004",
  appDropClosed: "71000000-0000-4000-8000-000000000005",
  appDropOther: "71000000-0000-4000-8000-000000000006",
  appQueuedPlain: "71000000-0000-4000-8000-000000000007",
  appBlocked: "71000000-0000-4000-8000-000000000008",
  appUncertain: "71000000-0000-4000-8000-000000000009",
  appRanked: "71000000-0000-4000-8000-00000000000a",
} as const

const LONG = "Active security clearance at the Secret level or higher, held continuously for the last five years and verifiable through the national vetting register"
const industryRules = (violated: readonly string[]) =>
  (["location", "sponsorship", "pay", "hours", "industry"] as const).map((rule) => ({ rule, result: violated.includes(rule) ? ("violated" as const) : ("met" as const), quote: null }))

function aaPostings(): JobPostingDetail[] {
  const weak = { ...strongMatch(), verdict: "weak" as const, weakReason: "coverage_below_threshold" as const, coveredCount: 6, totalCount: 10 }
  const excluded = (id: string, company: string, violated: string[]) => {
    const p = rankedPosting({ id, title: "Frontend Engineer", company, status: "excluded", rank: null, skipReason: "violated_rule", skipDetail: violated[0], ...dated(5) })
    return { ...p, eligibility: { ...p.eligibility!, rules: industryRules(violated) } }
  }
  return [
    rankedPosting({ id: aaIds.weak, title: "Senior Frontend Engineer", company: "Acme Payments", status: "skipped", rank: null, skipReason: "weak_core_match", match: weak, ...dated(3) }),
    rankedPosting({ id: aaIds.uncovered, title: "Staff Frontend Engineer, Payments Platform and Merchant Experience", company: "Initech International Holdings", status: "skipped", rank: null, skipReason: "uncovered_mandatory_prerequisite", skipDetail: LONG, ...dated(4) }),
    rankedPosting({ id: aaIds.noCore, title: "Frontend Engineer", company: "Contoso", status: "skipped", rank: null, skipReason: "no_core_responsibilities", ...dated(6) }),
    excluded(aaIds.industry, "Lucky Odds Ltd", ["industry"]),
    excluded(aaIds.location, "Umbrella", ["location"]),
    rankedPosting({ id: aaIds.rankedWithApp, title: "Frontend Lead", company: "Globex", rank: 1, ...dated(2) }),
  ]
}

/** EPIC-0010 fixed ids, so the design review can open each pasted screen. */
export const pdIds = {
  ranked: "70000000-0000-4000-8000-000000000001",
  skipped: "70000000-0000-4000-8000-000000000002",
  excluded: "70000000-0000-4000-8000-000000000003",
  checking: "70000000-0000-4000-8000-000000000004",
  linked: "70000000-0000-4000-8000-000000000005",
  /** Skipped and excluded with no Application: "Prepare documents" beside the warning, C-PD-43 last (DR coverage gap). */
  skippedNoApp: "70000000-0000-4000-8000-000000000006",
  excludedNoApp: "70000000-0000-4000-8000-000000000007",
  appNoLink: "70000000-0000-4000-8000-0000000000a1",
  appExcluded: "70000000-0000-4000-8000-0000000000a2",
}

const PD_LONG_TITLE = "Staff Frontend Engineer, Payments Platform and Merchant Experience (Remote, EMEA) ".repeat(2).trim()

function pdPostings(): JobPostingDetail[] {
  const weak = { ...strongMatch(), verdict: "weak" as const, weakReason: "coverage_below_threshold" as const, coveredCount: 6, totalCount: 10, thresholdPercent: 70 }
  const excluded = pastedPosting({ id: pdIds.excluded, title: PD_LONG_TITLE, company: "Initech International Holdings", status: "excluded", rank: null, skipReason: "violated_rule", skipDetail: "location" })
  return [
    pastedPosting({ id: pdIds.ranked, postingText: `Senior Frontend Engineer\n\n<script>alert(1)</script> **bold**\n${"Build merchant dashboards in React. ".repeat(60)}` }),
    pastedPosting({ id: pdIds.skipped, status: "skipped", rank: null, skipReason: "weak_core_match", match: weak }),
    {
      ...excluded,
      eligibility: excluded.eligibility && {
        ...excluded.eligibility,
        rules: excluded.eligibility.rules.map((r) => (r.rule === "location" || r.rule === "pay" ? { ...r, result: "violated" as const } : r.rule === "hours" ? { ...r, result: "unverified" as const } : r)),
      },
    },
    pastedPosting({ id: pdIds.skippedNoApp, title: "Frontend Engineer, Growth", company: "Kuda", status: "skipped", rank: null, skipReason: "weak_core_match", match: weak }),
    {
      ...excluded,
      id: pdIds.excludedNoApp,
      requisitionId: `pasted:${pdIds.excludedNoApp}`,
      title: "Senior React Engineer",
      company: "Moniepoint",
      eligibility: excluded.eligibility && {
        ...excluded.eligibility,
        rules: excluded.eligibility.rules.map((r) => (r.rule === "sponsorship" ? { ...r, result: "violated" as const } : r.rule === "hours" ? { ...r, result: "unverified" as const } : r)),
      },
    },
    pastedPosting({ id: pdIds.checking, status: "checking", rank: null, eligibility: null, match: null }),
    pastedPosting({ id: pdIds.linked, applicationUrl: "https://www.linkedin.com/jobs/view/4012345678", applyUrl: "https://www.linkedin.com/jobs/view/4012345678", applicationSystem: "linkedin.com" }),
    ...board(),
  ]
}

function pdApplications(): { app: ApplicationDetail; submission: Submission }[] {
  const app = (id: string, jobPostingId: string, title: string | null, company: string | null, url: string | null) =>
    readyApplication({ id, jobPostingId, roleTitle: title, company, requisitionId: `pasted:${jobPostingId}`, applicationUrl: url, pastedDescription: true, manualOnly: true })
  return [
    { app: app(pdIds.appNoLink, pdIds.skipped, "Senior Frontend Engineer", "Paystack", null), submission: submission({ state: null, kind: null }) },
    { app: app(pdIds.appExcluded, pdIds.excluded, PD_LONG_TITLE, "Initech International Holdings", null), submission: submission({ state: null, kind: null }) },
  ]
}

function aaApplications(): { app: ApplicationDetail; submission: Submission }[] {
  const at = "2026-10-29T10:00:00+01:00"
  const app = (id: string, jobPostingId: string, roleTitle: string, company: string, o: Partial<ApplicationDetail>) =>
    readyApplication({ id, jobPostingId, roleTitle, company, requisitionId: `R-${id.slice(-3)}`, ...o })
  const queued = submission({ state: "queued", kind: "automatic" })
  return [
    { app: app(aaIds.appOverride, aaIds.weak, "Senior Frontend Engineer", "Acme Payments", { override: storedOverride({ createdAt: at }), posting: { status: "skipped", hidden: false } }), submission: queued },
    {
      app: app(aaIds.appInactive, aaIds.uncovered, "Staff Frontend Engineer, Payments Platform and Merchant Experience", "Initech International Holdings", {
        override: storedOverride({ createdAt: at, skipReason: "uncovered_mandatory_prerequisite", skipDetail: LONG, applies: false, notAppliesReason: "decision_changed" }),
        posting: { status: "excluded", hidden: false },
      }),
      submission: submission({ state: "queued", kind: "automatic", queuedForWatDay: "2026-10-30" }),
    },
    { app: app(aaIds.appHidden, aaIds.noCore, "Frontend Engineer", "Contoso", { override: storedOverride({ createdAt: at, applies: false, notAppliesReason: "hidden" }), posting: { status: "skipped", hidden: true } }), submission: submission() },
    {
      app: app(aaIds.appLegacy, aaIds.industry, "Frontend Engineer", "Lucky Odds Ltd", {
        override: storedOverride({ createdAt: "2026-10-28T12:00:00+01:00", status: null, skipReason: null, skipDetail: null, violatedRules: null, applies: false, notAppliesReason: "legacy_no_decision" }),
        posting: { status: "excluded", hidden: false },
      }),
      submission: submission(),
    },
    { app: app(aaIds.appDropClosed, aaIds.location, "Frontend Engineer", "Umbrella", { posting: { status: "evaluation_failed", hidden: false }, latestDrop: { at, reason: "closed" } }), submission: submission() },
    { app: app(aaIds.appDropOther, aaIds.location, "Platform Engineer", "Hooli", { posting: { status: "skipped", hidden: false }, latestDrop: { at, reason: "not_submittable" } }), submission: submission() },
    { app: app(aaIds.appQueuedPlain, aaIds.rankedWithApp, "Frontend Lead", "Globex", { posting: { status: "ranked", hidden: false } }), submission: submission({ state: "queued", kind: "automatic", attemptNumber: 1, markedNotSubmittedAt: at }) },
    {
      app: app(aaIds.appBlocked, aaIds.weak, "Frontend Lead", "Initech", { override: storedOverride({ createdAt: at }), posting: { status: "skipped", hidden: false } }),
      submission: submission({ state: "blocked", kind: "automatic", blockedReason: "missing_approved_answer", blockedDetail: "The form asks: \"Why do you want to work here?\"", blockedQuestion: "Why do you want to work here?", blockedAt: at }),
    },
    {
      app: app(aaIds.appUncertain, aaIds.weak, "Mobile Engineer", "Globex", { override: storedOverride({ createdAt: at }), posting: { status: "skipped", hidden: false } }),
      submission: submission({ state: "uncertain", kind: "automatic", attemptNumber: 1, submittedAt: at, submittedWatDay: "2026-10-29", captchaAfterSubmit: true }),
    },
    { app: app(aaIds.appRanked, aaIds.weak, "Senior Frontend Engineer", "Pied Piper", { override: storedOverride({ createdAt: at }), posting: { status: "ranked", hidden: false } }), submission: queued },
  ]
}

const hiringFeedA = storedFeed({ url: HFEED_A, label: "Frontend hiring" })
const hiringFeedB = storedFeed({ url: HFEED_B, label: null })
const hiringRecord = { verifiedOn: "2026-10-21", verificationBasis: "Read Google's terms for Alerts RSS on 21 Oct.", updatedAt: "2026-10-21T10:15:00.000Z" }
function hiringPosts(n: number) {
  return Array.from({ length: n }, (_, i) =>
    storedPost({
      feedId: i % 7 === 6 ? null : i % 2 ? hiringFeedB.id : hiringFeedA.id,
      title: i === 0 ? "We're hiring a Senior Frontend Engineer to lead our design system work across web and mobile (remote, EMEA)" : `We're hiring: frontend engineer ${i + 1}`,
      canonicalUrl: `https://www.linkedin.com/posts/acme_hiring-activity-72500000000000000${String(i).padStart(2, "0")}`,
      kind: i % 5 === 4 ? "article" : "post",
      snippet: "Join our team building the web app. React, TypeScript and a design system used by millions. Apply on our careers page.",
      // Row 1 is the design-review worst case: a 2-line title with 6 technologies (4 chips + "+2").
      matchedTechnologies:
        i === 0 ? ["React", "TypeScript", "Next.js", "GraphQL", "Playwright", "AWS"] : i % 3 === 0 ? [] : ["React", "TypeScript"],
      date: new Date(Date.UTC(2026, 9, 24, 8, 30) - i * 3_600_000).toISOString(),
    })
  )
}

/** Stack posts rows for the shared row meta (design-review phase 3 B-2): long title with 6 technologies, no technology, 2 technologies. */
function stackRowCases() {
  const feedId = storedFeed().id
  return [
    { title: "Shipping a design system across web and mobile with React Server Components", tech: ["React", "TypeScript", "Next.js", "GraphQL", "Playwright", "AWS"] },
    { title: "Notes on our migration", tech: [] },
    { title: "Why we moved to TypeScript", tech: ["React", "TypeScript"] },
  ].map(({ title, tech }, i) =>
    storedPost({
      feedId,
      title,
      canonicalUrl: `https://www.linkedin.com/posts/ada-obi_stack-activity-${i}-abcd`,
      snippet: "How we rebuilt our component library and what we learned about React, TypeScript and design tokens.",
      matchedTechnologies: tech,
      date: new Date(Date.UTC(2026, 9, 24, 8, 30) - i * 3_600_000).toISOString(),
    })
  )
}

/**
 * The seven rows of design-review-phase3 "r1 re-check" (A to G), for re-measuring the Hiring
 * row budget (D8, design-spec r3 B-3) and the Stack posts rows. The long label is 60 characters
 * (ALERT_FEED_LABEL_MAX).
 */
const LONG_LABEL = "Frontend hiring in Lagos, Nairobi and Berlin (remote EMEA ok"
function rowCases(list: "hiring" | "stack") {
  const short = storedFeed({ url: list === "hiring" ? HFEED_A : FEED_A, label: list === "hiring" ? "Frontend hiring" : "React posts" })
  const long = storedFeed({ url: list === "hiring" ? HFEED_B : FEED_B, label: LONG_LABEL })
  const twoLine = "We're hiring a Senior Frontend Engineer to lead our design system work across web and mobile (remote, EMEA)"
  const six = ["React", "TypeScript", "Next.js", "GraphQL", "Playwright", "AWS"]
  const rows = [
    { title: "A Frontend Engineer (React)", tech: [], feed: short },
    { title: `B ${twoLine}`, tech: six, feed: short },
    { title: "C Frontend Engineer (React)", tech: ["React", "TypeScript"], feed: long },
    { title: `D ${twoLine}`, tech: [], feed: long, kind: "article" as const },
    { title: `E ${twoLine}`, tech: six, feed: long, kind: "article" as const },
    { title: "", tech: ["React", "TypeScript"], feed: null },
    { title: "G", tech: ["React", "TypeScript"], feed: short },
  ]
  const posts = rows.map(({ title, tech, feed, kind }, i) =>
    storedPost({
      feedId: feed?.id ?? null,
      title,
      kind: kind ?? "post",
      canonicalUrl: `https://www.linkedin.com/posts/acme_${list}-activity-72500000000000001${i}`,
      snippet: "Join our team building the web app. React, TypeScript and a design system used by millions. Apply on our careers page.",
      matchedTechnologies: tech,
      date: new Date(Date.UTC(2026, 9, 24, 8, 30) - i * 3_600_000).toISOString(),
    })
  )
  return { feeds: [short, long], posts }
}
const stackRows = rowCases("stack")
const hiringRows = rowCases("hiring")

const E11 = {
  draft: "e1100000-0000-4000-8000-000000000001",
  applied: "e1100000-0000-4000-8000-000000000002",
  interview: "e1100000-0000-4000-8000-000000000003",
  offer: "e1100000-0000-4000-8000-000000000004",
  closed: "e1100000-0000-4000-8000-000000000005",
  blocked: "e1100000-0000-4000-8000-000000000006",
  queued: "e1100000-0000-4000-8000-000000000007",
  employerAsked: "e1100000-0000-4000-8000-000000000008",
} as const

/** EPIC-0011: one Application per board column, plus a blocked and a queued one. */
function e11Applications(): { app: ApplicationDetail; submission: Submission }[] {
  const app = (id: string, roleTitle: string, company: string, o: Partial<ApplicationDetail> = {}) =>
    readyApplication({ id, jobPostingId: id.replace("e1100000", "e1200000"), roleTitle, company, requisitionId: `R-${id.slice(-3)}`, ...o })
  return [
    { app: app(E11.draft, "Senior Frontend Engineer", "Acme Payments"), submission: submission() },
    { app: app(E11.applied, "Staff Engineer", "Initech", { createdAt: "2026-11-05T09:00:00.000Z" }), submission: submission({ state: "manual", manualCompletedAt: "2026-11-05T10:00:00.000Z" }) },
    { app: app(E11.interview, "Frontend Lead", "Globex", { createdAt: "2026-11-04T09:00:00.000Z" }), submission: submission() },
    { app: app(E11.offer, "Platform Engineer", "Hooli", { createdAt: "2026-11-03T09:00:00.000Z" }), submission: submission() },
    { app: app(E11.closed, "Mobile Engineer", "Umbrella", { createdAt: "2026-11-02T09:00:00.000Z" }), submission: submission() },
    {
      app: app(E11.blocked, "Frontend Engineer", "Contoso", { createdAt: "2026-11-01T09:00:00.000Z" }),
      submission: submission({ state: "blocked", kind: "automatic", blockedReason: "captcha", blockedAt: "2026-11-05T10:00:00.000Z" }),
    },
    { app: app(E11.queued, "Full Stack Engineer", "Wayne Enterprises", { createdAt: "2026-10-31T09:00:00.000Z" }), submission: submission({ state: "queued", kind: "automatic" }) },
    { app: app(E11.employerAsked, "Design Engineer", "Stark Industries", { createdAt: "2026-10-30T09:00:00.000Z" }), submission: submission({ state: "manual", manualCompletedAt: "2026-11-01T10:00:00.000Z" }) },
  ]
}

const e11Outcomes = [
  { applicationId: E11.interview, type: "interview_invitation" },
  { applicationId: E11.offer, type: "offer" },
  { applicationId: E11.closed, type: "rejection" },
  { applicationId: E11.employerAsked, type: "interview_invitation" },
  { applicationId: E11.employerAsked, type: "request_for_action" },
] as const

export const scenarios = {
  simple: {
    description: "EPIC-0011: invited non-Operator, Advanced off, the simpler note due, a board in every column. Open /dashboard, /applications, /find-jobs, /settings",
    me: inviteeMe(),
    discovery: { postings: board(), waitingToBeCheckedCount: 2, waitingReason: "checks_not_enabled" as const, checkAgainMovesTo: "waiting_to_be_checked" as const },
    applications: e11Applications(),
    outcomes: e11Outcomes,
  },
  advanced: {
    description: "EPIC-0011: the Operator with Advanced on and a board in every column plus Sending and Needs you. Open /dashboard, /applications, /settings",
    me: operatorMe(),
    discovery: { postings: board() },
    applications: e11Applications(),
    outcomes: e11Outcomes,
  },
  newcomer: {
    description: "EPIC-0011: a new invitee with no resume. Home goes to /welcome",
    me: inviteeMe({ simplerNoteDue: false }),
    discovery: { postings: [] },
    career: { approval: null, versions: [] } as Partial<CareerSetupState>,
  },
  board: {
    description: "Operator board: rows aged 31-60, Not checked yet, failure lines, hidden line (1,293), Check again (4) queues checks",
    discovery: {
      postings: [...board(), ...hiddenOnes()],
      extraHiddenCounts: { offTarget: 1246, belowSeniorityFloor: 11, olderThan60Days: 33 },
      waitingToBeCheckedCount: 0,
    },
  },
  invitee: {
    description: "Non-Operator: Check again moves to waiting (waiting toast); Ranked shows the invitee waiting notice",
    discovery: {
      postings: [...board(), ...hiddenOnes()],
      waitingToBeCheckedCount: 2,
      waitingReason: "checks_not_enabled",
      checkAgainMovesTo: "waiting_to_be_checked",
    },
  },
  "cost-pause": {
    description: "Operator during the cost pause: Ranked waiting notice (cost_pause text)",
    discovery: { postings: board(), waitingToBeCheckedCount: 3, waitingReason: "cost_pause" },
  },
  "nothing-new": {
    description: "Check again finds nothing left to claim (another tab claimed it): nothing-new info toast",
    discovery: { postings: board(), nextCheckAgain: "nothing_left" },
  },
  "check-again-error": {
    description: "Check again answers 500: inline error in the dialog; confirm again succeeds",
    discovery: { postings: board(), nextCheckAgain: "internal_error" },
  },
  "check-again-csrf": {
    description: "Check again answers 403 csrf_invalid: the API message verbatim in the dialog",
    discovery: { postings: board(), nextCheckAgain: "csrf_invalid" },
  },
  "all-hidden-undated": {
    description: "Tonight after the migration: every posting undated (2,222) -> all-hidden, bodyUndated",
    discovery: { postings: [hiddenOnes()[2]], extraHiddenCounts: { undated: 2221 } },
  },
  "all-hidden-settings": {
    description: "Every posting off-target -> all-hidden, settings body",
    discovery: { postings: [hiddenOnes()[0]], extraHiddenCounts: { offTarget: 9 } },
  },
  "worst-case": {
    description: "Worst case: 4-digit counts on all four reasons, 10,000 recheckable, long names",
    discovery: {
      postings: [
        rankedPosting({
          title: "Principal Staff Software Engineer, Developer Platform and Internal Tooling (Remote, EMEA)",
          company: "Solutions and Customer Engineering International Holdings",
          rank: 1,
          attribution: { name: "We Work Remotely", url: "https://weworkremotely.com" },
          ...dated(60, "updated"),
        }),
        ...Array.from({ length: 3 }, () => rankedPosting({ status: "evaluation_failed", rank: null, evaluationFailure: "not_configured", eligibility: null })),
      ],
      extraHiddenCounts: { offTarget: 9999, belowSeniorityFloor: 1234, undated: 2222, olderThan60Days: 5678 },
    },
  },
  "paste-hidden": {
    description:
      "Paste result for hidden links (B7): paste any new URL -> 'Saved, but hidden: no posted date.'; paste " +
      "https://jobs.lever.co/hooli/junior-fe -> 'You already have this Job Posting. It's hidden: entry-level role.'",
    discovery: {
      postings: [
        ...board(),
        rankedPosting({
          id: previewIds.hiddenEntry,
          title: "Junior Frontend Developer",
          company: "Hooli",
          applicationUrl: PASTE_KNOWN_URL,
          applyUrl: PASTE_KNOWN_URL,
          hiddenReason: "below_seniority_floor",
          ...dated(4),
        }),
      ],
      nextPasted: (url: string) =>
        rankedPosting({
          applicationUrl: url,
          applyUrl: url,
          title: "Senior Frontend Engineer",
          company: "Globex",
          status: "not_checked",
          rank: null,
          eligibility: null,
          match: null,
          hiddenReason: "undated",
          ...UNDATED,
        }),
    },
  },
  empty: {
    description: "First run: no postings, no hidden line",
    discovery: { postings: [] },
  },
  "hiring-no-record": {
    description: "EPIC-0007 Phase 3: no own permitted-use record (Hiring view not-recorded panel and posts empty state); open /stack-posts?view=hiring",
    discovery: { postings: board() },
    stack: { verification: verifiedOn20Oct, feeds: [storedFeed({ url: FEED_A })] },
  },
  "hiring-no-feeds": {
    description: "EPIC-0007 Phase 3: own record, no feeds (recorded line, form, 'No Hiring Alert feeds yet')",
    discovery: { postings: board() },
    stack: { hiringVerification: hiringRecord },
  },
  "hiring-posts": {
    description:
      "EPIC-0007 Phase 3: own record, 2 feeds (one unlabelled), 120 Hiring posts over 3 pages (long title, removed-feed rows, no-tech rows); " +
      `Stack posts has ${FEED_A.slice(-6)} so registering it in Hiring shows C-HP-FEED-ERR-OTHER-LIST`,
    discovery: { postings: board() },
    stack: {
      verification: verifiedOn20Oct,
      feeds: [storedFeed({ url: FEED_A, label: "React posts" })],
      posts: stackRowCases(),
      hiringVerification: hiringRecord,
      hiringFeeds: [hiringFeedA, hiringFeedB],
      hiringPosts: hiringPosts(120),
    },
  },

  "hiring-rows": {
    description: "EPIC-0007 Phase 3 row budget: the design-review rows A to G (long 60-character source label in C, D, E) in both lists",
    discovery: { postings: board() },
    stack: {
      verification: verifiedOn20Oct,
      feeds: stackRows.feeds,
      posts: stackRows.posts,
      hiringVerification: hiringRecord,
      hiringFeeds: hiringRows.feeds,
      hiringPosts: hiringRows.posts,
    },
  },

  // ── EPIC-0002 B1: Job preferences and the four tabs ──
  "b1-prefs": {
    description: "B1 Settings > Job preferences: Kenya, version 3, keyword react, Mobile excluded; four tabs with each skip reason",
    discovery: { postings: [...board(), ...b1Skips()] },
    preferences: { record: b1Record() },
  },
  "b1-settings-hidden": {
    description: "B1 interim Settings: board families leave out DevOps and SRE, Data and ML, Solutions and customer engineering and Other: four Hidden badges and the plural note",
    discovery: { postings: board() },
    preferences: { record: b1Record() },
    career: {
      jobCriteria: {
        ...defaultJobCriteria(),
        frameworks: ["React", "Next.js", "NestJS"],
        technologies: ["TypeScript", "Playwright", "AWS"],
        version: 1,
        targetRoleFamilies: ["senior_frontend", "technical_lead", "fullstack", "product_engineering", "software_engineering", "backend", "mobile", "platform_engineering", "people_management"],
      },
    },
  },
  "b1-prefs-new": {
    description: "B1 no record yet: GET returns version null and STEP3_DEFAULTS (as wizard step 3 starts); first save creates version 1",
    discovery: { postings: board() },
    preferences: { record: null },
  },
  "b1-prefs-stale": {
    description: "B1 every save is stale (another tab saved): C-PREF-CONFLICT (D30) at the top, Reload preferences",
    discovery: { postings: board() },
    preferences: { record: b1Record(), staleEverySave: true },
  },
  "b1-prefs-network": {
    description: "B1 the next save fails with 500: prefs.save.error.network above the primary, Try again",
    discovery: { postings: board() },
    preferences: { record: b1Record(), nextSave: "internal_error" },
  },
  "b1-prefs-ratelimited": {
    description: "B1 10 saves already this minute: prefs.save.error.rateLimited",
    discovery: { postings: board() },
    preferences: { record: b1Record(), attempts: 10 },
  },
  "b1-tabs-none-excluded": {
    description: "B1 Operator-like: nothing excluded, no keyword: Not a match's excluded-family section shows postings.excludedEmpty.none, All has no hint",
    discovery: { postings: board() },
    preferences: { record: preferencesRecord(2) },
  },
  "b1-worst": {
    description: "B1 worst case: 100-character keyword, every family excluded but one, 3 themes of 60, long chips",
    discovery: { postings: [...board(), ...b1Skips()] },
    preferences: {
      record: preferencesRecord(9, {
        titleKeyword: "SuperLongKeywordWithoutAnySpacesAtAllSoItMustWrapSomewhereInTheUiOrItWillOverflowTheColumnBadly12345",
        roleFamilyTiers: Object.fromEntries(Object.keys(DEFAULT_ROLE_FAMILY_TIERS).map((k) => [k, k === "solutions_customer" ? 1 : "excluded"])) as typeof DEFAULT_ROLE_FAMILY_TIERS,
        workAuthorizedCountries: ["KE", "GB", "DE", "US", "AE", "SA", "QA", "NL", "IE", "SG"],
        excludedRelocationCountries: ["OM", "TR", "JO", "LB", "TH"],
        excludedIndustries: ["adult_content", "video_games_and_gaming_platforms", "gambling", "betting", "crypto_and_web3", "weapons_and_defense", "tobacco_and_vaping"],
        emphasisThemes: ["x".repeat(60), "designing reliable payment APIs used by millions of people", "mentoring developers"],
        payFloor: { amount: "99999999.99", currency: "CHF", period: "year", basis: "gross" },
      }),
    },
  },
  "apply-anyway": {
    description: "Apply anyway (v1.24.0): overridable postings, Override badges, no-longer-applies alerts, drop lines, Remove from queue",
    discovery: { postings: aaPostings() },
    applications: aaApplications(),
  },
  "apply-anyway-network": {
    description: "Apply anyway: the next create and the next remove fail with a network error (inline retry in the dialog)",
    discovery: { postings: aaPostings() },
    applications: aaApplications(),
    nextCreate: "network",
    nextRemove: "network",
  },
  "apply-anyway-decision-changed": {
    description: "Apply anyway: the next create answers 409 override_decision_changed (C-AA-9 panel)",
    discovery: { postings: aaPostings() },
    applications: aaApplications(),
    nextCreate: "override_decision_changed",
  },
  "apply-anyway-hidden": {
    description: "Apply anyway: the next create answers 409 posting_hidden (hidden-posting panel)",
    discovery: { postings: aaPostings() },
    applications: aaApplications(),
    nextCreate: "posting_hidden",
  },
  "apply-anyway-remove-conflict": {
    description: "Apply anyway: the next remove-from-queue answers 409 (C-AA-30 toast)",
    discovery: { postings: aaPostings() },
    applications: aaApplications(),
    nextRemove: "conflict",
  },
  pasted: {
    description:
      "EPIC-0010 pasted descriptions: paste panel on /postings, Home and Hiring; pasted postings (ranked, skipped, excluded, checking, with a link); pasted Applications. Greenhouse links containing 4019999 fail their lookup.",
    discovery: { postings: pdPostings() },
    applications: pdApplications(),
  },
  "pasted-cost-pause": {
    description: "EPIC-0010: a pasted description is saved as waiting (C-PD-36)",
    discovery: { postings: pdPostings(), pasteWaitingReason: "cost_pause" },
    applications: pdApplications(),
  },
  "pasted-invitee": {
    description: "EPIC-0010: an invitee's pasted description waits for checks (C-PD-37)",
    discovery: { postings: pdPostings(), pasteWaitingReason: "checks_not_enabled" },
    applications: pdApplications(),
  },
  "paste-not-a-match": {
    description: "EPIC-0011 F8: invitee on Home; paste any new link -> 'Not a match' with its reason and Prepare anyway",
    me: inviteeMe({ simplerNoteDue: false }),
    discovery: {
      postings: board(),
      nextPasted: (url: string) =>
        rankedPosting({
          applicationUrl: url,
          applyUrl: url,
          title: "Backend Engineer",
          company: "Umbrella",
          status: "skipped",
          rank: null,
          roleFamily: "backend",
          skipReason: "weak_core_match",
          match: { ...strongMatch(), verdict: "weak", weakReason: "coverage_below_threshold", coveredCount: 6, totalCount: 10 },
          ...dated(3),
        }),
    },
  },
  "paste-evaluation-failed": {
    description: "EPIC-0011 F8: invitee on Home; paste any new link -> 'Couldn't check' with its cause",
    me: inviteeMe({ simplerNoteDue: false }),
    discovery: {
      postings: board(),
      nextPasted: (url: string) =>
        rankedPosting({
          applicationUrl: url,
          applyUrl: url,
          title: "Senior Fullstack Engineer",
          company: "Lumon",
          status: "evaluation_failed",
          rank: null,
          roleFamily: "fullstack",
          evaluationFailure: "provider_error",
          eligibility: null,
          match: null,
          ...dated(3),
        }),
    },
  },
  "newcomer-approved": {
    description: "EPIC-0011 F8: a new invitee whose AI provider is approved. /welcome: upload a resume, then step 2 (drafting, then 'What Eve read') appears after 4 s",
    me: inviteeMe({ simplerNoteDue: false }),
    discovery: { postings: [] },
    career: { ...approvedState(), versions: [] } as Partial<CareerSetupState>,
    finishDraftingAfterMs: 4000,
  },
  "advanced-write-fails": {
    description: "EPIC-0011 F8: invitee; turning Advanced on (Settings, or the note on /blocked) fails: settings.advanced.error and hidden.error",
    me: inviteeMe({ simplerNoteDue: false }),
    discovery: { postings: board() },
    applications: e11Applications(),
    meFailWrites: true,
  },
  "move-fails": {
    description: "EPIC-0011 F8: invitee; moving a card on /applications fails: applications.move.error",
    me: inviteeMe({ simplerNoteDue: false }),
    discovery: { postings: board() },
    applications: e11Applications(),
    outcomes: e11Outcomes,
    outcomeWritesFail: true,
  },
  "email-failed": {
    description: "EPIC-0011 F8: invitee, Advanced off; Home shows the failed 'needs you' email alert in plain words",
    me: inviteeMe({ simplerNoteDue: false }),
    discovery: { postings: board() },
    applications: e11Applications(),
    emailFailure: "blocked_application" as const,
  },
  "email-failed-advanced": {
    description: "EPIC-0011 F8: the Operator, Advanced on; Home shows the failed email alert with the Operator wording",
    me: operatorMe(),
    discovery: { postings: board() },
    applications: e11Applications(),
    emailFailure: "blocked_application" as const,
  },
} satisfies Record<string, PreviewScenario>

export type ScenarioName = keyof typeof scenarios

/** Approved provider plus Job criteria that fill the Stack posts and Hiring search links (EPIC-0007 Phase 1 preview). */
export const previewCareer: Partial<CareerSetupState> = {
  ...approvedState(),
  versions: [version(1, "approved")],
  jobCriteria: {
    ...defaultJobCriteria(),
    frameworks: ["React", "Next.js", "NestJS"],
    technologies: ["TypeScript", "Playwright", "AWS"],
    version: 1,
  },
}

function b1Record() {
  return preferencesRecord(3, { titleKeyword: "react", roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, mobile: "excluded" } })
}

/** B1 skip rows: one excluded family and one keyword mismatch, both on Not a match; the keyword mismatch also shows on All. */
function b1Skips(): JobPostingDetail[] {
  return [
    rankedPosting({ title: "Flutter Developer", company: "Beta Ltd", status: "skipped", rank: null, roleFamily: "mobile", skipReason: "excluded_role_family", match: null, eligibility: null, ...dated(5) }),
    rankedPosting({ title: "Senior Vue Engineer", company: "Gamma", status: "skipped", rank: null, roleFamily: "senior_frontend", skipReason: "keyword_mismatch", match: null, eligibility: null, ...dated(6) }),
  ]
}
