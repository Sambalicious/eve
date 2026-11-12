import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { dated, rankedPosting, UNDATED } from "@/shared/testing"
import { openDiscovery } from "./discovery-helpers"

/** hidden-postings-applications-and-links.feature (AC-3.8), posting-age.feature (AC-6.3, 6.4) and posted-date.feature (AC-5.7). */

const NOTICE = {
  off_target: "Hidden from your board: off-target role, not one of your role families.",
  below_seniority_floor: "Hidden from your board: entry-level role, below your seniority setting.",
  undated: "Hidden from your board: no posted date.",
  older_than_60_days: "Hidden from your board: posted more than 60 days ago.",
} as const
const BODY = "Eve keeps this posting, and any Application for it still links here. No new Application can start from it."

describe("Hidden posting detail page (AC-3.8)", () => {
  it.each([
    ["off_target", true],
    ["below_seniority_floor", true],
    ["undated", false],
    ["older_than_60_days", false],
  ] as const)("names the %s reason; links to Job criteria: %s", async (reason, links) => {
    const posting = rankedPosting({ hiddenReason: reason, ...(reason === "undated" ? UNDATED : dated(reason === "older_than_60_days" ? 84 : 4)) })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })
    const title = await screen.findByText(NOTICE[reason])
    const notice = title.closest("[data-slot=alert]") as HTMLElement
    expect(notice).not.toHaveAttribute("role")
    expect(within(notice).getByText(BODY, { exact: false })).toBeVisible()
    const link = within(notice).queryByRole("link", { name: "Change job criteria" })
    if (links) expect(link).toHaveAttribute("href", "/settings#job-criteria")
    else expect(link).not.toBeInTheDocument()
  })

  it("a hidden ranked posting offers no Prepare documents and shows no rank, even in manual mode", async () => {
    const posting = rankedPosting({ hiddenReason: "off_target", roleFamily: "data_ml", applyMode: "manual", rank: 3 })
    const { api } = openDiscovery(`/postings/${posting.id}`, { postings: [posting] })
    expect(await screen.findByText(NOTICE.off_target)).toBeVisible()
    expect(screen.queryByRole("button", { name: /Prepare documents/ })).not.toBeInTheDocument()
    expect(api.state.postings[0].rank).toBe(3)
    expect(screen.getByText("Data and ML")).toBeVisible()
  })

  it("a visible ranked posting shows no hidden notice and keeps Prepare documents", async () => {
    const posting = rankedPosting({ title: "Senior Frontend Engineer", company: "Acme" })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })
    expect(await screen.findByRole("button", { name: /Prepare documents/ })).toBeVisible()
    expect(screen.queryByText(/Hidden from your board/)).not.toBeInTheDocument()
  })

  it("DP-4 a hidden failed posting keeps its badge but shows no failure line naming Check again", async () => {
    const posting = rankedPosting({
      status: "evaluation_failed",
      rank: null,
      evaluationFailure: "not_configured",
      eligibility: null,
      match: null,
      hiddenReason: "older_than_60_days",
      ...dated(84),
    })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })
    expect(await screen.findByText(NOTICE.older_than_60_days)).toBeVisible()
    expect(screen.getByText("Hidden")).toBeVisible()
    expect(screen.queryByText(/^Not checked:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Check again/)).not.toBeInTheDocument()
  })

  it("DP-4 a visible failed posting still shows its failure line", async () => {
    const posting = rankedPosting({ status: "evaluation_failed", rank: null, evaluationFailure: "timed_out", eligibility: null, match: null })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })
    expect(await screen.findByText("Not checked: the check took too long. Use Check again on Jobs to retry.")).toBeVisible()
  })

  it("a hidden not_checked posting shows the notice, not the Not checked yet line", async () => {
    const posting = rankedPosting({ status: "not_checked", rank: null, hiddenReason: "off_target", eligibility: null, match: null })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })
    expect(await screen.findByText(NOTICE.off_target)).toBeVisible()
    expect(screen.getByText("Hidden")).toBeVisible()
    expect(screen.queryByText("Not checked while it was hidden. Use Check again on Jobs.")).not.toBeInTheDocument()
  })
})

describe("Detail posted date and age (AC-6.3, AC-6.4)", () => {
  it.each([
    ["published", "Posted", "Posted 45 days ago"],
    ["updated", "Updated", "Updated 45 days ago"],
  ] as const)("a %s date shows the %s fact as a WAT date and the age label", async (kind, label, age) => {
    const posting = rankedPosting(dated(45, kind))
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })
    const term = await screen.findByText(label, { selector: "dt" })
    const value = term.nextElementSibling!.querySelector("time")!
    expect(value).toHaveTextContent("9 Sep 2026")
    expect(value).toHaveAttribute("dateTime", "2026-09-09")
    expect(screen.getByText(age)).toBeVisible()
  })

  it("a fresh posting shows its date but no age label", async () => {
    const posting = rankedPosting(dated(4))
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })
    expect(await screen.findByText("Posted", { selector: "dt" })).toBeVisible()
    expect(screen.queryByText(/days ago/)).not.toBeInTheDocument()
  })

  it("a hidden 84-day-old posting still shows its date and the age", async () => {
    const posting = rankedPosting({ hiddenReason: "older_than_60_days", ...dated(84) })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })
    expect(await screen.findByText("Posted 84 days ago")).toBeVisible()
    expect(screen.getByText("1 Aug 2026")).toBeVisible()
  })

  it("an undated posting shows no posted date", async () => {
    const posting = rankedPosting({ hiddenReason: "undated", ...UNDATED })
    openDiscovery(`/postings/${posting.id}`, { postings: [posting] })
    expect(await screen.findByText(NOTICE.undated)).toBeVisible()
    expect(screen.queryByText("Posted", { selector: "dt" })).not.toBeInTheDocument()
    expect(screen.queryByText("Updated", { selector: "dt" })).not.toBeInTheDocument()
  })
})

describe("Paste result for a hidden link (AC-5.7)", () => {
  const paste = async (user: ReturnType<typeof openDiscovery>["user"], url: string) => {
    await user.type(await screen.findByLabelText("Job link"), url)
    await user.click(screen.getByRole("button", { name: "Check link" }))
  }

  it.each([
    ["undated", "no posted date"],
    ["off_target", "off-target role"],
    ["below_seniority_floor", "entry-level role"],
    ["older_than_60_days", "posted more than 60 days ago"],
  ] as const)("a new %s link: 'Saved, but hidden: %s.' with View it, and no success toast", async (reason, phrase) => {
    const { user, currentPath } = openDiscovery("/postings", {
      nextPasted: (url) => rankedPosting({ applicationUrl: url, applyUrl: url, status: "not_checked", rank: null, hiddenReason: reason }),
    })
    await paste(user, "https://jobs.lever.co/globex/abc-999")
    const line = await screen.findByText(`Saved, but hidden: ${phrase}.`, { exact: false })
    expect(line).toHaveAttribute("role", "status")
    expect(screen.getByLabelText("Job link")).toHaveAccessibleDescription(expect.stringContaining(`Saved, but hidden: ${phrase}.`))
    expect(screen.queryByText(/^Checking the link\./)).not.toBeInTheDocument()
    const created = await waitFor(() => {
      const href = within(line).getByRole("link", { name: "View it" }).getAttribute("href")
      expect(href).toMatch(/^\/postings\//)
      return href
    })
    await user.click(within(line).getByRole("link", { name: "View it" }))
    expect(currentPath()).toBe(created)
  })

  it("a known hidden link says the Candidate already has it and names the reason", async () => {
    const stored = rankedPosting({ applicationUrl: "https://jobs.lever.co/globex/abc-999", hiddenReason: "undated", ...UNDATED })
    const { user, api } = openDiscovery("/postings", { postings: [stored] })
    await paste(user, "https://jobs.lever.co/globex/abc-999")
    expect(await screen.findByText("You already have this Job Posting. It's hidden: no posted date.", { exact: false })).toBeVisible()
    expect(api.state.postings).toHaveLength(1)
  })

  it("a visible new link keeps the success toast and shows no hidden line", async () => {
    const { user } = openDiscovery("/postings")
    await paste(user, "https://jobs.lever.co/globex/fe-1")
    expect(await screen.findByText(/^Checking the link\./)).toBeInTheDocument()
    expect(screen.queryByText(/hidden:/)).not.toBeInTheDocument()
  })
})
