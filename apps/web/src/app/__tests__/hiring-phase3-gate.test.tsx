import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { RoleFamilyValue } from "@eve/contracts"

import { ownRecord21Oct, rankedPosting, storedPost } from "@/shared/testing"
import { openDocuments } from "./documents-helpers"
import { checkRegion, openHiringFeeds as openHiring, showTab } from "./hiring-view-helpers"

/**
 * EPIC-0007 Phase 3 QA gate: component tests for @phase3 scenarios in Gherkin r6 that
 * no authored test cited. Test names start with the r6 Gherkin line. Strings are the
 * deck's (copy-deck.r3.md), quoted so a copy change fails here.
 */
const HINT =
  "Search hints for LinkedIn and Google. Results will include posts that don't fit. Eve can't check pay, hours or sponsorship from a search or post."
const HELP_WITH_HINT =
  "Paste the employer's application link from the post, not the LinkedIn post link. No link? Add the job description. Eve checks that job with your usual rules."
const HELP_SOLO =
  "Eve can't check pay, hours or sponsorship in a LinkedIn post. Paste the employer's application link from the post, not the post link. No link? Add the job description. Eve checks that job with your usual rules."
const LINK_ACCEPTED_START = /^Checking the link\./

async function postsRegion() {
  await showTab("Hiring posts")
  const region = await screen.findByRole("region", { name: "Hiring posts" })
  await waitFor(() =>
    expect(region.querySelector("ol:not([aria-hidden]), h3")).not.toBeNull()
  )
  return region
}

describe("HP:256 (r6) the posted date is the WAT calendar day of the post's date", () => {
  it.each([
    ["2026-10-24T22:59:00Z", "Posted 24 Oct 2026"],
    ["2026-10-24T23:00:00Z", "Posted 25 Oct 2026"],
    ["2026-10-23T23:30:00Z", "Posted 24 Oct 2026"],
  ])("stored %s shows %s", async (date, shown) => {
    openHiring({
      stack: {
        hiringVerification: ownRecord21Oct,
        hiringPosts: [
          storedPost({ title: "Hiring", date, dateKind: "posted" }),
        ],
      },
    })
    const region = await postsRegion()
    const row = within(region).getByRole("listitem", { name: "Hiring" })
    expect(row).toHaveTextContent(shown)
    // The date only: no time of day (r6 point 1).
    expect(row).not.toHaveTextContent(/\d{1,2}:\d{2}/)
  })
})

describe("CTJ:369 submitting a hidden link from a row shows the EPIC-0006 hidden line in that row", () => {
  it("'Saved, but hidden: no posted date.' then 'View it' in the row, one pasted_link posting, no success toast", async () => {
    const title = "We're hiring a frontend engineer"
    const { user, discovery } = openHiring({
      stack: {
        hiringVerification: ownRecord21Oct,
        hiringPosts: [storedPost({ title })],
      },
      discovery: {
        nextPasted: (url) =>
          rankedPosting({
            applicationUrl: url,
            applyUrl: url,
            origin: "pasted_link",
            status: "not_checked",
            rank: null,
            hiddenReason: "undated",
          }),
      },
    })
    const region = await postsRegion()
    const row = within(region).getByRole("listitem", { name: title })
    await user.click(
      within(row).getByRole("button", { name: `Check this job from ${title}` })
    )
    const field = await within(row).findByRole("textbox", {
      name: `Application link for ${title}`,
    })
    await user.type(field, "https://careers.example.org/jobs/123")
    await user.click(within(row).getByRole("button", { name: "Check link" }))

    const line = await within(row).findByText(
      /Saved, but hidden: no posted date\./
    )
    expect(line.closest("[role=status]") ?? line).toHaveTextContent(
      "Saved, but hidden: no posted date. View it"
    )
    const posting = discovery.state.postings[0]
    expect(discovery.state.postings).toHaveLength(1)
    expect(posting.origin).toBe("pasted_link")
    expect(within(row).getByRole("link", { name: "View it" })).toHaveAttribute(
      "href",
      `/postings/${posting.id}`
    )
    expect(
      within(row).queryByText("Job Posting saved.")
    ).not.toBeInTheDocument()
    expect(screen.queryByText(LINK_ACCEPTED_START)).not.toBeInTheDocument()
  })
})

describe("HV:291 (r5) Check this job shows C-HP-CHECK-HELP-SOLO exactly when the C-HP-HINT note is not rendered (Phases 1, 2 and 3)", () => {
  it.each([
    ["Frontend", ["senior_frontend"], true],
    ["Frontend, Backend", ["senior_frontend", "backend"], true],
    ["Other only", ["other"], false],
  ] as [string, RoleFamilyValue[], boolean][])(
    "%s",
    async (_name, targetRoleFamilies, hint) => {
      openHiring({
        criteria: { targetRoleFamilies, frameworks: ["React"] },
        stack: { hiringVerification: ownRecord21Oct },
      })
      // Phase 3 is shipped in this build: its section is present on its own tab.
      await showTab("Set up alerts")
      expect(
        await screen.findByRole("region", { name: "Hiring alert feeds" })
      ).toBeInTheDocument()
      await showTab("Search")
      const links = await screen.findByRole("region", {
        name: "Hiring search links",
      })
      const check = await checkRegion()
      if (hint) {
        expect(
          await within(links).findByText(HINT, { exact: false })
        ).toBeVisible()
        expect(within(check).getByText(HELP_WITH_HINT)).toBeVisible()
        expect(within(check).queryByText(HELP_SOLO)).not.toBeInTheDocument()
      } else {
        expect(
          await within(links).findByText("No role family to search for")
        ).toBeVisible()
        expect(
          within(links).queryByText(HINT, { exact: false })
        ).not.toBeInTheDocument()
        expect(within(check).getByText(HELP_SOLO)).toBeVisible()
        expect(
          within(check).queryByText(HELP_WITH_HINT)
        ).not.toBeInTheDocument()
      }
    }
  )
})

describe("HP:222 (r6) the privacy page states the posts retention under the 12-month rule", () => {
  it("C-RET-1, then C-DATA-1 after it; neither removed sentence is shown", async () => {
    openDocuments("/privacy")
    const region = await screen.findByRole("region", { name: "Retention" })
    const rule = within(region).getByText(
      "Detailed records are deleted automatically 12 months after creation, on the same date one year later. This covers documents, answers and Outcomes. Minimal records stay to block duplicates."
    )
    const posts = within(region).getByText(
      "Eve deletes posts from your field and Hiring posts 90 days after it first finds them, and keeps no more than your newest 2,000 of each."
    )
    expect(
      rule.compareDocumentPosition(posts) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(region).not.toHaveTextContent("Outcomes stay until you delete them")
    expect(region).not.toHaveTextContent("Nothing is deleted automatically.")
  })
})
