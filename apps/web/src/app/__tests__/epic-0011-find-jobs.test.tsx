import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { inviteeMe, operatorMe, server } from "@/shared/testing"
import { openEve } from "./epic-0011-helpers"

describe("Find jobs (find-jobs.feature)", () => {
  it("FJ:AC-5.1 the sections come in order: search links, Hiring posts, posts from your field, Set up alerts", async () => {
    openEve("/find-jobs", { me: inviteeMe() })
    await screen.findByRole("heading", { name: "Hiring posts" })
    const names = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "")
    const order = ["Hiring search links", "Search links", "Hiring posts", "Posts from your field", "Set up alerts"]
    expect(names.filter((n) => order.includes(n))).toEqual(order)
    expect(screen.getByText("Search for jobs and read hiring posts. Set up alerts if you want new ones delivered.")).toBeVisible()
  })

  it("FJ:AC-5.2 Set up alerts is collapsed until opened, then holds the feeds", async () => {
    const { user } = openEve("/find-jobs", { me: inviteeMe() })
    const toggle = await screen.findByRole("button", { name: /Set up alerts/ })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("heading", { name: "Alert feeds" })).not.toBeInTheDocument()
    await user.click(toggle)
    expect(await screen.findByRole("heading", { name: "Alert feeds" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Hiring alert feeds" })).toBeVisible()
  })

  it("FJ:AC-5.2a the Operator sees Job boards with its one plain line; the words Job Sources never show", async () => {
    const { user } = openEve("/find-jobs", { me: operatorMe() })
    await user.click(await screen.findByRole("button", { name: /Set up alerts/ }))
    expect(await screen.findByRole("heading", { name: "Job boards" })).toBeVisible()
    expect(screen.getByText("Eve checks these job boards every morning")).toBeVisible()
    expect(document.body).not.toHaveTextContent("Job Sources")
  })

  it("FJ:AC-5.2a a non-Operator sees no job boards or employer-list approval", async () => {
    const { user } = openEve("/find-jobs", { me: inviteeMe() })
    await user.click(await screen.findByRole("button", { name: /Set up alerts/ }))
    await screen.findByRole("heading", { name: "Alert feeds" })
    expect(screen.queryByRole("heading", { name: "Job boards" })).not.toBeInTheDocument()
    expect(screen.queryByText(/employer list/i)).not.toBeInTheDocument()
  })

  it("FJ:AC-5.6 /stack-posts opens Find jobs at the Stack posts section", async () => {
    const { currentPath } = openEve("/stack-posts", { me: inviteeMe() })
    await screen.findByRole("heading", { name: "Find jobs" })
    expect(currentPath()).toBe("/find-jobs#practitioner-posts")
  })

  it("FJ:AC-5.6 an email link to the Hiring view keeps its query and anchor", async () => {
    const { currentPath } = openEve("/stack-posts?view=hiring#hiring-posts", { me: inviteeMe() })
    await screen.findByRole("heading", { name: "Find jobs" })
    expect(currentPath()).toBe("/find-jobs?view=hiring#hiring-posts")
  })

  it("FJ:AC-5.6 /sources opens Find jobs at the job boards for the Operator, with Set up alerts open", async () => {
    const { currentPath } = openEve("/sources", { me: operatorMe() })
    expect(await screen.findByRole("heading", { name: "Job boards" })).toBeVisible()
    expect(currentPath()).toBe("/find-jobs#job-sources")
    expect(screen.getByRole("button", { name: /Set up alerts/ })).toHaveAttribute("aria-expanded", "true")
  })

  it("FJ:AC-5.6 /sources lands a non-Operator on Set up alerts, with no former Job Sources content", async () => {
    const { currentPath } = openEve("/sources", { me: inviteeMe() })
    expect(await screen.findByRole("heading", { name: "Alert feeds" })).toBeVisible()
    expect(currentPath()).toBe("/find-jobs#set-up-alerts")
    expect(screen.queryByRole("heading", { name: "Job boards" })).not.toBeInTheDocument()
  })

  it("FJ:AC-5.1 a Hiring posts failure shows an error with retry and the other sections still render", async () => {
    openEve("/find-jobs", { me: inviteeMe() })
    server.use(http.get("/v1/stack-posts/hiring-posts", () => HttpResponse.json({ error: { code: "internal_error", message: "x" } }, { status: 500 })))
    const section = (await screen.findByRole("heading", { name: "Hiring posts" })).closest("section") as HTMLElement
    await waitFor(() => expect(within(section).getByRole("button", { name: /try again|retry/i })).toBeVisible(), { timeout: 8000 })
    expect(screen.getByRole("heading", { name: "Posts from your field" })).toBeVisible()
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
    await user.click(await screen.findByRole("button", { name: /Set up alerts/ }))
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
