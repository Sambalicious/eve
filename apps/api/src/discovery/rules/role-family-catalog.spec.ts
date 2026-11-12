import { describe, expect, it } from "vitest"

import { type RoleFamily, TIER, classifyRoleFamily, classifyTitle, rankPostings, reconcileRoleFamily } from "./ranking.js"

/** EPIC-0006 role-family-catalog.feature (Gherkin r4). Expected families are copied from the feature tables. */
const FIXTURES: ReadonlyArray<readonly [string, RoleFamily]> = [
  // AC-1.3 fixture table
  ["Solutions Architect", "solutions_customer"],
  ["TAM Architect", "solutions_customer"],
  ["Technical Account Manager, Enterprise", "solutions_customer"],
  ["Senior Data Engineer", "data_ml"],
  ["Lead Machine Learning Engineer", "data_ml"],
  ["Senior Platform Engineer", "platform_engineering"],
  ["Site Reliability Engineer", "devops_platform"],
  ["DevOps Engineer", "devops_platform"],
  ["Senior Software Engineer", "software_engineering"],
  ["Staff Engineer", "software_engineering"],
  ["Principal Software Engineer", "software_engineering"],
  ["Staff Frontend Engineer", "senior_frontend"],
  ["Senior Backend Engineer", "backend"],
  ["Lead Engineer", "technical_lead"],
  ["Engineering Manager", "people_management"],
  ["Senior iOS Engineer", "mobile"],
  ["Product Engineer", "product_engineering"],
  ["Full Stack Developer", "fullstack"],
  ["QA Automation Engineer", "other"],
  ["Hardware Engineer", "other"],
  // AC-1.1 example titles
  ["Software Engineer", "software_engineering"],
  ["Senior Software Developer", "software_engineering"],
  ["Principal Engineer", "software_engineering"],
  ["Member of Technical Staff", "software_engineering"],
  ["Développeur", "software_engineering"],
  ["Softwareentwickler", "software_engineering"],
  // 8e inclusive forms (pre-filter-titles.feature 8e.8): software engineering, not other.
  ["Ingénieur(e) logiciel", "software_engineering"],
  ["Ingénieur\u00b7e logiciel", "software_engineering"],
  ["Ingénieur-e développement", "software_engineering"],
  ["Ingénieure logiciel", "software_engineering"],
  ["Ingénieur logiciel", "software_engineering"],
  ["Platform Engineer", "platform_engineering"],
  ["Data Scientist", "data_ml"],
  ["Machine Learning Engineer", "data_ml"],
  ["ML Engineer", "data_ml"],
  ["AI Engineer", "data_ml"],
  ["Analytics Engineer", "data_ml"],
  ["MLOps Engineer", "data_ml"],
  ["Solution Architect", "solutions_customer"],
  ["Sales Architect", "solutions_customer"],
  ["Customer Architect", "solutions_customer"],
  ["Technical Account Manager", "solutions_customer"],
  ["TAM", "solutions_customer"],
  // Precedence (P9)
  ["Data Engineering Lead", "data_ml"],
  ["Lead Data Scientist", "data_ml"],
  ["Machine Learning Engineering Manager", "data_ml"],
  ["Head of Data Science", "data_ml"],
  ["Solutions Architect Lead", "solutions_customer"],
  ["Manager, Technical Account Management", "solutions_customer"],
  ["Engineering Manager, Platform", "people_management"],
  ["Lead Engineer, Platform", "technical_lead"],
  ["Fullstack Platform Engineer", "fullstack"],
  ["Frontend Platform Engineer", "senior_frontend"],
  ["Backend Platform Engineer", "backend"],
  ["Mobile Platform Engineer", "mobile"],
  ["Staff Software Engineer, Frontend", "senior_frontend"],
  ["Senior Software Engineer, Backend", "backend"],
  ["Platform Engineer (DevOps)", "platform_engineering"],
  ["Platform Reliability Engineer", "platform_engineering"],
  ["DevOps Software Engineer", "devops_platform"],
  ["Software Engineer, SRE", "devops_platform"],
  // devops_platform narrowing
  ["Platform Engineering Specialist", "platform_engineering"],
  ["SRE", "devops_platform"],
  ["Infrastructure Engineer", "devops_platform"],
  ["Cloud Engineer", "devops_platform"],
  // folding
  ["SENIOR DATA ENGINEER", "data_ml"],
  ["solutions architect", "solutions_customer"],
  ["DÉVELOPPEUR", "software_engineering"],
  ["Senior   Platform   Engineer", "platform_engineering"],
]

describe("EPIC-0006 classifier (AC-1.1, AC-1.3)", () => {
  it.each(FIXTURES)("%s is %s", (title, family) => {
    expect(classifyRoleFamily(title, [])).toBe(family)
    expect(classifyTitle(title)).toBe(family)
  })

  it.each([
    ["Metadata Platform Specialist", "data_ml"],
    ["Taming Chaos Engineer", "solutions_customer"],
    ["Datadog Integrations Engineer", "data_ml"],
  ])("a family word inside a longer word does not select it (%s is not %s)", (title, family) => {
    expect(classifyRoleFamily(title, [])).not.toBe(family)
  })

  it.each([
    ["Software Engineer", "Train machine learning models and build data pipelines", "software_engineering"],
    ["Software Engineer", "Act as a solutions architect for enterprise customers", "software_engineering"],
    ["QA Engineer", "Run the Kubernetes platform", "other"],
  ])("duties never decide a new family (%s / %s)", (title, duties, family) => {
    expect(classifyRoleFamily(title, [duties])).toBe(family)
  })

  it.each([
    ["Build data pipelines and ML models", "other"],
    ["Solutions architecture for enterprise accounts", "other"],
    ["Hiring, performance reviews and line management of 12 engineers", "people_management"],
  ])("an untitled posting is other unless its duties make it people management (%s)", (duties, family) => {
    expect(classifyRoleFamily("", [duties])).toBe(family)
  })
})

describe("EPIC-0006 ranking tier (AC-1.4)", () => {
  it("every existing family keeps its tier; the four new families are in the last tier", () => {
    expect(TIER).toEqual({
      senior_frontend: 0, technical_lead: 0, fullstack: 1, product_engineering: 1,
      software_engineering: 2, backend: 2, mobile: 2, platform_engineering: 2, devops_platform: 2,
      people_management: 2, data_ml: 2, solutions_customer: 2, other: 2,
    })
  })

  it("the four new families rank after frontend and product engineering whatever their coverage", () => {
    const at = new Date("2026-10-01T08:00:00Z")
    const order = rankPostings([
      { id: "acme", family: "software_engineering", coverage: 1, discoveredAt: at, fromEmployerBoard: true },
      { id: "globex", family: "platform_engineering", coverage: 1, discoveredAt: at, fromEmployerBoard: true },
      { id: "initech", family: "data_ml", coverage: 1, discoveredAt: at, fromEmployerBoard: true },
      { id: "umbrella", family: "solutions_customer", coverage: 1, discoveredAt: at, fromEmployerBoard: true },
      { id: "hooli", family: "product_engineering", coverage: 0.7, discoveredAt: at, fromEmployerBoard: true },
      { id: "contoso", family: "senior_frontend", coverage: 0.7, discoveredAt: at, fromEmployerBoard: true },
    ])
    expect(order.slice(0, 2)).toEqual(["contoso", "hooli"])
  })

  it("within the last tier the family is not read", () => {
    const order = rankPostings([
      { id: "hooli", family: "backend", coverage: 0.9, discoveredAt: new Date("2026-10-02T08:00:00Z"), fromEmployerBoard: true },
      { id: "acme", family: "software_engineering", coverage: 0.8, discoveredAt: new Date("2026-10-01T08:00:00Z"), fromEmployerBoard: true },
      { id: "globex", family: "platform_engineering", coverage: 0.8, discoveredAt: new Date("2026-10-03T08:00:00Z"), fromEmployerBoard: true },
      { id: "initech", family: "devops_platform", coverage: 0.7, discoveredAt: new Date("2026-10-01T08:00:00Z"), fromEmployerBoard: true },
    ])
    expect(order).toEqual(["hooli", "acme", "globex", "initech"])
  })
})

describe("EPIC-0006 store-time family and reconciliation (AC-1.8)", () => {
  it("evaluation may move technical lead to people management and back", () => {
    expect(reconcileRoleFamily("technical_lead", "people_management")).toBe("people_management")
    expect(reconcileRoleFamily("people_management", "technical_lead")).toBe("technical_lead")
  })

  it.each<[RoleFamily, RoleFamily]>([
    ["software_engineering", "senior_frontend"],
    ["data_ml", "people_management"],
    ["solutions_customer", "backend"],
    ["platform_engineering", "devops_platform"],
    ["technical_lead", "other"],
  ])("no other evaluation output changes a stored %s", (stored, evaluated) => {
    expect(reconcileRoleFamily(stored, evaluated)).toBe(stored)
  })

  it("an untitled posting (no stored family) takes the evaluated family", () => {
    expect(reconcileRoleFamily(null, "people_management")).toBe("people_management")
  })
})
