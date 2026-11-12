import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { STACK_POSTS_PATH } from "@eve/contracts"

import { FEED_A, storedFeed, storedPost, verifiedOn20Oct, type StoredPost } from "@/shared/testing"
import { loadedPosts, openStackPosts, postTitles } from "./stack-posts-helpers"
import { renderApp } from "./test-app"

const many = (count: number): StoredPost[] =>
  Array.from({ length: count }, (_, i) =>
    storedPost({
      title: `Post ${String(count - i).padStart(4, "0")}`,
      date: new Date(Date.UTC(2026, 0, 1) + (count - i) * 60_000).toISOString(),
      canonicalUrl: `https://www.linkedin.com/posts/p-${i}`,
    })
  )

describe("Posts list (posts-list.feature)", () => {
  it("@ac-7.1 newest first by published date; ties broken by first seen; undated sorts by first seen", async () => {
    openStackPosts({
      stack: {
        verification: verifiedOn20Oct,
        posts: [
          storedPost({ title: "Hooks in practice", date: "2026-10-18T09:00:00.000Z", firstSeenAt: "2026-10-21T07:00:00.000Z" }),
          storedPost({ title: "RSC deep dive", date: "2026-10-20T09:00:00.000Z", firstSeenAt: "2026-10-20T13:00:00.000Z" }),
          storedPost({ title: "TypeScript at scale", date: "2026-10-19T09:00:00.000Z", firstSeenAt: "2026-10-20T13:00:00.000Z" }),
          storedPost({ title: "Later", date: "2026-10-20T09:00:00.000Z", firstSeenAt: "2026-10-21T01:00:00.000Z" }),
          storedPost({ title: "Undated post", date: "2026-10-21T07:00:00.000Z", dateKind: "found", firstSeenAt: "2026-10-21T07:00:00.000Z" }),
        ],
      },
    })
    const posts = await loadedPosts()
    expect(postTitles(posts)).toEqual(["Undated post", "Later", "RSC deep dive", "TypeScript at scale", "Hooks in practice"])
    expect(within(posts).getByText("Posts by people who work with the tools you use. They are not job listings.")).toBeVisible()
  })

  it("@ac-7.2 a row shows title link, kind, snippet, WAT date, matched technologies and source", async () => {
    const feed = storedFeed({ url: FEED_A, label: "React posts" })
    openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: [feed], posts: [storedPost({ feedId: feed.id })] } })
    const row = within(await loadedPosts()).getByRole("listitem", { name: "Hooks in practice" })
    const link = within(row).getByRole("link", { name: "Hooks in practice (opens in a new tab)" })
    expect(link).toHaveAttribute("href", "https://www.linkedin.com/posts/ada-obi_react-activity-1-abcd")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
    expect(within(row).getByText("Post")).toBeVisible()
    expect(within(row).getByText("What we learned moving a large app to React hooks and TypeScript.")).toBeVisible()
    expect(within(row).getByText("Posted 21 Oct 2026")).toBeVisible()
    expect(within(row).getByText("React")).toBeVisible()
    expect(within(row).getByText("TypeScript")).toBeVisible()
    expect(within(row).getByText("Mentions:")).toHaveClass("sr-only")
    expect(within(row).getByText("from React posts")).toBeVisible()
  })

  it("@ac-7.2 an article row shows Article; a Found date; no technology; removed feed; unlabelled feed source", async () => {
    const unlabelled = storedFeed({ url: FEED_A, label: null })
    openStackPosts({
      stack: {
        verification: verifiedOn20Oct,
        feeds: [unlabelled],
        posts: [
          storedPost({
            title: "Why we moved to Next.js",
            kind: "article",
            canonicalUrl: "https://www.linkedin.com/pulse/why-we-moved-to-nextjs-ada-obi",
            dateKind: "found",
            date: "2026-10-21T07:00:00.000Z",
            matchedTechnologies: [],
            feedId: null,
          }),
          storedPost({ title: "From an unlabelled feed", date: "2026-10-01T07:00:00.000Z", feedId: unlabelled.id }),
        ],
      },
    })
    const posts = await loadedPosts()
    const article = within(posts).getByRole("listitem", { name: "Why we moved to Next.js" })
    expect(within(article).getByText("Article")).toBeVisible()
    expect(within(article).getByText("Found 21 Oct 2026")).toBeVisible()
    expect(within(article).getByText("No listed technology in the snippet")).toBeVisible()
    expect(within(article).getByText("Removed feed")).toBeVisible()
    const fromUnlabelled = within(posts).getByRole("listitem", { name: "From an unlabelled feed" })
    expect(within(fromUnlabelled).getByText("from Alert feed …654321")).toBeVisible()
  })

  it("@ac-5.5 @ac-7.2 untitled posts get the untitled link text; empty snippet omits the line; text renders as text, not HTML", async () => {
    openStackPosts({
      stack: {
        verification: verifiedOn20Oct,
        posts: [
          storedPost({ title: "", snippet: "", kind: "post", date: "2026-10-21T07:00:00.000Z", canonicalUrl: "https://www.linkedin.com/posts/ada-obi_x-1" }),
          storedPost({
            title: "",
            snippet: "",
            kind: "article",
            date: "2026-10-20T07:00:00.000Z",
            canonicalUrl: "https://www.linkedin.com/pulse/why-we-moved-ada-obi",
          }),
          storedPost({ title: "<img src=x onerror=alert(1)>", snippet: "<b>bold</b> & more", date: "2026-10-19T07:00:00.000Z" }),
        ],
      },
    })
    const posts = await loadedPosts()
    // r3 (D-E5-10): final copy, muted, pointing to the canonical URL.
    for (const [name, url] of [
      ["Untitled LinkedIn post (opens in a new tab)", "https://www.linkedin.com/posts/ada-obi_x-1"],
      ["Untitled LinkedIn article (opens in a new tab)", "https://www.linkedin.com/pulse/why-we-moved-ada-obi"],
    ]) {
      const link = within(posts).getByRole("link", { name })
      expect(link).toBeVisible()
      expect(link).toHaveAttribute("href", url)
      expect(link).toHaveClass("text-muted-foreground")
    }
    const untitled = within(posts).getByRole("listitem", { name: "Untitled LinkedIn post" })
    expect(untitled.querySelectorAll("p")).toHaveLength(1)
    expect(within(posts).getByText("<img src=x onerror=alert(1)>")).toBeVisible()
    expect(within(posts).getByText("<b>bold</b> & more")).toBeVisible()
    expect(posts.querySelector("img, b")).toBeNull()
  })

  it("@ac-7.2 a long snippet is clamped to 2 lines with the full text in the row", async () => {
    const snippet = "x".repeat(1000)
    openStackPosts({ stack: { verification: verifiedOn20Oct, posts: [storedPost({ snippet })] } })
    const posts = await loadedPosts()
    const paragraph = within(posts).getByText(snippet)
    expect(paragraph).toHaveClass("line-clamp-2")
    expect(paragraph.textContent).toHaveLength(1000)
  })

  it("design-review N-2: each meta separator wraps with the item after it, never standing alone at a line end", async () => {
    const feed = storedFeed({ url: FEED_A, label: "React posts" })
    openStackPosts({
      stack: {
        verification: verifiedOn20Oct,
        feeds: [feed],
        posts: [storedPost({ feedId: feed.id }), storedPost({ title: "No tech", matchedTechnologies: [], date: "2026-10-01T07:00:00.000Z" })],
      },
    })
    const posts = await loadedPosts()
    for (const row of within(posts).getAllByRole("listitem")) {
      const meta = within(row).getByText(/^(Posted|Found) /).closest("p")
      expect(meta).not.toBeNull()
      const items = Array.from(meta?.children ?? [])
      expect(items.map((item) => item.textContent?.trim())).not.toContain("·")
      expect(items).toHaveLength(3)
      for (const item of items.slice(1)) expect(item.firstElementChild).toHaveTextContent(/^·$/)
    }
  })

  it("more than 4 technologies show 4 chips then +n, read as 'and n more'", async () => {
    openStackPosts({
      stack: { verification: verifiedOn20Oct, posts: [storedPost({ matchedTechnologies: ["A1", "B2", "C3", "D4", "E5", "F6"] })] },
    })
    const row = within(await loadedPosts()).getByRole("listitem")
    expect(within(row).getByText("D4")).toBeVisible()
    expect(within(row).queryByText("E5")).not.toBeInTheDocument()
    expect(within(row).getByText("+2")).toBeVisible()
    expect(within(row).getByText("and 2 more")).toHaveClass("sr-only")
  })

  it.each([
    [1, 1, false],
    [49, 49, false],
    [50, 50, false],
    [51, 50, true],
  ])("@ac-7.1 %i posts: the first page lists %i, next available: %s", async (count, first, next) => {
    openStackPosts({ stack: { verification: verifiedOn20Oct, posts: many(count) } })
    const posts = await loadedPosts()
    expect(within(posts).getAllByRole("listitem")).toHaveLength(first)
    if (count <= 50) {
      expect(within(posts).queryByRole("navigation")).not.toBeInTheDocument()
      return
    }
    const nav = within(posts).getByRole("navigation", { name: "Posts pages" })
    expect(within(nav).getByText("Page 1 of 2")).toBeVisible()
    expect(within(nav).getByRole("link", { name: "Previous" })).toHaveAttribute("aria-disabled", "true")
    expect(within(nav).getByRole("link", { name: "Next" })).not.toHaveAttribute("aria-disabled")
    expect(next).toBe(true)
  })

  it("@ac-7.1 next continues the order (?page=2), focus moves to Posts; previous returns", async () => {
    const { user, currentPath, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct, posts: many(51) } })
    const posts = await loadedPosts()
    await user.click(within(posts).getByRole("link", { name: "Next" }))
    await waitFor(() => expect(postTitles(posts)).toEqual(["Post 0001"]))
    expect(currentPath()).toBe("/find-jobs?spage=2")
    await waitFor(() => expect(within(posts).getByRole("heading", { name: "Posts from your field" })).toHaveFocus())
    const nav = within(posts).getByRole("navigation")
    expect(within(nav).getByText("Page 2 of 2")).toBeVisible()
    expect(within(nav).getByRole("link", { name: "Next" })).toHaveAttribute("aria-disabled", "true")
    expect(stack.requestsTo("GET", `${STACK_POSTS_PATH}?page=2`)).toHaveLength(1)

    await user.click(within(nav).getByRole("link", { name: "Previous" }))
    await waitFor(() => expect(within(posts).getAllByRole("listitem")).toHaveLength(50))
    expect(postTitles(posts)[0]).toBe("Post 0051")
    expect(currentPath()).toBe("/find-jobs")
  })

  it("DR-E5-01 enabled and disabled page controls both keep the outline button border", async () => {
    openStackPosts({ path: "/find-jobs?spage=2", stack: { verification: verifiedOn20Oct, posts: many(101) } })
    const nav = within(await loadedPosts()).getByRole("navigation", { name: "Posts pages" })
    await within(nav).findByText("Page 2 of 3")
    for (const name of ["Previous", "Next"]) {
      const link = within(nav).getByRole("link", { name })
      expect(link).not.toHaveAttribute("aria-disabled")
      expect(link).toHaveClass("border-border")
      expect(link).not.toHaveClass("border-transparent")
    }
  })

  it("DR-E5-01 a disabled page control keeps the outline button border", async () => {
    openStackPosts({ stack: { verification: verifiedOn20Oct, posts: many(51) } })
    const nav = within(await loadedPosts()).getByRole("navigation", { name: "Posts pages" })
    const prev = within(nav).getByRole("link", { name: "Previous" })
    expect(prev).toHaveAttribute("aria-disabled", "true")
    expect(prev).toHaveClass("border-border")
    expect(prev).not.toHaveClass("border-transparent")
  })

  it("@ac-7.1 new posts stored while page 2 is open appear only after reload (posts-list.feature)", async () => {
    const view = openStackPosts({ path: "/find-jobs?spage=2", stack: { verification: verifiedOn20Oct, posts: many(60) } })
    const posts = await loadedPosts()
    await waitFor(() => expect(postTitles(posts)).toHaveLength(10))
    const before = postTitles(posts)
    expect(before[0]).toBe("Post 0010")
    const reads = view.stack.requestsTo("GET", `${STACK_POSTS_PATH}?page=2`).length

    // A scheduled read stores 3 newer posts while page 2 is on screen.
    view.stack.state.posts.push(
      ...["New A", "New B", "New C"].map((title, i) =>
        storedPost({ title, date: new Date(Date.UTC(2026, 5, 1) + i * 60_000).toISOString(), canonicalUrl: `https://www.linkedin.com/posts/new-${i}` })
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(postTitles(posts)).toEqual(before)
    expect(within(posts).getByText("Page 2 of 2")).toBeVisible()
    expect(view.stack.requestsTo("GET", `${STACK_POSTS_PATH}?page=2`)).toHaveLength(reads)

    view.unmount()
    renderApp("/find-jobs?spage=2")
    const reloaded = await loadedPosts()
    await waitFor(() => expect(postTitles(reloaded)).toHaveLength(13))
    expect(postTitles(reloaded)[0]).toBe("Post 0013")
    expect(postTitles(reloaded)).not.toContain("New A")
  }, 15000)

  it("@ac-7.1 the last of 2,000 posts is reachable on page 40", async () => {
    openStackPosts({ path: "/find-jobs?spage=40", stack: { verification: verifiedOn20Oct, posts: many(2000) } })
    const posts = await loadedPosts()
    expect(within(posts).getAllByRole("listitem")).toHaveLength(50)
    expect(within(posts).getByText("Page 40 of 40")).toBeVisible()
    expect(within(posts).getByRole("link", { name: "Next" })).toHaveAttribute("aria-disabled", "true")
    expect(postTitles(posts).at(-1)).toBe("Post 0001")
  })

  it.each([
    ["/find-jobs?spage=abc", "/find-jobs"],
    ["/find-jobs?spage=-1", "/find-jobs"],
    ["/find-jobs?spage=0", "/find-jobs"],
    ["/find-jobs?spage=01", "/find-jobs"],
    ["/find-jobs?spage=999", "/find-jobs?spage=2"],
  ])("a stale or invalid %s is normalised to %s before or after the totals arrive", async (path, expected) => {
    const { currentPath, stack } = openStackPosts({ path, stack: { verification: verifiedOn20Oct, posts: many(60) } })
    const posts = await loadedPosts()
    await waitFor(() => expect(currentPath()).toBe(expected))
    await waitFor(() => expect(within(posts).getAllByRole("listitem").length).toBeGreaterThan(0))
    expect(stack.requestsTo("GET", `${STACK_POSTS_PATH}?`).length).toBeGreaterThan(0)
    for (const request of stack.requestsTo("GET", `${STACK_POSTS_PATH}?`)) {
      expect(request.path).toMatch(/\?page=[1-9]\d*$/)
    }
  })

  it("@ac-7.3 confirmed, no feeds, no posts: exactly one empty state, find.stack.empty with Set up alerts", async () => {
    openStackPosts({ stack: { verification: verifiedOn20Oct } })
    const posts = await loadedPosts()
    expect(within(posts).getByText("Posts from your field appear here once you set up job alerts.")).toBeVisible()
    expect(within(posts).getByRole("link", { name: "Set up alerts" })).toBeVisible()
    expect(within(posts).queryByText("Posts start after verification")).not.toBeInTheDocument()
    expect(within(posts).queryByText("No posts yet")).not.toBeInTheDocument()
    expect(within(posts).getAllByRole("heading", { level: 3 })).toHaveLength(1)
  })

  it("@ac-7.3 feeds registered, no posts yet: the waiting empty state", async () => {
    openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: [storedFeed()] } })
    const posts = await loadedPosts()
    expect(within(posts).getByText("No posts yet")).toBeVisible()
    expect(
      within(posts).getByText("Eve reads your feeds at 02:00, 08:00, 14:00 and 20:00 WAT and keeps only LinkedIn posts and articles.")
    ).toBeVisible()
  })

  it("@ac-7.3 @ac-4.8 posts from removed feeds are still listed with no feed registered", async () => {
    openStackPosts({ stack: { verification: verifiedOn20Oct, posts: [storedPost({ title: "A" }), storedPost({ title: "B" })] } })
    const posts = await loadedPosts()
    expect(within(posts).getAllByRole("listitem")).toHaveLength(2)
    expect(within(posts).queryByRole("heading", { level: 3 })).not.toBeInTheDocument()
    expect(within(posts).getAllByText("Removed feed")).toHaveLength(2)
  })

  it("@ac-7.4 the posts list never shows a full feed URL", async () => {
    const feed = storedFeed({ url: FEED_A, label: null })
    openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: [feed], posts: [storedPost({ feedId: feed.id })] } })
    await loadedPosts()
    expect(document.body.innerHTML).not.toContain("01234567890123456789/9876543210987654321")
  })

  it("@ac-9.1 a post row links only to its LinkedIn URL, never to an Eve action", async () => {
    openStackPosts({ stack: { verification: verifiedOn20Oct, posts: [storedPost()] } })
    const row = within(await loadedPosts()).getByRole("listitem")
    expect(within(row).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "https://www.linkedin.com/posts/ada-obi_react-activity-1-abcd",
    ])
    expect(within(row).queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 1, name: "Find jobs" })).toBeVisible()
  })
})
