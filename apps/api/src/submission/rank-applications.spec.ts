import { describe, expect, it } from "vitest"

import { type RankableApplication, rankApplications } from "./rank-applications.js"

/** Slice 8d (CR8D-05, SEC-8D-05): queue ranking with no cast and no one-Application-per-posting assumption. */
const at = new Date("2026-10-01T08:00:00.000Z")
const row = (id: string, posting: string, covered = 8): RankableApplication => ({
  id,
  job_posting_id: posting,
  role_family: "senior_frontend",
  covered_count: covered,
  total_count: 10,
  discovered_at: at,
  origin: "employer_board",
})

describe("rankApplications", () => {
  it("a full tie is broken on the posting id, not the Application id (RF-27, RF-28)", () => {
    const rows = [row("ffffffff-0000-4000-8000-000000000001", "00000000-0000-4000-8000-00000000000a"), row("11111111-0000-4000-8000-000000000001", "00000000-0000-4000-8000-00000000000b")]
    expect(rankApplications(rows)).toEqual(["ffffffff-0000-4000-8000-000000000001", "11111111-0000-4000-8000-000000000001"])
  })

  it("earlier keys still decide before any id", () => {
    const rows = [row("a1", "00000000-0000-4000-8000-00000000000a", 5), row("b1", "00000000-0000-4000-8000-00000000000b", 9)]
    expect(rankApplications(rows)).toEqual(["b1", "a1"])
  })

  it("two Applications of one posting are both kept once, ordered by Application id, next to each other", () => {
    const shared = "00000000-0000-4000-8000-00000000000b"
    const rows = [row("app-z", shared), row("app-a", shared), row("app-m", "00000000-0000-4000-8000-00000000000a"), row("app-q", "00000000-0000-4000-8000-00000000000c")]
    expect(rankApplications(rows)).toEqual(["app-m", "app-a", "app-z", "app-q"])
  })

  it("returns every input id exactly once", () => {
    const rows = Array.from({ length: 50 }, (_, index) => row(`app-${index}`, `00000000-0000-4000-8000-${String(index % 7).padStart(12, "0")}`, index % 3))
    const order = rankApplications(rows)
    expect([...order].sort()).toEqual(rows.map((item) => item.id).sort())
  })

  it("an empty queue ranks to nothing", () => {
    expect(rankApplications([])).toEqual([])
  })
})
