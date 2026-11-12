import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { JOB_POSTING_LINKS_PATH, STACK_POSTS_PATH } from "@eve/contracts"

import { HIRING_POSTS_PATH } from "@/shared/lib/hiring-contracts"
import {
  HFEED_A,
  ownRecord21Oct,
  server,
  storedFeed,
  storedPost,
  TEST_CSRF_TOKEN,
  verifiedOn20Oct,
  type StoredPost,
} from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { openHiringPosts as openHiring, pastes, showTab } from "./hiring-view-helpers"

/**
 * EPIC-0007 Phase 3 web: Hiring posts (design-spec r2 B4, H7) and Check this
 * job from a row (check-this-job.feature r4 CTJ:342 to CTJ:398). Test names
 * start with the Gherkin line (HP hiring-posts, CTJ check-this-job).
 */
const POST_1 = "https://www.linkedin.com/posts/acme_hiring-activity-7250000000000000001-aaaa"
const POST_2 = "https://www.linkedin.com/posts/beta_frontend-activity-7250000000000000002-bbbb"
const ROW_HELP = "Paste the employer's application link from this post, or add the job description. Eve doesn't open the post."
const LI_WARN =
  "Eve can't read LinkedIn, so this link will be saved as not supported. Paste the employer's application link if the post has one, or add the job description."
const GREENHOUSE = "https://boards.greenhouse.io/acme/jobs/4012345"
const POSTS_DESC =
  "LinkedIn posts and articles from your Hiring alert feeds, newest first. Eve hasn't vetted them. To check a job from one, use Check this job."

type StackState = NonNullable<NonNullable<Parameters<typeof openHiring>[0]>["stack"]>

const withRecord = (stack: StackState, path?: string) =>
  openHiring({ path, stack: { hiringVerification: ownRecord21Oct, ...stack } })

async function postsRegion() {
  const region = await screen.findByRole("region", { name: "Hiring posts" })
  await waitFor(() => expect(region.querySelector("ol:not([aria-hidden]), h3")).not.toBeNull())
  return region
}

const rows = (region: HTMLElement) => within(within(region).getAllByRole("list")[0]).getAllByRole("listitem")

function many(n: number, feedId: string | null = null): StoredPost[] {
  return Array.from({ length: n }, (_, i) =>
    storedPost({
      feedId,
      title: `Hiring post ${i + 1}`,
      canonicalUrl: `https://www.linkedin.com/posts/p-${i + 1}`,
      // Newest first: post 1 has the latest date.
      date: new Date(Date.UTC(2026, 9, 24) - i * 60_000).toISOString(),
      firstSeenAt: "2026-10-24T08:00:00.000Z",
    })
  )
}

describe("Hiring posts list (hiring-posts.feature, AC 7.4)", () => {
  it("HP:234 a row: title link, WAT date, technology, snippet, source label and the outline 'Not vetted' label", async () => {
    const feed = storedFeed({ url: HFEED_A, label: "Frontend hiring" })
    withRecord({
      hiringFeeds: [feed],
      hiringPosts: [
        storedPost({
          feedId: feed.id,
          canonicalUrl: POST_1,
          title: "We're hiring a frontend engineer",
          snippet: "Join our team building the web app.",
          date: "2026-10-24T08:30:00.000Z",
          matchedTechnologies: ["React"],
        }),
      ],
    })
    const region = await postsRegion()
    expect(within(region).getByText(POSTS_DESC)).toBeVisible()
    const [row] = rows(region)
    const link = within(row).getByRole("link", { name: /^We're hiring a frontend engineer/ })
    expect(link).toHaveAttribute("href", POST_1)
    // The Stack posts row format (design-spec r2 B4 wireframe "Posted 24 Oct 2026", C-SP-POSTED): the WAT
    // calendar date of 2026-10-24T08:30:00Z. The row shows no time (see frontend-spec, HP:234 note).
    expect(row).toHaveTextContent("Posted 24 Oct 2026")
    expect(within(row).getByText("React")).toBeVisible()
    expect(within(row).getByText("Join our team building the web app.")).toBeVisible()
    expect(within(row).getByText("from Frontend hiring")).toBeVisible()
    const label = within(row).getByText("Not vetted")
    expect(label.closest('[data-slot="badge"]')).toHaveAttribute("data-variant", "outline")
  })

  it("HP:245 the label is exactly 'Not vetted' and no row shows EPIC-0006 status wording", async () => {
    withRecord({ hiringFeeds: [storedFeed({ url: HFEED_A })], hiringPosts: many(3) })
    const region = await postsRegion()
    expect(within(region).getAllByText("Not vetted")).toHaveLength(3)
    expect(region).not.toHaveTextContent(/Not checked yet|Not checked|Unchecked|Waiting to be checked|Ranked|Skipped/)
  })

  it("HP:253 / HV:231 the title link opens in a new tab with rel noopener noreferrer", async () => {
    withRecord({ hiringPosts: [storedPost({ canonicalUrl: POST_1, title: "Hiring" })] })
    const [row] = rows(await postsRegion())
    const link = within(row).getByRole("link", { name: /^Hiring/ })
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
  })

  it("HP:75 untrusted title text is rendered literally, never as HTML", async () => {
    withRecord({ hiringPosts: [storedPost({ title: "<img src=x onerror=alert(1)>Hiring" })] })
    const region = await postsRegion()
    expect(within(region).getByText("<img src=x onerror=alert(1)>Hiring")).toBeVisible()
    expect(region.querySelector("img")).toBeNull()
  })

  it("HP:162 a post with no matched technology shows the Stack posts no-technology text", async () => {
    withRecord({ hiringPosts: [storedPost({ matchedTechnologies: [] })] })
    const [row] = rows(await postsRegion())
    expect(within(row).getByText("No listed technology in the snippet")).toBeVisible()
  })

  it("HP:259 a long snippet is clamped to 2 lines (line-clamp-2) and wraps", async () => {
    withRecord({ hiringPosts: [storedPost({ snippet: "a".repeat(1000) })] })
    const [row] = rows(await postsRegion())
    expect(within(row).getByText("a".repeat(1000))).toHaveClass("line-clamp-2")
  })

  /**
   * P3-B-2 layout guard (design-spec r2 B4 "Row line exception", D8: up to 7 lines at 375px). jsdom has no
   * layout, so this pins the structure that keeps the budget; the line counts were measured in Chromium
   * (frontend-fix.md). Below 1024px the badges stay on the title's line (no wrap); the meta is one inline
   * paragraph (not a flex row that breaks per part), so date, technologies and source share at most 2 lines;
   * the source drops its leading "·" below 1024px so no line starts with it.
   */
  it("P3-B-2 a worst-case row (2-line title, 6 technologies) keeps its badges with the title and its meta inline", async () => {
    const feed = storedFeed({ url: HFEED_A, label: "Frontend hiring" })
    withRecord({
      hiringFeeds: [feed],
      hiringPosts: [
        storedPost({
          feedId: feed.id,
          title: "We're hiring a Senior Frontend Engineer to lead our design system work across web and mobile (remote, EMEA)",
          matchedTechnologies: ["React", "TypeScript", "Next.js", "GraphQL", "Playwright", "AWS"],
          date: "2026-10-24T08:30:00.000Z",
        }),
        storedPost({ feedId: feed.id, title: "No tech", matchedTechnologies: [], date: "2026-10-23T00:00:00.000Z" }),
      ],
    })
    const region = await postsRegion()
    for (const row of rows(region)) {
      const title = within(row).getAllByRole("link")[0]
      expect(title).toHaveClass("line-clamp-2", "min-w-0")
      const titleRow = title.parentElement as HTMLElement
      expect(titleRow).toHaveClass("max-lg:flex-nowrap")
      const badges = within(row).getByText("Not vetted").closest('[data-slot="row-badges"]') as HTMLElement
      expect(badges.parentElement).toBe(titleRow)
      expect(badges).toHaveClass("max-lg:flex-nowrap")
      expect(within(badges).getByText(/^(Post|Article)$/)).toBeInTheDocument()

      const meta = row.querySelector('[data-slot="row-meta"]') as HTMLElement
      expect(meta.tagName).toBe("P")
      expect(meta).not.toHaveClass("flex")
      expect(meta).toHaveTextContent(/Posted \d+ \w+ 2026/)
      expect(meta).toHaveTextContent("from Frontend hiring")
      const sourceDot = within(meta).getByText("from Frontend hiring").querySelector('[aria-hidden="true"]')
      expect(sourceDot).toHaveTextContent("·")
      expect(sourceDot).toHaveClass("max-lg:hidden")
    }
    const [worst, noTech] = rows(region)
    expect(within(worst).getAllByText(/^(React|TypeScript|Next\.js|GraphQL)$/)).toHaveLength(4)
    expect(within(worst).getByText("+2")).toBeInTheDocument()
    expect(within(noTech).getByText("No listed technology in the snippet")).toBeVisible()
  })

  /**
   * P3-B-3 (design-spec r3 item 1): below 1024px the Hiring row meta is clamped to 2 lines, so a 60-character
   * source label cannot push the row past 7 lines (D8). The clamp is visual only: the full "from {label}" stays in
   * the DOM with no aria-label or title, and the parts stay in order (date, chips, source) so only the source is cut.
   */
  it("P3-B-3 a 60-character source label: meta clamped to 2 lines below 1024px, full label kept, order date, chips, source", async () => {
    const label = "L".repeat(60)
    const feed = storedFeed({ url: HFEED_A, label })
    withRecord({
      hiringFeeds: [feed],
      hiringPosts: [
        storedPost({
          feedId: feed.id,
          matchedTechnologies: ["React", "TypeScript", "Next.js", "GraphQL", "Playwright", "AWS"],
          date: "2026-10-24T08:30:00.000Z",
        }),
      ],
    })
    const [row] = rows(await postsRegion())
    const meta = row.querySelector('[data-slot="row-meta"]') as HTMLElement
    expect(meta).toHaveClass("max-lg:line-clamp-2")
    expect(meta).not.toHaveClass("line-clamp-2")
    expect(meta).not.toHaveAttribute("aria-label")
    expect(meta).not.toHaveAttribute("title")
    const source = within(meta).getByText(`from ${label}`)
    expect(source).not.toHaveAttribute("aria-label")
    expect(source).not.toHaveAttribute("title")
    expect(meta).toHaveTextContent(new RegExp(`^Posted \\d+ \\w+ 2026.*React.*GraphQL.*\\+2.*from ${label}$`))
  })

  it("HP:271 a post from a removed feed shows 'Removed feed'; an unlabelled feed shows 'Hiring alert feed …123456'", async () => {
    const unlabelled = storedFeed({ url: HFEED_A, label: null })
    withRecord({
      hiringFeeds: [unlabelled],
      hiringPosts: [storedPost({ feedId: null, title: "Old" }), storedPost({ feedId: unlabelled.id, title: "New", date: "2026-10-23T00:00:00.000Z" })],
    })
    const region = await postsRegion()
    expect(within(region).getByText("Removed feed")).toBeVisible()
    expect(within(region).getByText("from Hiring alert feed …123456")).toBeVisible()
  })

  it("HP:221 / HP:227 newest first by date, ties by first-seen", async () => {
    withRecord({
      hiringPosts: [
        storedPost({ title: "22 Oct", date: "2026-10-22T08:00:00.000Z" }),
        storedPost({ title: "24 Oct", date: "2026-10-24T08:00:00.000Z" }),
        storedPost({ title: "POST_1", canonicalUrl: POST_1, date: "2026-10-23T08:00:00.000Z", firstSeenAt: "2026-10-23T09:00:00.000Z" }),
        storedPost({ title: "POST_2", canonicalUrl: POST_2, date: "2026-10-23T08:00:00.000Z", firstSeenAt: "2026-10-23T10:00:00.000Z" }),
      ],
    })
    const region = await postsRegion()
    expect(rows(region).map((r) => r.getAttribute("aria-label"))).toEqual(["24 Oct", "POST_2", "POST_1", "22 Oct"])
  })

  it("HP:277 120 posts: 50 per page, 'Page 1 of 3' in 'Hiring posts pages', next/previous keep view=hiring", async () => {
    const { user, currentPath, stack } = withRecord({ hiringFeeds: [storedFeed({ url: HFEED_A })], hiringPosts: many(120) })
    let region = await postsRegion()
    expect(rows(region)).toHaveLength(50)
    const nav = within(region).getByRole("navigation", { name: "Hiring posts pages" })
    expect(within(nav).getByText("Page 1 of 3")).toBeVisible()
    expect(within(nav).getByRole("link", { name: "Previous" })).toHaveAttribute("aria-disabled", "true")
    expect(stack.requestsTo("GET", HIRING_POSTS_PATH).at(-1)?.path).toBe(`${HIRING_POSTS_PATH}?page=1`)

    await user.click(within(nav).getByRole("link", { name: "Next" }))
    await waitFor(() => expect(currentPath()).toBe("/find-jobs?view=hiring&page=2"))
    region = await screen.findByRole("region", { name: "Hiring posts" })
    await waitFor(() => expect(rows(region)[0]).toHaveAttribute("aria-label", "Hiring post 51"))
    expect(within(region).getByText("Page 2 of 3")).toBeVisible()
    expect(within(region).getByRole("link", { name: "Previous" })).not.toHaveAttribute("aria-disabled")

    await user.click(within(region).getByRole("link", { name: "Next" }))
    await waitFor(() => expect(rows(region)[0]).toHaveAttribute("aria-label", "Hiring post 101"))
    expect(rows(region)).toHaveLength(20)
    expect(within(region).getByRole("link", { name: "Next" })).toHaveAttribute("aria-disabled", "true")
    expect(currentPath()).toContain("view=hiring&page=3")
  })

  it("HP:289 exactly 50 posts: one page, no pagination", async () => {
    withRecord({ hiringPosts: many(50) })
    const region = await postsRegion()
    expect(rows(region)).toHaveLength(50)
    expect(within(region).queryByRole("navigation")).not.toBeInTheDocument()
  })

  it.each([
    ["0", "/find-jobs?view=hiring"],
    ["abc", "/find-jobs?view=hiring"],
    ["3", "/find-jobs?view=hiring&page=2"],
  ])("HP:315 page=%s is corrected (malformed to page 1, past the last to the last) and never errors", async (page, expected) => {
    const { currentPath } = withRecord({ hiringPosts: many(60) }, `/find-jobs?view=hiring&page=${page}`)
    await waitFor(() => expect(currentPath()).toBe(expected))
    const region = await postsRegion()
    expect(rows(region).length).toBeGreaterThan(0)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("HP:328 new posts stored while on page 2 appear only after reload (no polling)", async () => {
    const { stack } = withRecord({ hiringPosts: many(80) }, "/find-jobs?view=hiring&page=2")
    const region = await postsRegion()
    const before = rows(region).map((r) => r.getAttribute("aria-label"))
    const reads = stack.requestsTo("GET", HIRING_POSTS_PATH).length
    stack.state.hiringPosts.push(...many(5).map((p) => ({ ...p, id: crypto.randomUUID(), date: "2026-10-25T00:00:00.000Z" })))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rows(region).map((r) => r.getAttribute("aria-label"))).toEqual(before)
    expect(stack.requestsTo("GET", HIRING_POSTS_PATH)).toHaveLength(reads)
  })

  it("HP:348 R5: both lists share one page: posts from your field show Stack posts only, Hiring posts show Hiring posts only", async () => {
    const { stack } = withRecord({
      verification: verifiedOn20Oct,
      posts: [storedPost({ canonicalUrl: POST_2, title: "A Stack post" })],
      hiringPosts: [storedPost({ canonicalUrl: POST_1, title: "A Hiring post" })],
    })
    await showTab("Posts from your field")
    const stackPosts = await screen.findByRole("region", { name: "Posts from your field" })
    expect(await within(stackPosts).findByText("A Stack post")).toBeVisible()
    expect(within(stackPosts).queryByText("A Hiring post")).not.toBeInTheDocument()
    await showTab("Hiring posts")
    const region = await postsRegion()
    expect(await within(region).findByText("A Hiring post")).toBeVisible()
    expect(within(region).queryByText("A Stack post")).not.toBeInTheDocument()
    expect(stack.requestsTo("GET", STACK_POSTS_PATH).filter((r) => r.path.startsWith(`${STACK_POSTS_PATH}?`))).toHaveLength(1)
  })
})

describe("Hiring posts empty states (hiring-posts.feature, AC 7.5)", () => {
  it.each([
    ["the shared EPIC-0005 record is recorded", verifiedOn20Oct],
    ["the shared EPIC-0005 record is not recorded", null],
  ])("HP:357 / HP:388 no own record (%s): find.hiring.empty with 'Set up alerts'", async (_, shared) => {
    openHiring({ stack: { verification: shared } })
    const region = await postsRegion()
    expect(within(region).getByRole("heading", { name: "Hiring posts appear here once you set up job alerts. You can also use the Search tab." })).toBeVisible()
    expect(within(region).getByRole("link", { name: "Set up alerts" })).toHaveAttribute("href", "#set-up-alerts")
    expect(within(region).queryByText(POSTS_DESC)).not.toBeInTheDocument()
  })

  it("HP:373 'Set up alerts' opens that section and moves focus to its heading, where the one confirm step waits; the URL keeps view=hiring", async () => {
    const { user, currentPath } = openHiring({ path: "/find-jobs?view=hiring#hiring-posts" })
    const region = await postsRegion()
    await user.click(within(region).getByRole("link", { name: "Set up alerts" }))
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Set up alerts" })).toHaveFocus())
    expect(await screen.findByRole("button", { name: "I confirm" })).toBeVisible()
    // The tab click and the in-page link leave the URL as it arrived.
    expect(currentPath()).toBe("/find-jobs?view=hiring#hiring-posts")
  })

  it("HP:395 own record, no feeds: find.hiring.empty with one action, 'Set up alerts'", async () => {
    const { user } = withRecord({})
    const region = await postsRegion()
    expect(within(region).getByRole("heading", { name: "Hiring posts appear here once you set up job alerts. You can also use the Search tab." })).toBeVisible()
    await user.click(within(region).getByRole("link", { name: "Set up alerts" }))
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Set up alerts" })).toHaveFocus())
  })

  it("HP:424 with only Other targeted the no-feeds action is still Set up alerts, and Hiring search links shows its own next step", async () => {
    const { user } = openHiring({ criteria: { targetRoleFamilies: ["other"] }, stack: { hiringVerification: ownRecord21Oct } })
    const region = await postsRegion()
    await user.click(within(region).getByRole("link", { name: "Set up alerts" }))
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Set up alerts" })).toHaveFocus())
    await showTab("Search")
    const links = screen.getByRole("region", { name: "Hiring search links" })
    expect(within(links).getByText("No role family to search for")).toBeVisible()
    expect(within(links).getByRole("link", { name: "Choose role families" })).toBeVisible()
  })

  it("HP:403 feeds but no posts: 'No Hiring posts yet' with the schedule, no action", async () => {
    withRecord({ hiringFeeds: [storedFeed({ url: HFEED_A })] })
    const region = await postsRegion()
    expect(within(region).getByRole("heading", { name: "No Hiring posts yet" })).toBeVisible()
    expect(
      within(region).getByText(
        "Eve reads your Hiring alert feeds at 02:00, 08:00, 14:00 and 20:00 WAT and keeps only LinkedIn posts and articles."
      )
    ).toBeVisible()
    expect(within(region).queryByRole("link")).not.toBeInTheDocument()
  })

  it("HP:410 posts from removed feeds are listed with no empty state when no feed is registered", async () => {
    withRecord({ hiringPosts: many(2) })
    const region = await postsRegion()
    expect(rows(region)).toHaveLength(2)
    expect(within(region).queryAllByRole("heading", { level: 3 })).toEqual([])
  })

  it("HP:417 exactly one empty state: no own record wins over a fixture feed", async () => {
    openHiring({ stack: { hiringFeeds: [storedFeed({ url: HFEED_A })] } })
    const region = await postsRegion()
    expect(within(region).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Hiring posts appear here once you set up job alerts. You can also use the Search tab.",
    ])
  })
})

describe("Check this job from a Hiring post row (check-this-job.feature, AC 8.1, 8.2)", () => {
  const titled = (title: string, extra: Partial<StoredPost> = {}) => storedPost({ title, canonicalUrl: POST_1, ...extra })

  async function openRow(user: ReturnType<typeof openHiring>["user"], title: string) {
    const region = await postsRegion()
    const row = within(region).getByRole("listitem", { name: title })
    const toggle = within(row).getByRole("button", { name: `Check this job from ${title}` })
    await user.click(toggle)
    return { region, row, toggle, field: await within(row).findByRole("textbox", { name: `Application link for ${title}` }) }
  }

  it("CTJ:342 the row button (outline, aria-expanded) opens an empty field named for the post, with the helper, focused", async () => {
    const { user } = withRecord({ hiringPosts: [titled("We're hiring a frontend engineer")] })
    const region = await postsRegion()
    const toggle = within(region).getByRole("button", { name: "Check this job from We're hiring a frontend engineer" })
    expect(toggle).toHaveTextContent(/^Check this job$/)
    expect(toggle).toHaveClass("border-border", "bg-background")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    const { row, field } = await openRow(user, "We're hiring a frontend engineer")
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).toContainElement(field)
    expect(field).toHaveValue("")
    expect(within(row).getByText(ROW_HELP)).toBeVisible()
    expect(field).toHaveAccessibleDescription(ROW_HELP)
    await waitFor(() => expect(field).toHaveFocus())
    expect(within(row).getByRole("button", { name: "Check link" })).toHaveClass("border-border", "bg-background")
  })

  it("CTJ:352 opening the row field sends no request and holds no URL from the post", async () => {
    const { user, stack, discovery } = withRecord({ hiringPosts: [titled("Hiring")] })
    await postsRegion()
    const before = stack.requests.length + discovery.requests.length
    const { field } = await openRow(user, "Hiring")
    expect(field).toHaveValue("")
    expect(stack.requests.length + discovery.requests.length).toBe(before)
  })

  it("CTJ:360 / CTJ:390 submitting from a row sends only { url } with the CSRF header and shows the result in that row", async () => {
    const { user, discovery, stack } = withRecord({ hiringPosts: [titled("We're hiring", { matchedTechnologies: ["React"] })] })
    const headers: string[] = []
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname === JOB_POSTING_LINKS_PATH) headers.push(request.headers.get("x-csrf-token") ?? "")
    })
    const { row, field } = await openRow(user, "We're hiring")
    await user.type(field, GREENHOUSE)
    await user.click(within(row).getByRole("button", { name: "Check link" }))
    expect(await within(row).findByText("Job Posting saved.")).toBeVisible()
    expect(within(row).getByRole("link", { name: "View it" })).toHaveAttribute("href", expect.stringMatching(/^\/postings\//))
    server.events.removeAllListeners()
    expect(pastes(discovery)).toEqual([{ method: "POST", path: JOB_POSTING_LINKS_PATH, body: { url: GREENHOUSE } }])
    expect(headers).toEqual([TEST_CSRF_TOKEN])
    // The Hiring post is not written to and nothing links it to the posting (CTJ:390).
    expect(stack.requests.filter((r) => r.method !== "GET")).toEqual([])
    expect(within(row).getByText("Not vetted")).toBeVisible()
    expect(within(row).getByText("React")).toBeVisible()
    expect(
      await findToast("Checking the link. It goes through the same Eligibility, Match, duplicate and cap rules as discovered postings.")
    ).toBeInTheDocument()
  })

  it("CTJ:377 a linkedin.com URL shows C-HP-LI-WARN in that row and sends nothing until 'Save it anyway'", async () => {
    const { user, discovery } = withRecord({ hiringPosts: [titled("Hiring")] })
    const { row, field } = await openRow(user, "Hiring")
    await user.type(field, POST_1)
    await user.click(within(row).getByRole("button", { name: "Check link" }))
    expect(await within(row).findByText(LI_WARN)).toBeVisible()
    expect(pastes(discovery)).toEqual([])
    await user.click(within(row).getByRole("button", { name: "Save it anyway" }))
    await waitFor(() => expect(pastes(discovery)).toHaveLength(1))
  })

  it("CTJ:384 an empty row field shows the existing job_link_empty error", async () => {
    const { user, discovery } = withRecord({ hiringPosts: [titled("Hiring")] })
    const { row } = await openRow(user, "Hiring")
    await user.click(within(row).getByRole("button", { name: "Check link" }))
    expect(await within(row).findByText("Paste a job link.")).toBeVisible()
    expect(pastes(discovery)).toEqual([])
  })

  it("CTJ:398 opening the second row leaves the others closed; opening another discards the first panel's value", async () => {
    const { user } = withRecord({
      hiringPosts: [
        titled("First", { date: "2026-10-24T03:00:00.000Z", canonicalUrl: "https://www.linkedin.com/posts/1" }),
        titled("Second", { date: "2026-10-24T02:00:00.000Z", canonicalUrl: "https://www.linkedin.com/posts/2" }),
        titled("Third", { date: "2026-10-24T01:00:00.000Z", canonicalUrl: "https://www.linkedin.com/posts/3" }),
      ],
    })
    const second = await openRow(user, "Second")
    await user.type(second.field, "https://typed.example/x")
    const region = await postsRegion()
    expect(within(region).getAllByRole("textbox")).toHaveLength(1)
    await user.click(within(region).getByRole("button", { name: "Check this job from First" }))
    expect(within(region).getAllByRole("textbox")).toHaveLength(1)
    await user.click(within(region).getByRole("button", { name: "Check this job from Second" }))
    expect(within(region).getByRole("textbox", { name: "Application link for Second" })).toHaveValue("")
  })

  it("H7 step 5: Close and Escape close the panel and return focus to the row button", async () => {
    const { user } = withRecord({ hiringPosts: [titled("Hiring")] })
    const opened = await openRow(user, "Hiring")
    await user.click(within(opened.row).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(opened.toggle).toHaveFocus())
    expect(within(opened.row).queryByRole("textbox")).not.toBeInTheDocument()
    expect(opened.toggle).toHaveAttribute("aria-expanded", "false")

    await user.click(opened.toggle)
    await within(opened.row).findByRole("textbox")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(opened.toggle).toHaveFocus())
    expect(within(opened.row).queryByRole("textbox")).not.toBeInTheDocument()
  })
})
