import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { describe, expect, it, vi } from "vitest"
import {
  ALERT_FEEDS_PATH,
  JOB_CRITERIA_PATH,
  JOB_POSTING_LINKS_PATH,
  STACK_POSTS_PATH,
} from "@eve/contracts"

import {
  apiErrorResponse,
  expiredSession,
  noSession,
  rankedPosting,
  server,
  TEST_CSRF_TOKEN,
} from "@/shared/testing"
import { HIRING_SEARCH_INPUTS_PATH } from "@/shared/lib/hiring-contracts"
import { findToast } from "./career-setup-helpers"
import {
  applicationLink,
  checkLink,
  checkRegion,
  openHiring,
  pastes,
  openHiringFeeds,
} from "./hiring-view-helpers"
import { renderApp } from "./test-app"

/** Focus moves from the selected tab through that panel's controls; the targets never reached are returned. */
async function unreachedAfterTabbing(
  user: ReturnType<typeof userEvent.setup>,
  targets: readonly HTMLElement[],
  stops: number
): Promise<HTMLElement[]> {
  const reached = new Set<Element>()
  for (let stop = 0; stop < stops && reached.size < targets.length; stop++) {
    await user.tab()
    const active = document.activeElement
    if (active && targets.includes(active as HTMLElement)) reached.add(active)
  }
  return targets.filter((target) => !reached.has(target))
}

/** Deck strings (copy-deck.r1.md), quoted so a copy change fails here. */
const HELP_SOLO =
  "Eve can't check pay, hours or sponsorship in a LinkedIn post. Paste the employer's application link from the post, not the post link. No link? Add the job description. Eve checks that job with your usual rules."
const HELP_WITH_HINT =
  "Paste the employer's application link from the post, not the LinkedIn post link. No link? Add the job description. Eve checks that job with your usual rules."
const LI_WARN =
  "Eve can't read LinkedIn, so this link will be saved as not supported. Paste the employer's application link if the post has one, or add the job description."
const LINK_ACCEPTED =
  "Checking the link. It goes through the same Eligibility, Match, duplicate and cap rules as discovered postings."
const ERR_2 = "Couldn't check the link. Nothing changed. Try again."
const GREENHOUSE = "https://boards.greenhouse.io/acme/jobs/4012345"

describe("Hiring view frame (hiring-view.feature, Phase 2)", () => {
  it.each(["", "stack", "jobs", "HIRING", "hiring%20", "%3Cscript%3Ex%3C%2Fscript%3E"])(
    "HV:71 R5: view=%j is an old query value: Find jobs opens on Search with its own four tabs, no error",
    async (value) => {
      openHiring({ path: `/find-jobs?view=${value}` })
      expect(await screen.findByRole("region", { name: "Search links" })).toBeVisible()
      expect(screen.getByRole("region", { name: "Check this job" })).toBeVisible()
      // No view tabs of the old Hiring view; the tablist on screen is Find jobs' own four.
      expect(screen.getByRole("tab", { name: "Search" })).toHaveAttribute("aria-selected", "true")
      expect(screen.getAllByRole("tab")).toHaveLength(4)
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    }
  )

  it("HV:104 @ac-1.2 R5: the tabs in order, each holding its sections: Search (Hiring search links, Check this job, Search links), Hiring posts, Posts from your field, Set up alerts (inside it, Hiring alert feeds)", async () => {
    const { user } = openHiringFeeds({ criteria: { frameworks: ["React"] } })
    await screen.findByRole("heading", { name: "Hiring alert feeds" })
    const tabs = within(screen.getByRole("tablist", { name: "Find jobs" })).getAllByRole("tab")
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Search", "Hiring posts", "Posts from your field", "Set up alerts"])
    const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "")
    // The hash selects Set up alerts; each tab then shows its own sections in order.
    expect(headings()).toEqual(["Set up alerts", "Alert feeds", "Hiring alert feeds"])
    await user.click(screen.getByRole("tab", { name: "Search" }))
    await screen.findByRole("link", { name: /^LinkedIn posts for/ })
    expect(headings()).toEqual(["Hiring search links", "Check this job", "Search links"])
    await user.click(screen.getByRole("tab", { name: "Hiring posts" }))
    expect(headings()).toEqual(["Hiring posts"])
    await user.click(screen.getByRole("tab", { name: "Posts from your field" }))
    expect(headings()).toEqual(["Posts from your field"])
    expect(document.body).not.toHaveTextContent(/coming soon/i)
  })

  it("HV:113 @ac-1.3 a visitor without a session is sent to sign-in and no Hiring view data is shown", async () => {
    server.use(noSession)
    const api = vi.fn()
    server.use(
      http.get(ALERT_FEEDS_PATH, api),
      http.get(STACK_POSTS_PATH, api),
      http.get(JOB_CRITERIA_PATH, api)
    )
    const { currentPath } = renderApp("/stack-posts?view=hiring")
    await waitFor(() =>
      expect(currentPath()).toBe("/sign-in?next=%2Fstack-posts%3Fview%3Dhiring")
    )
    expect(
      screen.queryByRole("region", { name: "Check this job" })
    ).not.toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
  })

  it("HV:120 @ac-1.3 an expired session goes to sign-in and returns to the Hiring view", async () => {
    server.use(expiredSession)
    const { currentPath } = renderApp("/stack-posts?view=hiring")
    await waitFor(() =>
      expect(currentPath()).toBe(
        "/sign-in?next=%2Fstack-posts%3Fview%3Dhiring&reason=expired"
      )
    )
  })

  it("HV:191 / HV:198 @ac-1.3 every control has an accessible name and the check form is keyboard reachable", async () => {
    const { user } = openHiring()
    const region = await checkRegion()
    const opener = within(region).getByRole("button", { name: "Check this job" })
    opener.focus()
    expect(opener).toHaveFocus()
    await user.keyboard("{Enter}")
    const dialog = await screen.findByRole("dialog", { name: "Check this job" })
    const field = within(dialog).getByRole("textbox", { name: "Application link" })
    await waitFor(() => expect(field).toHaveFocus())
    await user.tab()
    expect(within(dialog).getByRole("button", { name: "Check link" })).toHaveFocus()
    for (const control of [...within(dialog).getAllByRole("textbox"), ...within(dialog).getAllByRole("button")]) {
      expect(control).toHaveAccessibleName()
    }
  })

})

describe("Check this job (check-this-job.feature, Phase 2)", () => {
  it("CTJ:29 @ac-5.1 one URL field 'Application link', one submit 'Check link', and the solo help text (no C-HP-HINT on screen)", async () => {
    // With Phase 1 shipped, SOLO is the help whenever the hint note is not rendered: here the no-family state.
    openHiring({ criteria: { targetRoleFamilies: ["other"] } })
    await screen.findByText("No role family to search for")
    const region = await checkRegion()
    // The section keeps its heading, one help line and one button that opens the form.
    expect(within(region).getByText(HELP_SOLO)).toBeVisible()
    expect(within(region).queryAllByRole("textbox")).toHaveLength(0)
    expect(within(region).getAllByRole("button").map((b) => b.textContent)).toEqual(["Check this job"])
    expect(region.querySelector("#check-this-job")).toBeNull()
    expect(region).toHaveAttribute("id", "check-this-job")
    const field = await applicationLink()
    const dialog = await screen.findByRole("dialog", { name: "Check this job" })
    expect(within(dialog).getAllByRole("textbox")).toHaveLength(1)
    expect(field).toHaveAttribute("type", "url")
    expect(field).toHaveAttribute("placeholder", "https://")
    expect(
      within(dialog).getByRole("button", { name: "Check link" })
    ).toBeVisible()
    expect(field).toHaveAccessibleDescription(HELP_SOLO)
    expect(screen.queryByText(HELP_WITH_HINT)).not.toBeInTheDocument()
  })

  it("CTJ:35 / CTJ:44 @ac-5.2 sends only { url } with the CSRF header to the existing paste endpoint", async () => {
    const { user, discovery } = openHiring()
    const headers: string[] = []
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname === JOB_POSTING_LINKS_PATH)
        headers.push(request.headers.get("x-csrf-token") ?? "")
    })
    await user.type(
      await applicationLink(),
      "https://jobs.lever.co/acme/7f3c2a10-1111-2222-3333-444455556666"
    )
    await user.click(checkLink())
    await waitFor(() => expect(pastes(discovery)).toHaveLength(1))
    server.events.removeAllListeners()
    expect(pastes(discovery)).toEqual([
      {
        method: "POST",
        path: "/v1/job-postings/links",
        body: {
          url: "https://jobs.lever.co/acme/7f3c2a10-1111-2222-3333-444455556666",
        },
      },
    ])
    expect(headers).toEqual([TEST_CSRF_TOKEN])
  })

  it("CTJ:50 @ac-5.3 a new posting: success toast, field cleared, 'Job Posting saved.' with its status and View it", async () => {
    const { user, discovery, currentPath } = openHiring()
    const url =
      "https://jobs.ashbyhq.com/beta/0a1b2c3d-0000-1111-2222-333344445555"
    const field = await applicationLink()
    await user.type(field, url)
    await user.click(checkLink())

    expect(await findToast(LINK_ACCEPTED)).toBeInTheDocument()
    const result = await within(await checkRegion()).findByRole("status")
    expect(result).toHaveTextContent("Job Posting saved.")
    expect(within(result).getByText("Checking")).toBeVisible()
    expect(field).toHaveValue("")
    expect(field).toHaveFocus()
    const posting = discovery.state.postings[0]
    expect(posting.applicationUrl).toBe(url)
    await user.click(within(result).getByRole("link", { name: "View it" }))
    expect(currentPath()).toBe(`/postings/${posting.id}`)
  })

  it("CTJ:53 @ac-5.3 the result line shows the posting's current status word, e.g. Checking", async () => {
    const { user } = openHiring({
      discovery: {
        nextPasted: (url) =>
          rankedPosting({
            applicationUrl: url,
            applyUrl: url,
            status: "waiting_to_be_checked",
            rank: null,
            eligibility: null,
            match: null,
          }),
      },
    })
    await user.type(await applicationLink(), GREENHOUSE)
    await user.click(checkLink())
    const result = await within(await checkRegion()).findByRole("status")
    expect(within(result).getByText("Checking")).toBeVisible()
  })

  it("H4 step 5: editing the field clears the result line", async () => {
    const { user } = openHiring()
    const field = await applicationLink()
    await user.type(field, GREENHOUSE)
    await user.click(checkLink())
    const region = await checkRegion()
    await within(region).findByText("Job Posting saved.")
    await user.type(field, "h")
    expect(
      within(region).queryByText("Job Posting saved.")
    ).not.toBeInTheDocument()
  })

  it("CTJ:59 @ac-5.3 an already stored link shows C-LINK-2 with View it, keeps the input and stores no second posting", async () => {
    const stored = rankedPosting({
      applicationUrl: GREENHOUSE,
      title: "Senior Frontend Engineer",
      company: "Acme",
    })
    const { user, discovery, currentPath } = openHiring({
      discovery: { postings: [stored] },
    })
    const field = await applicationLink()
    await user.type(field, GREENHOUSE)
    await user.click(checkLink())

    const region = await checkRegion()
    expect(
      await within(region).findByText(/You already have this Job Posting\./)
    ).toBeVisible()
    expect(
      within(region).queryByText("Job Posting saved.")
    ).not.toBeInTheDocument()
    expect(field).toHaveValue(GREENHOUSE)
    expect(discovery.state.postings).toHaveLength(1)
    await user.click(within(region).getByRole("link", { name: "View it" }))
    expect(currentPath()).toBe(`/postings/${stored.id}`)
  })

  it("CTJ:69 @ac-5.3 double-submitting sends one request; the button is disabled while sending and the field read-only", async () => {
    const { user, discovery } = openHiring()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    // Holds every paste until released, then falls through to the stateful fake (a resolver that returns nothing).
    server.use(
      http.post(JOB_POSTING_LINKS_PATH, async () => {
        await gate
      })
    )
    const field = await applicationLink()
    await user.type(field, GREENHOUSE)
    await user.click(checkLink())
    await user.keyboard("{Enter}")
    const busy = screen.getByRole("button", { name: "Checking…" })
    expect(busy).toBeDisabled()
    expect(field).toHaveAttribute("readonly")
    expect(busy.closest("form")).toHaveAttribute("aria-busy", "true")
    release()
    const region = await checkRegion()
    expect(
      await within(region).findByText(
        /Job Posting saved\.|You already have this Job Posting\./
      )
    ).toBeVisible()
    expect(pastes(discovery)).toHaveLength(1)
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument()
  })

  it.each([
    ["", "Paste a job link."],
    ["   ", "Paste a job link."],
    ["not a link", "Enter a full link that starts with https:// or http://."],
    [
      "ftp://acme.com/job/1",
      "Enter a full link that starts with https:// or http://.",
    ],
    [
      "javascript:alert(1)",
      "Enter a full link that starts with https:// or http://.",
    ],
  ])(
    "CTJ:78 / HV:219 @ac-5.3 %j shows the existing field error, linked and announced, keeps the input and sends nothing",
    async (input, error) => {
      const { user, discovery } = openHiring()
      const field = await applicationLink()
      if (input) await user.type(field, input)
      await user.click(checkLink())

      const alert = await screen.findByRole("alert")
      expect(alert).toHaveTextContent(error)
      expect(field).toHaveAttribute("aria-invalid", "true")
      expect(field).toHaveAccessibleDescription(expect.stringContaining(error))
      expect(field).toHaveFocus()
      // A url input sanitises surrounding spaces itself (HTML value sanitisation), so "   " reads back as "".
      expect(field).toHaveValue(input.trim())
      expect(pastes(discovery)).toEqual([])
    }
  )

  it("HV:169 @ac-1.3 a server field refusal shows the API's message inline and keeps the input", async () => {
    const { user } = openHiring()
    server.use(
      http.post(JOB_POSTING_LINKS_PATH, () =>
        apiErrorResponse("job_link_invalid")
      )
    )
    const field = await applicationLink()
    await user.type(field, "https://localhost")
    await user.click(checkLink())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a full link that starts with https:// or http://."
    )
    expect(field).toHaveValue("https://localhost")
    expect(field).toHaveFocus()
  })

  it("CTJ:93 @ac-5.2 a 2,048-character link is sent as typed", async () => {
    const { user, discovery } = openHiring()
    const url = `https://boards.greenhouse.io/acme/jobs/${"1".repeat(2048 - 39)}`
    expect(url).toHaveLength(2048)
    const field = await applicationLink()
    await user.click(field)
    await user.paste(url)
    await user.click(checkLink())
    await within(await checkRegion()).findByText("Job Posting saved.")
    expect(pastes(discovery)).toEqual([
      { method: "POST", path: "/v1/job-postings/links", body: { url } },
    ])
  })

  it("CTJ:99 @ac-5.3 a 2,049-character link is sent with no browser length check; the plain 400 toasts C-ERR-2 and keeps the input unmarked", async () => {
    const { user, discovery } = openHiring()
    const url = `https://boards.greenhouse.io/acme/jobs/${"1".repeat(2049 - 39)}`
    expect(url).toHaveLength(2049)
    const field = await applicationLink()
    await user.click(field)
    await user.paste(url)
    await user.click(checkLink())

    expect(await findToast(ERR_2)).toBeInTheDocument()
    expect(pastes(discovery)).toEqual([
      { method: "POST", path: "/v1/job-postings/links", body: { url } },
    ])
    expect(field).toHaveValue(url)
    expect(field).not.toHaveAttribute("aria-invalid")
    expect(
      within(await checkRegion()).queryByRole("alert")
    ).not.toBeInTheDocument()
    expect(discovery.state.postings).toHaveLength(0)
  })

  it("CTJ:109 @ac-5.3 spaces around a link are trimmed as the existing form trims them", async () => {
    const { user, discovery } = openHiring()
    await user.type(await applicationLink(), `  ${GREENHOUSE}  `)
    await user.click(checkLink())
    await within(await checkRegion()).findByText("Job Posting saved.")
    expect(pastes(discovery)[0].body).toEqual({ url: GREENHOUSE })
  })

  it("CTJ:116 @ac-5.4 another host is a normal created result; the Hiring view adds nothing", async () => {
    const { user, discovery } = openHiring({
      discovery: {
        nextPasted: (url) =>
          rankedPosting({
            applicationUrl: url,
            applyUrl: url,
            origin: "pasted_link",
            applicationSystem: "careers.example.org",
            applyMode: "manual",
            status: "skipped",
            skipReason: "unsupported_application_system",
            skipDetail: "careers.example.org",
            rank: null,
          }),
      },
    })
    await user.type(
      await applicationLink(),
      "https://careers.example.org/jobs/123"
    )
    await user.click(checkLink())
    const result = await within(await checkRegion()).findByRole("status")
    expect(result).toHaveTextContent("Job Posting saved.")
    // v1.28.0 manual lane: Eve cannot submit here, so the posting is a manual lead, not a rejection.
    expect(within(result).getByText("Manual apply")).toBeVisible()
    expect(discovery.state.postings[0].skipReason).toBe("unsupported_application_system")
  })

  it.each([
    "https://www.linkedin.com/posts/acme_hiring-activity-7250000000000000000-abcd",
    "https://linkedin.com/jobs/view/3999999999",
    "https://ng.linkedin.com/posts/acme_hiring-activity-7250000000000000001-wxyz",
    "  https://WWW.LinkedIn.com/feed/update/urn:li:activity:7250000000000000002  ",
    "http://www.linkedin.com/posts/acme_x-activity-7250000000000000003-aaaa",
  ])(
    "CTJ:126 @ac-5.5 %j shows the LinkedIn warning with 'Save it anyway' and sends nothing",
    async (url) => {
      const { user, discovery } = openHiring()
      const field = await applicationLink()
      await user.type(field, url)
      await user.click(checkLink())

      const warning = await screen.findByRole("alert")
      expect(warning).toHaveTextContent(LI_WARN)
      expect(
        within(warning).getByRole("button", { name: "Save it anyway" })
      ).toBeVisible()
      expect(field).not.toHaveAttribute("aria-invalid")
      expect(field).toHaveFocus()
      expect(field).toHaveAccessibleDescription(
        expect.stringContaining(LI_WARN)
      )
      expect(pastes(discovery)).toEqual([])
    }
  )

  it("CTJ:140 @ac-5.5 @ac-5.4 'Save it anyway' sends the link unchanged and shows today's unsupported result", async () => {
    const url = "https://www.linkedin.com/jobs/view/3999999999"
    const { user, discovery } = openHiring({
      discovery: {
        nextPasted: (pasted) =>
          rankedPosting({
            applicationUrl: pasted,
            applyUrl: pasted,
            origin: "pasted_link",
            applicationSystem: "www.linkedin.com",
            applyMode: "manual",
            status: "skipped",
            skipReason: "unsupported_application_system",
            skipDetail: "www.linkedin.com",
            rank: null,
          }),
      },
    })
    await user.type(await applicationLink(), url)
    await user.click(checkLink())
    await user.click(
      await screen.findByRole("button", { name: "Save it anyway" })
    )

    const result = await within(await checkRegion()).findByRole("status")
    expect(result).toHaveTextContent("Job Posting saved.")
    expect(within(result).getByText("Manual apply")).toBeVisible()
    expect(pastes(discovery)).toEqual([
      { method: "POST", path: "/v1/job-postings/links", body: { url } },
    ])
    expect(screen.queryByText(LI_WARN)).not.toBeInTheDocument()
    expect(discovery.requests.every((r) => !r.path.includes("linkedin"))).toBe(
      true
    )
  })

  it("H5 step 3: pressing Check link again with the same LinkedIn value sends it", async () => {
    const { user, discovery } = openHiring()
    await user.type(
      await applicationLink(),
      "https://linkedin.com/jobs/view/3999999999"
    )
    await user.click(checkLink())
    await screen.findByText(LI_WARN)
    await user.click(checkLink())
    await within(await checkRegion()).findByText("Job Posting saved.")
    expect(pastes(discovery)).toHaveLength(1)
  })

  it("CTJ:148 @ac-5.5 editing the field instead removes the warning, sends nothing and keeps focus; the next submit warns again", async () => {
    const url =
      "https://www.linkedin.com/posts/acme_hiring-activity-7250000000000000000-abcd"
    const { user, discovery } = openHiring()
    const field = await applicationLink()
    await user.type(field, url)
    await user.click(checkLink())
    await screen.findByText(LI_WARN)

    await user.type(field, "x")
    expect(screen.queryByText(LI_WARN)).not.toBeInTheDocument()
    expect(field).toHaveFocus()
    expect(field).toHaveValue(`${url}x`)
    expect(pastes(discovery)).toEqual([])

    await user.click(checkLink())
    expect(await screen.findByText(LI_WARN)).toBeVisible()
    expect(pastes(discovery)).toEqual([])
  })

  it.each([
    "https://notlinkedin.com/jobs/1",
    "https://linkedin.com.evil.example/jobs/1",
    "https://boards.greenhouse.io/linkedin/jobs/4012345",
    "https://careers.example.org/?ref=linkedin.com",
  ])("CTJ:155 @ac-5.5 %j gets no warning and is sent", async (url) => {
    const { user, discovery } = openHiring()
    await user.type(await applicationLink(), url)
    await user.click(checkLink())
    await within(await checkRegion()).findByText("Job Posting saved.")
    expect(screen.queryByText(LI_WARN)).not.toBeInTheDocument()
    expect(pastes(discovery)).toEqual([
      { method: "POST", path: "/v1/job-postings/links", body: { url } },
    ])
  })

  it("CTJ:183 / OUT:156 @ac-5.6 @ac-10.4 the same URL through both forms sends the same request", async () => {
    const hiring = openHiring()
    await hiring.user.type(await applicationLink(), GREENHOUSE)
    await hiring.user.click(checkLink())
    await within(await checkRegion()).findByText("Job Posting saved.")
    const fromHiring = pastes(hiring.discovery)
    hiring.unmount()

    const postings = openHiring({ path: "/postings" })
    await postings.user.type(
      await screen.findByLabelText("Job link"),
      GREENHOUSE
    )
    await postings.user.click(
      screen.getByRole("button", { name: "Check link" })
    )
    expect(await findToast(LINK_ACCEPTED)).toBeInTheDocument()
    expect(pastes(postings.discovery)).toEqual(fromHiring)
    // The existing form keeps its own lines: no Hiring result line or LinkedIn warning there.
    expect(screen.queryByText("Job Posting saved.")).not.toBeInTheDocument()
  })

  it("HV:157 @ac-1.3 a successful paste shows the existing paste success toast", async () => {
    const { user } = openHiring()
    await user.type(await applicationLink(), GREENHOUSE)
    await user.click(checkLink())
    expect(await findToast(LINK_ACCEPTED)).toBeInTheDocument()
  })

  it("HV:182 @ac-1.3 a network failure shows the retry error toast and keeps the input", async () => {
    const { user } = openHiring()
    server.use(http.post(JOB_POSTING_LINKS_PATH, () => HttpResponse.error()))
    const field = await applicationLink()
    await user.type(field, GREENHOUSE)
    await user.click(checkLink())
    expect(await findToast(ERR_2)).toBeInTheDocument()
    expect(field).toHaveValue(GREENHOUSE)
    expect(field).not.toHaveAttribute("aria-invalid")
  })

  it("the existing paste form does not warn for a LinkedIn link (unchanged behaviour)", async () => {
    const { user, discovery } = openHiring({ path: "/postings" })
    await user.type(
      await screen.findByLabelText("Job link"),
      "https://www.linkedin.com/jobs/view/3999999999"
    )
    await user.click(screen.getByRole("button", { name: "Check link" }))
    expect(await findToast(LINK_ACCEPTED)).toBeInTheDocument()
    expect(screen.queryByText(LI_WARN)).not.toBeInTheDocument()
    expect(pastes(discovery)).toHaveLength(1)
  })
})

describe("Hiring view with Phase 3 (hiring-view.feature r5, outbound-and-separation.feature)", () => {
  const record = {
    verifiedOn: "2026-10-21",
    verificationBasis: "Read Google's terms for Alerts RSS on 21 Oct.",
    updatedAt: "2026-10-21T10:15:00.000Z",
  }
  const FEED = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555123456"
  const feed = { id: "a0000000-0000-4000-8000-00000000f001", url: FEED, label: "Frontend hiring", createdAt: "2026-10-21T13:00:00.000Z", lastReadAt: null, failure: null }
  const post = {
    id: "b0000000-0000-4000-8000-00000000f001",
    canonicalUrl: "https://www.linkedin.com/posts/acme_hiring-activity-1-aaaa",
    kind: "post" as const,
    title: "We're hiring",
    snippet: "Join us.",
    date: "2026-10-24T08:30:00.000Z",
    dateKind: "posted" as const,
    matchedTechnologies: ["React"],
    feedId: feed.id,
    firstSeenAt: "2026-10-24T09:00:00.000Z",
  }
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...post, id: `b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, canonicalUrl: `${post.canonicalUrl}-${i}` }))

  it("HV:194 every Phase 3 control is reachable by keyboard, within its tab: Update, Feed URL, Add feed, Remove, row Check this job, paging", async () => {
    // Page 2 of 2 holds one row, so tabbing to every control stays short.
    const { user } = openHiringFeeds({
      path: "/find-jobs?view=hiring&page=2#set-up-alerts",
      criteria: { frameworks: ["React"] },
      stack: { hiringVerification: record, hiringFeeds: [feed], hiringPosts: many(51) },
    })
    // Set up alerts holds the feeds controls (the hash opened it).
    await user.click(await screen.findByRole("tab", { name: "Set up alerts" }))
    await screen.findByRole("region", { name: "Hiring alert feeds" })
    const alertTargets = [
      screen.getByRole("button", { name: "Update your confirmation for hiring alert feeds" }),
      screen.getByRole("textbox", { name: "Feed URL" }),
      screen.getByRole("button", { name: "Add feed" }),
      screen.getByRole("button", { name: /^Remove Frontend hiring/ }),
    ]
    // Focus starts on the selected tab; Tab then enters that panel's first control.
    expect(await unreachedAfterTabbing(user, alertTargets, 40)).toEqual([])
    // Hiring posts holds the row's Check this job and the paging.
    await user.click(screen.getByRole("tab", { name: "Hiring posts" }))
    const posts = await screen.findByRole("region", { name: "Hiring posts" })
    await within(posts).findByText("Page 2 of 2")
    const postTargets = [
      within(posts).getAllByRole("button", { name: /^Check this job from / })[0],
      within(posts).getByRole("link", { name: "Previous" }),
    ]
    expect(await unreachedAfterTabbing(user, postTargets, 40)).toEqual([])
  }, 20_000)

  it("HV:201 every Phase 3 control has an accessible name", async () => {
    const { user } = openHiringFeeds({ stack: { hiringVerification: record, hiringFeeds: [feed], hiringPosts: [post] } })
    const named = (region: HTMLElement) => {
      for (const control of [...within(region).getAllByRole("button"), ...within(region).queryAllByRole("link"), ...within(region).queryAllByRole("textbox")])
        expect(control).toHaveAccessibleName()
    }
    const alerts = await screen.findByRole("region", { name: "Hiring alert feeds" })
    await within(alerts).findByRole("button", { name: /^Remove Frontend hiring/ })
    named(alerts)
    await user.click(screen.getByRole("tab", { name: "Hiring posts" }))
    const posts = await screen.findByRole("region", { name: "Hiring posts" })
    await within(posts).findByRole("button", { name: /^Check this job from / })
    named(posts)
  })

  it("HV:135 Phase 3 writes carry the session's CSRF token (register, remove, permitted-use save)", async () => {
    const { user } = openHiringFeeds({ stack: { hiringVerification: record, hiringFeeds: [feed] } })
    const writes: { method: string; path: string; token: string | null }[] = []
    server.events.on("request:start", ({ request }) => {
      const url = new URL(request.url)
      if (request.method !== "GET" && url.pathname.startsWith("/v1/stack-posts/hiring-feeds"))
        writes.push({ method: request.method, path: url.pathname, token: request.headers.get("x-csrf-token") })
    })
    const feeds = await screen.findByRole("region", { name: "Hiring alert feeds" })
    await user.type(await within(feeds).findByRole("textbox", { name: "Feed URL" }), FEED.replace("123456", "777888"))
    await user.click(within(feeds).getByRole("button", { name: "Add feed" }))
    await findToast("Hiring alert feed added.")
    await user.click(within(feeds).getByRole("button", { name: /^Remove Frontend hiring/ }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove feed" }))
    await findToast("Hiring alert feed removed.")
    await user.click(within(feeds).getByRole("button", { name: "Update your confirmation for hiring alert feeds" }))
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "I confirm" }))
    await findToast("Confirmation saved.")
    server.events.removeAllListeners()
    expect(writes.map((w) => w.method)).toEqual(["POST", "DELETE", "PUT"])
    expect(writes.every((w) => w.token === TEST_CSRF_TOKEN)).toBe(true)
  })

  it("HV:231 every linkedin.com and google.com link (search, Google, Alerts, post title) opens in a new tab with noopener noreferrer", async () => {
    const { user } = openHiring({
      criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] },
      stack: { hiringVerification: record, hiringPosts: [post] },
    })
    const links = await screen.findByRole("region", { name: "Hiring search links" })
    await within(links).findByRole("link", { name: /^LinkedIn posts for/ })
    await user.click(within(links).getByRole("button", { name: /Google Alerts query/ }))
    await within(links).findByRole("link", { name: /^Open Google Alerts/ })
    const searchExternal = within(links)
      .getAllByRole("link")
      .filter((a) => /linkedin\.com|google\.com/.test(a.getAttribute("href") ?? ""))
    expect(searchExternal.length).toBeGreaterThanOrEqual(3)
    // The post title lives on the Hiring posts tab.
    await user.click(screen.getByRole("tab", { name: "Hiring posts" }))
    const posts = await screen.findByRole("region", { name: "Hiring posts" })
    await within(posts).findByRole("link", { name: /^We're hiring/ })
    const postExternal = within(posts)
      .getAllByRole("link")
      .filter((a) => /linkedin\.com|google\.com/.test(a.getAttribute("href") ?? ""))
    expect(postExternal.length).toBeGreaterThanOrEqual(1)
    const external = [...searchExternal, ...postExternal]
    expect(external.length).toBeGreaterThanOrEqual(4)
    for (const a of external) {
      expect(a).toHaveAttribute("target", "_blank")
      expect(a).toHaveAttribute("rel", "noopener noreferrer")
    }
  })

  it("OUT:29 / OUT:88 the Hiring view with Phase 3 calls only the Eve API (no LinkedIn, Google or AI request)", async () => {
    const hosts = new Set<string>()
    server.events.on("request:start", ({ request }) => hosts.add(new URL(request.url).host))
    const { user } = openHiring({ stack: { hiringVerification: record, hiringFeeds: [feed], hiringPosts: [post] } })
    await user.click(await screen.findByRole("tab", { name: "Hiring posts" }))
    const posts = await screen.findByRole("region", { name: "Hiring posts" })
    await user.click(await within(posts).findByRole("button", { name: /^Check this job from / }))
    server.events.removeAllListeners()
    expect([...hosts]).toEqual([window.location.host])
  })

  it("H1 step 6 / OUT:115 R5: the page reads the Hiring feeds and Hiring posts, and never LinkedIn or Google", async () => {
    const { stack, user } = openHiringFeeds({ stack: { hiringVerification: record } })
    await user.click(await screen.findByRole("tab", { name: "Hiring posts" }))
    await screen.findByRole("heading", { name: "Hiring posts appear here once you set up job alerts. You can also use the Search tab." })
    const paths = stack.requests.map((r) => r.path.split("?")[0])
    expect(paths).toEqual(expect.arrayContaining(["/v1/stack-posts/hiring-feeds", "/v1/stack-posts/hiring-posts"]))
    expect(paths.every((p) => p.startsWith("/v1/"))).toBe(true)
  })
})

/**
 * SEC-P2-03 (security-review.md appendix, threat model P2-4(b) and P2-5(c)):
 * committed form of the Phase 2 Security scratch probe. A hostile posting
 * returned by the paste renders no `javascript:` link, every link in the Check
 * this job region goes to `/postings/`, and HTML in the title and skip detail
 * never becomes markup.
 */
describe("SEC-P2-03: hostile posting fields in the Check this job result", () => {
  it("renders no javascript: href, only /postings/ links in the region, and no injected img or svg", async () => {
    const { user } = openHiring({
      discovery: {
        nextPasted: () =>
          rankedPosting({
            applicationUrl: "javascript:alert(1)",
            applyUrl: "javascript:alert(2)",
            title: "<img src=x onerror=alert(1)>",
            company: '"><svg onload=alert(3)>',
            skipDetail: '"><svg onload=alert(4)>',
            status: "skipped",
            skipReason: "unsupported_application_system",
            rank: null,
            origin: "pasted_link",
          }),
      },
    })
    await user.type(await applicationLink(), GREENHOUSE)
    await user.click(checkLink())
    const region = await checkRegion()
    const result = await within(region).findByRole("status")
    expect(result).toHaveTextContent("Job Posting saved.")

    const hrefs = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "")
    expect(hrefs.filter((href) => /^\s*javascript:/i.test(href))).toEqual([])
    const regionLinks = [...region.querySelectorAll("a")]
    expect(regionLinks.length).toBeGreaterThan(0)
    expect(regionLinks.every((a) => a.getAttribute("href")?.startsWith("/postings/"))).toBe(true)
    expect(document.querySelector("img[src=x]")).toBeNull()
    expect(document.querySelector("svg[onload]")).toBeNull()
    expect(document.body.innerHTML).not.toContain("<img src=x")
  })
})

/** EPIC-0009 copy deck (C-EH-HIRING-*, C-EH-POPOVER-CLOSE), quoted so a copy change fails here. */
const EH_LINE =
  "Eve doesn't open or read LinkedIn, so it can't find LinkedIn posts that match your job criteria by itself. The sections below help you find them."
const EH_TRIGGER = "Why Eve doesn't show LinkedIn posts"
const EH_TITLE = "Why Eve can't read LinkedIn"
const EH_BODY = [
  "LinkedIn's terms restrict automated access, so Eve never sends a request to linkedin.com.",
  "Three ways to find them",
  "Hiring search links open LinkedIn and Google searches in your own browser, where you're signed in. Eve doesn't see the results. Go to Hiring search links",
  "Check this job needs the employer's application link from a post, not the post link. Eve checks it with your usual rules. Go to Check this job",
  "Hiring alert feeds bring in short previews of posts Google Alerts found. Eve reads them four times a day, only after you confirm you may use these feeds. They miss some posts, and Eve hasn't vetted them. Go to Hiring alert feeds",
]
const HINT_TEXT =
  "Search hints for LinkedIn and Google. Results will include posts that don't fit. Eve can't check pay, hours or sponsorship from a search or post."

const linksSection = () => screen.findByRole("region", { name: "Hiring search links" })
const ehTrigger = () => screen.getByRole("button", { name: EH_TRIGGER })

/** The lead line comes after the page description and before the links section, once, outside every section. */
async function expectLeadLineFirst() {
  const line = await screen.findByText(EH_LINE)
  expect(line).toBeVisible()
  expect(screen.getAllByText(EH_LINE)).toHaveLength(1)
  const section = await linksSection()
  expect(line.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(section).not.toContainElement(line)
  const title = screen.getByRole("heading", { level: 1, name: "Find jobs" })
  expect(title.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
}

/** Holds the hint terms request open so the links section stays loading. */
function holdHintTerms() {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  server.use(
    http.get(HIRING_SEARCH_INPUTS_PATH, async () => {
      await gate
      return HttpResponse.json({ hintTerms: [] })
    })
  )
  return () => release()
}

describe("EPIC-0009 S3: Hiring view help (hiring-view-help.feature)", () => {
  it("@ac-9 ready: the lead line is under the page title, once, outside the unchanged C-HP-HINT note", async () => {
    openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    const note = await within(await linksSection()).findByText(HINT_TEXT, { exact: false })
    await expectLeadLineFirst()
    const noteBox = note.closest('[data-slot="section-note"]')
    expect(noteBox).toHaveTextContent(HINT_TEXT)
    expect(noteBox).not.toHaveTextContent(EH_LINE)
  })

  it("@ac-9 loading: the lead line shows while the links section loads", async () => {
    const view = openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    const release = holdHintTerms()
    await expectLeadLineFirst()
    expect(screen.queryByText(HINT_TEXT, { exact: false })).not.toBeInTheDocument()
    release()
    view.unmount()
  })

  it("@ac-9 error then ready after Try again: the lead line stays exactly once", async () => {
    const { user, hints } = openHiring({
      criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] },
      hints: { failing: true },
    })
    const alert = await within(await linksSection()).findByRole("alert", {}, { timeout: 10_000 })
    await expectLeadLineFirst()
    hints.state.failing = false
    await user.click(within(alert).getByRole("button", { name: "Try again" }))
    expect(await screen.findByText(HINT_TEXT, { exact: false })).toBeVisible()
    expect(screen.getAllByText(EH_LINE)).toHaveLength(1)
  })

  it("@ac-9 no Role family: the lead line shows with the empty state", async () => {
    openHiring({ criteria: { targetRoleFamilies: ["other"] } })
    expect(await within(await linksSection()).findByText("No role family to search for")).toBeVisible()
    await expectLeadLineFirst()
  })

  it("@ac-9 a Job criteria load error also keeps the lead line", async () => {
    openHiring()
    server.use(http.get(JOB_CRITERIA_PATH, () => apiErrorResponse("bad_request")))
    await within(await linksSection()).findByRole("alert")
    await expectLeadLineFirst()
  })

  it("@ac-9 the unconfirmed Hiring posts empty state (find.hiring.empty) sits next to the lead line", async () => {
    const { user } = openHiring({ stack: { hiringVerification: null } })
    expect(await screen.findByText(EH_LINE)).toBeVisible()
    await user.click(screen.getByRole("tab", { name: "Hiring posts" }))
    expect(await screen.findByText("Hiring posts appear here once you set up job alerts. You can also use the Search tab.")).toBeVisible()
  })

  it("@ac-10 @ac-13 exactly one collapsed (i) after the line; it opens the reason and three ways, in order", async () => {
    const { user } = openHiring()
    const line = await screen.findByText(EH_LINE)
    const triggers = screen.getAllByRole("button", { name: /^Why Eve doesn't show/ })
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toHaveAccessibleName(EH_TRIGGER)
    expect(triggers[0]).toHaveAttribute("aria-expanded", "false")
    expect(triggers[0]).toHaveAttribute("aria-haspopup")
    expect(line.compareDocumentPosition(triggers[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await user.click(triggers[0])
    const popover = await screen.findByRole("dialog", { name: EH_TITLE })
    expect(triggers[0]).toHaveAttribute("aria-expanded", "true")
    const body = [...popover.querySelectorAll("p, li")].map((el) => el.textContent).filter((t) => t !== EH_TITLE)
    expect(body).toEqual(EH_BODY)
    expect(within(popover).getAllByRole("listitem")).toHaveLength(3)
  })

  it("@ac-17 the popover's links stay on the page and point at the three sections", async () => {
    const { user } = openHiring()
    await user.click(await screen.findByRole("button", { name: EH_TRIGGER }))
    const popover = await screen.findByRole("dialog", { name: EH_TITLE })
    expect(within(popover).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "#hiring-search-links",
      "#check-this-job",
      "#hiring-alert-feeds",
    ])
  })

  it("@ac-15 Tab from the popup reaches the close button, then the three links", async () => {
    const { user } = openHiring()
    await screen.findByText(EH_LINE)
    ehTrigger().focus()
    await user.keyboard("{Enter}")
    const popover = await screen.findByRole("dialog", { name: EH_TITLE })
    await waitFor(() => expect(popover).toHaveFocus())
    for (const name of ["Close help", "Go to Hiring search links", "Go to Check this job", "Go to Hiring alert feeds"]) {
      await user.tab()
      expect(document.activeElement).toHaveAccessibleName(name)
    }
  })

  it.each([
    ["Go to Hiring search links", "Hiring search links"],
    ["Go to Check this job", "Check this job"],
    ["Go to Hiring alert feeds", "Hiring alert feeds"],
  ])("@ac-11 %s closes the popover, focuses the heading and keeps view and family", async (link, heading) => {
    const { user, currentPath } = openHiring({ path: "/find-jobs?view=hiring&family=senior_backend" })
    await screen.findByRole("region", { name: "Hiring search links" })
    await user.click(screen.getByRole("button", { name: EH_TRIGGER }))
    const popover = await screen.findByRole("dialog", { name: EH_TITLE })
    await user.click(within(popover).getByRole("link", { name: link }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: EH_TITLE })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: heading })).toHaveFocus())
    expect(currentPath()).toBe("/find-jobs?view=hiring&family=senior_backend")
  })

  it("@ac-11 a Go to link works by keyboard while the links section is loading", async () => {
    const { user, currentPath, unmount } = openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"] } })
    const release = holdHintTerms()
    await checkRegion()
    ehTrigger().focus()
    await user.keyboard("{Enter}")
    const popover = await screen.findByRole("dialog", { name: EH_TITLE })
    within(popover).getByRole("link", { name: "Go to Check this job" }).focus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Check this job" })).toHaveFocus())
    expect(screen.queryByRole("dialog", { name: EH_TITLE })).not.toBeInTheDocument()
    expect(currentPath()).toContain("view=hiring")
    release()
    unmount()
  })

  it("@ac-14 Escape and the close button close the popover and return focus to the trigger", async () => {
    const { user } = openHiring()
    await screen.findByText(EH_LINE)
    await user.click(ehTrigger())
    await screen.findByRole("dialog", { name: EH_TITLE })
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog", { name: EH_TITLE })).not.toBeInTheDocument())
    await waitFor(() => expect(ehTrigger()).toHaveFocus())
    expect(ehTrigger()).toHaveAttribute("aria-expanded", "false")

    await user.click(ehTrigger())
    await user.click(await screen.findByRole("button", { name: "Close help" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: EH_TITLE })).not.toBeInTheDocument())
    await waitFor(() => expect(ehTrigger()).toHaveFocus())
  })

  it("@ac-17 opening the popover, following a link and closing it sends no request, none to linkedin.com or google.com", async () => {
    const { user } = openHiringFeeds({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    await screen.findByText(HINT_TEXT, { exact: false })
    await screen.findByRole("region", { name: "Hiring alert feeds" })
    // The Hiring posts panel stays mounted; visit it so its requests have all fired before recording.
    await user.click(screen.getByRole("tab", { name: "Hiring posts" }))
    await screen.findByRole("region", { name: "Hiring posts" })
    await user.click(screen.getByRole("tab", { name: "Search" }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    const urls: string[] = []
    const record = ({ request }: { request: Request }) => void urls.push(request.url)
    server.events.on("request:start", record)
    try {
      await user.click(ehTrigger())
      const popover = await screen.findByRole("dialog", { name: EH_TITLE })
      await user.click(within(popover).getByRole("link", { name: "Go to Hiring search links" }))
      await waitFor(() => expect(screen.queryByRole("dialog", { name: EH_TITLE })).not.toBeInTheDocument())
      // The link focuses the heading on the next frame; reopen only after that, its observable end.
      await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Hiring search links" })).toHaveFocus())
      await user.click(ehTrigger())
      await user.click(await screen.findByRole("button", { name: "Close help" }))
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(urls.filter((url) => /(^|\.)(linkedin|google)\.com$/i.test(new URL(url).hostname))).toEqual([])
      expect(urls).toEqual([])
    } finally {
      server.events.removeListener("request:start", record)
    }
  })
})
