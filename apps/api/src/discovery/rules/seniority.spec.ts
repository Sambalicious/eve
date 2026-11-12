import { describe, expect, it } from "vitest"

import { seniorityMarker } from "./seniority.js"

/** EPIC-0006 seniority-floor.feature (Gherkin r4), AC-2.2 to AC-2.4. Titles copied from the feature tables. */
const ENTRY = [
  "Junior Frontend Developer", "Jr. Software Engineer", "Software Engineering Intern", "Graduate Software Engineer", "Entry-Level Developer", "Apprentice Developer",
  "Frontend Intern", "Frontend Engineering Internship", "Junior Backend Engineer", "Jr Backend Engineer", "Graduate Developer", "Grad Software Engineer",
  "New Grad Software Engineer", "Entry Level Software Engineer", "Entry-level Frontend Engineer", "Apprentice Software Engineer",
  "Software Engineering Apprenticeship", "Trainee Developer", "Stagiaire Développeur Web", "Alternance Développeur Full Stack", "Becario Desarrollo Frontend",
  "Becaria Desarrollo Backend", "Pasante de Desarrollo", "Praktikant Softwareentwicklung", "Praktikantin Frontend", "Werkstudent Softwareentwicklung",
  "Werkstudentin Frontend",
  "JUNIOR FRONTEND DEVELOPER", "junior frontend developer", "Jr. Developer", "(Junior) Developer", "Junior-Developer", "ENTRY LEVEL ENGINEER",
  "Stagiaire Développeur", "STAGIAIRE DÉVELOPPEUR",
  "Leadership Development Intern", "Midwest Junior Developer", "Seniority Systems Junior Developer", "Staffing Platform Intern", "Leader Junior Developer",
]
const MID_PLUS = [
  "Senior/Junior Developer", "Mid-level Engineer",
  "Junior to Mid Frontend Developer", "Junior/Mid-level Engineer", "Intermediate or Junior Developer", "Senior Engineer, Graduate Program",
  "Sr. Engineer (Intern Mentor)", "Staff Engineer, Apprenticeship Platform", "Principal Engineer, Graduate Hiring", "Lead Engineer, Intern Program",
  "Intermediate Developer", "Senior Frontend Engineer", "Staff Engineer",
  "Junior Developer (SENIOR team)", "Junior Developer - Sr. track",
]
const NONE = [
  "Internal Tools Engineer", "International Payments Engineer", "Software Engineer", "Associate Software Engineer", "Software Engineer I",
  "Frontend Engineer", "Software Engineer II", "Engineering Manager",
  "Interned Systems Engineer", "Gradle Build Engineer", "Upgrade Engineer", "Juniper Network Engineer",
  "Associate Frontend Developer", "Frontend Engineer 1",
]

describe("seniority marker (AC-2.2, AC-2.3)", () => {
  it.each(ENTRY)("%s is entry", (title) => expect(seniorityMarker(title)).toBe("entry"))
  it.each(MID_PLUS)("%s is mid_plus", (title) => expect(seniorityMarker(title)).toBe("mid_plus"))
  it.each(NONE)("%s has no marker", (title) => expect(seniorityMarker(title)).toBe("none"))

  it.each([null, "", "   "])("an untitled posting (%j) has no stored marker (AC-2.4)", (title) => {
    expect(seniorityMarker(title)).toBeNull()
  })
})
