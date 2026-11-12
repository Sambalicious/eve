import { describe, expect, it } from "vitest"

import { evaluationFailureLine, roleFamilyLabel } from "./copy"
import { ROLE_FAMILIES } from "./job-posting"
import { ageLabel, hiddenCountsLine, hiddenReasonHasSettingsLink, pastedHiddenLine, relevanceCopy, waitingNoticeText } from "./relevance-copy"
// The approved EPIC-0006 deck, so a drift between deck and build fails here.
import deck from "../../../../../../epics/active/EPIC-0006-role-relevance-filter/copy-deck.r1.md?raw"

/** `key -> copy` for every `| key | screen | state | copy | …` row. */
function deckRows(): Map<string, string> {
  const rows = new Map<string, string>()
  for (const line of deck.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim())
    if (cells.length < 6 || !/^[a-zA-Z]+(\.[\w]+)+$/.test(cells[1] ?? "")) continue
    rows.set(cells[1], cells[4])
  }
  return rows
}

/** Built copy for a deck key: singular and plural joined with " / " like the deck. */
function built(key: string): string | undefined {
  if (key.startsWith("family.")) return roleFamilyLabel[key.slice("family.".length) as keyof typeof roleFamilyLabel]
  if (key.startsWith("posting.failure.")) return evaluationFailureLine[key.slice("posting.failure.".length) as keyof typeof evaluationFailureLine]
  let node: unknown = relevanceCopy
  for (const part of key.split(".")) node = typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : undefined
  if (typeof node === "string") return node
  if (typeof node === "object" && node !== null && "one" in node && "other" in node) return `${node.one} / ${node.other}`
  return undefined
}

const CHECKED_PREFIXES = ["addJobLink.", "family.", "posting.", "postingDetail.", "postings.hidden.", "postings.allHidden.", "postings.checkAgain.", "postings.waitingNotice.", "api.error."]
// Composition rules and inline-API slots, not literal strings.
const NOT_LITERAL = new Set(["postings.hidden.join", "postings.checkAgain.dialog.errorApi", "postings.announce.queued", "postings.announce.waiting"])
// EPIC-0011 copy-review-full D14 replaces "Job Source" with "job board" on this line; the approved EPIC-0006 deck keeps the old text.
const CHANGED_BY_EPIC_0011 = new Set(["postings.allHidden.bodyUndated"])

describe("relevance copy follows copy-deck.r1", () => {
  const rows = [...deckRows()].filter(([key]) => CHECKED_PREFIXES.some((prefix) => key.startsWith(prefix)) && !NOT_LITERAL.has(key) && !CHANGED_BY_EPIC_0011.has(key))

  it("reads the deck's rows", () => {
    expect(rows.length).toBeGreaterThan(50)
  })

  // EPIC-0011 names the screen "Jobs" (copy-deck.md status.reason.notCheckedYet), so these four lines say "on Jobs".
  const jobsNamed = (copy: string) => copy.replace("Check again on Job Postings", "Check again on Jobs")
  it.each(rows)("%s is the deck's copy", (key, copy) => {
    expect(built(key)).toBe(key === "posting.notCheckedYet.line" || key.startsWith("posting.failure.") ? jobsNamed(copy) : copy)
  })

  it("has a label for every one of the 13 families, in catalog order", () => {
    expect(ROLE_FAMILIES.map((family) => roleFamilyLabel[family])).toEqual([
      "Frontend",
      "Hands-on technical lead",
      "Fullstack",
      "Product engineering",
      "Software engineering",
      "Backend",
      "Mobile",
      "Platform engineering",
      "DevOps and SRE",
      "Engineering management",
      "Data and ML",
      "Solutions and customer engineering",
      "Other",
    ])
  })

  it("no failure line says 'Paste the link again later'", () => {
    for (const line of Object.values(evaluationFailureLine)) expect(line).not.toContain("Paste the link again later")
  })
})

describe("ageLabel", () => {
  it.each([
    [null, null],
    [{ on: "2026-09-24", kind: "published" as const, ageDays: 30 }, null],
    [{ on: "2026-09-23", kind: "published" as const, ageDays: 31 }, "Posted 31 days ago"],
    [{ on: "2026-09-09", kind: "updated" as const, ageDays: 45 }, "Updated 45 days ago"],
    [{ on: "2023-07-08", kind: "published" as const, ageDays: 1204 }, "Posted 1,204 days ago"],
  ])("%o reads %s", (postedDate, label) => {
    expect(ageLabel(postedDate)).toBe(label)
  })
})

describe("hiddenCountsLine", () => {
  const counts = (offTarget: number, belowSeniorityFloor: number, undated: number, olderThan60Days: number) => ({
    offTarget,
    belowSeniorityFloor,
    undated,
    olderThan60Days,
    total: offTarget + belowSeniorityFloor + undated + olderThan60Days,
  })
  it.each([
    [counts(1247, 12, 0, 34), "1,293 postings hidden: 1,247 off-target roles, 12 entry-level and 34 older than 60 days."],
    [counts(4, 0, 2, 0), "6 postings hidden: 4 off-target roles and 2 with no posted date."],
    [counts(1, 0, 0, 0), "1 posting hidden: 1 off-target role."],
    [counts(0, 0, 2222, 0), "2,222 postings hidden: 2,222 with no posted date."],
    [counts(1, 1, 1, 1), "4 postings hidden: 1 off-target role, 1 entry-level, 1 with no posted date and 1 older than 60 days."],
  ])("%o reads %s", (input, line) => {
    expect(hiddenCountsLine(input)).toBe(line)
  })

  it("is null when nothing is hidden", () => {
    expect(hiddenCountsLine(counts(0, 0, 0, 0))).toBeNull()
  })
})

describe("waitingNoticeText", () => {
  it("uses the cost-pause text for cost_pause and the invitee text otherwise", () => {
    expect(waitingNoticeText("cost_pause", 2)).toBe(
      "2 postings are waiting to be checked. Eve checks them when the cost pause ends, then ranks them with the rest."
    )
    expect(waitingNoticeText("checks_not_enabled", 1)).toBe(
      "1 posting is waiting to be checked. It isn't checked until the person who runs your Eve turns on checks for you."
    )
  })
})

describe("pastedHiddenLine", () => {
  it("names the reason for a new and a known link", () => {
    expect(pastedHiddenLine(true, "undated")).toBe("Saved, but hidden: no posted date.")
    expect(pastedHiddenLine(false, "below_seniority_floor")).toBe("You already have this Job Posting. It's hidden: entry-level role.")
  })
})

describe("hiddenReasonHasSettingsLink", () => {
  it("links only for setting-driven reasons (P15)", () => {
    expect(hiddenReasonHasSettingsLink("off_target")).toBe(true)
    expect(hiddenReasonHasSettingsLink("below_seniority_floor")).toBe(true)
    expect(hiddenReasonHasSettingsLink("undated")).toBe(false)
    expect(hiddenReasonHasSettingsLink("older_than_60_days")).toBe(false)
  })
})
