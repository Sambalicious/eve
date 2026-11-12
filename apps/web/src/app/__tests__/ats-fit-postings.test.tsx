import { screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { rankedPosting, strongMatch } from "@/shared/testing"
import { openDiscovery } from "./discovery-helpers"

describe("ATS fit on Job Postings", () => {
  it("shows a ranked posting's ATS fit next to its Match, and nothing for a posting scored before ATS", async () => {
    openDiscovery("/postings?tab=good", {
      postings: [
        rankedPosting({ title: "Staff Frontend Engineer", match: { ...strongMatch(), atsFit: 67 } }),
        rankedPosting({ title: "Senior Frontend Engineer", match: strongMatch(), rank: 2 }),
      ],
    })
    const table = await screen.findByRole("table")
    expect(await within(table).findByText("2 of 2 · ATS 67%")).toBeInTheDocument()
    expect(within(table).getByText("2 of 2")).toBeInTheDocument()
  })
})
