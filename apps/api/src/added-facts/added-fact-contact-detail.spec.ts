import { describe, expect, it } from "vitest"

import { containsContactDetail } from "../documents/contact-detail.js"
import { textProblem } from "./added-facts-rules.js"
import { generationAddedFacts } from "./generation-facts.js"

const CONTACT = { name: "Ada Okafor", lines: ["Lagos, Nigeria", "12 Admiralty Way, Lekki", "ada@example.com", "+234 800 000 0000"] }

/**
 * FEAT-0017: the link rule is scoped to added-fact text. The shared
 * `containsContactDetail` keeps its decisions for every existing caller (validator,
 * generation, headline, posting extraction), so a plain URL is not a contact detail
 * there; an added fact holding one is still refused `contact_detail`.
 */
describe("FEAT-0017 added-fact contact detail", () => {
  it("a URL in added-fact text is refused as contact_detail", () => {
    expect(textProblem("Set up CI/CD at Acme, see https://github.com/acme/pipelines", CONTACT)).toBe("contact_detail")
    expect(textProblem("Portfolio at www.ada.dev", CONTACT)).toBe("contact_detail")
  })

  it("email and phone are refused as before", () => {
    expect(textProblem("Set up CI/CD at Acme, write to ada@example.com", CONTACT)).toBe("contact_detail")
    expect(textProblem("Set up CI/CD at Acme, call +234 801 234 5678", CONTACT)).toBe("contact_detail")
  })

  it("a technology name such as Node.js is not a link", () => {
    expect(textProblem("Built a Node.js build pipeline at Acme", CONTACT)).toBeNull()
  })

  it("SEC-R03: a bare host.tld/path link is refused, and the technology names that look like one are not", () => {
    for (const text of ["Built example.com/portfolio at Acme", "github.io/x"]) expect(textProblem(text, CONTACT)).toBe("contact_detail")
    for (const text of ["CI/CD pipelines", "React/Next.js", "Node.js", "ASP.NET/C#"]) expect(textProblem(text, CONTACT)).toBeNull()
  })

  it("the shared containsContactDetail still returns false for a plain URL (unchanged)", () => {
    expect(containsContactDetail("Set up CI/CD at Acme, see https://github.com/acme/pipelines", CONTACT)).toBe(false)
    expect(containsContactDetail("Portfolio at www.ada.dev", null)).toBe(false)
  })

  it("generation drops an added fact whose text now holds a link, as it drops a contact detail", () => {
    const sections = [{ id: "sec-exp", kind: "experience" as const, title: "Senior Engineer", organization: "Brightwave Ltd", period: "2021 to 2024", sourceQuote: null, facts: [] }]
    const rows = [
      { id: "00000000-0000-4000-8000-000000000001", kind: "one_liner" as const, text: "Set up CI/CD at Acme, see https://github.com/acme/pipelines", role_section_id: "sec-exp", role_snapshot: { title: "Senior Engineer", employer: "Brightwave Ltd", period: "2021 to 2024" } },
      { id: "00000000-0000-4000-8000-000000000002", kind: "one_liner" as const, text: "Set up GitHub Actions CI/CD at Acme", role_section_id: "sec-exp", role_snapshot: { title: "Senior Engineer", employer: "Brightwave Ltd", period: "2021 to 2024" } },
    ]
    const effective = generationAddedFacts(rows, sections, CONTACT)
    expect(effective.citable.map((fact) => fact.text)).toEqual(["Set up GitHub Actions CI/CD at Acme"])
    expect(effective.available.map((fact) => fact.text)).toEqual(["Set up GitHub Actions CI/CD at Acme"])
  })
})
