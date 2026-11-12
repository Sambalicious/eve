import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, rankedPosting, server, strongMatch } from "@/shared/testing"
import { JOB_POSTINGS_PATH } from "@eve/contracts"
import { http } from "msw"
import { advance, findToast } from "./career-setup-helpers"
import { openDiscovery } from "./discovery-helpers"

async function table() {
  return screen.findByRole("region", { name: "Job Postings, scrolls horizontally" })
}

describe("Job Postings list (F4)", () => {
  it("opens on Ranked and lists rank, role, family, Eligibility, Match, system and Unverified labels in rank order", async () => {
    const { user, currentPath } = openDiscovery("/postings", {
      postings: [
        rankedPosting({ title: "Fullstack Engineer", company: "Initech", roleFamily: "fullstack", rank: 2, unverifiedLabels: ["pay", "hours"], match: null }),
        rankedPosting({ title: "Senior Frontend Engineer", company: "Acme", rank: 1 }),
      ],
    })

    await user.click(await screen.findByRole("link", { name: "Jobs" }))
    expect(currentPath()).toBe("/postings")
    expect(screen.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible()
    expect(document.title).toBe("Jobs · Eve")
    expect(screen.getByRole("tab", { name: "Good matches" })).toHaveAttribute("aria-selected", "true")
    const rows = within(await table()).getAllByRole("row").slice(1)
    expect(rows[0]).toHaveTextContent("1Senior Frontend Engineer at Acme")
    expect(rows[0]).toHaveTextContent("Frontend")
    expect(rows[0]).toHaveTextContent("All rules met")
    expect(rows[0]).toHaveTextContent("Greenhouse")
    expect(rows[1]).toHaveTextContent("2Fullstack Engineer at Initech")
    expect(within(rows[1]).getByText("Unverified: pay")).toBeVisible()
    expect(within(rows[1]).getByText("Unverified: hours")).toBeVisible()
    expect(within(rows[0]).getByRole("link", { name: "Senior Frontend Engineer at Acme" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/postings\/[0-9a-f-]{36}$/)
    )
  })

  it("Skipped by rules tab shows each reason from C-SKIP-*, including the employer-site line (R4)", async () => {
    const { user, currentPath } = openDiscovery("/postings", {
      postings: [
        rankedPosting({ status: "excluded", rank: null, skipReason: "violated_rule", skipDetail: "location" }),
        rankedPosting({ status: "skipped", rank: null, skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Professional Kotlin Android experience" }),
        rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match" }),
        rankedPosting({ status: "skipped", rank: null, skipReason: "no_core_responsibilities" }),
        rankedPosting({
          status: "skipped",
          rank: null,
          skipReason: "unsupported_application_system",
          skipDetail: "Workday",
          applicationSystem: "Workday",
          applyMode: "manual",
          applicationUrl: "https://acme.wd1.myworkdayjobs.com/en-US/careers/12",
          applyUrl: "https://acme.wd1.myworkdayjobs.com/en-US/careers/12",
        }),
      ],
    })

    await user.click(await screen.findByRole("tab", { name: "Not a match" }))
    expect(currentPath()).toBe("/postings?tab=not_a_match")
    const region = await table()
    for (const text of [
      "This job needs a location that doesn't fit your criteria.",
      "Your profile doesn't show a required prerequisite for this job: \"Professional Kotlin Android experience\".",
      "Your profile doesn't back enough of the core responsibilities.",
      "Eve found no core responsibilities in this job, so it can't check the match.",
    ]) {
      expect(await within(region).findByText(text)).toBeVisible()
    }
    // R4: no Manual Application badge and no Skipped or Excluded words; every row reads Not a match.
    expect(within(region).queryByText("Manual Application")).not.toBeInTheDocument()
    expect(within(region).getAllByText("Not a match")).toHaveLength(4)
    // An excluded row explains itself with the violated rule, never "All rules met" (break-ui finding 3).
    const excludedRow = within(region).getByText("This job needs a location that doesn't fit your criteria.").closest("tr")!
    expect(excludedRow).not.toHaveTextContent("All rules met")
  })

  it("v1.28.0: jobs Eve cannot submit for are on their own Manual apply tab, with the employer-site line", async () => {
    const { user, currentPath } = openDiscovery("/postings", {
      postings: [
        rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match" }),
        rankedPosting({
          status: "skipped",
          rank: null,
          skipReason: "unsupported_application_system",
          skipDetail: "We Work Remotely",
          applicationSystem: "We Work Remotely",
          applyMode: "manual",
          applicationUrl: "https://weworkremotely.com/jobs/1",
          applyUrl: "https://weworkremotely.com/jobs/1",
        }),
      ],
    })

    await user.click(await screen.findByRole("tab", { name: "Manual apply" }))
    expect(currentPath()).toBe("/postings?tab=manual")
    const region = await table()
    expect(await within(region).findByText("You'll apply on the employer's site")).toBeVisible()
    expect(within(region).getAllByText("Manual apply")).toHaveLength(1)
    // The weak match stays on Not a match.
    await user.click(screen.getByRole("tab", { name: "Not a match" }))
    const notMatch = await table()
    expect(within(notMatch).queryByText("You'll apply on the employer's site")).toBeNull()
  })

  it("formats large Match counts with separators (break-ui finding 2)", async () => {
    openDiscovery("/postings", {
      postings: [rankedPosting({ match: { ...strongMatch(), coveredCount: 1284, totalCount: 1834 } })],
    })

    expect(await within(await table()).findByText("1,284 of 1,834")).toBeVisible()
  })

  it("shows the board credit as a followed link on remote-board postings", async () => {
    openDiscovery("/postings?tab=all", {
      postings: [
        rankedPosting({
          origin: "remote_board",
          applicationSystem: "Himalayas",
          applyMode: "manual",
          status: "skipped",
          rank: null,
          skipReason: "unsupported_application_system",
          skipDetail: "Himalayas",
          applyUrl: "https://himalayas.app/companies/acme/jobs/frontend",
          attribution: { name: "Himalayas", url: "https://himalayas.app" },
        }),
      ],
    })

    const credit = await within(await table()).findByRole("link", { name: /via Himalayas/ })
    expect(credit).toHaveAttribute("href", "https://himalayas.app")
    expect(credit.getAttribute("rel") ?? "").not.toContain("nofollow")
  })

  it("Ranked first run shows C-EMPTY-2 with Find jobs", async () => {
    openDiscovery("/postings")

    expect(await screen.findByRole("heading", { name: "No jobs yet" })).toBeVisible()
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Find jobs" })).toHaveAttribute("href", "/find-jobs")
  })

  it("Ranked tab with only skipped postings shows the zero state, not the first-run one", async () => {
    openDiscovery("/postings", { postings: [rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match" })] })

    expect(await screen.findByRole("heading", { name: "No good matches yet" })).toBeVisible()
  })

  it("says how many postings wait for the cost pause, with See them (EPIC-0006 postings.waitingNotice.text)", async () => {
    const { user, currentPath } = openDiscovery("/postings", { waitingToBeCheckedCount: 2 })

    expect(
      await screen.findByText("2 postings are waiting to be checked. Eve checks them when the cost pause ends, then ranks them with the rest.", { exact: false })
    ).toBeVisible()
    await user.click(screen.getByRole("link", { name: "See them" }))
    expect(currentPath()).toBe("/postings?tab=all")
  })

  it("shows C-ERR-1 with Try again when the list fails to load, and Try again reloads it", async () => {
    // Faked timers skip React Query's 1 s + 2 s retry backoff instead of waiting for it in real time.
    const { user } = openDiscovery("/postings", { postings: [rankedPosting({ title: "Senior Frontend Engineer", company: "Acme" })] }, { fakeTimers: true })
    let isDown = true
    let attempts = 0
    // After the fake: later handlers take precedence. Falls through to the fake once the API is back.
    server.use(
      http.get(JOB_POSTINGS_PATH, () => {
        attempts += 1
        return isDown ? apiErrorResponse("internal_error") : undefined
      })
    )

    await waitFor(() => expect(attempts).toBe(1))
    await advance(1000)
    await waitFor(() => expect(attempts).toBe(2))
    await advance(2000)
    const retry = await screen.findByRole("button", { name: "Try again" })
    expect(screen.getByText("Couldn't load this page.")).toBeVisible()
    expect(attempts).toBe(3)
    isDown = false
    await user.click(retry)

    expect(await within(await table()).findByRole("link", { name: "Senior Frontend Engineer at Acme" })).toBeVisible()
  })
})

describe("Add a job link (F3)", () => {
  it("checks a link: clears the field, toasts C-LINK-1, and lists it as Checking", async () => {
    const { user, api } = openDiscovery("/postings?tab=all")

    const field = await screen.findByLabelText("Job link")
    await user.type(field, "https://jobs.lever.co/globex/abc-123")
    await user.click(screen.getByRole("button", { name: "Check link" }))

    expect(
      await findToast("Checking the link. It goes through the same Eligibility, Match, duplicate and cap rules as discovered postings.")
    ).toBeInTheDocument()
    expect(field).toHaveValue("")
    expect(api.requests).toEqual([{ method: "POST", path: "/v1/job-postings/links", body: { url: "https://jobs.lever.co/globex/abc-123" } }])
    const region = await table()
    expect(await within(region).findByText("Checking")).toBeVisible()
    expect(within(region).getByText("https://jobs.lever.co/globex/abc-123")).toBeVisible()
  })

  it.each([
    ["", "Paste a job link."],
    ["not a url", "Enter a full link that starts with https:// or http://."],
    ["ftp://example.com/1", "Enter a full link that starts with https:// or http://."],
  ])("refuses %j inline and creates nothing", async (input, error) => {
    const { user, api } = openDiscovery("/postings")

    const field = await screen.findByLabelText("Job link")
    if (input) await user.type(field, input)
    await user.click(screen.getByRole("button", { name: "Check link" }))

    expect(await screen.findByText(error)).toBeVisible()
    expect(field).toHaveAttribute("aria-invalid", "true")
    expect(field).toHaveFocus()
    expect(api.requests).toEqual([])
  })

  it("shows the backend's refusal inline when it disagrees with the dashboard", async () => {
    const { user } = openDiscovery("/postings")
    server.use(http.post("/v1/job-postings/links", () => apiErrorResponse("job_link_invalid")))

    await user.type(await screen.findByLabelText("Job link"), "https://localhost")
    await user.click(screen.getByRole("button", { name: "Check link" }))

    expect(await screen.findByText("Enter a full link that starts with https:// or http://.")).toBeVisible()
  })

  it("an already stored link shows C-LINK-2 with View it and creates no second posting", async () => {
    const stored = rankedPosting({ applicationUrl: "https://jobs.lever.co/globex/abc-123", title: "Product Engineer", company: "Globex" })
    const { user, api, currentPath } = openDiscovery("/postings", { postings: [stored] })

    await user.type(await screen.findByLabelText("Job link"), "https://jobs.lever.co/globex/abc-123")
    await user.click(screen.getByRole("button", { name: "Check link" }))

    expect(await screen.findByText(/You already have this Job Posting\./)).toBeVisible()
    expect(api.state.postings).toHaveLength(1)
    await user.click(screen.getByRole("link", { name: "View it" }))
    expect(currentPath()).toBe(`/postings/${stored.id}`)
  })

  it("a server failure toasts C-ERR-2 and keeps the link", async () => {
    const { user } = openDiscovery("/postings")
    server.use(http.post("/v1/job-postings/links", () => apiErrorResponse("internal_error")))

    const field = await screen.findByLabelText("Job link")
    await user.type(field, "https://jobs.lever.co/globex/abc-123")
    await user.click(screen.getByRole("button", { name: "Check link" }))

    expect(await findToast("Couldn't check the link. Nothing changed. Try again.")).toBeInTheDocument()
    expect(field).toHaveValue("https://jobs.lever.co/globex/abc-123")
  })
})
