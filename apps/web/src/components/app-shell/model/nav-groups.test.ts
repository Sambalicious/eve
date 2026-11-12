import { describe, expect, it } from "vitest"

import { SAFE_VIEWER, type Viewer } from "@/entities/viewer"
import { navModel, needsYouEntry } from "./nav-groups"

const on: Viewer = { ...SAFE_VIEWER, advancedEnabled: true }
const titles = (viewer: Viewer, counts = {}) => navModel(viewer, counts, null).groups.flatMap((g) => g.items.map((i) => i.title))

describe("navModel (NAV:21, NAV:30, NAV:74)", () => {
  it("Advanced off: exactly the seven default items (Pipeline added in v1.29.0), no group heading", () => {
    const model = navModel(SAFE_VIEWER, {}, null)
    expect(titles(SAFE_VIEWER)).toEqual(["Home", "Jobs", "Find jobs", "Applications", "Pipeline", "Profile", "Settings"])
    expect(model.groups.map((g) => g.label)).toEqual([null])
    expect(model.needsYou).toBeNull()
  })

  it("Advanced on: the six plus the Automatic applying group of five", () => {
    const model = navModel(on, {}, null)
    expect(model.groups.map((g) => g.label)).toEqual([null, "Automatic applying"])
    expect(model.groups[1].items.map((i) => i.title)).toEqual(["Check first sends", "Blocked", "Unsure sends", "Form answers", "Pause and cost"])
    expect(model.groups[1].items.map((i) => i.url)).toEqual(["/activation", "/blocked", "/uncertain", "/answers", "/pause-and-cost"])
  })

  it("never lists Documents, Job Sources, Stack posts, Approved Answers or Existing applications", () => {
    for (const viewer of [SAFE_VIEWER, on]) {
      const all = titles(viewer).join("|")
      for (const gone of ["Documents", "Job Sources", "Stack posts", "Approved Answers", "Existing applications"]) {
        expect(all).not.toContain(gone)
      }
    }
  })

  it("a locked viewer shows Advanced even when the stored flag disagrees", () => {
    expect(navModel({ ...SAFE_VIEWER, advancedLocked: true }, {}, null).groups).toHaveLength(2)
  })

  it("badges the group items with their counts and keeps the strip for Advanced off only", () => {
    const counts = { blocked: 2, sameCompany: 1, uncertain: 1, sample: 3 }
    const model = navModel(on, counts, null)
    expect(model.groups[1].items.map((i) => i.badge)).toEqual(["3", "3", "1", undefined, undefined])
    expect(model.needsYou).toBeNull()
    expect(navModel(SAFE_VIEWER, counts, null).needsYou?.total).toBe(7)
  })
})

describe("needsYouEntry (NAV:95, NAV:111, NAV:119)", () => {
  it.each([
    [{ blocked: 2 }, 2, "/blocked"],
    [{ uncertain: 1 }, 1, "/uncertain"],
    [{ sameCompany: 1 }, 1, "/blocked"],
    [{ sample: 3 }, 3, "/activation"],
    [{ blocked: 1, sameCompany: 1 }, 2, "/blocked"],
  ])("one destination %j links straight there", (counts, total, url) => {
    const entry = needsYouEntry(counts)
    expect(entry?.total).toBe(total)
    expect(entry?.directUrl).toBe(url)
  })

  it("counts every kind together and lists a row per kind", () => {
    const entry = needsYouEntry({ blocked: 1, uncertain: 1, sample: 1 })
    expect(entry?.total).toBe(3)
    expect(entry?.directUrl).toBeNull()
    expect(entry?.rows.map((r) => r.url)).toEqual(["/blocked", "/uncertain", "/activation"])
  })

  it("is absent when nothing needs the user", () => {
    expect(needsYouEntry({})).toBeNull()
    expect(needsYouEntry({ blocked: 0 })).toBeNull()
  })
})
