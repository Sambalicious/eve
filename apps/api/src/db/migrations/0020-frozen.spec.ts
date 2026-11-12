import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { classifyRoleFamily } from "../../discovery/rules/ranking.js"
import { foldForKeywords } from "../../discovery/rules/rule-result.js"
import { seniorityMarker } from "../../discovery/rules/seniority.js"
import { frozenFamilyWithDuties, frozenFold, frozenMigratedFamily, frozenSeniority } from "./0020-role-relevance.js"

/**
 * EPIC-0006 (architecture.r1 "Schema: migration 0020"): 0020 carries frozen
 * copies of the fold, the 13-family classifier and the seniority marker. They
 * agree with the live functions over every string in the EPIC-0006 and slice 8
 * role-family, seniority and pre-filter features plus 600 generated titles.
 */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const EPICS = "../../../../../epics/active/"

function featureStrings(path: string): string[] {
  const text = readFileSync(here(`${EPICS}${path}`), "utf8")
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
    "Senior", "Staff", "Lead", "Principal", "Junior", "Jr.", "Intern", "Graduate", "Mid-level", "Frontend", "Backend", "Fullstack",
    "Product", "Engineer", "Developer", "Software", "Data", "ML", "Machine Learning", "Solutions", "Architect", "TAM", "Platform",
    "DevOps", "SRE", "QA", "Test", "Manager", "Engineering Manager", "Head of", "Director", "iOS", "Android", "Customer", "Analytics",
    "Développeur", "Entwickler", "Apprentice", "Trainee", "Werkstudent", "Reliability", "Infrastructure", "Cloud", "Tech Lead", "MTS",
  ]
  let seed = 20_020
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed
  }
  return Array.from({ length: count }, () => Array.from({ length: 1 + (next() % 5) }, () => words[next() % words.length]).join(" "))
}

const epic6 = readdirSync(here(`${EPICS}EPIC-0006-role-relevance-filter/gherkin/`))
  .filter((name) => name.endsWith(".feature"))
  .flatMap((name) => featureStrings(`EPIC-0006-role-relevance-filter/gherkin/${name}`))
const slice8 = ["role-family-classification.feature", "pre-filter-titles.feature"].flatMap((name) => featureStrings(`EPIC-0001-job-application-assistant/gherkin/${name}`))
const corpus = [...new Set([...epic6, ...slice8, ...generatedTitles(600)])]
const DUTIES = [[], ["Hiring and performance reviews for direct reports"], ["Write production React code"], ["Line management of 8 engineers", "Ship features"]]

describe("migration 0020 frozen copies", () => {
  it("the corpus holds the AC-1.3 and AC-2.3 fixture titles", () => {
    expect(corpus).toEqual(expect.arrayContaining(["TAM Architect", "Senior Platform Engineer", "Jr. Software Engineer", "Leader Junior Developer", "Head of Infrastructure"]))
    expect(corpus.length).toBeGreaterThan(1000)
  })

  it("the frozen fold, classifier and seniority marker agree with the live functions on every title", () => {
    const disagreements = corpus.filter(
      (title) =>
        frozenFold(title) !== foldForKeywords(title) ||
        DUTIES.some((duties) => frozenFamilyWithDuties(title, duties) !== classifyRoleFamily(title, duties)) ||
        (title.trim() !== "" && frozenSeniority(title) !== seniorityMarker(title))
    )
    expect(disagreements).toEqual([])
  })

  it("the migrated family only lets duties move technical_lead to people_management (AC-1.8, AC-8.2)", () => {
    expect(frozenMigratedFamily("Engineering Lead", ["Hiring and performance reviews for direct reports"])).toBe("people_management")
    expect(frozenMigratedFamily("Engineering Lead", ["Write production React code"])).toBe("technical_lead")
    expect(frozenMigratedFamily("Engineering Lead", [])).toBe("technical_lead")
    // Untitled-style duty rule never applies to other families during the migration.
    expect(frozenMigratedFamily("Senior Software Engineer", ["Hiring and performance reviews for direct reports"])).toBe("software_engineering")
    expect(frozenMigratedFamily("Senior Data Engineer", ["Hiring and performance reviews for direct reports"])).toBe("data_ml")
  })

  it("the migration imports no application code beyond the schema marker helper", () => {
    const source = readFileSync(here("./0020-role-relevance.ts"), "utf8")
    const imports = [...source.matchAll(/^import .* from "([^"]+)"/gm)].map((match) => match[1])
    expect(imports).toEqual(["kysely", "./schema-markers.js"])
    expect(source).not.toMatch(/\bfoldForKeywords\(|\bclassifyRoleFamily\(|\bseniorityMarker\(/)
  })
})
