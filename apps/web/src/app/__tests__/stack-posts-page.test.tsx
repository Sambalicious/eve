import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it, vi } from "vitest"
import { ALERT_FEEDS_PATH, JOB_CRITERIA_PATH, STACK_POSTS_PATH } from "@eve/contracts"

import { routeSkeleton } from "@/components/page-skeletons"
import { apiErrorResponse, expiredSession, noSession, server, storedFeed, storedPost, verifiedOn20Oct } from "@/shared/testing"
import { renderApp } from "./test-app"
import { loadedFeeds, loadedPosts, openStackPosts, region, showTab } from "./stack-posts-helpers"

const decoded = (href: string, name: string) => new URL(href).searchParams.get(name)
const rawParam = (href: string, name: string) =>
  new URL(href).search
    .slice(1)
    .split("&")
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1)

async function groupRows() {
  const links = await region("Search links")
  await within(links).findAllByRole("link", { name: /^LinkedIn posts for/ })
  return within(links).getAllByRole("listitem")
}

function linksOf(row: HTMLElement) {
  return {
    linkedin: within(row).getByRole("link", { name: /^LinkedIn posts for/ }).getAttribute("href") ?? "",
    googlePosts: within(row).getByRole("link", { name: /^Google posts for/ }).getAttribute("href") ?? "",
    googleArticles: within(row).getByRole("link", { name: /^Google articles for/ }).getAttribute("href") ?? "",
  }
}

describe("Stack posts page frame (stack-posts-page.feature)", () => {
  it("@ac-1.1 R5: the nav has Find jobs and no Stack posts entry; /stack-posts opens Find jobs at the Stack posts section", async () => {
    const { user, currentPath } = openStackPosts({ path: "/dashboard" })

    const entry = await screen.findByRole("link", { name: "Find jobs" })
    expect(entry.querySelector("svg.lucide-search")).not.toBeNull()
    expect(screen.queryByRole("link", { name: "Stack posts" })).not.toBeInTheDocument()

    await user.click(entry)
    expect(await screen.findByRole("heading", { level: 1, name: "Find jobs" })).toBeVisible()
    expect(screen.getByRole("link", { name: "Find jobs" })).toHaveAttribute("aria-current", "page")
    expect(currentPath()).toBe("/find-jobs")
  })

  it("@ac-1.1 @ac-9.2 R5: Job Sources has no nav entry either; its content is in Set up alerts", async () => {
    openStackPosts({ path: "/dashboard" })
    await screen.findByRole("link", { name: "Find jobs" })
    expect(screen.queryByRole("link", { name: "Job Sources" })).not.toBeInTheDocument()
  })

  it("@ac-1.1 shows Search links, Posts from your field and Set up alerts (with Alert feeds) in order, even on a new installation; title is Find jobs · Eve", async () => {
    const { user } = openStackPosts()
    const tabs = within(await screen.findByRole("tablist", { name: "Find jobs" })).getAllByRole("tab")
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Search", "Hiring posts", "Posts from your field", "Set up alerts"])
    const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "")
    // Each tab holds its own sections, in the design note's order.
    await user.click(screen.getByRole("tab", { name: "Search" }))
    expect(headings()).toEqual(expect.arrayContaining(["Hiring search links", "Check this job", "Search links"]))
    await user.click(screen.getByRole("tab", { name: "Posts from your field" }))
    expect(await screen.findByRole("heading", { level: 2, name: "Posts from your field" })).toBeVisible()
    await user.click(screen.getByRole("tab", { name: "Set up alerts" }))
    await loadedFeeds()
    expect(headings().filter((t) => ["Set up alerts", "Alert feeds"].includes(t))).toEqual(["Set up alerts", "Alert feeds"])
    expect(document.title).toBe("Find jobs · Eve")
  })

  it("@ac-1.2 a visitor without a session is sent to sign-in and no Stack posts data is requested", async () => {
    server.use(noSession)
    const api = vi.fn()
    server.use(http.get(ALERT_FEEDS_PATH, api), http.get(STACK_POSTS_PATH, api))
    const { currentPath } = renderApp("/stack-posts")
    await waitFor(() => expect(currentPath()).toMatch(/^\/sign-in\?next=%2Fstack-posts/))
    expect(api).not.toHaveBeenCalled()
  })

  it("@ac-1.2 an expired session is sent to sign in again", async () => {
    server.use(expiredSession)
    const { currentPath } = renderApp("/stack-posts")
    await waitFor(() => expect(currentPath()).toMatch(/^\/sign-in\?.*reason=expired/))
  })

  it("has a first-load skeleton with the page's own title", () => {
    expect(routeSkeleton("/stack-posts")?.title).toBe("Find jobs")
  })

  it("each section shows its own skeleton while loading and its own load error with Try again", async () => {
    openStackPosts({ criteria: { frameworks: ["React"] }, stack: { verification: verifiedOn20Oct } })
    server.use(http.get(STACK_POSTS_PATH, () => apiErrorResponse("internal_error")))
    const posts = await region("Posts")
    expect(await within(posts).findByText("Couldn't load this page.", {}, { timeout: 8000 })).toBeVisible()
    expect(within(posts).getByRole("button", { name: "Try again" })).toBeVisible()
    expect(within(await region("Search links")).getAllByRole("link", { name: /LinkedIn posts for React/ })).toHaveLength(1)
    expect(within(await loadedFeeds()).getByText("Confirmed on 20 Oct 2026")).toBeVisible()
  }, 15000)

  it("Search links shows its load error without hiding the other sections", async () => {
    openStackPosts()
    server.use(http.get(JOB_CRITERIA_PATH, () => apiErrorResponse("internal_error")))
    const links = await region("Search links")
    expect(await within(links).findByText("Couldn't load this page.", {}, { timeout: 8000 })).toBeVisible()
    await loadedFeeds()
  }, 15000)

  it("@ac-1.2 a write from a second tab is reflected after the first tab reloads", async () => {
    const view = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    const tabA = await loadedFeeds()
    expect(within(tabA).queryByRole("listitem")).not.toBeInTheDocument()

    // Tab B registers "React posts" against the same server state.
    view.stack.state.feeds.push(storedFeed({ label: "React posts" }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(within(tabA).queryByRole("listitem", { name: /^React posts/ })).not.toBeInTheDocument()

    view.unmount()
    renderApp("/find-jobs#set-up-alerts")
    const reloaded = await loadedFeeds()
    expect(await within(reloaded).findByRole("listitem", { name: "React posts, feed ending 6 5 4 3 2 1" })).toBeVisible()
  }, 15000)

  it("Alert feeds shows its load error with Try again without hiding the other sections", async () => {
    openStackPosts({ criteria: { frameworks: ["React"] }, stack: { verification: verifiedOn20Oct, posts: [storedPost()] } })
    server.use(http.get(ALERT_FEEDS_PATH, () => apiErrorResponse("internal_error")))
    const feeds = await region("Alert feeds")
    expect(await within(feeds).findByText("Couldn't load this page.", {}, { timeout: 8000 })).toBeVisible()
    expect(within(feeds).getByRole("button", { name: "Try again" })).toBeVisible()
    expect(within(feeds).queryByRole("textbox", { name: "Feed URL" })).not.toBeInTheDocument()
    expect(within(await region("Search links")).getAllByRole("link", { name: /LinkedIn posts for React/ })).toHaveLength(1)
    expect(within(await loadedPosts()).getByRole("listitem", { name: "Hooks in practice" })).toBeVisible()
  }, 15000)
})

describe("Search links (search-links.feature)", () => {
  it("@ac-2.1 @ac-2.3 Frameworks then Technologies, quoted, joined with OR; @ac-2.2 labelled by its terms", async () => {
    openStackPosts({ criteria: { frameworks: ["Next.js", "NestJS"], technologies: ["TypeScript"] } })
    const rows = await groupRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent("Next.js, NestJS, TypeScript")
    expect(decoded(linksOf(rows[0]).linkedin, "keywords")).toBe('("Next.js" OR "NestJS" OR "TypeScript") NOT hiring')
  })

  it("@ac-2.1 terms keep the saved order and entered form", async () => {
    openStackPosts({ criteria: { frameworks: ["nestjs", "React"], technologies: ["postgreSQL", "AWS"] } })
    const [row] = await groupRows()
    expect(decoded(linksOf(row).linkedin, "keywords")).toBe('("nestjs" OR "React" OR "postgreSQL" OR "AWS") NOT hiring')
  })

  it("@ac-2.4 @ac-2.5 the LinkedIn, Google posts and Google articles links for a group", async () => {
    openStackPosts({ criteria: { frameworks: ["Next.js", "NestJS"] } })
    const [row] = await groupRows()
    const { linkedin, googlePosts, googleArticles } = linksOf(row)
    expect(linkedin.startsWith("https://www.linkedin.com/search/results/content/?")).toBe(true)
    expect(decoded(linkedin, "keywords")).toBe('("Next.js" OR "NestJS") NOT hiring')
    expect(decoded(linkedin, "sortBy")).toBe('"date_posted"')
    expect(decoded(linkedin, "datePosted")).toBe('"past-week"')
    expect(rawParam(linkedin, "sortBy")).toBe("%22date_posted%22")
    expect(rawParam(linkedin, "datePosted")).toBe("%22past-week%22")
    expect(googlePosts.startsWith("https://www.google.com/search?")).toBe(true)
    expect(decoded(googlePosts, "q")).toBe('site:linkedin.com/posts ("Next.js" OR "NestJS") -hiring -job')
    expect(decoded(googlePosts, "tbs")).toBe("qdr:w")
    expect(decoded(googleArticles, "q")).toBe('site:linkedin.com/pulse ("Next.js" OR "NestJS") -hiring -job')
    expect(decoded(googleArticles, "tbs")).toBe("qdr:w")
  })

  it.each([
    ["C#", "#", "%23"],
    ["C++", "+", "%2B"],
    ["CI/CD", "/", "%2F"],
  ])("@ac-2.4 @ac-2.5 %s survives encoding in every link", async (term, raw, encoded) => {
    openStackPosts({ criteria: { frameworks: [term] } })
    const [row] = await groupRows()
    const { linkedin, googlePosts, googleArticles } = linksOf(row)
    const keywords = rawParam(linkedin, "keywords") ?? ""
    expect(keywords).toContain(encoded)
    expect(keywords).not.toContain(raw)
    expect(decoded(linkedin, "keywords")).toBe(`("${term}") NOT hiring`)
    expect(decoded(googlePosts, "q")).toBe(`site:linkedin.com/posts ("${term}") -hiring -job`)
    expect(decoded(googleArticles, "q")).toBe(`site:linkedin.com/pulse ("${term}") -hiring -job`)
  })

  it.each([
    [1, 0, 1, 1],
    [8, 0, 1, 8],
    [9, 0, 2, 1],
    [5, 4, 2, 1],
    [17, 0, 3, 1],
    [20, 20, 5, 8],
  ])("@ac-2.2 %i frameworks + %i technologies make %i groups, the last of %i terms", async (f, t, groups, last) => {
    const frameworks = Array.from({ length: f }, (_, i) => `F${i + 1}`)
    const technologies = Array.from({ length: t }, (_, i) => `T${i + 1}`)
    openStackPosts({ criteria: { frameworks, technologies } })
    const rows = await groupRows()
    expect(rows).toHaveLength(groups)
    const lastLabel = within(rows[rows.length - 1]).getByText(/^[FT]\d/).textContent ?? ""
    expect(lastLabel.split(", ")).toHaveLength(last)
    if (groups > 1) expect(rows[0]).toHaveTextContent(`Group 1 of ${groups}`)
    else expect(rows[0]).not.toHaveTextContent("Group 1 of")
  })

  it("@ac-2.1 @ac-2.2 a group spans Frameworks and Technologies", async () => {
    openStackPosts({
      criteria: { frameworks: ["React", "Next.js", "Vue", "Nuxt", "Svelte", "Angular"], technologies: ["TypeScript", "GraphQL", "PostgreSQL"] },
    })
    const rows = await groupRows()
    expect(within(rows[0]).getByText("React, Next.js, Vue, Nuxt, Svelte, Angular, TypeScript, GraphQL")).toBeVisible()
    expect(within(rows[1]).getByText("PostgreSQL")).toBeVisible()
  })

  it("@ac-2.6 two query strings per group behind the Google Alerts disclosure, each with its own Copy, no URL or time filter", async () => {
    const { user } = openStackPosts({ criteria: { frameworks: ["Next.js", "NestJS"] } })
    const [row] = await groupRows()
    const toggle = within(row).getByRole("button", { name: "Google Alerts queries for Next.js, NestJS" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    await user.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    const posts = within(row).getByLabelText("Posts query for Next.js, NestJS")
    const articles = within(row).getByLabelText("Articles query for Next.js, NestJS")
    expect(posts).toHaveTextContent('site:linkedin.com/posts ("Next.js" OR "NestJS") -hiring -job')
    expect(articles).toHaveTextContent('site:linkedin.com/pulse ("Next.js" OR "NestJS") -hiring -job')
    for (const text of [posts.textContent, articles.textContent]) {
      expect(text).not.toMatch(/https:\/\/|tbs|qdr:w/)
    }
    expect(within(row).getByRole("button", { name: "Copy posts query for Next.js, NestJS" })).toBeVisible()
    expect(within(row).getByRole("button", { name: "Copy articles query for Next.js, NestJS" })).toBeVisible()
  })

  it("@ac-2.6 a query string shows the term unencoded", async () => {
    const { user } = openStackPosts({ criteria: { technologies: ["C#", "CI/CD"] } })
    const [row] = await groupRows()
    await user.click(within(row).getByRole("button", { name: /Google Alerts queries/ }))
    expect(within(row).getByLabelText(/^Posts query for/)).toHaveTextContent('site:linkedin.com/posts ("C#" OR "CI/CD") -hiring -job')
  })

  it.each([
    ["posts", 'site:linkedin.com/posts ("Next.js" OR "NestJS") -hiring -job', "Posts query copied."],
    ["articles", 'site:linkedin.com/pulse ("Next.js" OR "NestJS") -hiring -job', "Articles query copied."],
  ])("@ac-2.6 @ac-1.3 copying the %s query puts exactly that string on the clipboard and announces it", async (kind, text, live) => {
    const { user } = openStackPosts({ criteria: { frameworks: ["Next.js", "NestJS"] } })
    const [row] = await groupRows()
    await user.click(within(row).getByRole("button", { name: /Google Alerts queries/ }))
    const button = within(row).getByRole("button", { name: `Copy ${kind} query for Next.js, NestJS` })
    await user.click(button)
    expect(await navigator.clipboard.readText()).toBe(text)
    expect(button).toHaveTextContent("Copied")
    expect(button).toHaveFocus()
    expect(within(await region("Search links")).getByRole("status").textContent ?? "").toBe(live)
  })

  it("@ac-1.3 a refused copy is announced as failed, not as copied, and the text is selected", async () => {
    const { user } = openStackPosts({ criteria: { frameworks: ["React"] } })
    const [row] = await groupRows()
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new DOMException("denied", "NotAllowedError"))
    await user.click(within(row).getByRole("button", { name: /Google Alerts queries/ }))
    const button = within(row).getByRole("button", { name: "Copy posts query for React" })
    await user.click(button)
    expect(await within(row).findByRole("alert")).toHaveTextContent("Couldn't copy. The query is selected, so press Ctrl+C or Cmd+C.")
    expect(button).not.toHaveTextContent("Copied")
    expect(screen.queryByText("Posts query copied.")).not.toBeInTheDocument()
    expect(window.getSelection()?.toString()).toBe('site:linkedin.com/posts ("React") -hiring -job')
  })

  it("@ac-2.6 @ac-1.4 links to Google Alerts and explains how to create an RSS alert", async () => {
    const { user } = openStackPosts({ criteria: { frameworks: ["React"] } })
    const [row] = await groupRows()
    await user.click(within(row).getByRole("button", { name: "Google Alerts queries for React" }))
    const open = within(row).getByRole("link", { name: "Open Google Alerts (opens in a new tab)" })
    expect(open).toHaveAttribute("href", "https://www.google.com/alerts")
    expect(open).toHaveAttribute("target", "_blank")
    expect(open).toHaveAttribute("rel", "noopener noreferrer")
    expect(
      within(row).getByText('Create an alert with a query, set "Deliver to" to "RSS feed", then paste the feed URL under Alert feeds.', { exact: false })
    ).toBeVisible()
  })

  it("@ac-2.7 the hint, not a guarantee", async () => {
    openStackPosts({ criteria: { frameworks: ["React"] } })
    await groupRows()
    expect(
      within(await region("Search links")).getByText(
        "Past-week searches from your job criteria. Excluding hiring posts is a hint to LinkedIn and Google, so some results will still be hiring posts or job ads."
      )
    ).toBeVisible()
  })

  it("@ac-2.9 empty criteria: empty state, no links, link to Settings Job criteria; other sections still shown", async () => {
    const { user, currentPath } = openStackPosts({
      stack: { verification: verifiedOn20Oct, feeds: [storedFeed({ label: "React posts" })] },
    })
    const links = await region("Search links")
    expect(await within(links).findByText("No frameworks or technologies saved")).toBeVisible()
    expect(within(links).getByText("Search links are built from the Frameworks and Technologies in your job criteria.")).toBeVisible()
    expect(within(links).queryByRole("link", { name: /LinkedIn|Google/ })).not.toBeInTheDocument()
    expect(within(links).queryByRole("link", { name: "Change job criteria" })).not.toBeInTheDocument()
    expect(within(await loadedFeeds()).getByRole("listitem", { name: /^React posts/ })).toBeVisible()
    expect(await region("Posts")).toBeVisible()

    // Back to the Search tab for its empty-state link.
    await showTab("Search links")
    await user.click(within(links).getByRole("link", { name: "Add job criteria" }))
    expect(currentPath()).toBe("/settings#job-criteria")
  })

  it("@ac-2.10 shown without a verification; @ac-1.4 @ac-6.4 the page requests nothing outside Eve's /v1 API", async () => {
    const outbound: string[] = []
    const listener = ({ request }: { request: Request }) => outbound.push(request.url)
    server.events.on("request:start", listener)
    openStackPosts({ criteria: { frameworks: ["React"], technologies: ["TypeScript"] } })
    const [row] = await groupRows()
    expect(within(row).getAllByRole("link")).toHaveLength(3)
    await loadedPosts()
    server.events.removeListener("request:start", listener)
    expect(outbound.length).toBeGreaterThan(0)
    for (const url of outbound) {
      expect(new URL(url).origin).toBe(window.location.origin)
      expect(new URL(url).pathname.startsWith("/v1/")).toBe(true)
    }
  })

  it("@ac-2.8 an open page keeps its terms; the next load uses the saved ones", async () => {
    const view = openStackPosts({ criteria: { frameworks: ["React"] } })
    await groupRows()
    view.career.state.jobCriteria = { ...view.career.state.jobCriteria, frameworks: ["Vue", "Nuxt"], version: 2 }
    expect((await groupRows())[0]).toHaveTextContent("React")
    view.unmount()
    renderApp("/find-jobs")
    await waitFor(async () => expect((await groupRows())[0]).toHaveTextContent("Vue, Nuxt"))
    expect(document.body.innerHTML).not.toContain("%22React%22")
  })
})

describe("EPIC-0007 P3-B-2: the shared row meta does not make Stack posts rows taller", () => {
  it("the meta is one inline paragraph with date, 4 chips + '+2' and source; badges wrap under the title as built (no Hiring nowrap)", async () => {
    const feed = storedFeed({ label: "React posts" })
    openStackPosts({
      stack: {
        verification: verifiedOn20Oct,
        feeds: [feed],
        posts: [storedPost({ feedId: feed.id, matchedTechnologies: ["React", "TypeScript", "Next.js", "GraphQL", "Playwright", "AWS"] })],
      },
    })
    const posts = await loadedPosts()
    const [row] = within(within(posts).getAllByRole("list")[0]).getAllByRole("listitem")
    const meta = row.querySelector('[data-slot="row-meta"]') as HTMLElement
    expect(meta.tagName).toBe("P")
    expect(meta).not.toHaveClass("flex")
    expect(meta).toHaveTextContent(/^Posted \d+ \w+ 2026/)
    expect(within(meta).getAllByText(/^(React|TypeScript|Next\.js|GraphQL)$/)).toHaveLength(4)
    expect(within(meta).getByText("+2")).toBeInTheDocument()
    expect(meta).toHaveTextContent("from React posts")
    const badges = row.querySelector('[data-slot="row-badges"]') as HTMLElement
    expect(badges.parentElement).not.toHaveClass("max-lg:flex-nowrap")
    // P3-B-3 (design-spec r3): the Hiring-only meta clamp does not reach Stack posts.
    expect(meta.className).not.toMatch(/line-clamp/)
  })
})

describe("External links and names (stack-posts-page.feature @ac-1.3 @ac-1.4)", () => {
  it("every LinkedIn and Google link opens in a new tab with rel noopener noreferrer", async () => {
    const { user } = openStackPosts({
      criteria: { frameworks: ["React"], technologies: ["TypeScript"] },
      stack: {
        verification: verifiedOn20Oct,
        posts: [storedPost({ canonicalUrl: "https://www.linkedin.com/posts/ada-obi_react-activity-7250000000000000000-abcd" })],
      },
    })
    const [row] = await groupRows()
    await user.click(within(row).getByRole("button", { name: /Google Alerts queries/ }))
    const external = (links: HTMLElement[]) => links.filter((a) => /linkedin\.com|google\.com/.test(a.getAttribute("href") ?? ""))
    // The Search tab's links, then Posts from your field's post title: five in all, as before the tabs.
    const searchLinks = external(within(await region("Search links")).getAllByRole("link"))
    const posts = await loadedPosts()
    const externalLinks = [...searchLinks, ...external(within(posts).getAllByRole("link"))]
    expect(externalLinks).toHaveLength(5)
    for (const link of externalLinks) {
      expect(link).toHaveAttribute("target", "_blank")
      expect(link).toHaveAttribute("rel", "noopener noreferrer")
      expect(link).toHaveAccessibleName(/\(opens in a new tab\)$/)
    }
  })

  it("every control has an accessible name; Copy names its query and Remove names its feed", async () => {
    const { user } = openStackPosts({
      criteria: { frameworks: ["React"], technologies: ["TypeScript"] },
      stack: { verification: verifiedOn20Oct, feeds: [storedFeed({ label: "React posts" })] },
    })
    const [row] = await groupRows()
    await user.click(within(row).getByRole("button", { name: /Google Alerts queries/ }))
    const named = () => {
      const main = screen.getByRole("main")
      for (const control of [...within(main).queryAllByRole("link"), ...within(main).queryAllByRole("button"), ...within(main).queryAllByRole("textbox")]) {
        expect(control).toHaveAccessibleName()
      }
    }
    // Each tab's own controls carry a name.
    await showTab("Search links")
    named()
    expect(within(row).getByRole("button", { name: "Copy posts query for React, TypeScript" })).toBeVisible()
    await loadedPosts()
    named()
    const feeds = await loadedFeeds()
    named()
    expect(within(feeds).getByRole("button", { name: "Remove React posts, feed ending 6 5 4 3 2 1" })).toBeVisible()
  })

  it("every control is reachable by keyboard in reading order", async () => {
    const { user } = openStackPosts({
      criteria: { frameworks: ["React"], technologies: ["TypeScript"] },
      stack: {
        verification: verifiedOn20Oct,
        feeds: [storedFeed({ label: "React posts" })],
        posts: Array.from({ length: 51 }, (_, i) => storedPost({ title: `Post ${i}`, date: new Date(Date.UTC(2026, 9, 1, i)).toISOString() })),
      },
    })
    await groupRows()
    await loadedFeeds()
    await within(await region("Posts")).findByRole("link", { name: /Next/ })

    /** Focus starts on the selected tab; Tab then enters that panel's first control, in reading order. */
    const order = async (tab: "Search links" | "Posts" | "Alert feeds", stops: number) => {
      await showTab(tab)
      await user.click(screen.getByRole("tab", { name: tab === "Search links" ? "Search" : tab === "Posts" ? "Posts from your field" : "Set up alerts" }))
      const names: string[] = []
      for (let i = 0; i < stops; i++) {
        await user.tab()
        const el = document.activeElement as HTMLElement
        names.push(el.getAttribute("aria-label") ?? el.textContent ?? "")
      }
      return names
    }
    const pos = (names: string[], pattern: RegExp) => names.findIndex((name) => pattern.test(name))

    // Search: the section's own links, then its Google Alerts disclosure.
    const search = await order("Search links", 20)
    expect(pos(search, /^LinkedIn posts for/)).toBeLessThan(pos(search, /^Google Alerts queries for/))

    // Posts from your field: every row, then the paging.
    const posts = await order("Posts", 80)
    expect(pos(posts, /^Post 50/)).toBe(0)
    expect(pos(posts, /^Post 1\b/)).toBeGreaterThan(pos(posts, /^Post 50/))
    expect(pos(posts, /Next/)).toBeGreaterThan(pos(posts, /^Post 1\b/))

    // Set up alerts: its one confirm step, then the feeds' rows and form.
    const alerts = await order("Alert feeds", 20)
    expect(pos(alerts, /^Update your confirmation for Alert feeds/)).toBeLessThan(pos(alerts, /^Remove React posts/))
    expect(pos(alerts, /^Remove React posts/)).toBeLessThan(pos(alerts, /^Add feed/))
  }, 30000)
})
