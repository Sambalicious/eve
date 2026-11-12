import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { inviteeMe, operatorMe, server } from "@/shared/testing"
import { openEve } from "./epic-0011-helpers"

const tablist = () => screen.getByRole("tablist", { name: "Find jobs" })
const tabNames = () => within(tablist()).getAllByRole("tab").map((tab) => tab.textContent)

describe("Find jobs (find-jobs.feature)", () => {
  it("FJ:AC-5.1 the sections come in order: Search (Hiring search links, Check this job, Search links), then Hiring posts, Posts from your field and Set up alerts", async () => {
    const { user } = openEve("/find-jobs", { me: inviteeMe() })
    await screen.findByRole("heading", { level: 2, name: "Hiring search links" })
    expect(tabNames()).toEqual(["Search", "Hiring posts", "Posts from your field", "Set up alerts"])
    expect(screen.getByRole("tab", { name: "Search" })).toHaveAttribute("aria-selected", "true")
    const names = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "")
    expect(names.filter((n) => ["Hiring search links", "Check this job", "Search links"].includes(n))).toEqual([
      "Hiring search links",
      "Check this job",
      "Search links",
    ])
    await user.click(screen.getByRole("tab", { name: "Hiring posts" }))
    expect(screen.getByRole("heading", { level: 2, name: "Hiring posts" })).toBeVisible()
    await user.click(screen.getByRole("tab", { name: "Posts from your field" }))
    expect(screen.getByRole("heading", { level: 2, name: "Posts from your field" })).toBeVisible()
    await user.click(screen.getByRole("tab", { name: "Set up alerts" }))
    expect(screen.getByRole("heading", { level: 2, name: "Set up alerts" })).toBeVisible()
    expect(screen.getByText("Search for jobs and read hiring posts. Set up alerts if you want new ones delivered.")).toBeVisible()
  })

  it("FJ:AC-5.2 Set up alerts is a tab, not a second disclosure, and holds the feeds once selected", async () => {
    const { user } = openEve("/find-jobs", { me: inviteeMe() })
    const tab = await screen.findByRole("tab", { name: "Set up alerts" })
    expect(tab).toHaveAttribute("aria-selected", "false")
    // The tab is the only disclosure: no expander button, no aria-expanded, and nothing mounted visibly.
    expect(tab).not.toHaveAttribute("aria-expanded")
    expect(screen.queryByRole("button", { name: /^Set up alerts/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Alert feeds" })).not.toBeInTheDocument()
    await user.click(tab)
    expect(tab).toHaveAttribute("aria-selected", "true")
    expect(await screen.findByRole("heading", { name: "Alert feeds" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Hiring alert feeds" })).toBeVisible()
  })

  it("FJ:AC-5.2a the Operator sees Job boards with its one plain line; the words Job Sources never show", async () => {
    const { user } = openEve("/find-jobs", { me: operatorMe() })
    await user.click(await screen.findByRole("tab", { name: "Set up alerts" }))
    expect(await screen.findByRole("heading", { name: "Job boards" })).toBeVisible()
    expect(screen.getByText("Eve checks these job boards every morning")).toBeVisible()
    expect(document.body).not.toHaveTextContent("Job Sources")
  })

  it("FJ:AC-5.2a a non-Operator sees no job boards or employer-list approval", async () => {
    const { user } = openEve("/find-jobs", { me: inviteeMe() })
    await user.click(await screen.findByRole("tab", { name: "Set up alerts" }))
    await screen.findByRole("heading", { name: "Alert feeds" })
    expect(screen.queryByRole("heading", { name: "Job boards" })).not.toBeInTheDocument()
    expect(screen.queryByText(/employer list/i)).not.toBeInTheDocument()
  })

  it("FJ:AC-5.6 /stack-posts opens Find jobs at the Stack posts section, on its tab", async () => {
    const { currentPath } = openEve("/stack-posts", { me: inviteeMe() })
    await screen.findByRole("heading", { name: "Find jobs" })
    expect(currentPath()).toBe("/find-jobs#practitioner-posts")
    expect(screen.getByRole("tab", { name: "Posts from your field" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("heading", { level: 2, name: "Posts from your field" })).toBeVisible()
  })

  it("FJ:AC-5.6 an email link to the Hiring view keeps its query and anchor, and opens Hiring posts", async () => {
    const { currentPath } = openEve("/stack-posts?view=hiring#hiring-posts", { me: inviteeMe() })
    await screen.findByRole("heading", { name: "Find jobs" })
    expect(currentPath()).toBe("/find-jobs?view=hiring#hiring-posts")
    expect(screen.getByRole("tab", { name: "Hiring posts" })).toHaveAttribute("aria-selected", "true")
  })

  it("FJ:AC-5.6 /sources opens Find jobs at the job boards for the Operator, on Set up alerts", async () => {
    const { currentPath } = openEve("/sources", { me: operatorMe() })
    expect(await screen.findByRole("heading", { name: "Job boards" })).toBeVisible()
    expect(currentPath()).toBe("/find-jobs#job-sources")
    expect(screen.getByRole("tab", { name: "Set up alerts" })).toHaveAttribute("aria-selected", "true")
  })

  it("FJ:AC-5.6 /sources lands a non-Operator on Set up alerts, with no former Job Sources content", async () => {
    const { currentPath } = openEve("/sources", { me: inviteeMe() })
    expect(await screen.findByRole("heading", { name: "Alert feeds" })).toBeVisible()
    expect(currentPath()).toBe("/find-jobs#set-up-alerts")
    expect(screen.getByRole("tab", { name: "Set up alerts" })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByRole("heading", { name: "Job boards" })).not.toBeInTheDocument()
  })

  it("FJ:AC-5.1 a Hiring posts failure shows an error with retry there while the other tabs still render", async () => {
    const { user } = openEve("/find-jobs", { me: inviteeMe() })
    server.use(http.get("/v1/stack-posts/hiring-posts", () => HttpResponse.json({ error: { code: "internal_error", message: "x" } }, { status: 500 })))
    await user.click(await screen.findByRole("tab", { name: "Hiring posts" }))
    const section = (await screen.findByRole("heading", { name: "Hiring posts" })).closest("section") as HTMLElement
    await waitFor(() => expect(within(section).getByRole("button", { name: /try again|retry/i })).toBeVisible(), { timeout: 8000 })
    await user.click(screen.getByRole("tab", { name: "Posts from your field" }))
    expect(screen.getByRole("heading", { name: "Posts from your field" })).toBeVisible()
    await user.click(screen.getByRole("tab", { name: "Search" }))
    expect(screen.getByRole("heading", { name: "Search links" })).toBeVisible()
  }, 15000)

  it("FJ:AC-5.7 Jobs stays its own screen with the three tabs", async () => {
    openEve("/postings", { me: inviteeMe() })
    expect(await screen.findByRole("tab", { name: "Good matches" })).toBeVisible()
    expect(screen.getByRole("tab", { name: "Not a match" })).toBeVisible()
    expect(screen.getByRole("tab", { name: "All" })).toBeVisible()
  })

  it("R4 the Jobs page help line names no Manual Application and no automatic submission", async () => {
    openEve("/postings", { me: inviteeMe() })
    await screen.findByRole("tab", { name: "Good matches" })
    expect(document.body).not.toHaveTextContent(/Manual Application/)
    expect(document.body).not.toHaveTextContent(/submitted automatically/)
  })

  it("F1 Set up alerts has one confirm step and no old wording", async () => {
    const { user } = openEve("/find-jobs", { me: inviteeMe() })
    await user.click(await screen.findByRole("tab", { name: "Set up alerts" }))
    const step = await screen.findByRole("group", { name: "Confirm you may use these feeds" })
    expect(within(step).getByRole("button", { name: "I confirm" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Hiring alert feeds" })).toBeVisible()
    expect(screen.getAllByRole("button", { name: "I confirm" })).toHaveLength(1)
    expect(document.body).not.toHaveTextContent(/Record permitted use|Hiring Alert feeds|Stack posts|haven't recorded permitted use/)
  })

  it("AC-4.5 the old tab values in a link still open: skipped maps to Not a match", async () => {
    const { currentPath } = openEve("/postings?tab=skipped", { me: inviteeMe() })
    await screen.findByRole("tab", { name: "Not a match" })
    await waitFor(() => expect(currentPath()).toBe("/postings?tab=not_a_match"))
  })
})
