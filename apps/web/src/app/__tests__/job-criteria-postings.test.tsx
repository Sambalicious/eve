import { act, screen, waitFor, within } from "@testing-library/react"
import { JOB_POSTINGS_PATH } from "@eve/contracts"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, rankedPosting, server, strongMatch } from "@/shared/testing"
import { criteriaSection, openWithCriteria } from "./job-criteria-helpers"

const NOT_CHECKED = "Technologies not checked"
const EMPTY_TITLE = "No postings meet your job criteria."
const TECH_LINE = "This job doesn't mention the technologies you told Eve to look for."

const withMatch = (covered: number, total: number, thresholdPercent: number, verdict: "strong" | "weak" = "weak") => ({
  ...strongMatch(),
  verdict,
  weakReason: verdict === "weak" ? ("coverage_below_threshold" as const) : null,
  coveredCount: covered,
  totalCount: total,
  thresholdPercent,
})

const skipped = (title: string, company: string, skipReason: "weak_core_match" | "technology_mismatch", covered = 6, total = 10, threshold = 70) =>
  rankedPosting({
    title,
    company,
    status: "skipped",
    rank: null,
    skipReason,
    match: withMatch(covered, total, threshold, skipReason === "technology_mismatch" ? "strong" : "weak"),
  })

async function table() {
  return screen.findByRole("region", { name: "Job Postings, scrolls horizontally" })
}

/** D4 (design-spec r2): the not-checked badge's glyph is CircleQuestionMark, never the Unverified CircleDashed. */
function expectQuestionMarkIcon(badge: HTMLElement) {
  const icon = badge.querySelector(":scope > svg")!
  expect(icon).toHaveClass("lucide-circle-question-mark")
  expect(icon).not.toHaveClass("lucide-circle-dashed")
  expect(icon).toHaveAttribute("aria-hidden", "true")
}

/** The desktop table row and the mobile card that name this posting. */
function rowsFor(name: string) {
  return screen.getAllByRole("link", { name }).map((link) => link.closest("tr, li") as HTMLElement)
}

describe("Postings page under Job criteria (postings-page.feature)", () => {
  // r7 (decision D1, prd.r3 AC 6.1): slice 8's "Search job titles" field and "Role family" menu stay; no Job criteria control appears.
  it("@ac-6.1 @ac-7.3 keeps the tabs Good matches, Manual apply, Not a match, All, with no Job criteria controls", async () => {
    const { user } = openWithCriteria("/postings", { criteria: { minCoreMatchPercent: 80, frameworks: ["React"] } })
    const tabs = await screen.findAllByRole("tab")
    expect(tabs.map((t) => t.textContent)).toEqual(["Good matches", "Manual apply", "Not a match", "All"])
    for (const name of ["Good matches", "Manual apply", "Not a match", "All"]) {
      await user.click(screen.getByRole("tab", { name }))
      expect(screen.queryByRole("slider")).not.toBeInTheDocument()
      expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument()
      expect(screen.queryByLabelText(/minimum core match|threshold|frameworks|technologies/i)).not.toBeInTheDocument()
      expect(screen.getAllByRole("searchbox").map((box) => box.getAttribute("id"))).toEqual(["postings-title-search"])
      expect(screen.getByRole("button", { name: /^Role family/ })).toBeInTheDocument()
    }
  })

  it("@ac-6.2 each tab lists the postings with the matching status", async () => {
    const { user } = openWithCriteria("/postings", {
      discovery: {
        postings: [
          rankedPosting({ title: "Frontend Tech Lead", company: "Globex" }),
          skipped("Frontend Engineer", "Initech", "weak_core_match"),
          skipped("Backend Engineer", "Umbrella", "technology_mismatch", 8),
          rankedPosting({ title: "Mobile Engineer", company: "Hooli", status: "skipped", rank: null, skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Kotlin" }),
          rankedPosting({ title: "Data Engineer", company: "Pied Piper", status: "excluded", rank: null, skipReason: "violated_rule", skipDetail: "location" }),
        ],
      },
    })
    const names = async () => within(await table()).getAllByRole("link", { name: / at / }).map((a) => a.textContent)
    await waitFor(async () => expect(await names()).toEqual(["Frontend Tech Lead at Globex"]))
    await user.click(screen.getByRole("tab", { name: "Not a match" }))
    await waitFor(async () =>
      expect(await names()).toEqual(["Frontend Engineer at Initech", "Backend Engineer at Umbrella", "Mobile Engineer at Hooli", "Data Engineer at Pied Piper"])
    )
    await user.click(screen.getByRole("tab", { name: "All" }))
    await waitFor(async () => expect(await names()).toHaveLength(5))
  })

  it.each([
    ["Frontend Engineer", "Initech", "weak_core_match", 6, 10, 70, "Your profile backs only 60% of the core responsibilities. Your minimum is 70%."],
    ["Backend Engineer", "Umbrella", "technology_mismatch", 8, 10, 70, TECH_LINE],
    ["Frontend Tech Lead", "Globex", "weak_core_match", 8, 10, 90, "Your profile backs only 80% of the core responsibilities. Your minimum is 90%."],
  ] as const)("@ac-6.2 @ac-2.6 @ac-5.2 %s at %s skipped as %s shows its reason line", async (title, company, reason, covered, total, threshold, line) => {
    openWithCriteria("/postings?tab=not_a_match", { discovery: { postings: [skipped(title, company, reason, covered, total, threshold)] } })
    const region = await table()
    const row = within(region).getByRole("link", { name: `${title} at ${company}` }).closest("tr")!
    expect(within(row).getByText(line)).toBeVisible()
    expect(within(row).getByText("Not a match")).toBeVisible()
  })

  it("@ac-6.2 lists both weak-Match skips with their reason lines while Ranked is empty", async () => {
    openWithCriteria("/postings?tab=not_a_match", {
      criteria: { minCoreMatchPercent: 100 },
      discovery: {
        criteriaEmptyState: true,
        postings: [skipped("Frontend Engineer", "Initech", "weak_core_match", 9, 10, 100), skipped("Platform Engineer", "Hooli", "weak_core_match", 7, 10, 100)],
      },
    })
    const region = await table()
    expect(within(region).getByText("Your profile backs only 90% of the core responsibilities. Your minimum is 100%.")).toBeVisible()
    expect(within(region).getByText("Your profile backs only 70% of the core responsibilities. Your minimum is 100%.")).toBeVisible()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
  })

  it("@ac-6.4 @ac-4.5 a ranked posting with no technology data shows Technologies not checked on its row (table and card)", async () => {
    openWithCriteria("/postings", {
      criteria: { frameworks: ["React"] },
      discovery: { postings: [rankedPosting({ title: "Frontend Tech Lead", company: "Globex", technologiesNotChecked: true, match: withMatch(8, 10, 70, "strong") })] },
    })
    await table()
    const rows = rowsFor("Frontend Tech Lead at Globex")
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(within(row).getByText(NOT_CHECKED)).toBeInTheDocument()
      expectQuestionMarkIcon(within(row).getByText(NOT_CHECKED))
    }
  })

  it("@ac-3.6 the not-checked label is absent when the API says the criterion is off", async () => {
    openWithCriteria("/postings", {
      discovery: { postings: [rankedPosting({ title: "Frontend Tech Lead", company: "Globex", technologiesNotChecked: false, technologies: null })] },
    })
    await table()
    expect(screen.queryByText(NOT_CHECKED)).not.toBeInTheDocument()
  })

  it("shows the label on ranked rows only, not on skipped rows (design-spec decision on Open question 5)", async () => {
    openWithCriteria("/postings?tab=not_a_match", {
      discovery: { postings: [{ ...skipped("Frontend Engineer", "Initech", "weak_core_match"), technologiesNotChecked: true }] },
    })
    await table()
    expect(screen.queryByText(NOT_CHECKED)).not.toBeInTheDocument()
  })

  it("@ac-6.3 Ranked names the Job criteria when they caused the empty list, and the link opens the section", async () => {
    const { user, currentPath } = openWithCriteria("/postings", {
      criteria: { minCoreMatchPercent: 90 },
      discovery: { criteriaEmptyState: true, postings: [skipped("Frontend Engineer", "Initech", "weak_core_match", 6, 10, 90)] },
    })
    const title = await screen.findByRole("heading", { level: 2, name: EMPTY_TITLE })
    expect(title).toBeVisible()
    expect(screen.getByText("Postings Eve ruled out are on the Not a match tab, each with its reason. Nothing was deleted.")).toBeVisible()
    const link = screen.getByRole("link", { name: "Change job criteria" })
    expect(link).toHaveAttribute("href", "/settings#job-criteria")
    expect(screen.queryByText("No good matches yet")).not.toBeInTheDocument()

    await user.click(link)
    expect(currentPath()).toBe("/settings#job-criteria")
    expect(await criteriaSection()).toHaveAttribute("id", "job-criteria")
    expect(document.title).toBe("Settings · Eve")
    // design-spec J5 step 5: focus lands on the section heading.
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Job criteria" })).toHaveFocus())
  })

  it("@ac-6.3 otherwise Ranked keeps the EPIC-0001 empty state", async () => {
    openWithCriteria("/postings", {
      discovery: { criteriaEmptyState: false, postings: [skipped("Frontend Engineer", "Initech", "weak_core_match")] },
    })
    expect(await screen.findByText("No good matches yet")).toBeVisible()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
  })

  it("@ac-6.3 a new installation with no postings keeps the first-run empty state", async () => {
    openWithCriteria("/postings")
    expect(await screen.findByText("No jobs yet")).toBeVisible()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
  })

  it("@ac-6.3 a ranked posting means no empty state, whatever the flag", async () => {
    openWithCriteria("/postings", {
      discovery: { criteriaEmptyState: false, postings: [rankedPosting({ title: "Frontend Tech Lead", company: "Globex" }), skipped("Frontend Engineer", "Initech", "weak_core_match")] },
    })
    expect(await screen.findAllByRole("link", { name: "Frontend Tech Lead at Globex" })).not.toHaveLength(0)
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
  })

  it("the criteria empty state shows only on Ranked, not on the other tabs", async () => {
    openWithCriteria("/postings?tab=all", { discovery: { criteriaEmptyState: true, postings: [] } })
    expect(await screen.findByText("No jobs yet")).toBeVisible()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
  })
})

/** r7 slice 8 coexistence (decision D1) and design-spec r2 B2 "Empty-state precedence on Ranked". */
describe("Postings page: slice 8 filters under Job criteria (postings-page.feature r7)", () => {
  const FILTER_EMPTY = "No postings match these filters"
  const search = () => screen.getByRole("searchbox", { name: "Search job titles" })
  const rankedNames = async () =>
    within(await table())
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("link")[0].textContent)

  it("@ac-6.1 role family and title search narrow the Ranked tab's criteria-matching postings; Clear filters restores them", async () => {
    const umbrella = skipped("Senior React Developer", "Umbrella", "technology_mismatch", 8)
    const piedPiper = skipped("Senior React Engineer", "Pied Piper", "weak_core_match")
    const { user, discovery } = openWithCriteria("/postings", {
      criteria: { frameworks: ["React"] },
      discovery: {
        postings: [
          rankedPosting({ title: "Senior React Engineer", company: "Globex", roleFamily: "senior_frontend", rank: 1 }),
          rankedPosting({ title: "React Tech Lead", company: "Initech", roleFamily: "technical_lead", rank: 2 }),
          rankedPosting({ title: "Senior Frontend Engineer", company: "Hooli", roleFamily: "senior_frontend", rank: 3 }),
          umbrella,
          piedPiper,
        ],
      },
    })
    await waitFor(async () => expect(await rankedNames()).toHaveLength(3))

    await user.click(screen.getByRole("button", { name: /^Role family/ }))
    const panel = await screen.findByRole("dialog", { name: "Role family" })
    await user.click(within(panel).getByRole("checkbox", { name: "Frontend" }))
    await user.keyboard("{Escape}")
    await user.type(search(), "React{Enter}")

    await waitFor(async () => expect(await rankedNames()).toEqual(["Senior React Engineer at Globex"]))
    expect(screen.queryByRole("link", { name: "Senior React Developer at Umbrella" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Senior React Engineer at Pied Piper" })).not.toBeInTheDocument()
    expect(discovery.listRequests.at(-1)?.toString()).toContain("tab=ranked")

    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    await waitFor(async () =>
      expect(await rankedNames()).toEqual(["Senior React Engineer at Globex", "React Tech Lead at Initech", "Senior Frontend Engineer at Hooli"])
    )
    // Filters never change a status or a skip reason.
    await user.click(screen.getByRole("tab", { name: "Not a match" }))
    const region = await table()
    expect(within(region).getByText(TECH_LINE)).toBeVisible()
    expect(within(region).getByText("Your profile backs only 60% of the core responsibilities. Your minimum is 70%.")).toBeVisible()
  })

  it("@ac-6.1 @ac-6.3 a selection that empties Ranked shows slice 8's filter-empty state, even when criteriaEmptyState is true", async () => {
    const { user } = openWithCriteria("/postings", {
      criteria: { minCoreMatchPercent: 90 },
      discovery: {
        criteriaEmptyState: true,
        postings: [
          rankedPosting({ title: "Senior React Engineer", company: "Globex", roleFamily: "senior_frontend" }),
          skipped("Frontend Engineer", "Initech", "weak_core_match", 6, 10, 90),
        ],
      },
    })
    await table()
    await user.type(search(), "Kotlin{Enter}")

    expect(await screen.findByRole("heading", { level: 2, name: FILTER_EMPTY })).toBeVisible()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Change job criteria" })).not.toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Clear filters" })).toHaveLength(1)
  })

  it("@ac-6.3 a selection on an already criteria-empty Ranked tab still shows filter-empty; Clear filters then shows the criteria empty state", async () => {
    const { user } = openWithCriteria("/postings?tab=good&families=mobile", {
      criteria: { minCoreMatchPercent: 90 },
      discovery: { criteriaEmptyState: true, postings: [skipped("Frontend Engineer", "Initech", "weak_core_match", 6, 10, 90)] },
    })
    expect(await screen.findByRole("heading", { level: 2, name: FILTER_EMPTY })).toBeVisible()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(await screen.findByRole("heading", { level: 2, name: EMPTY_TITLE })).toBeVisible()
    expect(screen.queryByText(FILTER_EMPTY)).not.toBeInTheDocument()
  })

  it("@ac-6.3 with no selection and criteriaEmptyState false, Ranked keeps the built empty state", async () => {
    openWithCriteria("/postings?tab=good", {
      discovery: { criteriaEmptyState: false, postings: [skipped("Frontend Engineer", "Initech", "weak_core_match")] },
    })
    expect(await screen.findByText("No good matches yet")).toBeVisible()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
    expect(screen.queryByText(FILTER_EMPTY)).not.toBeInTheDocument()
  })

  it("a load error wins over every empty state", async () => {
    openWithCriteria("/postings?tab=good&keyword=kotlin", { discovery: { criteriaEmptyState: true, postings: [] } })
    server.use(http.get(JOB_POSTINGS_PATH, () => apiErrorResponse("internal_error")))
    expect(await screen.findByText("Couldn't load this page.")).toBeVisible()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
    expect(screen.queryByText(FILTER_EMPTY)).not.toBeInTheDocument()
  })

  it("@ac-6.4 the not-checked badge renders on rows loaded by Load more, and skip lines on paged Skipped rows", async () => {
    const ranked = Array.from({ length: 27 }, (_, i) =>
      rankedPosting({ title: `R${String(i + 1).padStart(2, "0")} Engineer`, company: "Acme", rank: i + 1, technologiesNotChecked: i >= 25 })
    )
    const skips = Array.from({ length: 27 }, (_, i) =>
      skipped(`S${String(i + 1).padStart(2, "0")} Engineer`, "Acme", i % 2 === 0 ? "weak_core_match" : "technology_mismatch", 6, 10, 70)
    )
    const { user } = openWithCriteria("/postings", { criteria: { frameworks: ["React"] }, discovery: { postings: [...ranked, ...skips] } })
    await waitFor(async () => expect(await rankedNames()).toHaveLength(25))
    expect(screen.queryByText(NOT_CHECKED)).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Load more" }))
    await waitFor(async () => expect(await rankedNames()).toHaveLength(27))
    for (const name of ["R26 Engineer at Acme", "R27 Engineer at Acme"]) {
      for (const row of rowsFor(name)) expect(within(row).getByText(NOT_CHECKED)).toBeInTheDocument()
    }

    await user.click(screen.getByRole("tab", { name: "Not a match" }))
    await waitFor(async () => expect(await rankedNames()).toHaveLength(25))
    await user.click(screen.getByRole("button", { name: "Load more" }))
    await waitFor(async () => expect(await rankedNames()).toHaveLength(27))
    const [s26] = rowsFor("S26 Engineer at Acme")
    const [s27] = rowsFor("S27 Engineer at Acme")
    expect(within(s26).getByText(TECH_LINE)).toBeVisible()
    expect(within(s27).getByText("Your profile backs only 60% of the core responsibilities. Your minimum is 70%.")).toBeVisible()
  })
})

describe("Posting detail: Technologies mentioned (technology-extraction.feature, criteria-decision.feature)", () => {
  const technologies = [
    { name: "React", quote: "You will build features in React and TypeScript", inCriteria: true },
    { name: "TypeScript", quote: "You will build features in React and TypeScript", inCriteria: false },
    { name: "AWS", quote: "deployed on AWS with Terraform", inCriteria: false },
  ]

  async function region() {
    return screen.findByRole("region", { name: "Technologies mentioned" })
  }

  it("@ac-4.4 lists each verified technology with its quote, after the Match panel", async () => {
    const posting = rankedPosting({ match: strongMatch(), technologies: technologies.map((t) => ({ ...t, inCriteria: false })) })
    openWithCriteria(`/postings/${posting.id}`, { discovery: { postings: [posting] } })
    const section = await region()
    const rows = within(section).getAllByRole("listitem")
    expect(rows.map((r) => r.querySelector("span")?.textContent)).toEqual(["React", "TypeScript", "AWS"])
    expect(within(rows[2]).getByText("deployed on AWS with Terraform").tagName).toBe("BLOCKQUOTE")
    expect(within(rows[2]).getByText("From the posting:")).toHaveClass("sr-only")
    const match = screen.getByRole("region", { name: "Match" })
    expect(match.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("@ac-4.4 marks a technology in the criteria, sorts it first and counts the matches", async () => {
    const posting = rankedPosting({ match: strongMatch(), technologies: [technologies[2], technologies[0]] })
    openWithCriteria(`/postings/${posting.id}`, { criteria: { frameworks: ["React.js"] }, discovery: { postings: [posting] } })
    const section = await region()
    const react = within(section).getByRole("listitem", { name: "React, in your criteria" })
    expect(within(react).getByText("In your criteria")).toBeVisible()
    const rows = within(section).getAllByRole("listitem")
    expect(rows[0]).toBe(react)
    expect(within(rows[1]).queryByText("In your criteria")).not.toBeInTheDocument()
    expect(await within(section).findByText("1 of 2 is in your criteria.")).toBeVisible()
    expect(within(section).getByRole("link", { name: "Change job criteria" })).toHaveAttribute("href", "/settings#job-criteria")
  })

  it("says none of these is in your criteria when the criterion is on and nothing matches", async () => {
    const posting = rankedPosting({ status: "skipped", rank: null, skipReason: "technology_mismatch", match: strongMatch(), technologies: [technologies[2]] })
    openWithCriteria(`/postings/${posting.id}`, { criteria: { frameworks: ["React"] }, discovery: { postings: [posting] } })
    const section = await region()
    expect(await within(section).findByText("None of these is in your criteria.")).toBeVisible()
    expect(screen.getByText(TECH_LINE)).toBeVisible()
  })

  it("@ac-3.6 @ac-4.4 with both lists empty, still lists technologies with no criteria marks or summary", async () => {
    const posting = rankedPosting({
      match: strongMatch(),
      technologies: [
        { name: "React", quote: "Build UIs in React", inCriteria: false },
        { name: "AWS", quote: "hosted on AWS", inCriteria: false },
      ],
    })
    openWithCriteria(`/postings/${posting.id}`, { discovery: { postings: [posting] } })
    const section = await region()
    expect(within(section).getByText("Build UIs in React")).toBeVisible()
    expect(within(section).getByText("hosted on AWS")).toBeVisible()
    expect(screen.queryByText("In your criteria")).not.toBeInTheDocument()
    expect(within(section).queryByText(/in your criteria\.$/)).not.toBeInTheDocument()
  })

  it("@ac-4.5 an empty list is technology data: None found in the posting, and no not-checked label", async () => {
    const posting = rankedPosting({ match: strongMatch(), technologies: [] })
    openWithCriteria(`/postings/${posting.id}`, { criteria: { frameworks: ["React"] }, discovery: { postings: [posting] } })
    const section = await region()
    expect(within(section).getAllByText("None found in the posting.")).toHaveLength(1)
    expect(screen.queryByText(NOT_CHECKED)).not.toBeInTheDocument()
  })

  it("@ac-4.5 a posting evaluated before this epic shows Technologies not checked with its note", async () => {
    const posting = rankedPosting({ match: strongMatch(), technologies: null, technologiesNotChecked: true })
    openWithCriteria(`/postings/${posting.id}`, { criteria: { frameworks: ["React"] }, discovery: { postings: [posting] } })
    const section = await region()
    expect(within(section).getByText(NOT_CHECKED)).toBeVisible()
    expectQuestionMarkIcon(within(section).getByText(NOT_CHECKED))
    expect(
      within(section).getByText("Eve checked this posting before it read technologies, so the technology rule wasn't applied. It gets them on its next check.")
    ).toBeVisible()
  })

  it("@ac-3.6 no technology data with the criterion off: the section and label are absent", async () => {
    const posting = rankedPosting({ match: strongMatch(), technologies: null, technologiesNotChecked: false })
    openWithCriteria(`/postings/${posting.id}`, { discovery: { postings: [posting] } })
    await screen.findByRole("region", { name: "Match" })
    expect(screen.queryByRole("region", { name: "Technologies mentioned" })).not.toBeInTheDocument()
    expect(screen.queryByText(NOT_CHECKED)).not.toBeInTheDocument()
  })

  it("shows 12 rows and Show all {n} over 12, matched rows always within the first 12", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ name: `Tool ${i + 1}`, quote: `uses Tool ${i + 1}`, inCriteria: i === 14 }))
    const posting = rankedPosting({ match: strongMatch(), technologies: many })
    const { user } = openWithCriteria(`/postings/${posting.id}`, { criteria: { technologies: ["Tool 15"] }, discovery: { postings: [posting] } })
    const section = await region()
    expect(within(section).getAllByRole("listitem")).toHaveLength(12)
    expect(within(section).getByRole("listitem", { name: "Tool 15, in your criteria" })).toBeVisible()
    const toggle = within(section).getByRole("button", { name: "Show all 15" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    await user.click(toggle)
    expect(within(section).getAllByRole("listitem")).toHaveLength(15)
    expect(within(section).getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true")
  })

  /**
   * SEC-011 / CR-02 (technology-extraction.feature r9): the API drops malformed stored entries before
   * it answers (job-criteria.int-spec.ts covers that against Postgres), and postingTechnologySchema is
   * strict, so a malformed entry can never reach the web as valid contract data. The fake therefore
   * returns what the API sends for the scenario's six stored entries: only the well-formed one.
   */
  it("@ac-4.4 @ac-5.11 the detail page loads with only the well-formed technology the API kept from malformed stored entries", async () => {
    const posting = rankedPosting({
      title: "Frontend Engineer",
      company: "Initech",
      match: withMatch(8, 10, 70, "strong"),
      technologies: [{ name: "React", quote: "We use React.", inCriteria: true }],
    })
    openWithCriteria(`/postings/${posting.id}`, { criteria: { frameworks: ["React"] }, discovery: { postings: [posting] } })
    const section = await region()
    const rows = within(section).getAllByRole("listitem")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toBe(within(section).getByRole("listitem", { name: "React, in your criteria" }))
    expect(within(rows[0]).getByText("We use React.").tagName).toBe("BLOCKQUOTE")
    expect(within(rows[0]).getByText("In your criteria")).toBeVisible()
    expect(screen.getByRole("region", { name: "Match" })).toBeVisible()
  })

  it("the detail reason alert shows the numbered weak-Match line", async () => {
    const posting = rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match", match: withMatch(7, 10, 80), technologies: [] })
    openWithCriteria(`/postings/${posting.id}`, { criteria: { minCoreMatchPercent: 80 }, discovery: { postings: [posting] } })
    expect(await screen.findByText("Your profile backs only 70% of the core responsibilities. Your minimum is 80%.")).toBeVisible()
  })
})

/**
 * finding-r3-empty-flash (design-review.r2 BLOCKER[frontend-engineer]): while a new view loads and the
 * previous one had no rows, the last settled empty state stays, dimmed like the rows, until the new page
 * arrives. No other empty state may appear in between.
 */
describe("Postings page: the last settled empty state stays while a view loads (finding-r3-empty-flash)", () => {
  const FILTER_EMPTY = "No postings match these filters"
  const NOTHING_ELIGIBLE = "No good matches yet"
  const FIRST_RUN = "No jobs yet"
  const search = () => screen.getByRole("searchbox", { name: "Search job titles" })

  /** Holds every list request until `release()`; held requests then fall through to the fake API. */
  function holdListRequests() {
    const held: Array<() => void> = []
    let open = false
    server.use(
      http.get(JOB_POSTINGS_PATH, () => (open ? undefined : new Promise<undefined>((resolve) => held.push(() => resolve(undefined)))))
    )
    return {
      release: () => {
        open = true
        act(() => held.splice(0).forEach((resolve) => resolve()))
      },
    }
  }

  /** Records whether `text` was ever in the document, so a one-frame flash is caught too. */
  function watchFor(...texts: string[]) {
    const seen = new Set<string>()
    const check = () => texts.forEach((t) => document.body.textContent?.includes(t) && seen.add(t))
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    return {
      seen: () => {
        check()
        observer.disconnect()
        return [...seen]
      },
    }
  }

  async function dimmed(title: string) {
    const heading = await screen.findByRole("heading", { level: 2, name: title })
    await waitFor(() => expect(heading.closest(".transition-opacity")).toHaveClass("opacity-60"))
  }

  it("Ranked: typing a filter keeps the criteria empty state, dimmed, until the filter-empty page arrives", async () => {
    const watch = watchFor(NOTHING_ELIGIBLE, FIRST_RUN)
    const { user } = openWithCriteria("/postings", {
      criteria: { minCoreMatchPercent: 90 },
      discovery: { criteriaEmptyState: true, postings: [skipped("Frontend Engineer", "Initech", "weak_core_match", 6, 10, 90)] },
    })
    expect(await screen.findByRole("heading", { level: 2, name: EMPTY_TITLE })).toBeVisible()
    const gate = holdListRequests()

    await user.type(search(), "React{Enter}")
    await dimmed(EMPTY_TITLE)
    expect(screen.queryByText(FILTER_EMPTY)).not.toBeInTheDocument()

    gate.release()
    const filterEmpty = await screen.findByRole("heading", { level: 2, name: FILTER_EMPTY })
    expect(filterEmpty.closest(".transition-opacity")).not.toHaveClass("opacity-60")
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
    expect(watch.seen()).toEqual([])
  })

  it("Ranked: Clear filters keeps the filter-empty state, dimmed, until the criteria empty state arrives", async () => {
    const watch = watchFor(NOTHING_ELIGIBLE, FIRST_RUN)
    const { user } = openWithCriteria("/postings?tab=good&families=mobile", {
      criteria: { minCoreMatchPercent: 90 },
      discovery: { criteriaEmptyState: true, postings: [skipped("Frontend Engineer", "Initech", "weak_core_match", 6, 10, 90)] },
    })
    await screen.findByRole("heading", { level: 2, name: FILTER_EMPTY })
    const gate = holdListRequests()

    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    await dimmed(FILTER_EMPTY)
    // One Clear filters at most: the filter bar's own stays hidden while FilterEmpty shows.
    expect(screen.getAllByRole("button", { name: "Clear filters" })).toHaveLength(1)

    gate.release()
    expect(await screen.findByRole("heading", { level: 2, name: EMPTY_TITLE })).toBeVisible()
    expect(screen.queryByText(FILTER_EMPTY)).not.toBeInTheDocument()
    expect(watch.seen()).toEqual([])
  })

  it("Ranked: Clear filters on a new installation goes from filter-empty straight to first-run, never Nothing eligible", async () => {
    const watch = watchFor(NOTHING_ELIGIBLE)
    const { user } = openWithCriteria("/postings?tab=good&keyword=kotlin", { discovery: { criteriaEmptyState: false, postings: [] } })
    await screen.findByRole("heading", { level: 2, name: FILTER_EMPTY })
    const gate = holdListRequests()

    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    await dimmed(FILTER_EMPTY)

    gate.release()
    expect(await screen.findByText(FIRST_RUN)).toBeVisible()
    expect(watch.seen()).toEqual([])
  })

  it("Ranked: Clear filters with no postings ranked and no criteria cause shows Nothing eligible only once the page arrives", async () => {
    const { user } = openWithCriteria("/postings?tab=good&keyword=kotlin", {
      discovery: { criteriaEmptyState: false, postings: [skipped("Frontend Engineer", "Initech", "weak_core_match")] },
    })
    await screen.findByRole("heading", { level: 2, name: FILTER_EMPTY })
    const gate = holdListRequests()

    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    await dimmed(FILTER_EMPTY)
    expect(screen.queryByText(NOTHING_ELIGIBLE)).not.toBeInTheDocument()

    gate.release()
    expect(await screen.findByText(NOTHING_ELIGIBLE)).toBeVisible()
    expect(screen.queryByText(FILTER_EMPTY)).not.toBeInTheDocument()
  })

  it("Skipped: Clear filters keeps the filter-empty state, dimmed, until the rows arrive", async () => {
    const watch = watchFor(NOTHING_ELIGIBLE, FIRST_RUN)
    const { user } = openWithCriteria("/postings?tab=not_a_match&keyword=kotlin", {
      discovery: { postings: [skipped("Frontend Engineer", "Initech", "weak_core_match")] },
    })
    await screen.findByRole("heading", { level: 2, name: FILTER_EMPTY })
    const gate = holdListRequests()

    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    await dimmed(FILTER_EMPTY)

    gate.release()
    expect(await screen.findAllByRole("link", { name: "Frontend Engineer at Initech" })).not.toHaveLength(0)
    expect(watch.seen()).toEqual([])
  })

  it("All: typing a filter on an empty tab keeps its empty state, dimmed, until the filter-empty page arrives", async () => {
    const { user } = openWithCriteria("/postings?tab=all", { discovery: { postings: [] } })
    await screen.findByRole("heading", { level: 2, name: FIRST_RUN })
    const gate = holdListRequests()

    await user.type(search(), "React{Enter}")
    await dimmed(FIRST_RUN)
    expect(screen.queryByText(FILTER_EMPTY)).not.toBeInTheDocument()

    gate.release()
    expect(await screen.findByRole("heading", { level: 2, name: FILTER_EMPTY })).toBeVisible()
    expect(screen.queryByText(FIRST_RUN)).not.toBeInTheDocument()
  })

  it("a tab change from an empty Ranked tab keeps the Ranked empty state, dimmed, until the Skipped rows arrive", async () => {
    const watch = watchFor(NOTHING_ELIGIBLE, FIRST_RUN)
    const { user } = openWithCriteria("/postings", {
      criteria: { minCoreMatchPercent: 90 },
      discovery: { criteriaEmptyState: true, postings: [skipped("Frontend Engineer", "Initech", "weak_core_match", 6, 10, 90)] },
    })
    await screen.findByRole("heading", { level: 2, name: EMPTY_TITLE })
    const gate = holdListRequests()

    await user.click(screen.getByRole("tab", { name: "Not a match" }))
    await dimmed(EMPTY_TITLE)

    gate.release()
    expect(await screen.findAllByRole("link", { name: "Frontend Engineer at Initech" })).not.toHaveLength(0)
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
    expect(watch.seen()).toEqual([])
  })

  it("a first visit to an empty Ranked tab never shows Nothing eligible before first-run", async () => {
    const watch = watchFor(NOTHING_ELIGIBLE)
    openWithCriteria("/postings")
    expect(await screen.findByText(FIRST_RUN)).toBeVisible()
    expect(watch.seen()).toEqual([])
  })
})
