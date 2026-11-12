import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { foldForKeywords } from "../../discovery/rules/rule-result.js"
import { frozenClassifyTitle, frozenFold } from "./0011-postings-paging-filter.js"

/**
 * Slice 8d (8d.18, D8d-7; RF-32, RF-33): migration 0011 is frozen. Its own
 * copies of the fold and the title classifier agree with the live functions
 * (unchanged since 121802c) over every title in the RF and PRE features plus
 * 500 generated titles, so freezing it changes no result today.
 */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const GHERKIN = "../../../../../epics/active/EPIC-0001-job-application-assistant/gherkin/"

/** Every table cell and every double-quoted string in a feature file: a superset of its titles. */
function featureStrings(file: string): string[] {
  const text = readFileSync(here(`${GHERKIN}${file}`), "utf8")
  const found = new Set<string>()
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("#")) continue
    if (line.trim().startsWith("|")) for (const cell of line.split("|").slice(1, -1)) found.add(cell.trim())
    for (const match of line.matchAll(/"([^"]*)"/g)) found.add(match[1]!)
  }
  return [...found].filter((value) => value !== "")
}

function generatedTitles(count: number): string[] {
  const words = [
    "Senior", "Staff", "Lead", "Principal", "Frontend", "Front-End", "Backend", "Back End", "Fullstack", "Full Stack", "Product",
    "Engineer", "Developer", "Tech Lead", "Engineering Manager", "Head of Engineering", "Director", "React", "React Native", "iOS",
    "Android", "Mobile", "Flutter", "DevOps", "SRE", "Platform", "Infrastructure", "Cloud", "Server-Side", "Data", "UI Engineer",
    "Web Engineer", "Team Lead", "VP", "Kotlin Multiplatform", "Site Reliability", "Software", "Développeur", "DÉVELOPPEUR", "U.S.",
    "Back\u2010End", "Soft\u00adware", "Ingénieur", "Sales", "Specialist", "(m/w/d)", "Head of Infrastructure",
  ]
  let seed = 8_018
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed
  }
  return Array.from({ length: count }, () => Array.from({ length: 1 + (next() % 5) }, () => words[next() % words.length]).join(next() % 3 === 0 ? "  " : " "))
}

const corpus = [...featureStrings("role-family-classification.feature"), ...featureStrings("pre-filter-titles.feature")]
const generated = generatedTitles(500)

describe("migration 0011 frozen copies (8d.18)", () => {
  it("the corpus holds the RF and PRE titles", () => {
    expect(corpus).toEqual(expect.arrayContaining(["Head of Infrastructure", "Senior Backend Engineer", "DÉVELOPPEUR MOBILE", "Sales Engineer", "Développeur·euse Full Stack"]))
    expect(corpus.length).toBeGreaterThan(200)
    expect(generated).toHaveLength(500)
  })

  /**
   * RF-33 (EPIC-0006, architecture.r1 "Migration interplay"): EPIC-0006 changed the live classifier on purpose,
   * so 0011's frozen classifier is now compared with a snapshot of its own outputs (captured from 0011 at
   * cdd6102, when it still equalled the slice 8 live classifier). The fold still matches the live fold.
   * 0020-frozen.spec.ts compares the live classifier with 0020's copy.
   */
  it("RF-33: the frozen fold agrees with the live fold, and the frozen classifier with its own snapshot", () => {
    const snapshot = JSON.parse(readFileSync(here("./__fixtures__/0011-classifier.snap.json"), "utf8")) as Record<string, string>
    const titles = [...corpus, ...generated]
    expect(titles.filter((title) => frozenFold(title) !== foldForKeywords(title))).toEqual([])
    expect(Object.fromEntries(titles.map((title) => [title, frozenClassifyTitle(title)]))).toEqual(snapshot)
  })

  it("RF-32: the migration imports no application code", () => {
    const source = readFileSync(here("./0011-postings-paging-filter.ts"), "utf8")
    const imports = [...source.matchAll(/^import .* from "([^"]+)"/gm)].map((match) => match[1])
    expect(imports).toEqual(["kysely"])
    expect(source).not.toMatch(/\bfoldForKeywords\(|\bclassifyRoleFamily\(/)
  })
})
