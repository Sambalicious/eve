import { describe, expect, it } from "vitest"

import { stackPostsTarget } from "./legacy-targets"

describe("stackPostsTarget (FJ:AC-5.6, email link shapes)", () => {
  it("keeps the Hiring view's params and anchor", () => {
    expect(stackPostsTarget("?view=hiring&family=backend&page=2", "#hiring-posts")).toBe("/find-jobs?view=hiring&family=backend&page=2#hiring-posts")
  })
  it("sends the Stack view to its section, moving its page to spage", () => {
    expect(stackPostsTarget("", "")).toBe("/find-jobs#practitioner-posts")
    expect(stackPostsTarget("?page=3", "#posts")).toBe("/find-jobs?spage=3#practitioner-posts")
  })
  it("keeps any other anchor", () => {
    expect(stackPostsTarget("", "#alert-feeds")).toBe("/find-jobs#alert-feeds")
  })
})
