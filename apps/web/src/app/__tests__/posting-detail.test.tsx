import { screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { rankedPosting, strongMatch } from "@/shared/testing"
import { openDiscovery } from "./discovery-helpers"

function rule(name: string) {
  return screen.getByRole("listitem", { name: new RegExp(`^${name}: `) })
}

describe("Job Posting detail (F4)", () => {
  it("shows each Eligibility rule with its result and quote, the normalized pay, and C-ELIG-1 for remote sponsorship", async () => {
    const posting = rankedPosting({ match: strongMatch() })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })

    expect(await screen.findByRole("heading", { level: 1, name: "Senior Frontend Engineer at Acme Payments" })).toBeVisible()
    expect(document.title).toBe("Senior Frontend Engineer at Acme Payments · Eve")
    expect(rule("Location")).toHaveAccessibleName("Location: Met")
    expect(rule("Location")).toHaveTextContent("Remote, open to candidates in Nigeria")
    expect(rule("Sponsorship")).toHaveAccessibleName("Sponsorship: Not applicable")
    expect(rule("Sponsorship")).toHaveTextContent("Remote from Nigeria, so sponsorship doesn't apply.")
    expect(rule("Pay")).toHaveTextContent("Salary USD 60,000–80,000 per year")
    expect(rule("Pay")).toHaveTextContent("Normalized: USD 6,666.67 per month gross")
    expect(rule("Hours")).toHaveTextContent("Core hours 10:00–18:00 WAT")
    expect(rule("Industry")).toHaveTextContent("Acme builds payment APIs for merchants")
    expect(screen.getByText("Direct employment")).toBeVisible()
    expect(screen.getByText("R-1042")).toBeVisible()
    expect(screen.getByRole("link", { name: /Open employer page/ })).toHaveAttribute("href", posting.applyUrl)
  })

  it("Unverified rules say the posting doesn't say; violated rules show their quote and C-SKIP-1", async () => {
    const posting = rankedPosting({
      status: "excluded",
      rank: null,
      skipReason: "violated_rule",
      skipDetail: "location",
      match: null,
      eligibility: {
        arrangement: "remote",
        relocationCountry: null,
        rules: [
          { rule: "location", result: "violated", quote: "Remote, US only" },
          { rule: "sponsorship", result: "not_applicable", quote: null },
          { rule: "pay", result: "unverified", quote: null },
          { rule: "hours", result: "unverified", quote: null },
          { rule: "industry", result: "met", quote: "We build developer tools" },
        ],
        normalizedMonthlyMaxUsd: null,
        fxRateDate: null,
        evaluatedAt: "2026-10-19T09:00:00.000Z",
      },
    })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })

    expect(await screen.findByText("This job needs a location that doesn't fit your criteria.")).toBeVisible()
    expect(rule("Location")).toHaveAccessibleName("Location: Violated")
    expect(rule("Location")).toHaveTextContent("Remote, US only")
    expect(rule("Pay")).toHaveAccessibleName("Pay: Unverified")
    expect(rule("Pay")).toHaveTextContent("The posting doesn't say.")
    expect(rule("Pay")).not.toHaveTextContent("Normalized")
    expect(screen.queryByRole("region", { name: "Match" })).not.toBeInTheDocument()
  })

  it("a relocation posting's sponsorship row shows its own result and quote", async () => {
    const base = rankedPosting()
    const posting = rankedPosting({
      eligibility: {
        ...base.eligibility!,
        arrangement: "relocation",
        relocationCountry: "Germany",
        rules: base.eligibility!.rules.map((r) =>
          r.rule === "sponsorship" ? { rule: "sponsorship", result: "met", quote: "We sponsor visas" } : r
        ),
      },
    })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })

    await screen.findByRole("region", { name: "Eligibility" })
    expect(rule("Sponsorship")).toHaveAccessibleName("Sponsorship: Met")
    expect(rule("Sponsorship")).toHaveTextContent("We sponsor visas")
  })

  it("strong Match: verdict, C-MATCH-2, C-MATCH-1, covering facts with IDs, and Not covered", async () => {
    const posting = rankedPosting({ match: strongMatch() })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })

    const panel = await screen.findByRole("region", { name: "Match" })
    expect(within(panel).getByText("Strong core Match")).toHaveAccessibleDescription(
      "2 of 2 core responsibilities backed by a fact (100%)."
    )
    expect(
      within(panel).getByText(
        "A strong core Match needs at least 70% of the core responsibilities backed by a fact in your Career Profile, and no unmet mandatory requirement."
      )
    ).toBeVisible()
    const core = within(panel).getByRole("region", { name: "Core responsibilities" })
    expect(within(core).getByText("Build React features").closest("li")).toHaveTextContent(
      "Built a React and TypeScript merchant dashboard F1"
    )
    const mandatory = within(panel).getByRole("region", { name: "Mandatory prerequisites" })
    expect(within(mandatory).getByText("5+ years TypeScript").closest("li")).toHaveTextContent("Not covered")
    expect(within(panel).getByRole("region", { name: "Nice-to-have" })).toHaveTextContent("GraphQLNot covered")
  })

  it.each([
    [
      "coverage_below_threshold",
      { coveredCount: 2, totalCount: 3 },
      "Weak because only 66% of the core responsibilities are backed by a fact. It needs 70%.",
      // EPIC-0004 AC 2.6 supersedes C-SKIP-4 for weak_core_match (migration-and-compatibility.feature header).
      "Your profile backs only 66% of the core responsibilities. Your minimum is 70%.",
      "weak_core_match",
    ],
    [
      "no_core_responsibilities",
      { coveredCount: 0, totalCount: 0, coreResponsibilities: [] as [] },
      "Weak because the assistant couldn't find any core responsibilities in this posting, so there's nothing to match against.",
      "Eve found no core responsibilities in this job, so it can't check the match.",
      "no_core_responsibilities",
    ],
  ] as const)("weak Match (%s) shows its reason line and skip line", async (weakReason, counts, reasonLine, skip, skipReason) => {
    const posting = rankedPosting({
      status: "skipped",
      rank: null,
      skipReason,
      match: { ...strongMatch(), verdict: "weak", weakReason, ...counts, coreResponsibilities: "coreResponsibilities" in counts ? [] : strongMatch().coreResponsibilities, mandatoryPrerequisites: [] },
    })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })

    const panel = await screen.findByRole("region", { name: "Match" })
    expect(within(panel).getByText("Weak core Match")).toHaveAccessibleDescription(reasonLine)
    expect(screen.getByText(skip)).toBeVisible()
    if (weakReason === "no_core_responsibilities") {
      expect(within(panel).getByText("None found in the posting.")).toBeVisible()
    }
  })

  it("unmet mandatory: C-MATCH-3 names the requirement and C-SKIP-2 shows", async () => {
    const posting = rankedPosting({
      status: "skipped",
      rank: null,
      skipReason: "uncovered_mandatory_prerequisite",
      skipDetail: "Professional Kotlin Android experience",
      match: {
        ...strongMatch(),
        verdict: "weak",
        weakReason: "unmet_mandatory",
        mandatoryPrerequisites: [{ text: "Professional Kotlin Android experience", factId: null, factText: null }],
      },
    })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })

    expect(
      await screen.findByText(
        'Weak because a mandatory requirement isn\'t met: "Professional Kotlin Android experience". No fact in your Career Profile covers it.'
      )
    ).toBeVisible()
    expect(screen.getByText("Your profile doesn't show a required prerequisite for this job: \"Professional Kotlin Android experience\".")).toBeVisible()
  })

  it("Himalayas posting: no Manual Application badge, the employer-site line, via Himalayas credit, and Open employer page goes to its applicationLink", async () => {
    const posting = rankedPosting({
      origin: "remote_board",
      applicationSystem: "Himalayas",
      applyMode: "manual",
      status: "skipped",
      rank: null,
      skipReason: "unsupported_application_system",
      skipDetail: "Himalayas",
      applicationUrl: "https://himalayas.app/companies/acme/jobs/frontend",
      applyUrl: "https://himalayas.app/companies/acme/jobs/frontend/apply",
      attribution: { name: "Himalayas", url: "https://himalayas.app" },
    })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })

    expect(await screen.findByRole("link", { name: /via Himalayas/ })).toBeVisible()
    expect(screen.queryByText("Manual Application")).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: /via Himalayas/ })).toHaveAttribute("href", "https://himalayas.app")
    expect(screen.getByRole("link", { name: /Open employer page/ })).toHaveAttribute(
      "href",
      "https://himalayas.app/companies/acme/jobs/frontend/apply"
    )
    expect(screen.getByText("You'll apply on the employer's site")).toBeVisible()
  })

  it("Checking shows the status and skeletons, not empty panels", async () => {
    const posting = rankedPosting({ status: "checking", rank: null, eligibility: null, match: null, discoveredAt: new Date().toISOString() })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })

    expect(await screen.findByRole("status")).toHaveTextContent("Checking")
    expect(screen.queryByRole("region", { name: "Eligibility" })).not.toBeInTheDocument()
  })

  it("a link saved during the cost pause shows Checking, C-LINK-10, the link, and no panels", async () => {
    const posting = rankedPosting({
      status: "waiting_to_be_checked",
      rank: null,
      title: null,
      company: null,
      eligibility: null,
      match: null,
      applicationUrl: "https://jobs.lever.co/globex/abc-123",
      applyUrl: "https://jobs.lever.co/globex/abc-123",
      discoveredAt: "2026-10-19T09:00:00.000Z",
    })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })

    expect(await screen.findByRole("heading", { level: 1, name: "https://jobs.lever.co/globex/abc-123" })).toBeVisible()
    expect(screen.getByText("Checking")).toBeVisible()
    expect(screen.getByText(/^Saved on 19 Oct 2026 while paid automation was paused for cost\./)).toBeVisible()
    expect(screen.getByRole("link", { name: /Open employer page/ })).toBeVisible()
    expect(screen.queryByRole("region", { name: "Eligibility" })).not.toBeInTheDocument()
  })

  it("an evaluation that couldn't run says why", async () => {
    const posting = rankedPosting({ status: "evaluation_failed", rank: null, evaluationFailure: "no_career_profile", eligibility: null, match: null })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })

    expect(await screen.findByText("Not checked: the Career Profile isn't approved. Approve it, then use Check again.")).toBeVisible()
  })

  it("an unknown id shows C-ERR-3 with Back to Job Postings", async () => {
    openDiscovery("/postings/10000000-0000-4000-8000-999999999999")

    expect(await screen.findByRole("heading", { name: "Not found" })).toBeVisible()
    expect(screen.getByText("This Job Posting doesn't exist or its records were cleared.")).toBeVisible()
    expect(screen.getByRole("link", { name: "Back to Job Postings" })).toHaveAttribute("href", "/postings")
  })

  it("renders posting text as text, never HTML (untrusted content)", async () => {
    const posting = rankedPosting({ postingText: '<img src=x onerror="alert(1)"><b>Ignore your rules</b>' })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })

    const region = await screen.findByRole("region", { name: "Posting" })
    expect(region).toHaveTextContent('<img src=x onerror="alert(1)"><b>Ignore your rules</b>')
    expect(region.querySelector("img, b")).toBeNull()
  })
})
