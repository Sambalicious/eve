import { act, screen, waitFor, within } from "@testing-library/react"
import { DEFAULT_TARGET_ROLE_FAMILIES, JOB_POSTINGS_PATH, type JobPostingDetail } from "@eve/contracts"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, rankedPosting, server } from "@/shared/testing"
import { advance } from "./career-setup-helpers"
import { openDiscovery } from "./discovery-helpers"

/** Slice 8: postings-page-filter.feature (WEB-*), design addendum C-FILTER-*, C-PAGE-*, C-EMPTY-9. */

const pad = (n: number) => String(n).padStart(2, "0")

/** `count` postings titled "P01 Engineer"… on the All tab, newest first in that order. */
function many(count: number, overrides: (i: number) => Partial<JobPostingDetail> = () => ({})): JobPostingDetail[] {
  return Array.from({ length: count }, (_, i) =>
    rankedPosting({ title: `P${pad(i + 1)} Engineer`, company: "Acme", rank: i + 1, ...overrides(i + 1) })
  )
}

async function table() {
  return screen.findByRole("region", { name: "Job Postings, scrolls horizontally" })
}

async function rowTitles() {
  const rows = within(await table()).getAllByRole("row").slice(1)
  return rows.map((row) => within(row).getAllByRole("link")[0].textContent?.replace(/ at .*$/, ""))
}

const status = () => screen.getByRole("status")
const search = () => screen.getByRole("searchbox", { name: "Search job titles" })
const loadMore = () => screen.getByRole("button", { name: "Load more" })
const lastListQuery = (api: { listRequests: URLSearchParams[] }) => api.listRequests.at(-1)!.toString()

/** Opens the Role family panel (design r2 B2): a dialog named by its title. */
async function openFamilyPanel(user: ReturnType<typeof openDiscovery>["user"]) {
  await user.click(screen.getByRole("button", { name: /^Role family/ }))
  return screen.findByRole("dialog", { name: "Role family" })
}

describe("Filter controls (8W.1, 8R.7)", () => {
  it.each(["ranked", "skipped", "all"])("WEB-01 the %s tab shows the filter landmark with search and the Role family button", async (tab) => {
    openDiscovery(`/postings?tab=${tab}`, { postings: many(3) })

    const landmark = await screen.findByRole("search", { name: "Filter Job Postings" })
    expect(within(landmark).getByRole("searchbox", { name: "Search job titles" })).toHaveAttribute("placeholder", "e.g. React")
    expect(within(landmark).getByRole("button", { name: "Role family" })).toBeVisible()
  })

  it("WEB-02 the panel has the title Role family and Close in its header above a divider, then one checkbox per target family in catalog order (EPIC-0006 P7)", async () => {
    const { user } = openDiscovery("/postings", { postings: many(3) })
    await screen.findByRole("search")

    const panel = await openFamilyPanel(user)
    const header = within(panel).getByText("Role family", { selector: "h2" }).parentElement!
    expect(within(header).getByRole("button", { name: "Close" })).toBeVisible()
    expect(header.nextElementSibling).toHaveAttribute("data-slot", "separator")
    const group = within(panel).getByRole("group", { name: "Show these role families" })
    expect(within(group).getAllByRole("checkbox").map((box) => box.closest("label")?.textContent)).toEqual([
      "Frontend",
      "Hands-on technical lead",
      "Fullstack",
      "Product engineering",
      "Software engineering",
      "Backend",
      "Mobile",
      "Platform engineering",
      "Engineering management",
    ])
    expect(within(panel).queryByRole("button", { name: "Show all role families" })).not.toBeInTheDocument()
  })

  it.each([
    ["Senior Backend Engineer", "backend", "Backend"],
    ["iOS Engineer", "mobile", "Mobile"],
    ["Site Reliability Engineer", "devops_platform", "DevOps and SRE"],
  ] as const)("WEB-03 the list shows %s with the family label %s", async (title, family, label) => {
    openDiscovery("/postings?tab=good", { postings: [rankedPosting({ title, roleFamily: family })] })

    const row = within(await table()).getAllByRole("row")[1]
    expect(row).toHaveTextContent(title)
    expect(within(row).getByText(label)).toBeInTheDocument()
  })

  it("WEB-04 checking Backend and Mobile narrows the list, keeps the panel open, writes the URL and shows the count badge", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=good", {
      postings: [
        rankedPosting({ title: "Senior Backend Engineer", roleFamily: "backend", rank: 1 }),
        rankedPosting({ title: "Flutter Developer", roleFamily: "mobile", rank: 2 }),
        rankedPosting({ title: "Senior Frontend Engineer", roleFamily: "senior_frontend", rank: 3 }),
      ],
    })
    await table()

    const panel = await openFamilyPanel(user)
    await user.click(within(panel).getByRole("checkbox", { name: "Backend" }))
    expect(screen.getByRole("dialog", { name: "Role family" })).toBeVisible()
    await user.click(within(panel).getByRole("checkbox", { name: "Mobile" }))
    expect(within(panel).getByRole("checkbox", { name: "Backend" })).toHaveAttribute("aria-checked", "true")

    await waitFor(async () => expect(await rowTitles()).toEqual(["Senior Backend Engineer", "Flutter Developer"]))
    expect(currentPath()).toBe("/postings?tab=good&families=backend,mobile")
    expect(screen.getByRole("dialog", { name: "Role family" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Role family 2 selected" })).toHaveAttribute("aria-haspopup", "dialog")
    await user.keyboard("{Escape}")
    const trigger = screen.getByRole("button", { name: "Role family 2 selected" })
    expect(trigger).toHaveFocus()
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeVisible()
  })

  it("WEB-04b Show all role families unchecks every family", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=good&families=backend", { postings: many(3) })
    await screen.findByRole("search")

    const panel = await openFamilyPanel(user)
    await user.click(within(panel).getByRole("button", { name: "Show all role families" }))
    await waitFor(() => expect(currentPath()).toBe("/postings?tab=good"))
    // Design r2 behaviour table: closes the panel and returns focus to the button.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Role family" })).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Role family" })).toHaveFocus()
  })
})

describe("Role family panel (design r2 B2, D13)", () => {
  it("WEB-46 opens by keyboard on the first checkbox; Space checks and stays open; Escape and Close return focus and keep the selection", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=good", { postings: many(3) })
    await table()

    const trigger = screen.getByRole("button", { name: "Role family" })
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog")
    trigger.focus()
    await user.keyboard("{Enter}")
    const panel = await screen.findByRole("dialog", { name: "Role family" })
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(within(panel).getByRole("button", { name: "Close" })).toBeVisible()
    const first = within(panel).getByRole("checkbox", { name: "Frontend" })
    await waitFor(() => expect(first).toHaveFocus())

    await user.keyboard(" ")
    await waitFor(() => expect(currentPath()).toBe("/postings?tab=good&families=senior_frontend"))
    expect(first).toHaveAttribute("aria-checked", "true")
    expect(first).toHaveFocus()
    expect(screen.getByRole("dialog", { name: "Role family" })).toBeVisible()

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Role family 1 selected" })).toHaveFocus()
    expect(currentPath()).toBe("/postings?tab=good&families=senior_frontend")

    await user.keyboard("{Enter}")
    const again = await screen.findByRole("dialog", { name: "Role family" })
    await user.click(within(again).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Role family 1 selected" })).toHaveFocus()
    expect(currentPath()).toBe("/postings?tab=good&families=senior_frontend")
  })

  it("clicking a row's label toggles its checkbox; Shift+Tab from the first checkbox reaches Close", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=good", { postings: many(3) })
    await table()

    const panel = await openFamilyPanel(user)
    await user.click(within(panel).getByText("Mobile"))
    await waitFor(() => expect(currentPath()).toBe("/postings?tab=good&families=mobile"))
    expect(within(panel).getByRole("checkbox", { name: "Mobile" })).toHaveAttribute("aria-checked", "true")

    within(panel).getByRole("checkbox", { name: "Frontend" }).focus()
    await user.tab({ shift: true })
    expect(within(panel).getByRole("button", { name: "Close" })).toHaveFocus()
  })

  it("WEB-48 Shift+Tab from Close closes the panel on the first press and focuses the Role family button", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=good&families=mobile", {
      postings: many(3, () => ({ roleFamily: "mobile" })),
    })
    await table()

    const trigger = screen.getByRole("button", { name: "Role family 1 selected" })
    trigger.focus()
    await user.keyboard("{Enter}")
    const panel = await screen.findByRole("dialog", { name: "Role family" })
    await waitFor(() => expect(within(panel).getByRole("checkbox", { name: "Frontend" })).toHaveFocus())
    await user.tab({ shift: true })
    expect(within(panel).getByRole("button", { name: "Close" })).toHaveFocus()

    await user.tab({ shift: true })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(currentPath()).toBe("/postings?tab=good&families=mobile")
  })

  it("WEB-48 Tab from Close still moves into the panel", async () => {
    const { user } = openDiscovery("/postings?tab=good", { postings: many(3) })
    await table()

    const panel = await openFamilyPanel(user)
    within(panel).getByRole("button", { name: "Close" }).focus()
    await user.tab()
    expect(within(panel).getByRole("checkbox", { name: "Frontend" })).toHaveFocus()
    expect(screen.getByRole("dialog", { name: "Role family" })).toBeVisible()
  })

  it("an outside click closes the panel and leaves focus where the Candidate clicked", async () => {
    const { user } = openDiscovery("/postings?tab=good", { postings: many(3) })
    await table()

    await openFamilyPanel(user)
    await user.click(search())
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(search()).toHaveFocus()
  })

  it("the checkboxes follow the URL when Back changes it while the panel is open", async () => {
    const { user, app } = openDiscovery("/postings?tab=good", { postings: many(3) })
    await table()
    await user.click(screen.getByRole("tab", { name: "All" }))
    await waitFor(() => expect(app.router.state.location.search).toBe("?tab=all"))

    const panel = await openFamilyPanel(user)
    await user.click(within(panel).getByRole("checkbox", { name: "Backend" }))
    await waitFor(() => expect(app.router.state.location.search).toBe("?tab=all&families=backend"))
    await act(() => app.router.navigate(-1))
    await waitFor(() => expect(app.router.state.location.search).toBe("?tab=good"))
    expect(within(panel).getByRole("checkbox", { name: "Backend" })).toHaveAttribute("aria-checked", "false")
  })
})

describe("Title search (8W.2)", () => {
  it("WEB-05 types one character every 100 ms, then requests once, 300 ms after the last keystroke", async () => {
    const { user, api, currentPath } = openDiscovery(
      "/postings?tab=good",
      { postings: [rankedPosting({ title: "Senior React Engineer", rank: 1 }), rankedPosting({ title: "Senior Backend Engineer", rank: 2 })] },
      { fakeTimers: true }
    )
    await table()
    const before = api.listRequests.length
    const keywordRequests = () => api.listRequests.slice(before).filter((q) => q.has("keyword"))

    for (const [i, char] of [..."react"].entries()) {
      if (i > 0) await advance(100)
      await user.type(search(), char)
    }
    expect(keywordRequests()).toHaveLength(0)
    await advance(300)
    await waitFor(() => expect(keywordRequests().map((q) => q.get("keyword"))).toEqual(["react"]))
    await waitFor(async () => expect(await rowTitles()).toEqual(["Senior React Engineer"]))
    expect(currentPath()).toBe("/postings?tab=good&keyword=react")
    // The exact 299 / 300 ms boundary (WEB-06) is in use-title-search.test.ts, on a clock that only moves when told.
  })

  it("WEB-07 typing a keyword replaces the history entry, so Back leaves the page", async () => {
    const { user, app } = openDiscovery("/dashboard", { postings: many(3) })
    await user.click(await screen.findByRole("link", { name: "Jobs" }))
    await screen.findByRole("search")
    await user.type(search(), "react{Enter}")
    await waitFor(() => expect(app.router.state.location.search).toBe("?keyword=react"))

    await act(() => app.router.navigate(-1))
    expect(app.router.state.location.pathname).toBe("/dashboard")
  })

  it("WEB-08 Enter applies the keyword at once", async () => {
    const { user, api } = openDiscovery("/postings?tab=good", { postings: many(3) }, { fakeTimers: true })
    await table()

    await user.type(search(), "react{Enter}")
    await waitFor(() => expect(api.listRequests.filter((q) => q.get("keyword") === "react")).toHaveLength(1))
    await advance(400)
    expect(api.listRequests.filter((q) => q.get("keyword") === "react")).toHaveLength(1)
  })

  it("WEB-09 Escape empties the search, removes the keyword and keeps focus", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=good&keyword=react", { postings: many(3) })
    await screen.findByRole("search")
    expect(search()).toHaveValue("react")

    await user.click(search())
    await user.keyboard("{Escape}")
    expect(search()).toHaveValue("")
    await waitFor(() => expect(currentPath()).toBe("/postings?tab=good"))
    expect(search()).toHaveFocus()
  })

  it("WEB-09b the clear button empties the search and returns focus to it; it shows only with text", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=good&keyword=react", { postings: many(3) })
    await screen.findByRole("search")

    await user.click(screen.getByRole("button", { name: "Clear title search" }))
    expect(search()).toHaveValue("")
    expect(search()).toHaveFocus()
    await waitFor(() => expect(currentPath()).toBe("/postings?tab=good"))
    expect(screen.queryByRole("button", { name: "Clear title search" })).not.toBeInTheDocument()
  })

  it("WEB-10 accepts at most 100 characters", async () => {
    const { user, api } = openDiscovery("/postings?tab=all", { postings: many(3) })
    await screen.findByRole("search")

    await user.type(search(), `${"a".repeat(101)}{Enter}`)
    expect(search()).toHaveValue("a".repeat(100))
    await waitFor(() => expect(api.listRequests.at(-1)?.get("keyword")).toBe("a".repeat(100)))
  })

  it("WEB-10b a whitespace-only search removes the keyword; the field keeps what was typed", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=all&keyword=go", { postings: many(3) })
    await screen.findByRole("search")

    await user.clear(search())
    await user.type(search(), "   {Enter}")
    await waitFor(() => expect(currentPath()).toBe("/postings?tab=all"))
    expect(search()).toHaveValue("   ")
  })
})

describe("URL state (8W.3 to 8W.6)", () => {
  it("WEB-11 a filtered link opens the same view", async () => {
    const { user } = openDiscovery("/postings?tab=good&families=backend,mobile&keyword=senior", {
      postings: [
        rankedPosting({ title: "Senior iOS Engineer", roleFamily: "mobile", rank: 1 }),
        rankedPosting({ title: "Senior Backend Engineer", roleFamily: "backend", rank: 2 }),
        rankedPosting({ title: "Backend Developer", roleFamily: "backend", rank: 3 }),
        rankedPosting({ title: "Senior Frontend Engineer", roleFamily: "senior_frontend", rank: 4 }),
      ],
    })

    await waitFor(async () => expect(await rowTitles()).toEqual(["Senior iOS Engineer", "Senior Backend Engineer"]))
    expect(screen.getByRole("tab", { name: "Good matches" })).toHaveAttribute("aria-selected", "true")
    expect(search()).toHaveValue("senior")
    const panel = await openFamilyPanel(user)
    expect(within(panel).getByRole("checkbox", { name: "Backend" })).toHaveAttribute("aria-checked", "true")
    expect(within(panel).getByRole("checkbox", { name: "Mobile" })).toHaveAttribute("aria-checked", "true")
    expect(within(panel).getByRole("checkbox", { name: "Fullstack" })).toHaveAttribute("aria-checked", "false")
  })

  it("WEB-12/13 Load more never puts a page or cursor in the URL; a fresh visit starts from page 1", async () => {
    const postings = many(60, () => ({ roleFamily: "backend" }))
    const first = openDiscovery("/postings?tab=good&families=backend", { postings })
    await table()
    await first.user.click(loadMore())
    await waitFor(async () => expect(await rowTitles()).toHaveLength(50))
    expect(first.currentPath()).toBe("/postings?tab=good&families=backend")
    first.unmount()

    const refreshed = openDiscovery("/postings?tab=good&families=backend", { postings })
    await waitFor(async () => expect(await rowTitles()).toHaveLength(25))
    expect(refreshed.api.listRequests.every((q) => !q.has("cursor"))).toBe(true)
  })

  it("WEB-14 /postings opens Ranked with no filter and stays without parameters", async () => {
    const { user, currentPath } = openDiscovery("/postings", { postings: many(3) })
    await table()

    expect(screen.getByRole("tab", { name: "Good matches" })).toHaveAttribute("aria-selected", "true")
    expect(search()).toHaveValue("")
    expect(currentPath()).toBe("/postings")
    const panel = await openFamilyPanel(user)
    for (const item of within(panel).getAllByRole("checkbox")) expect(item).toHaveAttribute("aria-checked", "false")
  })

  it("WEB-15 the filter is sent only as the list request, never saved in storage", async () => {
    const { user, api } = openDiscovery("/postings?tab=good", { postings: many(3) })
    await table()

    const panel = await openFamilyPanel(user)
    await user.click(within(panel).getByRole("checkbox", { name: "Backend" }))
    await user.keyboard("{Escape}")
    await user.type(search(), "react{Enter}")
    await waitFor(() => expect(lastListQuery(api)).toBe("tab=ranked&families=backend&keyword=react"))
    expect(api.requests).toEqual([])
    const stored = [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" ")
    expect(stored).not.toMatch(/backend|react/)
  })

  it.each([
    ["/postings?tab=good&families=robotics", "/postings?tab=good", ""],
    ["/postings?tab=good&families=backend,frontend", "/postings?tab=good&families=backend", "backend"],
    ["/postings?tab=good&families=Backend", "/postings?tab=good", ""],
    ["/postings?tab=good&families=backend,", "/postings?tab=good&families=backend", "backend"],
    [`/postings?tab=good&keyword=${"a".repeat(101)}`, "/postings?tab=good", ""],
    [`/postings?tab=good&families=mobile&keyword=${"a".repeat(101)}`, "/postings?tab=good&families=mobile", "mobile"],
    ["/postings?tab=good&keyword=%20%20", "/postings?tab=good", ""],
    // v1.12.1: a control character would get a 400; the keyword is dropped instead (no load error).
    ["/postings?keyword=%00", "/postings", ""],
    ["/postings?tab=good&families=backend&keyword=go%00", "/postings?tab=good&families=backend", "backend"],
    ["/postings?tab=good&families=mobile,backend", "/postings?tab=good&families=backend,mobile", "backend,mobile"],
    // 8d.15: a keyword that folds to empty (only zero-width, format or combining characters) is dropped.
    ["/postings?tab=good&keyword=%E2%80%8B", "/postings?tab=good", ""],
    ["/postings?tab=good&keyword=%C2%AD", "/postings?tab=good", ""],
    ["/postings?tab=good&keyword=%CC%81", "/postings?tab=good", ""],
    ["/postings?tab=good&families=mobile&keyword=%E2%81%A0%E2%80%8B", "/postings?tab=good&families=mobile", "mobile"],
  ])("WEB-16 %s is rewritten in place to %s with no error", async (url, rewritten, families) => {
    const { api, app, currentPath } = openDiscovery(url, {
      postings: [rankedPosting({ roleFamily: "backend", rank: 1 }), rankedPosting({ roleFamily: "mobile", rank: 2 })],
    })

    await table()
    expect(currentPath()).toBe(rewritten)
    expect(app.router.state.historyAction).toBe("REPLACE")
    expect(screen.queryByText("Couldn't load this page.")).not.toBeInTheDocument()
    expect(api.listRequests.every((q) => !q.has("keyword") || q.get("keyword")!.length <= 100)).toBe(true)
    expect(search()).toHaveValue("")
    expect(api.listRequests.at(-1)?.get("families") ?? "").toBe(families)
  })
})

describe("Tab changes and restarts (8W.4)", () => {
  it("WEB-17 changing the tab keeps the filter and pushes a history entry", async () => {
    const { user, app, currentPath } = openDiscovery("/postings?tab=good&families=backend&keyword=senior", { postings: many(3) })
    await screen.findByRole("search")

    await user.click(screen.getByRole("tab", { name: "Not a match" }))
    expect(currentPath()).toBe("/postings?tab=not_a_match&families=backend&keyword=senior")
    expect(search()).toHaveValue("senior")
    await act(() => app.router.navigate(-1))
    expect(currentPath()).toBe("/postings?tab=good&families=backend&keyword=senior")
  })

  it.each([
    ["the All tab", "all"],
    ["Backend", "family"],
    ["engineer", "keyword"],
  ])("WEB-18 changing %s after Load more restarts from page 1", async (_, change) => {
    const { user, api } = openDiscovery("/postings?tab=good", { postings: many(80, () => ({ roleFamily: "backend" })) })
    await table()
    await user.click(loadMore())
    await waitFor(async () => expect(await rowTitles()).toHaveLength(50))

    if (change === "all") await user.click(screen.getByRole("tab", { name: "All" }))
    if (change === "family") {
      const panel = await openFamilyPanel(user)
      await user.click(within(panel).getByRole("checkbox", { name: "Backend" }))
      await user.keyboard("{Escape}")
    }
    if (change === "keyword") await user.type(search(), "engineer{Enter}")

    await waitFor(async () => expect(await rowTitles()).toHaveLength(25))
    expect(api.listRequests.at(-1)?.has("cursor")).toBe(false)
  })

  it("WEB-18b the previous rows stay, dimmed, while the new view loads; Load more is unavailable meanwhile", async () => {
    const { user } = openDiscovery("/postings?tab=all", { postings: many(30) })
    await table()
    let release: () => void = () => undefined
    server.use(http.get(JOB_POSTINGS_PATH, () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))))

    await user.click(screen.getByRole("tab", { name: "Good matches" }))
    expect(await rowTitles()).toHaveLength(25)
    const list = within(await table()).getAllByRole("row")[1].closest(".transition-opacity")!
    expect(list).toHaveClass("opacity-60")
    expect(loadMore()).toHaveAttribute("aria-disabled", "true")
    act(() => release())
    await waitFor(() => expect(list).not.toHaveClass("opacity-60"))
  })
})

describe("Result count (8W.7)", () => {
  it.each([
    [1, "/postings?tab=all", "1 posting"],
    [12, "/postings?tab=all", "12 postings"],
    [1204, "/postings?tab=all", "Showing 25 of 1,204 postings"],
    [1, "/postings?tab=all&keyword=engineer", "1 matching posting"],
    [12, "/postings?tab=all&families=backend", "12 matching postings"],
    [26, "/postings?tab=all&families=backend", "Showing 25 of 26 matching postings"],
  ])("WEB-19/20 %i postings at %s read %s", async (count, url, line) => {
    openDiscovery(url, { postings: many(count, () => ({ roleFamily: "backend" })) })

    expect(await screen.findByText(line)).toBeVisible()
  })

  it("WEB-21 the count stays the total after Load more", async () => {
    const { user } = openDiscovery("/postings?tab=all", { postings: many(60) })
    await table()

    await user.click(loadMore())
    expect(await screen.findByText("Showing 50 of 60 postings")).toBeVisible()
  })
})

describe("Load more (8W.8)", () => {
  it("WEB-22/23/43 appends the next page, moves focus to the 26th row, announces, and is gone on the last page", async () => {
    const { user } = openDiscovery("/postings?tab=all", { postings: many(60) })
    const first = await rowTitles()
    expect(first).toHaveLength(25)

    await user.click(loadMore())
    await waitFor(async () => expect(await rowTitles()).toHaveLength(50))
    expect((await rowTitles()).slice(0, 25)).toEqual(first)
    await waitFor(() => expect(status()).toHaveTextContent("25 more postings loaded. Showing 50 of 60."))
    await waitFor(() => expect(screen.getAllByRole("link", { name: "P26 Engineer at Acme" })[0]).toHaveFocus())

    await user.click(loadMore())
    await waitFor(async () => expect(await rowTitles()).toHaveLength(60))
    expect(screen.getByText("60 postings")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument()
    await waitFor(() => expect(status()).toHaveTextContent("10 more postings loaded. All 60 are shown."))
    await waitFor(() => expect(screen.getAllByRole("link", { name: "P51 Engineer at Acme" })[0]).toHaveFocus())
  })

  it.each([
    [24, false],
    [25, false],
    [26, true],
  ])("WEB-24 with %i postings Load more is shown: %s", async (count, shown) => {
    openDiscovery("/postings?tab=all", { postings: many(count) })
    await table()

    expect(screen.queryByRole("button", { name: "Load more" }) !== null).toBe(shown)
  })

  it("WEB-25 cannot be pressed twice while loading; shows Loading… and is busy", async () => {
    const { user, api } = openDiscovery("/postings?tab=all", { postings: many(60) })
    await table()
    let release: () => void = () => undefined
    server.use(
      http.get(JOB_POSTINGS_PATH, ({ request }) =>
        new URL(request.url).searchParams.has("cursor")
          ? new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
          : undefined
      )
    )

    const button = loadMore()
    await user.click(button)
    expect(button).toHaveTextContent("Loading…")
    expect(button).toHaveAttribute("aria-busy", "true")
    expect(button).toHaveAttribute("aria-disabled", "true")
    await user.click(button)
    act(() => release())
    await waitFor(async () => expect(await rowTitles()).toHaveLength(50))
    expect(api.listRequests.filter((q) => q.has("cursor"))).toHaveLength(1)
  })

  it("WEB-26 a failed page keeps the rows, shows the inline error and Try again with focus, then recovers", async () => {
    const { user } = openDiscovery("/postings?tab=all", { postings: many(60) }, { fakeTimers: true })
    await table()
    let isDown = true
    server.use(
      http.get(JOB_POSTINGS_PATH, ({ request }) =>
        isDown && new URL(request.url).searchParams.has("cursor") ? apiErrorResponse("internal_error") : undefined
      )
    )

    const button = loadMore()
    await user.click(button)
    // A 5xx is retried twice with backoff (query-client.ts). Each retry timer exists only once the
    // previous request has failed, so step the clock until the error line shows instead of a fixed sum.
    const errorLine = () => document.getElementById("postings-load-more-error")
    for (let step = 0; step < 20 && !errorLine(); step += 1) await advance(500)
    expect(errorLine()).toHaveTextContent("Couldn't load more postings. The ones above are still here.")
    expect(button).toHaveTextContent("Try again")
    expect(button).toHaveFocus()
    expect(button).toHaveAccessibleDescription("Couldn't load more postings. The ones above are still here.")
    expect(await rowTitles()).toHaveLength(25)
    await waitFor(() => expect(status()).toHaveTextContent("Couldn't load more postings. The ones above are still here."))

    isDown = false
    await user.click(button)
    await waitFor(async () => expect(await rowTitles()).toHaveLength(50))
    expect(screen.queryByText("Couldn't load more postings. The ones above are still here.")).not.toBeInTheDocument()
  })

  it("WEB-27 a cursor refused with 400 keeps the rows; Try again restarts from page 1 and focuses the first row", async () => {
    const { user, api } = openDiscovery("/postings?tab=all", { postings: many(60) })
    await table()
    server.use(
      http.get(JOB_POSTINGS_PATH, ({ request }) =>
        new URL(request.url).searchParams.has("cursor") ? apiErrorResponse("bad_request") : undefined
      )
    )

    await user.click(loadMore())
    expect(await screen.findByText("Couldn't load more postings. The ones above are still here.")).toBeVisible()
    expect(await rowTitles()).toHaveLength(25)
    const before = api.listRequests.length

    await user.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(api.listRequests.length).toBeGreaterThan(before))
    expect(api.listRequests.slice(before).every((q) => !q.has("cursor"))).toBe(true)
    await waitFor(() => expect(screen.getAllByRole("link", { name: "P01 Engineer at Acme" })[0]).toHaveFocus())
    expect(screen.getByRole("button", { name: "Load more" })).toBeVisible()
    // postings.announce.restarted (design r1 Q5; not quoted by the Gherkin).
    await waitFor(() => expect(status()).toHaveTextContent("The list started over from the top. Showing 25 of 60 postings."))
  })
})

describe("Client dedupe (8W.9)", () => {
  function pagedOverride(pages: JobPostingDetail[][]) {
    let index = 0
    server.use(
      http.get(JOB_POSTINGS_PATH, async ({ request }) => {
        const { jobPostingsResponseSchema } = await import("@eve/contracts")
        const hasCursor = new URL(request.url).searchParams.has("cursor")
        const page = pages[hasCursor ? 1 : 0]
        index += 1
        const body = jobPostingsResponseSchema.parse({
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          postings: page.map(({ postingText: _t, employmentType: _e, eligibility: _l, match: _m, technologies: _x, applyAnyway: _a, applicationId: _i, pastedPrepareOffered: _p, ...summary }) => ({ ...summary, match: null })),
          waitingToBeCheckedCount: 0,
          nextCursor: hasCursor ? pages.length > 2 ? "c2" : null : "c1",
          totalCount: 49,
          criteriaEmptyState: false,
          // v1.18.0 required keys.
          hiddenCounts: { offTarget: 0, belowSeniorityFloor: 0, undated: 0, olderThan60Days: 0, total: 0 },
          recheckableCount: 0,
          targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES],
          waitingReason: null,
        })
        return Response.json(body)
      })
    )
    return () => index
  }

  it("WEB-28 a repeated id keeps its first position", async () => {
    const all = many(49)
    const { user } = openDiscovery("/postings?tab=all")
    pagedOverride([all.slice(0, 25), all.slice(24, 49)])
    await table()

    await user.click(loadMore())
    await waitFor(async () => expect(await rowTitles()).toHaveLength(49))
    const titles = await rowTitles()
    expect(titles.filter((t) => t === "P25 Engineer")).toHaveLength(1)
    expect(titles.indexOf("P25 Engineer")).toBe(24)
    await waitFor(() => expect(status()).toHaveTextContent("24 more postings loaded. All 49 are shown."))
  })

  it("WEB-29 a page of repeats adds nothing, says so and keeps focus on Load more", async () => {
    const all = many(25)
    const { user } = openDiscovery("/postings?tab=all")
    pagedOverride([all, all.slice(23, 25), []])
    await table()

    await user.click(loadMore())
    await waitFor(() => expect(status()).toHaveTextContent("No new postings on that page. Load more to keep going."))
    expect(await rowTitles()).toHaveLength(25)
    expect(loadMore()).toHaveFocus()
  })
})

describe("Global rank and empty states (8W.10 to 8W.13)", () => {
  it("WEB-30 a filtered Ranked list shows global ranks with gaps and the rank hint", async () => {
    const titles = ["React Lead", "Go", "Rust", "React Dev", "Java", "Ruby", "PHP", "C", "React Native", "Elm"]
    openDiscovery("/postings?tab=good&keyword=react", {
      postings: titles.map((title, i) => rankedPosting({ title, rank: i + 1 })),
    })

    await waitFor(async () => expect(await rowTitles()).toEqual(["React Lead", "React Dev", "React Native"]))
    const ranks = within(await table()).getAllByRole("row").slice(1).map((row) => row.querySelector("td")?.textContent)
    expect(ranks).toEqual(["1", "4", "9"])
    expect(screen.getByText("Ranks are positions in the full Ranked list, so they can skip numbers here.")).toBeVisible()
  })

  it("WEB-30b no rank hint without a filter or off the Ranked tab", async () => {
    openDiscovery("/postings?tab=all&keyword=engineer", { postings: many(3) })
    await table()
    expect(screen.queryByText(/Ranks are positions/)).not.toBeInTheDocument()
  })

  it("WEB-31 a filter matching nothing shows C-EMPTY-9, no count line, no Load more and one Clear filters", async () => {
    openDiscovery("/postings?tab=good&families=mobile&keyword=flutter", { postings: many(30) })

    expect(await screen.findByRole("heading", { level: 2, name: "No postings match these filters" })).toBeVisible()
    expect(screen.getByText("Try fewer words in the title search or more role families.")).toBeVisible()
    expect(screen.getAllByRole("button", { name: "Clear filters" })).toHaveLength(1)
    expect(screen.queryByText(/postings?$/)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument()
    // A first load announces nothing (design r1, Accessibility: live regions).
    expect(status()).toHaveTextContent("")
  })

  it("WEB-31b a filter change that matches nothing announces the filter empty title", async () => {
    const { user } = openDiscovery("/postings?tab=all", { postings: many(3) })
    await table()

    await user.type(search(), "flutter{Enter}")
    expect(await screen.findByRole("heading", { level: 2, name: "No postings match these filters" })).toBeVisible()
    await waitFor(() => expect(status()).toHaveTextContent("No postings match these filters"))
  })

  it("WEB-32 Clear filters keeps the tab, empties the controls, focuses the search and shows page 1", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=not_a_match&families=mobile&keyword=flutter", {
      postings: many(30, () => ({ status: "skipped", rank: null, skipReason: "weak_core_match" })),
    })

    await user.click(await screen.findByRole("button", { name: "Clear filters" }))
    expect(currentPath()).toBe("/postings?tab=not_a_match")
    expect(search()).toHaveValue("")
    expect(search()).toHaveFocus()
    await waitFor(async () => expect(await rowTitles()).toHaveLength(25))
    expect(screen.getByRole("button", { name: "Role family" })).toBeVisible()
  })

  it("WEB-32b the filter bar's Clear filters also focuses the search", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=all&families=backend", { postings: many(3, () => ({ roleFamily: "backend" })) })
    await table()

    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(currentPath()).toBe("/postings?tab=all")
    expect(search()).toHaveFocus()
  })

  it("WEB-33 with no postings at all an active filter shows C-EMPTY-9, not first-run", async () => {
    openDiscovery("/postings?tab=good&keyword=react")

    expect(await screen.findByRole("heading", { name: "No postings match these filters" })).toBeVisible()
    expect(screen.queryByRole("heading", { name: "No jobs yet" })).not.toBeInTheDocument()
  })

  it("WEB-34 clearing the filter on an empty installation shows the first-run state", async () => {
    const { user } = openDiscovery("/postings?tab=good&keyword=react")

    await user.click(await screen.findByRole("button", { name: "Clear filters" }))
    expect(await screen.findByRole("heading", { name: "No jobs yet" })).toBeVisible()
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Find jobs" })).toBeVisible()
  })

  it("WEB-35 only skipped postings and a filter on Ranked: C-EMPTY-9, not Nothing eligible", async () => {
    openDiscovery("/postings?tab=good&families=backend", {
      postings: many(4, () => ({ status: "skipped", rank: null, skipReason: "weak_core_match" })),
    })

    expect(await screen.findByRole("heading", { name: "No postings match these filters" })).toBeVisible()
    expect(screen.queryByRole("heading", { name: "No good matches yet" })).not.toBeInTheDocument()
  })

  it("WEB-36/37/38 first-run reads the unfiltered All-tab totalCount with limit=1", async () => {
    const { api } = openDiscovery("/postings", {
      postings: [rankedPosting({ status: "checking", rank: null, eligibility: null })],
    })

    expect(await screen.findByRole("heading", { name: "No good matches yet" })).toBeVisible()
    expect(screen.queryByRole("heading", { name: "No jobs yet" })).not.toBeInTheDocument()
    expect(api.listRequests.map(String)).toContain("tab=all&limit=1")
  })

  it("WEB-39 the waiting notice ignores the filter and its link drops the filter", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=good&families=mobile&keyword=flutter", {
      waitingToBeCheckedCount: 2,
      postings: many(5),
    })

    expect(
      // EPIC-0006 copy-deck.r1 postings.waitingNotice.text replaces the "saved link(s)" text.
      await screen.findByText(/2 postings are waiting to be checked\. Eve checks them when the cost pause ends, then ranks them with the rest\./)
    ).toBeVisible()
    // 8d.24: a polite status, not an alert.
    const notice = screen.getByText(/postings are waiting to be checked/).closest("[data-slot=alert]")
    expect(notice).toHaveAttribute("role", "status")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "No postings match these filters" })).toBeVisible()
    await user.click(screen.getByRole("link", { name: "See them" }))
    expect(currentPath()).toBe("/postings?tab=all")
  })
})

describe("F-QA8-02: an outside keyword change drops a pending keystroke", () => {
  // QA repro (qa/scripts/repro-clear.cjs) cases B and E: a family is checked, "engineer" is
  // typed, and Clear filters is used before the 300 ms debounce ends.
  async function filteredByFamily() {
    const view = openDiscovery("/postings?tab=good&families=backend", { postings: many(30, () => ({ roleFamily: "backend" })) }, { fakeTimers: true })
    await table()
    return view
  }

  it("WEB-32 case B: type, then click Clear filters within 300 ms; the keyword stays cleared", async () => {
    const { user, currentPath, api } = await filteredByFamily()
    await user.type(search(), "engineer")
    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    await advance(1500)

    expect(currentPath()).toBe("/postings?tab=good")
    expect(search()).toHaveValue("")
    expect(api.listRequests.some((q) => q.has("keyword"))).toBe(false)
  })

  it("WEB-32 case E: type, then Tab to Clear filters and press Enter within 300 ms", async () => {
    const { user, currentPath, api } = await filteredByFamily()
    search().focus()
    await user.keyboard("engineer")
    screen.getByRole("button", { name: "Clear filters" }).focus()
    await user.keyboard("{Enter}")
    await advance(1500)

    expect(currentPath()).toBe("/postings?tab=good")
    expect(search()).toHaveValue("")
    expect(api.listRequests.some((q) => q.has("keyword"))).toBe(false)
  })

  it("the filter empty state's Clear filters within 300 ms of typing also stays cleared", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=good&keyword=flutter", { postings: many(3) }, { fakeTimers: true })
    expect(await screen.findByRole("heading", { name: "No postings match these filters" })).toBeVisible()
    await user.type(search(), "x")
    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    await advance(1500)

    expect(currentPath()).toBe("/postings?tab=good")
    expect(search()).toHaveValue("")
  })

  it("the See them link within 300 ms of typing lands on the All tab with no keyword", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=good&keyword=flutter", { waitingToBeCheckedCount: 2, postings: many(3) }, { fakeTimers: true })
    await screen.findByRole("link", { name: "See them" })
    await user.type(search(), "x")
    await user.click(screen.getByRole("link", { name: "See them" }))
    await advance(1500)

    expect(currentPath()).toBe("/postings?tab=all")
    expect(search()).toHaveValue("")
  })

  it("Back within 300 ms of typing shows the earlier keyword, not the typed one", async () => {
    // Filter changes replace the history entry and tab changes push one, so Back here
    // returns from (All, "vue") to (Ranked, "react"): the keyword changes from outside.
    const { user, app } = openDiscovery("/postings?tab=good&keyword=react", { postings: many(3) }, { fakeTimers: true })
    await screen.findByRole("search")
    await user.click(screen.getByRole("tab", { name: "All" }))
    await user.clear(search())
    await user.type(search(), "vue{Enter}")
    await waitFor(() => expect(app.router.state.location.search).toBe("?tab=all&keyword=vue"))
    await user.type(search(), "x")
    await act(() => app.router.navigate(-1))
    await advance(1500)

    expect(app.router.state.location.search).toBe("?tab=good&keyword=react")
    expect(search()).toHaveValue("react")
  })

  it("Back that changes only the tab keeps the typed text, like a tab change", async () => {
    const { user, app } = openDiscovery("/postings?tab=good&keyword=react", { postings: many(3) }, { fakeTimers: true })
    await screen.findByRole("search")
    await user.click(screen.getByRole("tab", { name: "All" }))
    await waitFor(() => expect(app.router.state.location.search).toBe("?tab=all&keyword=react"))
    await user.type(search(), "ive")
    await act(() => app.router.navigate(-1))
    await advance(1500)

    expect(app.router.state.location.search).toBe("?tab=good&keyword=reactive")
    expect(search()).toHaveValue("reactive")
  })

  it("a tab change within 300 ms of typing keeps the typed text and applies it on the new tab", async () => {
    // The tab keeps the filter (8W.4), so the keyword is unchanged and the pending keystroke stands.
    const { user, currentPath } = openDiscovery("/postings?tab=good", { postings: many(3) }, { fakeTimers: true })
    await table()
    await user.type(search(), "engineer")
    await user.click(screen.getByRole("tab", { name: "All" }))
    await advance(1500)

    expect(currentPath()).toBe("/postings?tab=all&keyword=engineer")
    expect(search()).toHaveValue("engineer")
  })
})

describe("Accessibility (8W.14)", () => {
  it("WEB-41 every control works by keyboard and has its accessible name", async () => {
    const { user, currentPath } = openDiscovery("/postings?tab=good", { postings: many(60, () => ({ roleFamily: "backend" })) })
    await table()

    screen.getByRole("button", { name: "Role family" }).focus()
    await user.keyboard("{Enter}")
    const panel = await screen.findByRole("dialog", { name: "Role family" })
    expect(within(panel).getByRole("button", { name: "Close" })).toBeVisible()
    const backend = within(panel).getByRole("checkbox", { name: "Backend" })
    await waitFor(() => expect(within(panel).getAllByRole("checkbox")[0]).toHaveFocus())
    // EPIC-0006: Software engineering now sits before Backend in the catalog.
    for (let i = 0; i < 5; i += 1) await user.tab()
    expect(backend).toHaveFocus()
    await user.keyboard(" ")
    await waitFor(() => expect(currentPath()).toBe("/postings?tab=good&families=backend"))
    await user.keyboard("{Escape}")
    expect(screen.getByRole("button", { name: "Role family 1 selected" })).toHaveFocus()

    search().focus()
    await user.keyboard("engineer{Enter}")
    await waitFor(() => expect(currentPath()).toBe("/postings?tab=good&families=backend&keyword=engineer"))
    expect(screen.getByRole("button", { name: "Clear title search" })).toBeVisible()

    await waitFor(() => expect(screen.getByText("Showing 25 of 60 matching postings")).toBeVisible())
    loadMore().focus()
    await user.keyboard("{Enter}")
    await waitFor(async () => expect(await rowTitles()).toHaveLength(50))

    screen.getByRole("button", { name: "Clear filters" }).focus()
    await user.keyboard("{Enter}")
    expect(currentPath()).toBe("/postings?tab=good")
  })

  it("WEB-42 a settled filter change announces the new count; polls and the first load do not", async () => {
    const { user } = openDiscovery("/postings?tab=all", { postings: many(60, (i) => ({ roleFamily: i <= 12 ? "backend" : "fullstack" })) })
    await table()
    expect(status()).toHaveTextContent("")

    const panel = await openFamilyPanel(user)
    await user.click(within(panel).getByRole("checkbox", { name: "Backend" }))
    await waitFor(() => expect(status()).toHaveTextContent("12 matching postings"))
  })

  it("the list section no longer has aria-live; one status region per page", async () => {
    openDiscovery("/postings?tab=all", { postings: many(3) })
    const section = (await table()).closest("section")!
    expect(section).not.toHaveAttribute("aria-live")
    expect(screen.getAllByRole("status")).toHaveLength(1)
  })
})

describe("Polling with several loaded pages", () => {
  it("refetches every loaded page in place, keeps them loaded, and does not move focus or announce", async () => {
    const postings = many(60, (i) => (i === 40 ? { status: "checking", rank: null, eligibility: null } : {}))
    const { user, api } = openDiscovery("/postings?tab=all", { postings }, { fakeTimers: true })
    await table()
    await user.click(loadMore())
    await waitFor(async () => expect(await rowTitles()).toHaveLength(50))
    await waitFor(() => expect(status()).toHaveTextContent("25 more postings loaded."))
    const focused = document.activeElement
    api.state.postings[39] = { ...api.state.postings[39], status: "ranked", rank: 40 }
    api.state.postings[0] = { ...api.state.postings[0], title: "P01 Renamed Engineer" }
    const before = api.listRequests.length

    await advance(5000)
    await waitFor(() => expect(screen.getAllByRole("link", { name: "P01 Renamed Engineer at Acme" }).length).toBeGreaterThan(0))
    const poll = api.listRequests.slice(before)
    expect(poll.map((q) => q.has("cursor"))).toEqual([false, true])
    expect(await rowTitles()).toHaveLength(50)
    expect(document.activeElement).toBe(focused)
    expect(status()).toHaveTextContent("25 more postings loaded.")
    expect(screen.getByText("Showing 50 of 60 postings")).toBeVisible()
  })
})

describe("Slice 8d: invisible keywords and a cancelled list request", () => {
  it("WEB-47 a keyword of only invisible characters is no keyword, on load and when typed", async () => {
    const { user, api, currentPath, app } = openDiscovery("/postings?tab=good&keyword=%E2%80%8B", {
      postings: [rankedPosting({ roleFamily: "backend", rank: 1 }), rankedPosting({ roleFamily: "mobile", rank: 2 })],
    })
    await table()

    expect(currentPath()).toBe("/postings?tab=good")
    expect(app.router.state.historyAction).toBe("REPLACE")
    expect(screen.getByRole("tab", { name: "Good matches" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByText("2 postings")).toBeVisible()
    expect(screen.queryByText(/matching/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Ranks are positions/)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument()
    expect(api.listRequests.every((q) => !q.has("keyword"))).toBe(true)

    const requests = api.listRequests.length
    await user.type(search(), "\u200B{Enter}")
    expect(search()).toHaveValue("\u200B")
    // The raw text is not empty, so the clear button shows and can remove it.
    expect(screen.getByRole("button", { name: "Clear title search" })).toBeVisible()
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)))
    expect(currentPath()).toBe("/postings?tab=good")
    expect(api.listRequests).toHaveLength(requests)
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Clear title search" }))
    expect(search()).toHaveValue("")
    expect(search()).toHaveFocus()
  })

  it("WEB-49 a list request the server cancels (500) shows the existing load error after the retries", async () => {
    const { user } = openDiscovery("/postings?tab=good", { postings: many(3) }, { fakeTimers: true })
    let attempts = 0
    server.use(
      http.get(JOB_POSTINGS_PATH, () => {
        attempts += 1
        return apiErrorResponse("internal_error")
      })
    )

    for (let step = 0; step < 20 && !screen.queryByText("Couldn't load this page."); step += 1) await advance(500)
    expect(attempts).toBe(3)
    const alert = screen.getByText("Couldn't load this page.").closest("[data-slot=alert]")
    expect(alert).toHaveAttribute("role", "alert")
    expect(within(alert as HTMLElement).getByRole("button", { name: "Try again" })).toBeVisible()

    // The filter bar stays usable.
    const landmark = screen.getByRole("search", { name: "Filter Job Postings" })
    await user.type(within(landmark).getByRole("searchbox", { name: "Search job titles" }), "react")
    expect(search()).toHaveValue("react")
    await user.click(within(landmark).getByRole("button", { name: "Role family" }))
    expect(await screen.findByRole("dialog", { name: "Role family" })).toBeVisible()
  })
})

describe("Permission (8W.3)", () => {
  it("WEB-45 a filtered link without a session keeps the view in next", async () => {
    const { renderApp } = await import("./test-app")
    const { currentPath } = renderApp("/postings?tab=good&families=backend&keyword=react")

    await screen.findByRole("button", { name: "Sign in with Google" })
    expect(currentPath()).toBe(`/sign-in?${new URLSearchParams({ next: "/postings?tab=good&families=backend&keyword=react" })}`)
  })
})
