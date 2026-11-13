import { describe, expect, it } from "vitest"
import { readCopyDeck } from "@/shared/testing/copy-deck"

import { fillCopy, linkNameSuffix, plural, retentionCopy } from "./copy"
// The approved copy deck itself, so a drift between deck and build fails here.
const deck = readCopyDeck("epics/active/EPIC-0001-job-application-assistant/copy-deck-12-month-expiry.md")
const hasDeck = deck !== null

/** Every `| C-RET-x \`key\` | screen | state | copy | …` row of the deck's slot table: key → copy cell. */
function deckSlots(): Map<string, string> {
  const slots = new Map<string, string>()
  for (const line of (deck ?? "").split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim())
    const key = /^C-RET-[\w]+ `([\w.]+)`$/.exec(cells[1] ?? "")?.[1]
    if (!key || cells.length < 6) continue
    slots.set(key, cells[4])
  }
  return slots
}

/** The daily summary lines are rendered by the api's email, not the web app. */
const EMAIL_KEYS = ["email.dailySummary.retention", "email.dailySummary.retention.heading", "email.dailySummary.retention.link"]

/** The deck's cell for a web slot, in the shape `retentionCopy` keeps it. */
function expected(key: string, cell: string): unknown {
  const parts = cell.split("<br>")
  if (key === "privacy.retention.due.value") {
    const noDate = /^date missing: one "(.+)", other "(.+)"$/.exec(parts[2])
    return { one: parts[0].replace(/^one: /, ""), other: parts[1].replace(/^other: /, ""), oneNoDate: noDate?.[1], otherNoDate: noDate?.[2] }
  }
  if (key === "privacy.retention.minimalHelp") return { text: parts[0], link: parts[1].replace(/^Link: /, "") }
  if (key === "applications.row.expires.none") {
    return { visible: parts[0].replace(/^Visible: (\S+) .*$/, "$1"), srOnly: parts[1].replace(/^sr-only: /, "") }
  }
  if (parts.length === 2) {
    const forms = Object.fromEntries(parts.map((p) => /^(one|other): (.+)$/.exec(p)!.slice(1, 3)))
    return { one: forms.one, other: forms.other }
  }
  return cell
}

describe.skipIf(!hasDeck)("retentionCopy follows the copy deck (copy-deck-12-month-expiry.md r2)", () => {
  const slots = deckSlots()
  const web = [...slots].filter(([key]) => !EMAIL_KEYS.includes(key))

  it("reads all 34 C-RET slots of the deck; 31 are web strings, including C-RET-22 and C-RET-A3", () => {
    expect(slots.size).toBe(34)
    expect(web).toHaveLength(31)
    expect(slots.get("privacy.retention.graceStarts")).toBe("Automatic deletion starts on {date}.")
    expect(slots.has("applications.row.expires.none")).toBe(true)
  })

  it.each(web)("%s is the deck's copy", (key, cell) => {
    expect(retentionCopy[key as keyof typeof retentionCopy]).toEqual(expected(key, cell))
  })

  it("the build has no C-RET key the deck lacks", () => {
    expect(Object.keys(retentionCopy).filter((key) => !slots.has(key))).toEqual([])
  })
})

describe("plural and fillCopy", () => {
  it.each([
    [1, "1 record is past 12 months and waits for your decision"],
    [2, "2 records are past 12 months and wait for your decision"],
    [1250, "1,250 records are past 12 months and wait for your decision"],
  ])("C-RET-6 for %i reads %s", (n, text) => {
    expect(fillCopy(plural(n, retentionCopy["privacy.retention.waiting.value"]), { n })).toBe(text)
  })

  it("leaves an unknown placeholder as written", () => {
    expect(fillCopy("{n} and {x}", { n: 3 })).toBe("3 and {x}")
  })
})

describe("C-RET-A1/A2 start with the visible link text (WCAG 2.5.3, deck r3)", () => {
  it.each([
    ["C-RET-5 / C-RET-A1", "privacy.retention.due.link", "privacy.retention.due.linkLabel"],
    ["C-RET-7 / C-RET-A2", "privacy.retention.waiting.link", "privacy.retention.waiting.linkLabel"],
  ] as const)("%s, one and other forms", (_, link, label) => {
    for (const form of ["one", "other"] as const) {
      expect(retentionCopy[label][form].startsWith(retentionCopy[link][form])).toBe(true)
    }
  })

  it("linkNameSuffix returns the sr-only rest and refuses a name that drops the visible text", () => {
    expect(linkNameSuffix("Review them", "Review them, 2 records waiting for your decision")).toBe(", 2 records waiting for your decision")
    expect(() => linkNameSuffix("Review them", "Review the 2 records waiting for your decision")).toThrow()
  })
})
