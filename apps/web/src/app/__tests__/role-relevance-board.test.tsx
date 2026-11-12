import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { dated, rankedPosting, UNDATED } from "@/shared/testing"
import { openDiscovery } from "./discovery-helpers"

/**
 * EPIC-0006 board states against the v1.18.0 MSW fake: age label, hidden-count
 * line, all-hidden empty state, Not checked yet, failure lines, waiting notice
 * variants and the target-only Posting filter panel.
 */

const hidden = (reason: "off_target" | "below_seniority_floor" | "undated" | "older_than_60_days", overrides = {}) =>
  rankedPosting({ hiddenReason: reason, ...(reason === "undated" ? UNDATED : {}), ...overrides })

async function table() {
  return screen.findByRole("region", { name: "Job Postings, scrolls horizontally" })
}

const settingsLinks = () => screen.queryAllByRole("link", { name: "Change job criteria" })

describe("Posting age label (posting-age.feature AC-6.3)", () => {
  it.each([
    ["published", "Posted 45 days ago"],
    ["updated", "Updated 45 days ago"],
  ] as const)("a %s date 45 days old shows %s on the row and the card, inside <time>", async (kind, label) => {
    openDiscovery("/postings?tab=all", {
      postings: [rankedPosting({ title: "Senior Frontend Engineer", company: "Acme", ...dated(45, kind) })],
    })
    const row = within(await table()).getAllByRole("row")[1]
    const rowLabel = within(row).getByText(label)
    expect(rowLabel.tagName).toBe("TIME")
    expect(rowLabel).toHaveAttribute("dateTime", "2026-09-09")
    const card = within(screen.getByRole("list", { name: "Job Postings" })).getAllByRole("listitem")[0]
    expect(within(card).getByText(label)).toBeInTheDocument()
  })

  it("age 30 shows no label; age 31 does", async () => {
    openDiscovery("/postings?tab=all", {
      postings: [
        rankedPosting({ title: "Thirty", company: "A", rank: 1, ...dated(30) }),
        rankedPosting({ title: "Thirty-one", company: "B", rank: 2, ...dated(31) }),
      ],
    })
    const [, thirty, thirtyOne] = within(await table()).getAllByRole("row")
    expect(thirty).not.toHaveTextContent(/days ago/)
    expect(within(thirtyOne).getByText("Posted 31 days ago")).toBeInTheDocument()
  })

  it("sits on the attribution meta line with a hidden separator", async () => {
    openDiscovery("/postings?tab=all", {
      postings: [rankedPosting({ attribution: { name: "Himalayas", url: "https://himalayas.app" }, ...dated(45) })],
    })
    const row = within(await table()).getAllByRole("row")[1]
    const age = within(row).getByText("Posted 45 days ago")
    // DP-3: separator and label share one wrapping item, next to the attribution link.
    const group = age.closest("[data-slot=posting-age-group]") as HTMLElement
    expect(within(group).getByText("·")).toHaveAttribute("aria-hidden", "true")
    const line = group.parentElement!
    expect(within(line).getByRole("link", { name: /via Himalayas/ })).toBeInTheDocument()
    expect(group.firstElementChild).toHaveTextContent("·")
  })
})

describe("Hidden-count line (hidden-postings-board.feature AC-3.5)", () => {
  it("names the total and each non-zero reason, links to Job criteria, and lists no hidden title", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=good", {
      postings: [rankedPosting({ title: "Visible Lead", company: "Globex" })],
      extraHiddenCounts: { offTarget: 1247, belowSeniorityFloor: 12, olderThan60Days: 34 },
    })
    const line = await screen.findByText("1,293 postings hidden: 1,247 off-target roles, 12 entry-level and 34 older than 60 days.", { exact: false })
    expect(line.closest("p")).not.toHaveAttribute("role")
    expect(line.closest("p")).not.toHaveAttribute("aria-live")
    const link = within(line.closest("p")!).getByRole("link", { name: "Change job criteria" })
    expect(link).toHaveAttribute("href", "/settings#job-criteria")
    await user.click(link)
    expect(currentPath()).toBe("/settings#job-criteria")
  })

  it.each(["ranked", "skipped", "all"])("shows the same counts on the %s tab", async (tab) => {
    openDiscovery(`/postings?tab=${tab}`, {
      postings: [
        rankedPosting({ title: "Visible", company: "A" }),
        rankedPosting({ title: "Skipped", company: "B", status: "skipped", rank: null, skipReason: "weak_core_match" }),
        ...Array.from({ length: 4 }, () => hidden("off_target", { roleFamily: "data_ml" })),
        hidden("undated"),
        hidden("undated"),
      ],
    })
    expect(await screen.findByText("6 postings hidden: 4 off-target roles and 2 with no posted date.", { exact: false })).toBeVisible()
  })

  it("uses the singular for one hidden posting", async () => {
    openDiscovery("/postings?tab=good", { postings: [rankedPosting(), hidden("off_target")] })
    expect(await screen.findByText("1 posting hidden: 1 off-target role.", { exact: false })).toBeVisible()
  })

  it("is absent when nothing is hidden", async () => {
    openDiscovery("/postings?tab=good", { postings: [rankedPosting()] })
    await table()
    expect(screen.queryByText(/postings? hidden/)).not.toBeInTheDocument()
  })

  it("ignores the Posting filter and keeps its link above the filter empty state", async () => {
    openDiscovery("/postings?tab=all&keyword=zzz", {
      postings: [rankedPosting(), ...Array.from({ length: 4 }, () => hidden("off_target"))],
    })
    expect(await screen.findByRole("heading", { name: "No postings match these filters" })).toBeVisible()
    const line = screen.getByText("4 postings hidden: 4 off-target roles.", { exact: false }).closest("p")!
    expect(within(line).getByRole("link", { name: "Change job criteria" })).toBeVisible()
    expect(screen.queryByText("Every posting Eve found is hidden")).not.toBeInTheDocument()
  })

  it("sits above the Ranked tab's existing empty state, with its link, when other tabs have visible postings", async () => {
    openDiscovery("/postings?tab=good", {
      postings: [
        rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match" }),
        ...Array.from({ length: 5 }, () => hidden("off_target")),
      ],
    })
    expect(await screen.findByText("No good matches yet")).toBeVisible()
    const line = screen.getByText("5 postings hidden: 5 off-target roles.", { exact: false }).closest("p")!
    expect(within(line).getByRole("link", { name: "Change job criteria" })).toBeVisible()
    expect(screen.queryByText("Every posting Eve found is hidden")).not.toBeInTheDocument()
  })
})

describe("All-hidden empty state (AC-3.6, AC-8.4)", () => {
  it("every posting undated: the bodyUndated variant, one link to Job criteria, the line without its link", async () => {
    openDiscovery("/postings?tab=good", { postings: [hidden("undated"), hidden("undated")], extraHiddenCounts: { undated: 2220 } })
    expect(await screen.findByRole("heading", { level: 2, name: "Every posting Eve found is hidden" })).toBeVisible()
    expect(screen.getByText("Posted dates fill in the next time Eve reads each job board. Your job criteria decide the rest.")).toBeVisible()
    expect(screen.getByText("2,222 postings hidden: 2,222 with no posted date.")).toBeVisible()
    expect(screen.queryByText("No jobs yet")).not.toBeInTheDocument()
    expect(settingsLinks()).toHaveLength(1)
    expect(settingsLinks()[0]).toHaveAttribute("href", "/settings#job-criteria")
  })

  it("every posting off-target on All: the settings body variant", async () => {
    openDiscovery("/postings?tab=all", { postings: Array.from({ length: 10 }, () => hidden("off_target")) })
    expect(await screen.findByRole("heading", { level: 2, name: "Every posting Eve found is hidden" })).toBeVisible()
    expect(
      screen.getByText("Your role families, seniority setting and the 60-day age limit decide what shows. The line above gives each reason.")
    ).toBeVisible()
    expect(settingsLinks()).toHaveLength(1)
  })

  it("on Skipped by rules too", async () => {
    openDiscovery("/postings?tab=not_a_match", { postings: Array.from({ length: 3 }, () => hidden("older_than_60_days")) })
    expect(await screen.findByRole("heading", { level: 2, name: "Every posting Eve found is hidden" })).toBeVisible()
  })

  it("no postings at all keeps the first-run state and no hidden line", async () => {
    openDiscovery("/postings?tab=good")
    expect(await screen.findByText("No jobs yet")).toBeVisible()
    expect(screen.queryByText(/postings? hidden/)).not.toBeInTheDocument()
  })
})

describe("Not checked yet and failure lines (AC-4.3, AC-7.7)", () => {
  it("a visible not_checked posting shows the neutral badge and its line, different from the failed one", async () => {
    openDiscovery("/postings?tab=all", {
      postings: [
        rankedPosting({ title: "Solutions Architect", company: "Globex", status: "not_checked", rank: null, roleFamily: "solutions_customer" }),
        rankedPosting({ title: "Senior Frontend Engineer", company: "Acme", status: "evaluation_failed", rank: null, evaluationFailure: "provider_error" }),
      ],
    })
    const [, notChecked, failed] = within(await table()).getAllByRole("row")
    const badge = within(notChecked).getByText("Couldn't check")
    expect(badge.querySelector("svg")).toHaveClass("lucide-triangle-alert")
    expect(within(notChecked).getByText("Not checked while it was hidden. Use Check again on Jobs.")).toBeVisible()
    expect(within(failed).getByText("Couldn't check")).toBeVisible()
    expect(within(failed).getByText("Not checked: Anthropic didn't answer. Use Check again on Jobs to retry.")).toBeVisible()
  })

  it.each([
    ["invalid_output", "Not checked: the AI answer couldn't be used. Use Check again on Jobs to retry."],
    ["timed_out", "Not checked: the check took too long. Use Check again on Jobs to retry."],
    ["not_configured", "Not checked: the Anthropic API key isn't set on the server. Set it there, then use Check again."],
    ["no_career_profile", "Not checked: the Career Profile isn't approved. Approve it, then use Check again."],
  ] as const)("a %s row reads its deck line and never says 'Paste the link again later'", async (kind, line) => {
    openDiscovery("/postings?tab=all", {
      postings: [rankedPosting({ status: "evaluation_failed", rank: null, evaluationFailure: kind })],
    })
    const row = within(await table()).getAllByRole("row")[1]
    expect(within(row).getByText(line)).toBeVisible()
    expect(document.body).not.toHaveTextContent("Paste the link again later")
    // not_configured offers no dashboard action: the only link in the row is the posting title.
    if (kind === "not_configured") expect(within(row).getAllByRole("link").map((a) => a.textContent)).toEqual(["Senior Frontend Engineer at Acme Payments"])
  })
})

describe("Waiting notice variant (waitingReason, AC-7.4)", () => {
  it("cost_pause reads the Operator text", async () => {
    openDiscovery("/postings?tab=good", { waitingToBeCheckedCount: 1, postings: [rankedPosting()] })
    expect(
      await screen.findByText("1 posting is waiting to be checked. Eve checks it when the cost pause ends, then ranks it with the rest.", { exact: false })
    ).toBeVisible()
  })

  it("checks_not_enabled reads the invitee text with no cost-pause wording", async () => {
    openDiscovery("/postings?tab=good", { waitingToBeCheckedCount: 3, waitingReason: "checks_not_enabled", postings: [rankedPosting()] })
    const text = await screen.findByText(
      "3 postings are waiting to be checked. They aren't checked until the person who runs your Eve turns on checks for you.",
      { exact: false }
    )
    expect(text.closest("[data-slot=alert]")).toHaveAttribute("role", "status")
    expect(screen.queryByText(/cost pause/)).not.toBeInTheDocument()
    expect(within(text.closest("[data-slot=alert]") as HTMLElement).getByRole("link", { name: "See them" })).toHaveAttribute(
      "href",
      "/postings?tab=all"
    )
  })

  it("no notice when nothing waits", async () => {
    openDiscovery("/postings?tab=good", { postings: [rankedPosting()] })
    await table()
    expect(screen.queryByText(/waiting to be checked\./)).not.toBeInTheDocument()
  })
})

describe("Posting filter panel lists only target families (AC-3.7, P7)", () => {
  it("lists the targets in catalog order", async () => {
    const { user } = openDiscovery("/postings?tab=all", {
      postings: [rankedPosting()],
      targetRoleFamilies: ["senior_frontend", "backend", "data_ml"],
    })
    await table()
    await user.click(screen.getByRole("button", { name: "Role family" }))
    const panel = await screen.findByRole("dialog", { name: "Role family" })
    expect(within(panel).getAllByRole("checkbox").map((box) => box.closest("label")?.textContent)).toEqual([
      "Frontend",
      "Backend",
      "Data and ML",
    ])
  })

  it("a URL naming a non-target family is accepted and shows the filter empty state", async () => {
    openDiscovery("/postings?tab=all&families=other", { postings: [rankedPosting(), hidden("off_target", { roleFamily: "other" })] })
    expect(await screen.findByRole("heading", { name: "No postings match these filters" })).toBeVisible()
  })
})

describe("Row with a not_checked posting appears only on All (AC-4.3)", () => {
  it("is not on Ranked", async () => {
    openDiscovery("/postings?tab=good", {
      postings: [rankedPosting({ title: "Visible", company: "A" }), rankedPosting({ title: "Solutions Architect", company: "Globex", status: "not_checked", rank: null })],
    })
    await table()
    await waitFor(() => expect(screen.queryAllByRole("link", { name: "Solutions Architect at Globex" })).toHaveLength(0))
  })
})
