import { describe, expect, it } from "vitest"

import { foldForKeywords } from "./rule-result.js"
import { type RoleFamily, TIER, classifyRoleFamily, rankPostings } from "./ranking.js"

/**
 * The pre-slice-8 classifier, frozen verbatim from main 49d8a53
 * (apps/api/src/discovery/rules/ranking.ts), for RF-07: the slice 8 classifier
 * must agree with it on every one of the five named families.
 */
function legacyClassify(title: string, coreResponsibilities: readonly string[]): string {
  const MANAGEMENT_TITLE = /\b(engineering manager|manager,? engineering|head of engineering|director|vp|vice president|people manager)\b/
  const MANAGEMENT_DUTIES = /\b(hiring|performance reviews?|line management|people management|direct reports|career development of)\b/
  const HANDS_ON = /\b(code|coding|hands-on|hands on|build|implement|write|ship|react|typescript|frontend|front-end)\b/
  const LEAD = /\b(tech(nical)? lead|lead engineer|lead developer|team lead|engineering lead|lead (frontend|front-end|software))\b/
  const FRONTEND = /\b(frontend|front-end|front end|ui engineer|web engineer|react)\b/
  const FULLSTACK = /\b(full[- ]?stack)\b/
  const PRODUCT = /\b(product engineer(ing)?)\b/
  const folded = foldForKeywords(title)
  const duties = foldForKeywords(coreResponsibilities.join(". "))
  const managing = MANAGEMENT_TITLE.test(folded) || (MANAGEMENT_DUTIES.test(duties) && !HANDS_ON.test(duties))
  if (managing && !LEAD.test(folded)) return "people_management"
  if (LEAD.test(folded)) return MANAGEMENT_DUTIES.test(duties) && !HANDS_ON.test(duties) ? "people_management" : "technical_lead"
  if (FULLSTACK.test(folded)) return "fullstack"
  if (PRODUCT.test(folded)) return "product_engineering"
  if (FRONTEND.test(folded)) return "senior_frontend"
  return "other"
}

// RF-01 (8R.3, 8R.5, 8R.6): the PRD table, every row.
const PRD_TABLE: ReadonlyArray<readonly [string, RoleFamily]> = [
  ["Senior Backend Engineer", "backend"],
  ["Back-End Developer", "backend"],
  ["Server-Side Engineer (Node.js)", "backend"],
  ["Lead Backend Engineer", "backend"],
  ["Backend Tech Lead", "technical_lead"],
  ["Engineering Manager, Backend", "people_management"],
  ["Fullstack Engineer (Backend focus)", "fullstack"],
  ["Backend Engineer (React, Node)", "senior_frontend"],
  ["iOS Engineer", "mobile"],
  ["Senior Android Developer", "mobile"],
  ["Flutter Developer", "mobile"],
  ["Mobile Tech Lead", "technical_lead"],
  ["React Native Engineer", "senior_frontend"],
  ["Mobile Backend Engineer", "mobile"],
  ["Site Reliability Engineer", "devops_platform"],
  ["SRE", "devops_platform"],
  ["DevOps Engineer", "devops_platform"],
  // EPIC-0006 (P8, AC-1.3): platform engineering titles moved out of devops_platform.
  ["Platform Engineer", "platform_engineering"],
  ["Infrastructure Engineer", "devops_platform"],
  ["Cloud Engineer", "devops_platform"],
  ["Backend Infrastructure Engineer", "backend"],
  ["Frontend Platform Engineer", "senior_frontend"],
  ["Lead Engineer, Platform", "technical_lead"],
  ["Head of Infrastructure", "devops_platform"],
  // EPIC-0006 (AC-1.1): generic software and data titles have their own families now.
  ["Software Engineer", "software_engineering"],
  ["Data Engineer", "data_ml"],
]

// RF-02 (8R.5): every listed word or phrase.
const PHRASES: ReadonlyArray<readonly [string, RoleFamily]> = [
  ["Senior iOS Developer", "mobile"],
  ["Android Engineer", "mobile"],
  ["Mobile Developer", "mobile"],
  ["Flutter Engineer", "mobile"],
  ["SwiftUI Developer", "mobile"],
  ["Senior React Native Developer", "senior_frontend"],
  ["Xamarin Developer", "mobile"],
  ["Kotlin Multiplatform Engineer", "mobile"],
  ["Backend Developer", "backend"],
  ["Back-end Engineer", "backend"],
  ["Back End Engineer", "backend"],
  ["Server-side Developer", "backend"],
  ["Server Side Engineer", "backend"],
  ["DevOps Specialist", "devops_platform"],
  ["Dev Ops Engineer", "devops_platform"],
  ["Site Reliability Specialist", "devops_platform"],
  ["SRE II", "devops_platform"],
  ["Reliability Engineer", "devops_platform"],
  ["Senior Platform Engineer", "platform_engineering"],
  ["Platform Engineering Specialist", "platform_engineering"],
  ["Infrastructure Specialist", "devops_platform"],
  ["Infra Engineer", "devops_platform"],
  ["Senior Cloud Engineer", "devops_platform"],
  ["Cloud Infrastructure Specialist", "devops_platform"],
]

// RF-03 (8R.4): folding.
const FOLDED: ReadonlyArray<readonly [string, RoleFamily]> = [
  ["SENIOR BACKEND ENGINEER", "backend"],
  ["Développeur Backend", "backend"],
  ["DÉVELOPPEUR MOBILE", "mobile"],
  ["Ingénieur DevOps", "devops_platform"],
  ["Back\u2010End Engineer", "backend"],
  ["Senior   Android   Engineer", "mobile"],
]

describe("slice 8 role families (role-family-classification.feature)", () => {
  it.each([...PRD_TABLE, ...PHRASES, ...FOLDED])("RF-01/02/03: %s is %s", (title, family) => {
    expect(classifyRoleFamily(title, [])).toBe(family)
  })

  // EPIC-0006: "Kiosk Software Engineer" is software_engineering ("software" is a whole word); the slice 8 family words still do not match inside it.
  it.each(["Kiosk Software Engineer", "Backendless Engineer", "Automobile Engineer", "Infrastructural Engineer", "Androidology Engineer"])(
    "RF-04: a family word inside a longer word does not select it (%s)",
    (title) => {
      expect(["other", "software_engineering"]).toContain(classifyRoleFamily(title, []))
    }
  )

  it.each([
    ["Build backend services in Go. Own the server-side APIs."],
    ["Ship the iOS and Android apps"],
    ["Run the Kubernetes platform and the DevOps pipeline"],
  ])("RF-05: duties never decide a new family (%s)", (duties) => {
    // EPIC-0006: the title alone is software_engineering; the duties still decide nothing.
    expect(classifyRoleFamily("Software Engineer", [duties])).toBe("software_engineering")
  })

  it("RF-06: an untitled posting is other unless its duties make it people management", () => {
    expect(classifyRoleFamily("", ["Build backend services. Ship the iOS app."])).toBe("other")
    expect(classifyRoleFamily("", ["Run the DevOps platform"])).toBe("other")
    expect(classifyRoleFamily("", ["Hiring, performance reviews and line management of 12 engineers"])).toBe("people_management")
  })

  it("RF-07: every pre-slice-8 named family is unchanged except where EPIC-0006 precedence moves it; other moves only to a newer family", () => {
    const words = [
      "Senior", "Staff", "Lead", "Principal", "Frontend", "Front-End", "Backend", "Back End", "Fullstack", "Full Stack", "Product",
      "Engineer", "Developer", "Tech Lead", "Engineering Manager", "Head of Engineering", "Director", "React", "React Native", "iOS",
      "Android", "Mobile", "Flutter", "DevOps", "SRE", "Platform", "Infrastructure", "Cloud", "Server-Side", "Data", "UI Engineer",
      "Web Engineer", "Team Lead", "VP", "Kotlin Multiplatform", "Site Reliability", "Software",
    ]
    const dutyOptions = [[], ["Hiring and performance reviews"], ["Write production React code"], ["Line management of 8 engineers", "Ship features"]]
    let seed = 7
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed
    }
    const corpus: Array<[string, string[]]> = [...PRD_TABLE, ...PHRASES, ...FOLDED].map(([title]) => [title, []])
    while (corpus.length < 500) {
      const length = 1 + (next() % 4)
      const title = Array.from({ length }, () => words[next() % words.length]).join(" ")
      corpus.push([title, dutyOptions[next() % dutyOptions.length] as string[]])
    }
    for (const [title, duties] of corpus) {
      const before = legacyClassify(title, duties)
      const after = classifyRoleFamily(title, duties)
      // EPIC-0006 (AC-1.3, P9): data and ML and solutions are decided before the slice 8 rules.
      if (before !== "other" && !["data_ml", "solutions_customer"].includes(after)) expect({ title, family: after }).toEqual({ title, family: before })
      else if (before === "other")
        expect(["other", "backend", "mobile", "devops_platform", "software_engineering", "platform_engineering", "data_ml", "solutions_customer"]).toContain(after)
    }
  })

  it("RF-09: the new families rank below fullstack and product engineering whatever their coverage", () => {
    const at = new Date("2026-10-01T08:00:00Z")
    const order = rankPostings([
      { id: "backend", family: "backend", coverage: 1, discoveredAt: at, fromEmployerBoard: true },
      { id: "mobile", family: "mobile", coverage: 1, discoveredAt: at, fromEmployerBoard: true },
      { id: "devops", family: "devops_platform", coverage: 1, discoveredAt: at, fromEmployerBoard: true },
      { id: "product", family: "product_engineering", coverage: 0.7, discoveredAt: at, fromEmployerBoard: true },
      { id: "fullstack", family: "fullstack", coverage: 0.7, discoveredAt: at, fromEmployerBoard: true },
    ])
    expect(order.slice(0, 2).sort()).toEqual(["fullstack", "product"])
  })

  it("RF-10: within the last tier the family name is not read", () => {
    const order = rankPostings([
      { id: "acme", family: "other", coverage: 0.9, discoveredAt: new Date("2026-10-02T08:00:00Z"), fromEmployerBoard: true },
      { id: "hooli", family: "backend", coverage: 0.8, discoveredAt: new Date("2026-10-01T08:00:00Z"), fromEmployerBoard: true },
      { id: "globex", family: "people_management", coverage: 0.8, discoveredAt: new Date("2026-10-03T08:00:00Z"), fromEmployerBoard: true },
      { id: "initech", family: "devops_platform", coverage: 0.8, discoveredAt: new Date("2026-10-02T08:00:00Z"), fromEmployerBoard: true },
      { id: "umbrella", family: "mobile", coverage: 0.7, discoveredAt: new Date("2026-10-01T08:00:00Z"), fromEmployerBoard: true },
    ])
    expect(order).toEqual(["acme", "hooli", "initech", "globex", "umbrella"])
  })
})

describe("slice 8d housekeeping (RF-35, 8d.20)", () => {
  it("the tier table keeps every slice 8 tier (EPIC-0006 adds four last-tier families) and the unused tier helper is gone", async () => {
    expect(TIER).toEqual({
      senior_frontend: 0, technical_lead: 0, fullstack: 1, product_engineering: 1,
      backend: 2, mobile: 2, devops_platform: 2, people_management: 2, other: 2,
      software_engineering: 2, platform_engineering: 2, data_ml: 2, solutions_customer: 2,
    })
    expect(Object.keys(await import("./ranking.js")).sort()).toEqual(["TIER", "classifyRoleFamily", "classifyTitle", "rankPostings", "reconcileRoleFamily"])
  })
})
