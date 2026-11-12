import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { Eligibility } from "@/entities/job-posting"
import { EligibilityPanel } from "./eligibility-panel"

const base = { arrangement: "remote", relocationCountry: null, normalizedMonthlyMaxUsd: null, fxRateDate: null, evaluatedAt: "2026-10-28T10:00:00Z" } as const
const five: Eligibility["rules"] = [
  { rule: "location", result: "met", quote: "Remote, EMEA" },
  { rule: "sponsorship", result: "not_applicable", quote: null },
  { rule: "pay", result: "unverified", quote: null },
  { rule: "hours", result: "met", quote: "9 to 5 CET" },
  { rule: "industry", result: "met", quote: null },
]

describe("EligibilityPanel with five or seven rules (D44)", () => {
  it("renders a result stored before B1 with five rows and no mention of the new rules", () => {
    render(<EligibilityPanel eligibility={{ ...base, rules: five }} employmentType={null} />)
    expect(screen.getAllByRole("listitem")).toHaveLength(5)
    expect(screen.queryByText("Seniority")).toBeNull()
    expect(screen.queryByText("Employment type")).toBeNull()
  })

  it("renders seven rows with the new labels and lines", () => {
    const rules: Eligibility["rules"] = [
      ...five,
      { rule: "seniority", result: "unverified", quote: null },
      { rule: "employment_type", result: "violated", quote: null },
    ]
    render(<EligibilityPanel eligibility={{ ...base, rules }} employmentType="contract" />)
    expect(screen.getAllByRole("listitem")).toHaveLength(7)
    expect(screen.getByRole("listitem", { name: "Seniority: Unverified" })).toHaveTextContent("The job title doesn't state a level.")
    expect(screen.getByRole("listitem", { name: "Employment type: Violated" })).toHaveTextContent("Stated in the posting: Independent contractor.")
  })
})
