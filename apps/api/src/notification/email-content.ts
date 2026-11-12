import {
  type AlertFeedFailureReason,
  type HiringSearchGroup,
  type RoleFamilyValue,
  type StackSearchGroup,
  alertFeedFailurePhrase,
  isSafeAccessRequestEmail,
} from "@eve/contracts"

import type { BlockedReason, BlockedSubReason, EvidenceKind } from "../db/schema.js"
import { formatUsd } from "../spend/spend-math.js"
import { MailerError } from "./mailer.js"
import { ruleInlineLabel } from "./rule-labels.js"

/**
 * Email content (design-spec r4, "Email templates", E1 to E3). Pure functions:
 * each email is a list of blocks rendered twice, as plain text and as one-column
 * HTML with the same content. Links point only to authenticated dashboard routes
 * (AC 7.4). Inputs carry no Approved Answer values, document text or salary
 * figures, so no email can contain them (CONTEXT.md data rules).
 */
export type RenderedEmail = Readonly<{
  subject: string
  preheader: string
  text: string
  /** Absent for text-only emails (EPIC-0003 Operator emails). */
  html?: string
  /** EPIC-0003: the visitor, on access-request emails only. Never a recipient. */
  replyTo?: string
}>

export type Block =
  | Readonly<{ kind: "p"; text: string }>
  | Readonly<{ kind: "lines"; lines: readonly string[] }>
  | Readonly<{ kind: "heading"; text: string }>
  /** `colon`: "label: href" in text; `paren`: "label (href)". `external`: opens in a new tab without opener or referrer (EPIC-0005 AC 1.4). */
  | Readonly<{ kind: "link"; label: string; href: string; style: "colon" | "paren"; external?: true }>
  /** EPIC-0005 B4: a label line, then links inline (HTML, " · ") or one "label: href" per line (text). Always external. */
  | Readonly<{ kind: "inline-links"; label: string; links: readonly Readonly<{ label: string; href: string }>[] }>
  /** EPIC-0005 B4: a post title linked to LinkedIn, then one meta line. External. */
  | Readonly<{ kind: "post"; title: string; href: string; meta: string }>

const FOOTER = "Links open your Eve dashboard and ask you to sign in."
const DAILY_CAP = 5
const WAT_OFFSET_MS = 60 * 60 * 1000
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

/** "20 Oct 2026, 10:15 WAT" (design-spec r4: dates in emails). */
export function formatWat(at: Date): string {
  return `${formatWatDate(watDate(at))}, ${formatWatTime(at)}`
}

function watDate(at: Date): string {
  return new Date(at.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10)
}

function formatWatTime(at: Date): string {
  return `${new Date(at.getTime() + WAT_OFFSET_MS).toISOString().slice(11, 16)} WAT`
}

/** "2026-10-20" -> "20 Oct 2026". */
function formatWatDate(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  return `${date} ${MONTHS[month - 1]} ${year}`
}

const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const

/** "2026-10-01" -> "October 2026". */
function formatMonth(day: string): string {
  const [year, month] = day.split("-").map(Number) as [number, number]
  return `${FULL_MONTHS[month - 1]} ${year}`
}

/** SEC-602: employer-controlled text is capped and defanged so mail clients don't turn it into links. */
const UNTRUSTED_MAX = 120
/** A stored C-BLOCK detail can quote a page label; it is a sentence, so its cap is longer. */
const DETAIL_MAX = 400

export function untrusted(text: string, max = UNTRUSTED_MAX): string {
  const defanged = text.replace(/:\/\//g, "[:]//").replace(/\bwww\./gi, (match) => `${match.slice(0, 3)}[.]`)
  return defanged.length > max ? `${defanged.slice(0, max - 1)}…` : defanged
}

/** The first day of the month after `day`, as "1 Nov 2026". */
function firstOfNextMonth(day: string): string {
  const [year, month] = day.split("-").map(Number) as [number, number]
  return month === 12 ? `1 Jan ${year + 1}` : `1 ${MONTHS[month]} ${year}`
}

const applicationUrl = (base: string, id: string, anchor = "") => `${base}/applications/${id}${anchor}`

// ── E1 ───────────────────────────────────────────────────────

export type ConfirmedEmailInput = Readonly<{
  applicationId: string
  role: string
  company: string
  requisitionId: string
  submittedAt: Date
  evidence: Readonly<{ kind: EvidenceKind; text: string | null }>
  sentAs: "automatic" | "sample"
  employmentType: "direct" | "employer_of_record" | "contract" | null
  unverified: readonly string[]
  coverLetterStatus: "not_submitted" | "uploaded" | "no_field"
  automaticToday: number
  /** v1.24.0 (AA-4.6): the stored override's short reason; null or absent for no override or a legacy one. */
  override?: OverrideFact | null
}>

/** v1.24.0: `{reason}` is the copy deck's short form (`overrideReasonShort`). */
export type OverrideFact = Readonly<{ reason: string }>

/** Copy deck C-AA-32 (E1 after "Sent:", E2 after "Reason:"). The prerequisite in `{reason}` is untrusted. */
const overrideFactLines = (override: OverrideFact | null | undefined): string[] => (override ? [`Override: you chose to apply despite ${untrusted(override.reason, DETAIL_MAX)}`] : [])
/** Copy deck C-AA-34, leading space included, appended at the end of a daily-summary line. */
const OVERRIDE_MARKER = " [Override]"
const marked = (line: string, override: boolean | undefined) => (override ? `${line}${OVERRIDE_MARKER}` : line)

const EMPLOYMENT_TYPE = { direct: "Direct employment", employer_of_record: "Employer of record", contract: "Independent contractor" } as const

function evidenceLine(evidence: ConfirmedEmailInput["evidence"]): string {
  if (evidence.kind === "application_id") return `Application ID ${evidence.text ?? ""}`.trim()
  return evidence.kind === "confirmation_page" ? "Confirmation page" : "Marked confirmed by you"
}

function evidencePhrase(evidence: ConfirmedEmailInput["evidence"]): string {
  if (evidence.kind === "application_id") return `application ID ${evidence.text ?? ""}`.trim()
  return evidence.kind === "confirmation_page" ? "the confirmation page" : "your mark"
}

export function renderConfirmed(raw: ConfirmedEmailInput, base: string): RenderedEmail {
  const input = { ...raw, role: untrusted(raw.role), company: untrusted(raw.company), requisitionId: untrusted(raw.requisitionId) }
  const facts = [
    `Role: ${input.role}`,
    `Company: ${input.company}`,
    `Requisition ID: ${input.requisitionId}`,
    `Submitted: ${formatWat(input.submittedAt)}`,
    `Confirmed by: ${evidenceLine(input.evidence)}`,
    `Sent: ${input.sentAs === "automatic" ? "Automatically" : "As an approved sample"}`,
    ...overrideFactLines(input.override),
    ...(input.employmentType ? [`Employment type: ${EMPLOYMENT_TYPE[input.employmentType]}`] : []),
    // D44: rule names in the dashboard's inline words ("employment type", never the raw key).
    ...(input.unverified.length > 0 ? [`Unverified: ${input.unverified.map(ruleInlineLabel).join(", ")}`] : []),
  ]
  const coverLetter: Block[] =
    input.coverLetterStatus === "no_field"
      ? [
          { kind: "p", text: "Cover letter: not uploaded, the form had no cover letter field." },
          { kind: "link", label: "View the stored cover letter", href: applicationUrl(base, input.applicationId, "#cover-letter"), style: "colon" },
        ]
      : [{ kind: "link", label: "View the cover letter used", href: applicationUrl(base, input.applicationId, "#cover-letter"), style: "colon" }]
  const blocks: Block[] = [
    { kind: "p", text: "Your Application was submitted and the employer's receipt is confirmed." },
    { kind: "lines", lines: facts },
    { kind: "p", text: "Exactly what was sent:" },
    { kind: "link", label: "View the resume used", href: applicationUrl(base, input.applicationId, "#resume"), style: "colon" },
    ...coverLetter,
    { kind: "link", label: "View the answers used", href: applicationUrl(base, input.applicationId, "#answers"), style: "colon" },
    ...(input.sentAs === "automatic" ? [{ kind: "p", text: `Automatic submissions today: ${input.automaticToday} of ${DAILY_CAP}.` } as const] : []),
  ]
  return render(
    `Applied: ${input.role} at ${input.company} (${input.requisitionId})`,
    `Confirmed by ${evidencePhrase(input.evidence)} on ${formatWat(input.submittedAt)}.`,
    blocks
  )
}

// ── E2 ───────────────────────────────────────────────────────

export type BlockedEmailInput = Readonly<{
  applicationId: string
  role: string
  company: string
  requisitionId: string
  reason: BlockedReason
  subReason: BlockedSubReason | null
  /** The C-BLOCK-* detail stored with the block. Built by backend code; never an answer value. */
  detail: string | null
  /** v1.24.0 (AA-4.6): as on E1. */
  override?: OverrideFact | null
}>

export const BLOCKED_REASON_LABEL: Readonly<Record<BlockedReason, string>> = {
  missing_approved_answer: "Missing Approved Answer",
  login: "Login",
  email_verification: "Email verification",
  captcha: "CAPTCHA",
  assessment: "Assessment",
  same_company_review: "Same-company review",
  declaration: "Declaration",
  personal_data_request: "Personal data request",
  automation_incomplete: "Automation couldn't complete the form",
  ats_below_minimum: "ATS match below your minimum",
}

const APPLY_YOURSELF = "Apply yourself on the employer site with the prepared documents, then mark it completed manually."
const WHAT_TO_DO: Readonly<Record<BlockedReason, string>> = {
  missing_approved_answer: "Add the answer in your dashboard. The Application then goes back to automatic submission.",
  login: APPLY_YOURSELF,
  email_verification: APPLY_YOURSELF,
  captcha: APPLY_YOURSELF,
  assessment: APPLY_YOURSELF,
  declaration: APPLY_YOURSELF,
  personal_data_request: APPLY_YOURSELF,
  same_company_review: "Approve it to submit under the normal rules, decline it with a reason, or apply yourself and mark it completed manually.",
  automation_incomplete: `${APPLY_YOURSELF} The assistant won't try this form again.`,
  ats_below_minimum: "Add the missing experience to your Career Profile and generate the documents again, or lower your ATS minimum in Settings: it goes back to the queue once its ATS match reaches your minimum. Or apply yourself and mark it completed manually.",
}

export function renderBlocked(raw: BlockedEmailInput, base: string): RenderedEmail {
  const input = { ...raw, role: untrusted(raw.role), company: untrusted(raw.company), requisitionId: untrusted(raw.requisitionId), detail: raw.detail === null ? null : untrusted(raw.detail, DETAIL_MAX) }
  const label = BLOCKED_REASON_LABEL[input.reason]
  const seventh = input.reason === "automation_incomplete"
  const details = [
    ...(input.detail ? [input.detail] : []),
    ...(seventh ? ["The assistant stopped before the submit button, so the employer received nothing."] : []),
  ]
  const blocks: Block[] = [
    { kind: "p", text: "The assistant stopped before submitting this Application." },
    { kind: "lines", lines: [`Role: ${input.role}`, `Company: ${input.company}`, `Requisition ID: ${input.requisitionId}`, `Reason: ${label}`, ...overrideFactLines(input.override), ...details] },
    { kind: "p", text: `What you can do: ${WHAT_TO_DO[input.reason]}` },
    { kind: "link", label: "Open this Blocked Application", href: applicationUrl(base, input.applicationId), style: "colon" },
    { kind: "p", text: "It doesn't count toward today's cap." },
  ]
  return render(
    `Needs you: ${input.role} at ${input.company} (${label})`,
    seventh ? "Nothing was submitted. Please apply to this one yourself." : "Nothing was submitted. Here's what the assistant needs.",
    blocks
  )
}

// ── E3 ───────────────────────────────────────────────────────

export type DailySummaryInput = Readonly<{
  watDay: string
  automaticToday: number
  /** v1.24.0 (AA-4.6): `override` (an override recorded, legacy included) appends C-AA-34 to the line. */
  submitted: readonly Readonly<{ role: string; company: string; requisitionId: string; override?: boolean }>[]
  blockedCount: number
  uncertainCount: number
  uncertain: readonly Readonly<{ role: string; company: string; submittedAt: Date; captchaAfterSubmit: boolean; override?: boolean }>[]
  failures: readonly Readonly<{ role: string; company: string; reason: string; override?: boolean }>[]
  skipped: readonly Readonly<{ role: string; company: string; reason: string; manualPossible: boolean; override?: boolean }>[]
  globalPaused: boolean
  costPaused: boolean
  /** Slice 7: the cost pause cleared on its own today, at 00:00 WAT on the 1st (C-COST-6). */
  costResumedToday: boolean
  /** Slice 7: this month's spend and ceiling, for the "Spend" section (CR6-05). Null leaves it out. */
  spend: Readonly<{ spentMicros: number; ceilingMicros: number }> | null
  /** EPIC-0005: the "Stack posts" section, after "Not a match" and before "Spend". Absent leaves it out. */
  stackPosts?: StackPostsSection
  /** Automatic expiry (E5.4, D-E7): Applications that day's run deleted. 0 or absent leaves the section out. */
  retentionDeleted?: number
}>

/** Copy deck C-RET-20, C-RET-20h, C-RET-21. Names no company, role or requisition. */
const RETENTION_COPY = {
  heading: "Retention",
  line: (n: number) =>
    n === 1
      ? "Detailed records of 1 Application were deleted automatically today, after 12 months. Its minimal record stays."
      : `Detailed records of ${n.toLocaleString("en-US")} Applications were deleted automatically today, after 12 months. Their minimal records stay.`,
  link: "See minimal records",
} as const

function retentionBlocks(deleted: number, base: string): Block[] {
  return [
    { kind: "heading", text: RETENTION_COPY.heading },
    { kind: "p", text: RETENTION_COPY.line(deleted) },
    { kind: "link", label: RETENTION_COPY.link, href: `${base}/privacy#records`, style: "colon" },
  ]
}

/** EPIC-0005 AC 8: no snippets (D-E5-4); failing feeds by name and mask, never the URL (AC 7.4). */
export type StackPostsSection = Readonly<{
  groups: readonly StackSearchGroup[]
  /** EPIC-0007 Phase 1: the "Hiring search links" part, after the Stack posts search links. Absent leaves it out. */
  hiring?: HiringLinksSection
  verified: boolean
  newPosts: readonly Readonly<{ title: string; kind: "post" | "article"; canonicalUrl: string; date: Date; dateKind: "posted" | "found"; matchedTechnologies: readonly string[] }>[]
  newCount: number
  failingFeeds: readonly Readonly<{ label: string | null; maskedUrl: string; reason: AlertFeedFailureReason }>[]
  /** EPIC-0007 Phase 3 (AC 9.1, 9.2): the summary Candidate's own Hiring record. False leaves the Hiring posts part and count out. CR-P3-02: required, as the reader always provides it. */
  hiringVerified: boolean
  hiringNewPosts: readonly Readonly<{ title: string; kind: "post" | "article"; canonicalUrl: string; date: Date; dateKind: "posted" | "found"; matchedTechnologies: readonly string[] }>[]
  hiringNewCount: number
  failingHiringFeeds: readonly Readonly<{ label: string | null; maskedUrl: string; reason: AlertFeedFailureReason }>[]
}>

/** Copy deck C-SP-EMAIL-* and C-SP-UNTITLED-* (final in copy deck r1, D-E5-10). */
const STACK_COPY = {
  heading: "Stack posts",
  linksIntro: "Past-week searches from your job criteria. Some results will still be hiring posts or job ads.",
  linkLinkedIn: "LinkedIn posts",
  linkGooglePosts: "Google posts",
  linkGoogleArticles: "Google articles",
  linksEmpty: "Search links need Frameworks or Technologies in your job criteria. Both lists are empty.",
  linksEmptyLink: "Add job criteria",
  newTitle: (n: number) => `New Stack posts: ${n}`,
  more: (n: number) => `${n} more on your Stack posts page`,
  noneNew: "No new Stack posts.",
  failTitle: "Failing Alert feeds",
  fallbackName: "Alert feed",
  untitled: { post: "Untitled LinkedIn post", article: "Untitled LinkedIn article" },
  summaryCount: (n: number) => (n === 1 ? "1 new Stack post" : `${n} new Stack posts`),
} as const

/** EPIC-0007 Phase 1 (contract v1.19.0): the first target family with phrases (D6), or none (AC 4.2). */
export type HiringLinksSection =
  | Readonly<{ family: RoleFamilyValue; groups: readonly HiringSearchGroup[]; hasOtherFamilies: boolean }>
  | Readonly<{ family: null }>

/**
 * EPIC-0006 copy deck `family.*` labels, the same words the web shows. Email
 * keeps its own map until a shared server-side one exists (architecture r1).
 */
const ROLE_FAMILY_LABEL: Readonly<Record<RoleFamilyValue, string>> = {
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

/** EPIC-0007 copy deck r1, C-HP-EMAIL-* and the reused C-HP-GROUP-ANY, C-HP-LINK-LI, C-HP-LINK-G. */
const HIRING_COPY = {
  linksTitle: "Hiring search links",
  linksIntro: (family: string) => `Past-week search hints for ${family} roles. Some results won't fit, and Eve can't check pay, hours or sponsorship from them.`,
  groupAny: "Any technology",
  linkLinkedIn: "LinkedIn posts",
  linkGoogle: "Google posts",
  other: "Searches for your other role families",
  noFamily: "Hiring searches need job titles, and Other has none. Choose another role family in your job criteria.",
  noFamilyLink: "Choose role families",
  // Phase 3 (copy deck r2): C-HP-EMAIL-POSTS-TITLE, -POST-META, C-HP-NOTCHECKED, -MORE, -NONE-NEW, -FAIL-TITLE, -FAIL-LINE, -SUMMARY-COUNT.
  postsTitle: (n: number) => `New Hiring posts: ${n}`,
  notChecked: "Not vetted",
  more: (n: number) => `${n} more on the Hiring view`,
  noneNew: "No new Hiring posts.",
  failTitle: "Failing Hiring Alert feeds",
  fallbackName: "Hiring Alert feed",
  summaryCount: (n: number) => (n === 1 ? "1 new Hiring post" : `${n} new Hiring posts`),
} as const

/**
 * The hiring links part (design-spec r1 B5): title, intro naming the family, one
 * label-plus-links block per group (LinkedIn and Google only, no query string),
 * then the link to the Hiring view when other families have phrases. Hrefs come
 * only from the builder, whose URLs start with the fixed https bases (P1-4).
 */
function hiringLinksBlocks(hiring: HiringLinksSection, base: string): Block[] {
  const blocks: Block[] = [{ kind: "p", text: HIRING_COPY.linksTitle }]
  if (hiring.family === null) {
    blocks.push({ kind: "p", text: HIRING_COPY.noFamily }, { kind: "link", label: HIRING_COPY.noFamilyLink, href: `${base}/settings#job-criteria`, style: "colon" })
    return blocks
  }
  blocks.push({ kind: "p", text: HIRING_COPY.linksIntro(ROLE_FAMILY_LABEL[hiring.family]) })
  for (const group of hiring.groups) {
    blocks.push({
      kind: "inline-links",
      label: group.label === "" ? HIRING_COPY.groupAny : group.label,
      links: [
        { label: HIRING_COPY.linkLinkedIn, href: group.linkedin },
        { label: HIRING_COPY.linkGoogle, href: group.google },
      ],
    })
  }
  if (hiring.hasOtherFamilies) blocks.push({ kind: "link", label: HIRING_COPY.other, href: `${base}/stack-posts?view=hiring`, style: "colon" })
  return blocks
}

function stackPostsBlocks(section: StackPostsSection, base: string): Block[] {
  const blocks: Block[] = [{ kind: "heading", text: STACK_COPY.heading }]
  if (section.groups.length === 0) {
    blocks.push({ kind: "p", text: STACK_COPY.linksEmpty }, { kind: "link", label: STACK_COPY.linksEmptyLink, href: `${base}/settings#job-criteria`, style: "colon" })
  } else {
    blocks.push({ kind: "p", text: STACK_COPY.linksIntro })
    for (const group of section.groups) {
      blocks.push({
        kind: "inline-links",
        label: group.label,
        links: [
          { label: STACK_COPY.linkLinkedIn, href: group.linkedin },
          { label: STACK_COPY.linkGooglePosts, href: group.googlePosts },
          { label: STACK_COPY.linkGoogleArticles, href: group.googleArticles },
        ],
      })
    }
  }
  if (section.hiring) blocks.push(...hiringLinksBlocks(section.hiring, base))
  if (section.verified) blocks.push(...stackPostsReadBlocks(section, base))
  if (section.hiringVerified) blocks.push(...hiringPostsBlocks(section, base))
  return blocks
}

/** EPIC-0005 AC 8: the new posts and failing feeds parts, shown only with the shared record. Unchanged output. */
function stackPostsReadBlocks(section: StackPostsSection, base: string): Block[] {
  const blocks: Block[] = []
  if (section.newCount === 0) blocks.push({ kind: "p", text: STACK_COPY.noneNew })
  else {
    blocks.push({ kind: "p", text: STACK_COPY.newTitle(section.newCount) })
    for (const post of section.newPosts) {
      const date = `${post.dateKind === "posted" ? "Posted" : "Found"} ${formatWatDate(watDate(post.date))}`
      const techs = post.matchedTechnologies.map((name) => untrusted(name)).join(", ")
      blocks.push({ kind: "post", title: post.title === "" ? STACK_COPY.untitled[post.kind] : untrusted(post.title), href: post.canonicalUrl, meta: techs ? `${date} · ${techs}` : date })
    }
    const remaining = section.newCount - section.newPosts.length
    if (remaining > 0) blocks.push({ kind: "link", label: STACK_COPY.more(remaining), href: `${base}/stack-posts`, style: "colon" })
  }
  if (section.failingFeeds.length > 0) {
    blocks.push(
      { kind: "p", text: STACK_COPY.failTitle },
      { kind: "lines", lines: section.failingFeeds.map((feed) => `${feed.label ? untrusted(feed.label) : STACK_COPY.fallbackName} (${feed.maskedUrl}): ${alertFeedFailurePhrase(feed.reason)}`) }
    )
  }
  return blocks
}

/**
 * EPIC-0007 Phase 3 (design-spec r2 B5, AC 9.1): after the Stack posts parts, only with the summary
 * Candidate's own record. Up to 10 posts, no snippet, title through `untrusted()`; the remaining
 * count links to the Hiring posts section; failing Hiring Alert feeds by name and mask.
 */
function hiringPostsBlocks(section: StackPostsSection, base: string): Block[] {
  const blocks: Block[] = []
  const count = section.hiringNewCount
  const posts = section.hiringNewPosts
  if (count === 0) blocks.push({ kind: "p", text: HIRING_COPY.noneNew })
  else {
    blocks.push({ kind: "p", text: HIRING_COPY.postsTitle(count) })
    for (const post of posts) {
      const date = `${post.dateKind === "posted" ? "Posted" : "Found"} ${formatWatDate(watDate(post.date))}`
      const techs = post.matchedTechnologies.map((name) => untrusted(name)).join(", ")
      blocks.push({
        kind: "post",
        title: post.title === "" ? STACK_COPY.untitled[post.kind] : untrusted(post.title),
        href: post.canonicalUrl,
        meta: techs ? `${date} · ${techs} · ${HIRING_COPY.notChecked}` : `${date} · ${HIRING_COPY.notChecked}`,
      })
    }
    const remaining = count - posts.length
    if (remaining > 0) blocks.push({ kind: "link", label: HIRING_COPY.more(remaining), href: `${base}/stack-posts?view=hiring#hiring-posts`, style: "colon" })
  }
  const failing = section.failingHiringFeeds
  if (failing.length > 0) {
    blocks.push(
      { kind: "p", text: HIRING_COPY.failTitle },
      { kind: "lines", lines: failing.map((feed) => `${feed.label ? untrusted(feed.label) : HIRING_COPY.fallbackName} (${feed.maskedUrl}): ${alertFeedFailurePhrase(feed.reason)}`) }
    )
  }
  return blocks
}

function section(heading: string, lines: readonly string[], none: string): Block[] {
  return [{ kind: "heading", text: heading }, { kind: "lines", lines: lines.length > 0 ? lines : [none] }]
}

function uncertainLine(item: DailySummaryInput["uncertain"][number]): string {
  const start = `${item.role} at ${item.company}, submitted ${formatWatTime(item.submittedAt)}.`
  return item.captchaAfterSubmit
    ? `${start} A CAPTCHA appeared after the submit click, so receipt can't be confirmed; it won't be retried.`
    : `${start} No confirmation seen; it won't be retried.`
}

export function renderDailySummary(input: DailySummaryInput, base: string): RenderedEmail {
  const needYou = input.blockedCount + input.uncertainCount
  const needsYou: Block[] =
    needYou === 0
      ? [{ kind: "lines", lines: ["Nothing needs you."] }]
      : [
          { kind: "link", label: `Blocked: ${input.blockedCount}`, href: `${base}/blocked`, style: "paren" },
          { kind: "link", label: `Unsure sends: ${input.uncertainCount}`, href: `${base}/uncertain`, style: "paren" },
        ]
  const status = input.costPaused
    ? `Paid automation is paused for the monthly cost ceiling. It resumes on ${firstOfNextMonth(input.watDay)}, or sooner if you raise this month's ceiling.`
    : input.globalPaused
      ? "Automation is paused."
      : input.costResumedToday
        ? "A new month started, so paid automation resumed."
        : null
  const line = (item: Readonly<{ role: string; company: string }>) => `${untrusted(item.role)} at ${untrusted(item.company)}`
  const submittedLines = input.submitted.map((item) => marked(`${line(item)} (${untrusted(item.requisitionId)})`, item.override))
  const dashboardLink: Block = { kind: "link", label: "Open your dashboard", href: `${base}/dashboard`, style: "colon" }
  const blocks: Block[] = [
    { kind: "heading", text: "Submitted" },
    { kind: "lines", lines: submittedLines.length > 0 ? [`Automatic submissions: ${input.automaticToday} of ${DAILY_CAP}.`, ...submittedLines] : ["No Applications were submitted today."] },
    { kind: "heading", text: "Needs you" },
    ...needsYou,
    ...section("Unsure sends", input.uncertain.map((item) => marked(uncertainLine({ ...item, role: untrusted(item.role), company: untrusted(item.company) }), item.override)), "No unsure sends."),
    ...section("Failures", input.failures.map((item) => marked(`${line(item)}: ${item.reason}`, item.override)), "Nothing failed."),
    ...section(
      "Not a match",
      input.skipped.map((item) => marked(`${line(item)}: ${item.reason}${item.manualPossible ? ". You can prepare it anyway, then apply on the employer's site." : ""}`, item.override)),
      "No jobs were ruled out."
    ),
    ...(input.stackPosts ? stackPostsBlocks(input.stackPosts, base) : []),
    ...(input.spend ? section("Spend", [`USD ${formatUsd(input.spend.spentMicros)} of USD ${formatUsd(input.spend.ceilingMicros)} this month.`], "") : []),
    ...((input.retentionDeleted ?? 0) > 0 ? retentionBlocks(input.retentionDeleted!, base) : []),
    ...(status ? [{ kind: "p", text: status } as const] : []),
    dashboardLink,
  ]
  // C-SP-EMAIL-TEXT-SUMMARY (D-E5-14, AC 8.5): byte for byte the preheader, and the last line of the text part.
  // EPIC-0007 Phase 3 (C-HP-EMAIL-SUMMARY-COUNT): the Hiring count follows the Stack posts count, only with the Candidate's own record.
  const stackCount = input.stackPosts?.verified ? `, ${STACK_COPY.summaryCount(input.stackPosts.newCount)}` : ""
  const hiringCount = input.stackPosts?.hiringVerified ? `, ${HIRING_COPY.summaryCount(input.stackPosts.hiringNewCount)}` : ""
  const summaryLine = `${input.skipped.length} not a match, ${input.failures.length} failed, ${input.uncertain.length} unsure${stackCount}${hiringCount}.`
  return render(`Eve, ${formatWatDate(input.watDay)}: ${input.submitted.length} submitted, ${needYou} need you`, summaryLine, blocks, { textTail: { link: dashboardLink, summaryLine } })
}

// ── E4 ───────────────────────────────────────────────────────

export type CostPauseEmailInput = Readonly<{
  /** First of the WAT month the pause belongs to. */
  month: string
  spentMicros: number
  ceilingMicros: number
  /** `{action label}`; null leaves the "Next paid action" line out. */
  action: string | null
  estimateMicros: number | null
  pausedAt: Date
  globalPaused: boolean
}>

const LIMIT_MICROS = 100_000_000
const DEFAULT_CEILING = "50.00"

export function renderCostPause(input: CostPauseEmailInput, base: string): RenderedEmail {
  const ceiling = formatUsd(input.ceilingMicros)
  const resumes = firstOfNextMonth(input.month)
  const atLimit = input.ceilingMicros >= LIMIT_MICROS
  const facts = [
    `Spent this month: USD ${formatUsd(input.spentMicros)}`,
    `This month's ceiling: USD ${ceiling}`,
    ...(input.action !== null && input.estimateMicros !== null ? [`Next paid action: ${input.action}, estimated USD ${formatUsd(input.estimateMicros)}`] : []),
    `Paused at: ${formatWat(input.pausedAt)}`,
  ]
  const sooner = atLimit
    ? "- This month's ceiling is already at the USD 100.00 limit, so it can't be raised again."
    : `- Sooner, if you raise this month's ceiling to an amount that leaves room for the next paid action. You can raise it to at most USD 100.00, and the raise lasts until the end of ${formatMonth(input.month)}.`
  const blocks: Block[] = [
    { kind: "p", text: `Paid automation is paused. The next paid action would have taken this month's spend over USD ${ceiling}, so the assistant stopped before running it.` },
    { kind: "lines", lines: facts },
    { kind: "p", text: "What's stopped: every paid action, including discovery, document generation, Eligibility and Match checks, and the browser that fills and submits forms. Nothing is sent to employers while this pause is on." },
    { kind: "p", text: "What still works: your dashboard. You can still paste job links. They're saved now, then checked for Eligibility and Match once the pause ends, because checking is a paid AI call." },
    { kind: "p", text: "Applications that were mid-way stay where they are. If the pause hit before the submit click, the Application wasn't submitted and goes ahead after the pause ends." },
    { kind: "lines", lines: ["When it resumes:", `- On its own at 00:00 WAT on ${resumes}, when a new month starts and the ceiling returns to USD ${DEFAULT_CEILING}.`, sooner] },
    {
      kind: "p",
      text: input.globalPaused
        ? "Your global pause is also on. Ending the cost pause won't resume automation until you also select Resume automation in the dashboard."
        : "Your global pause is off. You don't need to do anything else.",
    },
    ...(atLimit ? [] : [{ kind: "link", label: "Raise this month's ceiling", href: `${base}/settings#cost`, style: "colon" } as const]),
    { kind: "link", label: "See this month's spend", href: `${base}/settings#cost`, style: "colon" },
    { kind: "p", text: "You'll get one email for this pause. The daily summary repeats the status until it ends." },
  ]
  return render("Paid automation paused: monthly cost ceiling", `Nothing paid runs until ${resumes}, unless you raise this month's ceiling.`, blocks)
}

// ── EPIC-0003 Operator emails (copy-deck r2) ─────────────────

export type AccessRequestEmailInput = Readonly<{ email: string; requests: readonly Readonly<{ note: string; createdAt: Date }>[] }>

const OPERATOR_FOOTER = "You get this because your server's NOTIFY_TO setting points to this address."
const COALESCED_NOTES_MAX = 5
/** The stored note is already capped at 500 code points; this only defangs, never truncates. */
const NOTE_MAX = Number.MAX_SAFE_INTEGER
/** Same text as `landing.request.error_rate_global` (copy-deck r2, rendered from that key's string). */
const ERROR_RATE_GLOBAL = "Eve can't take more requests today. Try again tomorrow."

/**
 * `email.access_request.*`: plain text only, to `NOTIFY_TO` with `Reply-To` set to
 * the visitor. The stored email is re-checked against the endpoint's allow-list;
 * a failure refuses the send, so nothing malformed reaches an SMTP header.
 */
export function renderAccessRequest(input: AccessRequestEmailInput): RenderedEmail {
  if (!isSafeAccessRequestEmail(input.email)) throw new MailerError("send_refused")
  const note = (text: string) => (text === "" ? "No note." : untrusted(text, NOTE_MAX))
  const [first] = input.requests
  const body =
    input.requests.length === 1 && first
      ? [`Note\n${note(first.note)}`, `Received ${formatWat(first.createdAt)}`]
      : [
          `${input.requests.length} requests from this address in 24 hours. Notes are below, oldest first.`,
          ...input.requests.slice(0, COALESCED_NOTES_MAX).map((request, index) => `${index + 1}. ${formatWat(request.createdAt)}\n${note(request.note)}`),
          ...(input.requests.length > COALESCED_NOTES_MAX ? [`Only the first ${COALESCED_NOTES_MAX} notes are included.`] : []),
        ]
  return textOnly(`Eve access request from ${input.email}`, [
    `${input.email} asked for access to Eve.`,
    ...body,
    `Eve hasn't emailed ${input.email}. Replying to this message goes to them.`,
    OPERATOR_FOOTER,
  ], input.email)
}

export type AccessRequestCapEmailInput = Readonly<{ day: string; accepted: number }>

/** `email.access_request_cap.*`: once per UTC day, no visitor data, no Reply-To. */
export function renderAccessRequestCap(input: AccessRequestCapEmailInput): RenderedEmail {
  const date = formatWatDate(input.day)
  return textOnly(`Eve reached its daily limit of access requests on ${date}`, [
    `Eve accepted ${input.accepted} access requests on ${date} (UTC), the most it takes in one day.`,
    `Further requests that day were refused. Those visitors saw "${ERROR_RATE_GLOBAL}"`,
    `The ${input.accepted} accepted requests are stored and reach you as usual. Refused requests were not stored.`,
    "Requests open again at 01:00 WAT (00:00 UTC).",
    "You don't need to do anything.",
    OPERATOR_FOOTER,
  ])
}

function textOnly(subject: string, paragraphs: readonly string[], replyTo?: string): RenderedEmail {
  return { subject, preheader: paragraphs[0] ?? "", text: paragraphs.join("\n\n") + "\n", ...(replyTo ? { replyTo } : {}) }
}

// ── Rendering ────────────────────────────────────────────────

/**
 * `textTail` (daily summary only, D-E5-14) ends the text part with the given
 * link block, a blank line and `summaryLine`; the footer moves to just before
 * that link, so the summary line is the last line. The HTML part is unchanged
 * and keeps the line only in its hidden preheader. CR-E5F-05 (architecture r4
 * item 4): the link is found among `blocks` by identity (`===`), never by
 * position or kind, and a link that is not there throws: a programming error,
 * which the sender records as an `unknown` failed send.
 */
type RenderOptions = Readonly<{ textTail?: Readonly<{ link: Block; summaryLine: string }> }>

function render(subject: string, preheader: string, blocks: readonly Block[], options: RenderOptions = {}): RenderedEmail {
  const footer: Block = { kind: "p", text: FOOTER }
  const all: readonly Block[] = [...blocks, footer]
  const tail = options.textTail
  if (tail && !blocks.includes(tail.link)) throw new Error("render: the text tail's dashboard link block is not among the blocks")
  const textBlocks: readonly Block[] = tail ? [...blocks.filter((block) => block !== tail.link), footer, tail.link, { kind: "p", text: tail.summaryLine }] : all
  return { subject, preheader, text: textBlocks.map(textOf).join("\n\n") + "\n", html: htmlDocument(subject, preheader, all.map(htmlOf).join("\n")) }
}

/** Test seam for the block renderer (CR-E5F-05); production callers use the `render*` functions above. */
export const renderEmail = render

function textOf(block: Block): string {
  switch (block.kind) {
    case "p":
    case "heading":
      return block.text
    case "lines":
      return block.lines.join("\n")
    case "link":
      return block.style === "colon" ? `${block.label}: ${block.href}` : `${block.label} (${block.href})`
    case "inline-links":
      return [block.label, ...block.links.map((link) => `${link.label}: ${link.href}`)].join("\n")
    case "post":
      return `${block.title}: ${block.href}\n${block.meta}`
  }
}

const EXTERNAL = 'target="_blank" rel="noopener noreferrer"'
const A_STYLE = 'style="color:#0a0a0a;text-decoration:underline"'
const externalLink = (href: string, label: string) => `<a href="${escapeHtml(href)}" ${EXTERNAL} ${A_STYLE}>${escapeHtml(label)}</a>`

const P = 'style="margin:0 0 16px;font-size:14px;line-height:20px;color:#0a0a0a"'

function htmlOf(block: Block): string {
  switch (block.kind) {
    case "p":
      return `<p ${P}>${escapeHtml(block.text)}</p>`
    case "heading":
      return `<h2 style="margin:24px 0 8px;font-size:16px;line-height:24px;color:#0a0a0a">${escapeHtml(block.text)}</h2>`
    case "lines":
      return `<p ${P}>${block.lines.map(escapeHtml).join("<br>")}</p>`
    case "link":
      return block.external
        ? `<p ${P}>${externalLink(block.href, block.label)}</p>`
        : `<p ${P}><a href="${escapeHtml(block.href)}" style="color:#0a0a0a;text-decoration:underline">${escapeHtml(block.label)}</a></p>`
    case "inline-links":
      return `<p ${P}>${escapeHtml(block.label)}<br>${block.links.map((link) => externalLink(link.href, link.label)).join(" · ")}</p>`
    case "post":
      return `<p ${P}>${externalLink(block.href, block.title)}<br>${escapeHtml(block.meta)}</p>`
  }
}

function htmlDocument(title: string, preheader: string, body: string): string {
  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>`,
    `<body style="margin:0;padding:24px;background:#ffffff;font-family:Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif">`,
    `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>`,
    `<div style="max-width:600px;margin:0 auto">`,
    body,
    "</div></body></html>",
  ].join("\n")
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}
