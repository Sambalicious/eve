import { describe, expect, it } from "vitest"

import { jobPostingCopy, skipLine } from "./copy"
import { countLine, formatCopy, loadedAnnouncement, postingsCopy } from "./postings-copy"
// The approved copy deck itself, so a drift between deck and build fails here.
import deck from "../../../../../../epics/active/EPIC-0001-job-application-assistant/copy-deck-slice-08-postings-paging-filter.r1.md?raw"
// EPIC-0002 copy-deck.r4 (D17) changes slice 8 keys for the four tabs; those keys are checked against it.
import deckR4 from "../../../../../../epics/active/EPIC-0002-multi-user-onboarding/copy-deck.r4.md?raw"


/** Every `| \`key\` | screen | state | copy | …` row of the deck's two slot tables. */
function deckSlots(source: string = deck): Map<string, string> {
  const slots = new Map<string, string>()
  for (const line of source.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim())
    // A key cell may carry a revision mark: "`postings.familyMenu.title` (r1)".
    const key = /^`((?:postings|postingDetail)\.[\w.]+)`(?: \(r\d+\))?$/.exec(cells[1] ?? "")?.[1]
    if (!key || cells.length < 6) continue
    slots.set(key, cells[4].replace(/^`(.*)`$/, "$1"))
  }
  return slots
}

/**
 * Slots EPIC-0006 `copy-deck.r1.md` supersedes: the 13 `family.*` labels and the
 * waiting notice. `relevance-copy.test.ts` checks them against that deck instead.
 */
const SUPERSEDED_BY_EPIC_0006 = (key: string) => key.startsWith("postings.family.") || key.startsWith("postings.waitingNotice.")

/**
 * Slots EPIC-0011 rewrites (copy-deck.md: jobs.empty.*, posting.detail.applyOnSite and the reason lines that no
 * longer say Skipped or Excluded). The older decks no longer describe them; they are checked below instead.
 */
const REWRITTEN_BY_EPIC_0011: Readonly<Record<string, string>> = {
  "postings.firstRun.title": "No jobs yet",
  "postings.firstRun.text": "Every job Eve finds or you paste appears here. Paste one on Home to start.",
  "postings.firstRun.action": "Find jobs",
  "postings.rankedEmpty.title": "No good matches yet",
  "postings.rankedEmpty.text": "Jobs that fit your profile appear here. Paste one on Home or set up alerts.",
  "postings.list.skipNotSoftware": "This isn't a software engineering role.",
}

/** What the build renders for a deck key. Function slots are rendered with their placeholder. */
function built(key: string): string | undefined {
  if (key === "postingDetail.meta.familyLabel") return jobPostingCopy.roleFamilyLabel
  if (key === "postings.list.skipNotSoftware") return skipLine({ skipReason: "not_software_role", skipDetail: null, applicationSystem: "", coverage: null }) ?? undefined
  let node: unknown = postingsCopy
  for (const part of key.split(".").slice(1)) {
    node = typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : undefined
  }
  return typeof node === "string" ? node : undefined
}

describe("postingsCopy follows the copy deck", () => {
  const slots = deckSlots()

  it("reads all 56 slots of the deck", () => {
    expect(slots.size).toBe(56)
  })

  const r4 = deckSlots(deckR4)
  it.each([...slots].filter(([key]) => !SUPERSEDED_BY_EPIC_0006(key) && !(key in REWRITTEN_BY_EPIC_0011)))("%s is the deck's copy", (key, copy) => {
    expect(built(key)).toBe(r4.get(key) ?? copy)
  })

  it.each(Object.entries(REWRITTEN_BY_EPIC_0011))("EPIC-0011 rewrites %s", (key, copy) => {
    expect(built(key)).toBe(copy)
  })
})

describe("countLine picks the slot by filter and nextCursor", () => {
  it.each([
    [{ total: 1, loaded: 1, hasMore: false, filtered: false }, "1 posting"],
    [{ total: 12, loaded: 12, hasMore: false, filtered: false }, "12 postings"],
    [{ total: 1204, loaded: 25, hasMore: true, filtered: false }, "Showing 25 of 1,204 postings"],
    [{ total: 1, loaded: 1, hasMore: false, filtered: true }, "1 matching posting"],
    [{ total: 12, loaded: 12, hasMore: false, filtered: true }, "12 matching postings"],
    [{ total: 26, loaded: 25, hasMore: true, filtered: true }, "Showing 25 of 26 matching postings"],
    [{ total: 12345, loaded: 1000, hasMore: true, filtered: true }, "Showing 1,000 of 12,345 matching postings"],
    // Data changed between pages: the wording follows nextCursor, not loaded vs total.
    [{ total: 50, loaded: 50, hasMore: true, filtered: false }, "Showing 50 of 50 postings"],
    [{ total: 60, loaded: 50, hasMore: false, filtered: false }, "60 postings"],
  ])("%o reads %s", (input, text) => {
    expect(countLine(input)).toBe(text)
  })
})

describe("loadedAnnouncement", () => {
  it.each([
    [{ added: 25, loaded: 50, total: 60, hasMore: true }, "25 more postings loaded. Showing 50 of 60."],
    [{ added: 1, loaded: 26, total: 60, hasMore: true }, "1 more posting loaded. Showing 26 of 60."],
    [{ added: 24, loaded: 49, total: 49, hasMore: false }, "24 more postings loaded. All 49 are shown."],
    [{ added: 1, loaded: 1204, total: 1204, hasMore: false }, "1 more posting loaded. All 1,204 are shown."],
  ])("%o reads %s", (input, text) => {
    expect(loadedAnnouncement(input)).toBe(text)
  })
})

describe("formatCopy", () => {
  it("fills the restart announcement with the count line", () => {
    expect(formatCopy(postingsCopy.announce.restarted, { countLine: "Showing 25 of 60 postings" })).toBe(
      "The list started over from the top. Showing 25 of 60 postings."
    )
  })

  it("leaves an unknown placeholder as written", () => {
    expect(formatCopy("{k} and {x}", { k: 1 })).toBe("1 and {x}")
  })
})
