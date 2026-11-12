import { describe, expect, it } from "vitest"

import { parsePeriod, requirementYears, tenureMonths } from "./tenure.js"

const NOW = new Date("2026-11-10T00:00:00.000Z")

/** A month index for readable assertions: January is 0. */
const month = (year: number, monthNumber: number) => year * 12 + (monthNumber - 1)

describe("parsePeriod", () => {
  it("reads the forms the profile stores", () => {
    expect(parsePeriod("AUGUST 2019 – Present", NOW)).toEqual({ startMonth: month(2019, 8), endMonth: month(2026, 11) })
    expect(parsePeriod("FEBRUARY 2022 – February 2023", NOW)).toEqual({ startMonth: month(2022, 2), endMonth: month(2023, 2) })
    expect(parsePeriod("AUGUST 2019 - August 2020", NOW)).toEqual({ startMonth: month(2019, 8), endMonth: month(2020, 8) })
    expect(parsePeriod("Jan 2020 to Dec 2020", NOW)).toEqual({ startMonth: month(2020, 1), endMonth: month(2020, 12) })
  })

  it("takes a year alone as January to December", () => {
    expect(parsePeriod("2019 – 2020", NOW)).toEqual({ startMonth: month(2019, 1), endMonth: month(2020, 12) })
  })

  it("treats the ongoing words as today", () => {
    for (const word of ["Present", "present", "Current", "Now", "today"]) {
      expect(parsePeriod(`MARCH 2024 – ${word}`, NOW)?.endMonth).toBe(month(2026, 11))
    }
  })

  it("returns null for anything it cannot read", () => {
    for (const bad of [null, "", "Present", "SINCE 2019", "2019 – 2018", "Spring 2019 – Autumn 2020"]) {
      expect(parsePeriod(bad, NOW)).toBeNull()
    }
  })
})

describe("tenureMonths", () => {
  const sections = [
    { kind: "experience", period: "AUGUST 2019 – August 2020" },
    { kind: "experience", period: "AUGUST 2020 – February 2022" },
    { kind: "experience", period: "FEBRUARY 2022 – February 2023" },
    { kind: "experience", period: "FEBRUARY 2023 – November 2023" },
    { kind: "experience", period: "JANUARY 2024 – Present" },
    { kind: "education", period: "2015 – 2019" },
    { kind: "skills", period: null },
  ]

  it("counts the distinct calendar months of the experience sections only", () => {
    // Aug 2019 to Nov 2023 is one unbroken run (52 months: the roles chain at their edges),
    // then Jan 2024 to Nov 2026 adds 35. The 2015-2019 education is not experience.
    expect(tenureMonths(sections, NOW)).toBe(52 + 35)
  })

  it("does not double count overlapping roles", () => {
    const overlapping = [
      { kind: "experience", period: "JANUARY 2020 – DECEMBER 2020" },
      { kind: "experience", period: "JUNE 2020 – DECEMBER 2020" },
    ]
    expect(tenureMonths(overlapping, NOW)).toBe(12)
  })

  it("leaves unreadable periods out instead of guessing", () => {
    expect(tenureMonths([{ kind: "experience", period: "a while ago" }], NOW)).toBe(0)
    expect(tenureMonths([], NOW)).toBe(0)
  })
})

describe("requirementYears", () => {
  it("answers plain total-experience requirements", () => {
    expect(requirementYears("5+ years of overall software engineering experience")).toBe(5)
    expect(requirementYears("8+ years of professional software engineering experience")).toBe(8)
    expect(requirementYears("At least 3 years of software development experience")).toBe(3)
    expect(requirementYears("5 years of experience")).toBe(5)
    expect(requirementYears("7+ yrs of industry experience")).toBe(7)
  })

  it("stays out of anything with a domain, level or extra clause", () => {
    const qualified = [
      "6+ years of software engineering experience, including 3+ years in cloud computing (AWS, Azure, or GCP) or platform engineering.",
      "8+ years of software engineering experience, including 3+ years at Staff, Principal level or equivalent technical leadership.",
      "5+ years of experience with C++",
      "5+ years of experience building web applications",
      "4+ years of hands-on experience with React and TypeScript",
      "3+ years of professional experience in a startup environment",
      "10+ years of professional software engineering experience, including substantial experience at Staff level",
      "Experience with Go and 5+ years of backend development",
    ]
    for (const text of qualified) expect(requirementYears(text), text).toBeNull()
  })

  it("needs the word experience, so a bare duration is not a requirement on the applicant", () => {
    expect(requirementYears("5+ years in business")).toBeNull()
    expect(requirementYears("Our team has 5+ years of experience")).toBeNull()
  })
})
