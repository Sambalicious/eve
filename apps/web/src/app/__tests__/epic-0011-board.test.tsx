import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { beforeEach, describe, expect, it } from "vitest"

import { blocked, inviteeMe, operatorMe, server, submission, uncertain } from "@/shared/testing"
import { entryOf, openEve } from "./epic-0011-helpers"

/** The board lays out as columns from 1024px; the stacked mobile layout hides closed sections. */
beforeEach(() => {
  const real = window.matchMedia
  window.matchMedia = (query: string) => ({ ...real(query), matches: query.includes("min-width: 1024px") })
})

const ID = {
  draft: "d1000000-0000-4000-8000-000000000001",
  applied: "d1000000-0000-4000-8000-000000000002",
  interview: "d1000000-0000-4000-8000-000000000003",
  offer: "d1000000-0000-4000-8000-000000000004",
  closed: "d1000000-0000-4000-8000-000000000005",
}
const applied = () => entryOf(submission({ state: "manual", manualCompletedAt: "2026-11-05T10:00:00.000Z" }), { id: ID.applied, roleTitle: "Applied Role", company: "Co" })
const draft = () => entryOf(submission(), { id: ID.draft, roleTitle: "Draft Role", company: "Co" })
const column = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name}, \\d+ applications?$`) })
const card = (title: string) => screen.getByText(title).closest("[data-card-id]") as HTMLElement
const outcome = (applicationId: string, type: string, n: number) => ({
  id: `a2000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  applicationId,
  type: type as "offer",
  source: "candidate" as const,
  excerpt: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
})

async function pickMove(user: ReturnType<typeof openEve>["user"], title: string, item: string) {
  await user.click(within(card(title)).getByRole("button", { name: `Move ${title} to…` }))
  await user.click(await screen.findByRole("menuitem", { name: new RegExp(item) }))
}
const regionRows = (name: string) => within(column(name)).queryAllByRole("link").map((a) => a.textContent)

describe("Applications board (applications-board.feature)", () => {
  it("BRD:AC-6.1 the board shows five columns in order, with a List view that keeps the table and delete toolbar", async () => {
    const { user } = openEve("/applications", { me: inviteeMe(), entries: [draft()] })
    await screen.findByText("Draft Role")
    const names = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
    expect(names).toEqual(["Draft", "Applied", "Interview", "Offer", "Closed"])
    await user.click(screen.getByRole("button", { name: "List" }))
    expect(await screen.findByRole("checkbox", { name: /Select all/ })).toBeVisible()
  })

  it("BRD:AC-6.2 placement derives from existing data", async () => {
    const entries = [
      draft(),
      applied(),
      entryOf(submission(), { id: ID.interview, roleTitle: "Interview Role" }),
      entryOf(submission(), { id: ID.offer, roleTitle: "Offer Role" }),
      entryOf(submission({ state: "declined", declinedAt: "2026-11-01T10:00:00.000Z", declinedReason: "x" }), { id: ID.closed, roleTitle: "Closed Role" }),
    ]
    const { controls } = openEve("/applications", { me: inviteeMe(), entries })
    controls.state.outcomes.push(outcome(ID.interview, "interview_invitation", 1), outcome(ID.offer, "offer", 2))
    await screen.findByText("Draft Role")
    await waitFor(() => expect(regionRows("Interview")).toContain("Interview Role"))
    expect(regionRows("Draft")).toEqual(["Draft Role"])
    expect(regionRows("Applied")).toEqual(["Applied Role"])
    expect(regionRows("Offer")).toEqual(["Offer Role"])
    expect(regionRows("Closed")).toEqual(["Closed Role"])
  })

  it("BRD:AC-6.1 Sending and Needs you show only when they hold cards and are allowed; the safety rule shows Needs you with Advanced off", async () => {
    const queued = entryOf(submission({ state: "queued", kind: "automatic" }), { roleTitle: "Queued Role" })
    const stuck = entryOf(blocked("captcha", "x"), { roleTitle: "Stuck Role" })
    openEve("/applications", { me: inviteeMe(), entries: [queued, stuck] })
    await screen.findByText("Stuck Role")
    const names = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
    expect(names).toEqual(["Needs you", "Draft", "Applied", "Interview", "Offer", "Closed"])
    expect(regionRows("Draft")).toEqual(["Queued Role"])
  })

  it("BRD:AC-6.1 with Advanced on a queued card sits in Sending", async () => {
    openEve("/applications", { me: operatorMe(), entries: [entryOf(submission({ state: "queued", kind: "automatic" }), { roleTitle: "Queued Role" })] })
    await screen.findByText("Queued Role")
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toContain("Sending")
    expect(regionRows("Sending")).toEqual(["Queued Role"])
  })

  it("BRD:AC-6.7 automatic cards have no Move to menu and link to the page that holds their actions", async () => {
    openEve("/applications", { me: operatorMe(), entries: [entryOf(blocked("captcha", "x"), { roleTitle: "Stuck Role" }), entryOf(uncertain(), { roleTitle: "Unsure Role" })] })
    await screen.findByText("Stuck Role")
    expect(screen.queryByRole("button", { name: /^Move .* to…/ })).not.toBeInTheDocument()
    expect(within(card("Stuck Role")).getByRole("link", { name: "Open Blocked" })).toHaveAttribute("href", "/blocked")
    expect(within(card("Unsure Role")).getByRole("link", { name: "Open Unsure sends" })).toHaveAttribute("href", "/uncertain")
  })

  it("BRD:AC-6.3 I applied asks first and sends manual-complete once confirmed", async () => {
    const { user, submission: sub } = openEve("/applications", { me: inviteeMe(), entries: [draft()] })
    await screen.findByText("Draft Role")
    await pickMove(user, "Draft Role", "I applied")
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText("This records that you applied. It can't be undone.")).toBeVisible()
    expect(sub.requests.filter((r) => r.path.endsWith("/manual-complete"))).toHaveLength(0)
    await user.click(within(dialog).getByRole("button", { name: "I applied" }))
    await waitFor(() => expect(regionRows("Applied")).toEqual(["Draft Role"]))
    expect(sub.requests.filter((r) => r.path.endsWith("/manual-complete"))).toHaveLength(1)
  })

  it("BRD:AC-6.3 cancelling the confirm sends nothing and leaves the card in Draft", async () => {
    const { user, submission: sub } = openEve("/applications", { me: inviteeMe(), entries: [draft()] })
    await screen.findByText("Draft Role")
    await pickMove(user, "Draft Role", "I applied")
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }))
    expect(sub.requests.filter((r) => r.path.endsWith("/manual-complete"))).toHaveLength(0)
    expect(regionRows("Draft")).toEqual(["Draft Role"])
  })

  it.each([
    ["Interview", "interview_invitation"],
    ["Offer", "offer"],
    ["Closed", "rejection"],
  ])("BRD:AC-6.4 Applied to %s records a %s Outcome", async (target, type) => {
    const { user, controls } = openEve("/applications", { me: inviteeMe(), entries: [applied()] })
    await screen.findByText("Applied Role")
    await pickMove(user, "Applied Role", `^${target}$`)
    await waitFor(() => expect(regionRows(target)).toEqual(["Applied Role"]))
    expect(controls.state.outcomes.map((o) => o.type)).toEqual([type])
  })

  it("BRD:AC-6.5 moving back edits the placing Outcome and deletes nothing", async () => {
    const { user, controls } = openEve("/applications", { me: inviteeMe(), entries: [entryOf(submission(), { id: ID.interview, roleTitle: "Interview Role" })] })
    controls.state.outcomes.push(outcome(ID.interview, "interview_invitation", 1))
    await waitFor(() => expect(regionRows("Interview")).toEqual(["Interview Role"]))
    await pickMove(user, "Interview Role", "Back to Applied")
    await waitFor(() => expect(regionRows("Applied")).toEqual(["Interview Role"]))
    expect(controls.state.outcomes).toHaveLength(1)
    expect(controls.state.outcomes[0].type).toBe("confirmation")
  })

  it("BRD:AC-6.4 Closed from Offer records a rejection", async () => {
    const { user, controls } = openEve("/applications", { me: inviteeMe(), entries: [entryOf(submission(), { id: ID.offer, roleTitle: "Offer Role" })] })
    controls.state.outcomes.push(outcome(ID.offer, "offer", 1))
    await waitFor(() => expect(regionRows("Offer")).toEqual(["Offer Role"]))
    await pickMove(user, "Offer Role", "^Closed$")
    await waitFor(() => expect(regionRows("Closed")).toEqual(["Offer Role"]))
    expect(controls.state.outcomes.map((o) => o.type)).toEqual(["offer", "rejection"])
  })

  it("BRD:AC-6.5 an Applied card can't go back to Draft and says why on the menu", async () => {
    const { user } = openEve("/applications", { me: inviteeMe(), entries: [applied()] })
    await screen.findByText("Applied Role")
    await user.click(within(card("Applied Role")).getByRole("button", { name: "Move Applied Role to…" }))
    const menu = await screen.findByRole("menu")
    const draftItem = within(menu).getByRole("menuitem", { name: /^Draft/ })
    expect(draftItem).toHaveAttribute("aria-disabled", "true")
    expect(draftItem).toHaveTextContent("Can't go back to Draft. A record that you applied can't be undone.")
  })

  it("BRD:AC-6.6 the menu works from the keyboard alone", async () => {
    const { user, controls } = openEve("/applications", { me: inviteeMe(), entries: [applied()] })
    await screen.findByText("Applied Role")
    within(card("Applied Role")).getByRole("button", { name: "Move Applied Role to…" }).focus()
    await user.keyboard("{Enter}")
    const menu = await screen.findByRole("menu")
    // The menu moves focus into itself after it mounts; keys sent before that land on the trigger and are lost.
    const interview = within(menu).getByRole("menuitem", { name: /^Interview$/ })
    await waitFor(() => expect(interview).toHaveFocus())
    await user.keyboard("{ArrowDown}")
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /^Offer$/ })).toHaveFocus())
    await user.keyboard("{ArrowUp}")
    await waitFor(() => expect(interview).toHaveFocus())
    await user.keyboard("{Enter}")
    await waitFor(() => expect(regionRows("Interview")).toEqual(["Applied Role"]))
    expect(controls.state.outcomes.map((o) => o.type)).toEqual(["interview_invitation"])
  })

  it("BRD:AC-6.4 the toast after a move offers Undo, which edits the Outcome back", async () => {
    const { user, controls } = openEve("/applications", { me: inviteeMe(), entries: [applied()] })
    await screen.findByText("Applied Role")
    await pickMove(user, "Applied Role", "^Offer$")
    await user.click(await screen.findByRole("button", { name: "Undo" }))
    await waitFor(() => expect(regionRows("Applied")).toEqual(["Applied Role"]))
    expect(controls.state.outcomes.map((o) => o.type)).toEqual(["confirmation"])
  })

  it("BRD:AC-6.3 a failed move leaves the card where it was and says so", async () => {
    const { user } = openEve("/applications", { me: inviteeMe(), entries: [applied()] })
    server.use(http.post("/v1/applications/:id/outcomes", () => HttpResponse.json({ error: { code: "internal_error", message: "x" } }, { status: 500 })))
    await screen.findByText("Applied Role")
    await pickMove(user, "Applied Role", "^Interview$")
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't move the card. It is back where it was. Try again.")
    expect(regionRows("Applied")).toEqual(["Applied Role"])
  })

  it("BRD:AC-6.2 a card changed elsewhere refreshes first and refuses the stale move with the conflict line", async () => {
    const { user, controls } = openEve("/applications", { me: inviteeMe(), entries: [applied()] })
    await screen.findByText("Applied Role")
    // Another device closed it after this board loaded.
    controls.state.outcomes.push(outcome(ID.applied, "rejection", 9))
    await user.click(within(card("Applied Role")).getByRole("button", { name: "Move Applied Role to…" }))
    await user.click(await screen.findByRole("menuitem", { name: /^Interview$/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("This card changed on another device.")
    expect(controls.state.outcomes.map((o) => o.type)).toEqual(["rejection"])
    await waitFor(() => expect(regionRows("Closed")).toEqual(["Applied Role"]))
  })

  it("BRD:AC-6.8 a card links to the Application detail, which links to its documents", async () => {
    const { user } = openEve("/applications", { me: inviteeMe(), entries: [applied()] })
    await user.click(await screen.findByRole("link", { name: "Applied Role" }))
    const documents = await screen.findByRole("navigation", { name: "Documents" })
    expect(within(documents).getByRole("link", { name: "Resume" })).toHaveAttribute("href", "#resume")
    expect(within(documents).getByRole("link", { name: "Cover letter" })).toHaveAttribute("href", "#cover-letter")
  })

  it("R4 List view: the column is Stage and each row shows its board word, never Prepared for you", async () => {
    const { user } = openEve("/applications", { me: inviteeMe(), entries: [draft(), applied()] })
    await user.click(await screen.findByRole("button", { name: "List" }))
    expect(await screen.findByRole("columnheader", { name: /Stage/ })).toBeVisible()
    expect(screen.queryByRole("columnheader", { name: "Status" })).not.toBeInTheDocument()
    const rows = screen.getAllByRole("row").slice(1)
    expect(rows.map((r) => ["Draft", "Applied"].find((w) => within(r).queryByText(w)))).toEqual(expect.arrayContaining(["Draft", "Applied"]))
    expect(document.body).not.toHaveTextContent("Prepared for you")
  })

  it("R4 List view: the Stage header explains the words, including Draft", async () => {
    const { user } = openEve("/applications", { me: inviteeMe(), entries: [draft()] })
    await user.click(await screen.findByRole("button", { name: "List" }))
    expect(await screen.findByRole("button", { name: "What Stage means" })).toBeInTheDocument()
  })

  it("R6 every board column heading explains its word", async () => {
    openEve("/applications", { me: inviteeMe(), entries: [draft(), applied()] })
    for (const word of ["Draft", "Applied", "Interview", "Offer", "Closed"]) {
      expect(await screen.findByRole("button", { name: `What ${word} means` })).toBeInTheDocument()
    }
  })

  it("an empty board says what will appear and gives one action", async () => {
    openEve("/applications", { me: inviteeMe() })
    expect(await screen.findByText("Applications appear here once you prepare one. Paste a job on Home to start.")).toBeVisible()
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/dashboard")
  })
})
