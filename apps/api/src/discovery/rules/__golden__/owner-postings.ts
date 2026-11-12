import type { PostingExtraction } from "../../posting-extraction.js"
import type { StructuredFields } from "../eligibility.js"

/**
 * EPIC-0002 A0: fixture postings for the owner Eligibility golden snapshot.
 * Each one runs through today's rules with the owner's values. The set
 * covers every rule result, every skip reason and every role family, so a
 * change of behaviour when slice B moves rules onto Job Preferences shows up
 * as a byte difference in `owner-regression.snap.json`.
 *
 * Do not edit a fixture to make the snapshot pass. Adding fixtures is fine;
 * the snapshot then changes in its own commit with a reason.
 */
export type GoldenPosting = Readonly<{
  id: string
  title: string
  postingText: string
  structured: StructuredFields
  extraction: PostingExtraction
  discoveredAt: string
  fromEmployerBoard: boolean
}>

/** Fact IDs of the owner's approved Career Profile in this fixture. */
export const OWNER_FACT_IDS: readonly string[] = ["F1", "F2", "F3", "F4", "F5", "F6"]

const NO_STRUCTURED: StructuredFields = { workplace: null, locationRestrictions: null, pay: null, employmentType: null }

const NO_EXTRACTION: PostingExtraction = {
  workArrangement: "unclear",
  locationQuote: null,
  relocationCountry: null,
  relocationQuote: null,
  sponsorshipQuote: null,
  payQuote: null,
  hoursQuote: null,
  employerBusiness: "business software",
  businessQuote: null,
  employmentType: null,
  coreResponsibilities: [],
  mandatoryPrerequisites: [],
  niceToHave: [],
}

const DUTIES = ["Build React interfaces", "Own the TypeScript design system", "Ship accessible web features", "Review frontend code", "Improve page performance"]

/** `count` core duties quoted from the posting; the first `covered` are backed by an approved fact. */
function duties(count: number, covered: number): PostingExtraction["coreResponsibilities"] {
  return DUTIES.slice(0, count).map((text, index) => ({ text, quote: text, factId: index < covered ? `F${index + 1}` : null }))
}

/** The duty sentences that `duties()` quotes, for the posting text. */
function dutyText(count: number): string {
  return DUTIES.slice(0, count).map((text) => `${text}.`).join(" ")
}

type Spec = Readonly<{
  title: string
  text: string
  duties?: number
  covered?: number
  structured?: Partial<StructuredFields>
  extraction?: Partial<PostingExtraction>
  fromEmployerBoard?: boolean
  day?: number
}>

function posting(index: number, spec: Spec): GoldenPosting {
  const count = spec.duties ?? 4
  const covered = spec.covered ?? count
  const id = `golden-${String(index).padStart(2, "0")}`
  return {
    id,
    title: spec.title,
    postingText: `${spec.text} ${dutyText(count)}`.trim(),
    structured: { ...NO_STRUCTURED, ...spec.structured },
    extraction: { ...NO_EXTRACTION, coreResponsibilities: duties(count, covered), ...spec.extraction },
    discoveredAt: new Date(Date.UTC(2026, 9, 1 + (spec.day ?? index), 8, 0, 0)).toISOString(),
    fromEmployerBoard: spec.fromEmployerBoard ?? index % 2 === 0,
  }
}

const SPECS: readonly Spec[] = [
  // Location met, eligible, strong Match.
  { title: "Senior Frontend Engineer", text: "Remote, open to candidates in Nigeria. Salary USD 60,000–80,000 per year. Core hours 10:00–18:00 WAT.", extraction: { employerBusiness: "payment APIs" } },
  { title: "Frontend Engineer", text: "Fully remote. We hire in Lagos, Nigeria and across Africa." },
  { title: "Tech Lead, Web", text: "Remote, Lagos, Nigeria." },
  { title: "Full Stack Engineer", text: "Location: Nigeria. Remote role.", covered: 3 },
  { title: "Product Engineer", text: "Remote. Applicants in Nigeria are welcome.", duties: 5, covered: 4 },
  // Location violated.
  { title: "Senior Frontend Engineer", text: "Remote, US only." },
  { title: "Frontend Engineer", text: "Remote within the EU; we cannot hire in Nigeria." },
  { title: "React Engineer", text: "Remote (excluding Nigeria and Ghana)." },
  { title: "UI Engineer", text: "Remote role.", structured: { workplace: "remote", locationRestrictions: ["United States", "Canada"] } },
  { title: "Web Engineer", text: "Remote role.", structured: { workplace: "remote", locationRestrictions: ["Nigeria"] } },
  // Location unverified (worldwide wording and silence).
  { title: "Senior Frontend Engineer", text: "Remote, work from anywhere in the world." },
  { title: "Frontend Developer", text: "Remote team, async first." },
  // Relocation: allowed, excluded country, no destination, sponsorship.
  { title: "Senior Frontend Engineer", text: "You must relocate to Berlin. We offer visa sponsorship." },
  { title: "Frontend Engineer", text: "You will relocate to Istanbul. Visa sponsorship is available." },
  { title: "Frontend Engineer", text: "Relocation required. We cannot sponsor visas." },
  { title: "Senior Frontend Engineer", text: "You must relocate to Amsterdam." },
  { title: "Frontend Engineer", text: "On-site in our London office.", structured: { workplace: "onsite", locationRestrictions: ["London, United Kingdom"] } },
  // Pay.
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. Salary USD 1,000 per month." },
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. Pay EUR 45,000 per year." },
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria.", structured: { pay: { currency: "USD", min: 30, max: 45, period: "hour", label: "USD 30–45 per hour" } } },
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. Compensation GBP 1,200 per month." },
  // Hours.
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. Hours 9am–5pm PST." },
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. Core hours 09:00–17:00 CET." },
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. Overlap 2pm-10pm EST required." },
  // Industry.
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. We run an online casino platform.", extraction: { employerBusiness: "online casino" } },
  { title: "Frontend Engineer", text: "Remote, open to Nigeria. Our sportsbook serves millions.", extraction: { employerBusiness: null } },
  { title: "Frontend Engineer", text: "Remote, open to Nigeria. Gamified learning for schools.", extraction: { employerBusiness: "education software", businessQuote: "Gamified learning for schools" } },
  // Match outcomes.
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria.", duties: 5, covered: 3 },
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. Professional Kotlin Android experience.", extraction: { mandatoryPrerequisites: [{ text: "Professional Kotlin Android experience", quote: null, factId: null }] } },
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria.", duties: 0 },
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria.", duties: 4, covered: 4, extraction: { niceToHave: [{ text: "GraphQL", quote: null, factId: null }] } },
  // Role families.
  { title: "Engineering Manager", text: "Remote, open to Nigeria. Hiring and performance reviews for direct reports.", extraction: { coreResponsibilities: [{ text: "Hiring and performance reviews for direct reports", quote: null, factId: "F1" }] } },
  { title: "Backend Engineer", text: "Remote, open to Nigeria." },
  { title: "iOS Engineer", text: "Remote, open to Nigeria." },
  { title: "Site Reliability Engineer", text: "Remote, open to Nigeria." },
  { title: "Data Analyst", text: "Remote, open to Nigeria." },
  { title: "Lead Frontend Engineer", text: "Remote, open to Nigeria.", covered: 3, duties: 4 },
  // Employment type and ranking ties.
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. This is a contract role through an employer of record.", day: 3 },
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. Full-time permanent employee.", day: 3, fromEmployerBoard: true },
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. Full-time permanent employee.", day: 3, fromEmployerBoard: false },
  // Model output can't lift a violated floor.
  { title: "Senior Frontend Engineer", text: "Remote, US only.", extraction: { locationQuote: "Open to candidates in Nigeria", workArrangement: "remote" } },
  { title: "Senior Frontend Engineer", text: "Hybrid: 3 days a week in our Lagos office.", extraction: { workArrangement: "remote" } },
  // Industry unverified: no business stated.
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria.", extraction: { employerBusiness: null } },
  // A0 item 1 (r4), added in repair wave 1 (F-QA-03): a second title for each family, the precedence
  // cases, React Native, the pre-filter title forms, the contract employment type and a currency with no rate.
  { title: "Fullstack Developer", text: "Remote, open to Nigeria." },
  { title: "Senior Product Engineer", text: "Remote, open to Nigeria." },
  { title: "Senior Backend Developer", text: "Remote, open to Nigeria." },
  { title: "Android Engineer", text: "Remote, open to Nigeria." },
  { title: "Platform Engineer", text: "Remote, open to Nigeria." },
  { title: "Engineering Lead", text: "Remote, open to Nigeria. Hiring and performance reviews for direct reports.", extraction: { coreResponsibilities: [{ text: "Hiring and performance reviews for direct reports", quote: null, factId: "F1" }] } },
  { title: "Machine Learning Engineer", text: "Remote, open to Nigeria." },
  { title: "React Native Engineer", text: "Remote, open to Nigeria." },
  { title: "Sales Engineer", text: "Remote, open to Nigeria." },
  { title: "Support Engineer", text: "Remote, open to Nigeria." },
  { title: "Customer Engineer", text: "Remote, open to Nigeria." },
  { title: "Solutions Engineer", text: "Remote, open to Nigeria." },
  { title: "Field Engineer", text: "Remote, open to Nigeria." },
  { title: "HR Business Partner", text: "Remote, open to Nigeria." },
  { title: "HR Systems Engineer", text: "Remote, open to Nigeria." },
  { title: "Account Executive", text: "Remote, open to Nigeria." },
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. Independent contractor engagement." },
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria. Salary NGN 900,000–1,200,000 per month." },
]

export const OWNER_POSTINGS: readonly GoldenPosting[] = SPECS.map((spec, index) => posting(index + 1, spec))

/**
 * EPIC-0002 r5 "Should A0 cover job criteria and Stack posts?": postings that
 * carry `technologies` (EPIC-0004 AC 4), so AC 5.1 step 5 runs under a
 * non-empty criteria set. Kept apart from `OWNER_POSTINGS` so the 70
 * percent, empty-list snapshots (owner-regression, Job Postings page) stay
 * byte-equal. IDs continue the `golden-NN` sequence.
 *
 * An omitted `technologies` field verifies to null ("not checked"); `[]` is
 * "checked, none found"; a list is verified against the posting text, and an
 * item whose quote is not in the posting is dropped (AC 4.2).
 */
const TECHNOLOGY_SPECS: readonly Spec[] = [
  // Not checked (technologies null): never skipped for technology (AC 4.5).
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria." },
  { title: "Frontend Engineer", text: "Remote, open to Nigeria.", covered: 3 },
  // Checked, none found ([]).
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria.", extraction: { technologies: [] } },
  { title: "Frontend Engineer", text: "Remote, open to Nigeria.", covered: 3, extraction: { technologies: [] } },
  // Verified lists.
  { title: "Senior Frontend Engineer", text: "Remote, open to Nigeria.", extraction: { technologies: [{ name: "React", quote: "Build React interfaces" }] } },
  { title: "Product Engineer", text: "Remote, open to Nigeria. We write TS daily.", duties: 5, covered: 4, extraction: { technologies: [{ name: "TS", quote: "We write TS daily" }] } },
  { title: "Frontend Engineer", text: "Remote, open to Nigeria. Our stack is Vue 3.", extraction: { technologies: [{ name: "Vue", quote: "Our stack is Vue 3" }] } },
  {
    title: "Backend Engineer",
    text: "Remote, open to Nigeria. Our services run on Python.",
    extraction: { technologies: [{ name: "React", quote: "Angular dashboards" }, { name: "Python", quote: "run on Python" }] },
  },
  { title: "Senior Frontend Engineer", text: "Remote, US only.", extraction: { technologies: [{ name: "React", quote: "Build React interfaces" }] } },
  { title: "Full Stack Engineer", text: "Remote, open to Nigeria.", duties: 5, covered: 3, extraction: { technologies: [{ name: "TypeScript", quote: "Own the TypeScript design system" }] } },
]

export const OWNER_TECHNOLOGY_POSTINGS: readonly GoldenPosting[] = TECHNOLOGY_SPECS.map((spec, index) => posting(SPECS.length + index + 1, spec))
