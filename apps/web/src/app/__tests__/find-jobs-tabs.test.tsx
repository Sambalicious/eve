import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"
import { STACK_POSTS_PATH } from "@eve/contracts"

import { createHiringSearchInputsApi, createStackPostsApi, server, verifiedOn20Oct } from "@/shared/testing"
import { openDiscovery } from "./discovery-helpers"
import { openHiring } from "./hiring-view-helpers"

/**
 * EPIC-0015 Find jobs tabs (find-jobs-tabs design note sections 1, 3 and 4): the one tablist on the page,
 * its keyboard model, its deep-link rule, and the promise that switching a tab is not navigation.
 * Gherkin: find-jobs.feature FJ:AC-5.1 and FJ:AC-5.6.
 */
const TAB_LABELS = ["Search", "Hiring posts", "Posts from your field", "Set up alerts"]

const tablist = () => screen.getByRole("tablist", { name: "Find jobs" })
const tab = (name: string) => screen.getByRole("tab", { name })

describe("Find jobs tablist (EPIC-0015 design note sections 1 and 4)", () => {
  it("FJ:AC-5.1 four tabs in order, named by the page title, each panel labelled by its tab", async () => {
    const { user } = openHiring()
    await screen.findByRole("heading", { level: 2, name: "Hiring search links" })
    expect(within(tablist()).getAllByRole("tab").map((t) => t.textContent)).toEqual(TAB_LABELS)
    // Search is the start: selected, and the only tab in the Tab order.
    expect(tab("Search")).toHaveAttribute("aria-selected", "true")
    expect(tab("Search")).toHaveAttribute("tabindex", "0")
    for (const name of TAB_LABELS.slice(1)) expect(tab(name)).toHaveAttribute("tabindex", "-1")
    // One panel per tab, named by it (the library default; not overridden).
    expect(screen.getByRole("tabpanel", { name: "Search" })).toBeVisible()
    for (const name of TAB_LABELS.slice(1)) {
      await user.click(tab(name))
      expect(screen.getByRole("tabpanel", { name })).toBeVisible()
      // The panel is not a Tab stop.
      expect(screen.getByRole("tabpanel", { name })).toHaveAttribute("tabindex", "-1")
    }
  })

  it("FJ:AC-5.1 Left and Right move and wrap, Home and End jump, and focus stays on the tab", async () => {
    const { user } = openHiring()
    await screen.findByRole("heading", { level: 2, name: "Hiring search links" })
    tab("Search").focus()
    await user.keyboard("{ArrowRight}")
    expect(tab("Hiring posts")).toHaveAttribute("aria-selected", "true")
    expect(tab("Hiring posts")).toHaveFocus()
    await user.keyboard("{End}")
    expect(tab("Set up alerts")).toHaveAttribute("aria-selected", "true")
    expect(tab("Set up alerts")).toHaveFocus()
    await user.keyboard("{ArrowRight}")
    expect(tab("Search")).toHaveAttribute("aria-selected", "true")
    await user.keyboard("{ArrowLeft}")
    expect(tab("Set up alerts")).toHaveAttribute("aria-selected", "true")
    expect(tab("Set up alerts")).toHaveFocus()
    await user.keyboard("{Home}")
    expect(tab("Search")).toHaveAttribute("aria-selected", "true")
    expect(tab("Search")).toHaveFocus()
  })

  it.each([
    ["#hiring-search-links", "Search"],
    ["#check-this-job", "Search"],
    ["#search-links", "Search"],
    ["#hiring-posts", "Hiring posts"],
    ["#practitioner-posts", "Posts from your field"],
    ["#set-up-alerts", "Set up alerts"],
    ["#confirm-feeds", "Set up alerts"],
    ["#alert-feeds", "Set up alerts"],
    ["#hiring-alert-feeds", "Set up alerts"],
    ["#job-sources", "Set up alerts"],
    ["#employer-list", "Set up alerts"],
  ])("FJ:AC-5.6 the hash %s selects %s", async (hash, selected) => {
    openHiring({ path: `/find-jobs${hash}` })
    await waitFor(() => expect(tab(selected)).toHaveAttribute("aria-selected", "true"))
  })

  it.each([
    ["/find-jobs", "Search"],
    ["/find-jobs?page=2", "Hiring posts"],
    ["/find-jobs?spage=2", "Posts from your field"],
    ["/find-jobs?spage=2&page=2", "Posts from your field"],
  ])("FJ:AC-5.6 first load at %s opens %s", async (path, selected) => {
    openHiring({ path })
    await waitFor(() => expect(tab(selected)).toHaveAttribute("aria-selected", "true"))
  })

  it("FJ:AC-5.6 the hash #search-links selects Search and focuses the Search links heading", async () => {
    openHiring({ path: "/find-jobs#search-links" })
    const heading = await screen.findByRole("heading", { level: 2, name: "Search links" })
    await waitFor(() => expect(heading).toHaveFocus())
  })

  it("FJ:AC-5.6 the hash #employer-list selects Set up alerts and focuses the Employer list heading", async () => {
    // Job boards sit in Set up alerts; the Search tab and both feeds read too, so install their fakes before the first render.
    server.use(...createStackPostsApi().handlers, ...createHiringSearchInputsApi().handlers)
    openDiscovery("/find-jobs#employer-list")
    const heading = await screen.findByRole("heading", { level: 2, name: "Employer list" })
    await waitFor(() => expect(heading).toHaveFocus())
  })

  it("FJ:AC-5.6 a tab click writes no URL and adds no history entry", async () => {
    const { user, app, currentPath } = openHiring({ path: "/find-jobs?family=backend" })
    await screen.findByRole("heading", { level: 2, name: "Hiring search links" })
    const before = currentPath()
    const entry = app.router.state.location.key
    for (const name of ["Hiring posts", "Posts from your field", "Set up alerts", "Search"]) {
      await user.click(tab(name))
      expect(currentPath()).toBe(before)
      // A push would make a new entry, and so a new location key.
      expect(app.router.state.location.key).toBe(entry)
    }
  })

  it("FJ:AC-5.1 a typed draft survives a tab switch: the panels stay mounted", async () => {
    const { user } = openHiring({ path: "/find-jobs#set-up-alerts", stack: { verification: verifiedOn20Oct } })
    const feeds = await screen.findByRole("region", { name: "Alert feeds" })
    const url = (await within(feeds).findByRole("textbox", { name: "Feed URL" })) as HTMLInputElement
    await user.type(url, "https://www.google.com/alerts/feeds/0123/4567")
    await user.click(tab("Search"))
    expect(screen.queryByRole("region", { name: "Alert feeds" })).not.toBeInTheDocument()
    await user.click(tab("Set up alerts"))
    expect(within(await screen.findByRole("region", { name: "Alert feeds" })).getByRole("textbox", { name: "Feed URL" })).toHaveValue(
      "https://www.google.com/alerts/feeds/0123/4567"
    )
  })

  it("FJ:AC-5.1 a load error in a hidden panel is not announced until that tab is selected", async () => {
    const { user } = openHiring()
    server.use(http.get(STACK_POSTS_PATH, () => HttpResponse.json({ error: { code: "internal_error", message: "x" } }, { status: 500 })))
    await screen.findByRole("heading", { level: 2, name: "Hiring search links" })
    // Out of the accessibility tree: no alert to announce while the tab is hidden.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    await user.click(tab("Posts from your field"))
    const posts = await screen.findByRole("region", { name: "Posts from your field" })
    expect(await within(posts).findByRole("alert")).toBeVisible()
  })

  it("FJ:AC-5.1 below 640px the tablist is four equal columns, each label wrapping whole", async () => {
    openHiring()
    await screen.findByRole("heading", { level: 2, name: "Hiring search links" })
    const list = tablist()
    expect(list).toHaveClass("grid", "grid-cols-4", "w-full")
    expect(list).not.toHaveClass("w-fit")
    const tabs = within(list).getAllByRole("tab")
    expect(tabs).toHaveLength(4)
    for (const [index, item] of tabs.entries()) {
      // The label is whole and may wrap, never clipped or truncated.
      expect(item.textContent).toBe(TAB_LABELS[index])
      const label = item.querySelector("span")
      expect(label).not.toBeNull()
      expect(label).toHaveClass("min-w-0", "text-balance")
      expect(label).not.toHaveClass("truncate")
      expect(item).not.toHaveClass("overflow-hidden")
    }
    // Selected is more than colour: the line variant's 1px underline plus the foreground weight.
    expect(tab("Search")).toHaveClass("data-active:text-foreground")
    expect(tab("Search").className).toMatch(/after:h-px/)
  })
})
