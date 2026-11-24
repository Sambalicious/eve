import { describe, expect, it } from "vitest"

import { hiringCafeLinks, hiringCafeUrl } from "./hiringcafe-search"

describe("hiringCafeUrl", () => {
  it("encodes the title as a searchQuery in searchState", () => {
    const url = new URL(hiringCafeUrl("frontend engineer"))
    expect(url.origin + url.pathname).toBe("https://hiring.cafe/")
    expect(JSON.parse(url.searchParams.get("searchState")!)).toEqual({ searchQuery: "frontend engineer" })
  })
})

describe("hiringCafeLinks", () => {
  it("gives one link per target family that has a title, first phrase as label", () => {
    const links = hiringCafeLinks(["senior_frontend", "backend", "other"])
    expect(links.map((l) => l.label)).toEqual(["frontend engineer", "backend engineer"])
  })
  it("gives no links without targets", () => {
    expect(hiringCafeLinks([])).toEqual([])
  })
})
