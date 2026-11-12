import { screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { rankedPosting } from "@/shared/testing"
import {
  applicationLink,
  checkLink,
  checkRegion,
  openHiring,
} from "./hiring-view-helpers"

/**
 * EPIC-0006 B7 in Check this job (integration of EPIC-0006 into EPIC-0007
 * Phase 2): a saved hidden posting shows the B7 status line (copy-deck.r1.md
 * `addJobLink.hidden.*`) instead of "Job Posting saved." and the toast.
 */
const GREENHOUSE = "https://boards.greenhouse.io/acme/jobs/4012345"
const LINK_ACCEPTED_START = /^Checking the link\./

describe("Check this job: hidden result (EPIC-0006 B7)", () => {
  it.each([
    ["undated", "no posted date"],
    ["off_target", "off-target role"],
    ["below_seniority_floor", "entry-level role"],
    ["older_than_60_days", "posted more than 60 days ago"],
  ] as const)(
    "a new %s link: 'Saved, but hidden: %s.' with View it, no toast and no 'Job Posting saved.'",
    async (reason, phrase) => {
      const { user, discovery, currentPath } = openHiring({
        discovery: {
          nextPasted: (url) =>
            rankedPosting({
              applicationUrl: url,
              applyUrl: url,
              status: "not_checked",
              rank: null,
              hiddenReason: reason,
            }),
        },
      })
      const field = await applicationLink()
      await user.type(field, GREENHOUSE)
      await user.click(checkLink())

      const region = await checkRegion()
      const line = await within(region).findByRole("status")
      expect(line).toHaveTextContent(`Saved, but hidden: ${phrase}. View it`)
      expect(
        within(region).queryByText("Job Posting saved.")
      ).not.toBeInTheDocument()
      expect(screen.queryByText(LINK_ACCEPTED_START)).not.toBeInTheDocument()
      expect(field).toHaveValue("")
      expect(field).toHaveFocus()
      expect(field).toHaveAccessibleDescription(
        expect.stringContaining(`Saved, but hidden: ${phrase}.`)
      )
      const posting = discovery.state.postings[0]
      await user.click(within(line).getByRole("link", { name: "View it" }))
      expect(currentPath()).toBe(`/postings/${posting.id}`)
    }
  )

  it("a known hidden link shows the hidden existing line with View it and keeps the input", async () => {
    const stored = rankedPosting({
      applicationUrl: GREENHOUSE,
      hiddenReason: "below_seniority_floor",
      rank: null,
    })
    const { user, discovery, currentPath } = openHiring({
      discovery: { postings: [stored] },
    })
    const field = await applicationLink()
    await user.type(field, GREENHOUSE)
    await user.click(checkLink())

    const region = await checkRegion()
    const line = await within(region).findByRole("status")
    expect(line).toHaveTextContent(
      "You already have this Job Posting. It's hidden: entry-level role. View it"
    )
    expect(field).toHaveValue(GREENHOUSE)
    expect(discovery.state.postings).toHaveLength(1)
    await user.click(within(line).getByRole("link", { name: "View it" }))
    expect(currentPath()).toBe(`/postings/${stored.id}`)
  })

  it("editing the field clears the hidden line", async () => {
    const { user } = openHiring({
      discovery: {
        nextPasted: (url) =>
          rankedPosting({
            applicationUrl: url,
            applyUrl: url,
            rank: null,
            hiddenReason: "off_target",
          }),
      },
    })
    const field = await applicationLink()
    await user.type(field, GREENHOUSE)
    await user.click(checkLink())
    const region = await checkRegion()
    await within(region).findByText(/Saved, but hidden: off-target role\./)
    await user.type(field, "h")
    expect(within(region).queryByRole("status")).not.toBeInTheDocument()
  })
})
