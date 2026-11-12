import { describe, expect, it } from "vitest"

import { HEADLINE_MAX_WORDS, headlineDecision, headlineFor } from "./headline.js"

/** The checklist from design-decisions section 3: every case below is one line of it. */
describe("resume headline support (EPIC-0012 rule 1)", () => {
  it("prints the posting title when one profile title holds its words as one contiguous run", () => {
    expect(headlineFor("Sustainability Consultant", ["Sustainability Consultant"])).toBe("Sustainability Consultant")
    expect(headlineFor("Senior Frontend Engineer", ["Senior Frontend Engineer"])).toBe("Senior Frontend Engineer")
  })

  // Revision 2, R12: the run is in order. A reversed or interruptible title prints nothing.
  it("needs the posting title's words in one run and in their written order (Revision 2, R12)", () => {
    expect(headlineFor("Engineer Senior Frontend", ["Senior Frontend Engineer"])).toBeNull()
    expect(headlineFor("Data Engineer", ["Senior Data Platform Engineer"])).toBeNull()
    expect(headlineFor("Head of Finance", ["Finance Head"])).toBeNull()
  })

  it("needs the posting title's stop words as written, but they never make it unsupportable", () => {
    expect(headlineFor("Head of Finance", ["Head of Finance"])).toBe("Head of Finance")
    expect(headlineFor("Head of Finance", ["Head Finance"])).toBeNull()
    // R21: a bracketed second role is a second segment, so the entry is a multi-title entry and has no candidate.
    expect(headlineFor("Head of Finance", ["Sustainability Analyst (Head of Finance from 2023)"])).toBeNull()
  })

  it("prints nothing for a posting title in two segments, even when the words are supported (Revision 2, M1)", () => {
    expect(headlineFor("Analyst, Sustainability", ["Sustainability Analyst"])).toBeNull()
    expect(headlineFor("Sustainability Analyst / Consultant", ["Sustainability Analyst"])).toBeNull()
  })

  // Revision 4, R21: there is no relation cut any more. The profile segment must be the posting title whole,
  // so a relation phrase prints nothing for either role (fail closed).
  it("prints nothing when the whole profile title is not the posting title (Revision 4, R21)", () => {
    for (const qualifier of ["Deputy", "Assistant", "Associate"]) {
      expect(headlineFor("Head of Finance", [`${qualifier} Head of Finance`])).toBeNull()
    }
    for (const suffix of ["Intern", "Trainee"]) {
      expect(headlineFor("Head of Finance", [`Head of Finance ${suffix}`])).toBeNull()
    }
    for (const relation of ["reporting to", "reports to", "under", "for"]) {
      expect(headlineFor("Head of Finance", [`Sustainability Analyst ${relation} the Head of Finance`])).toBeNull()
    }
    expect(headlineFor("Head of Finance", ["PA to Head of Finance"])).toBeNull()
    expect(headlineFor("Head of Finance", ["Executive Assistant to Head of Finance"])).toBeNull()
    expect(headlineFor("Head of Finance", ["Sustainability Analyst (reported to Head of Finance)"])).toBeNull()
    // A relation word that ends the title stays, so it is not the posting title whole.
    expect(headlineFor("Head of Sustainability", ["Head of Sustainability Reporting"])).toBeNull()
    // R21: the relation cut is gone, so neither role is found inside "Assistant to the Head of Finance".
    expect(headlineFor("Assistant", ["Assistant to the Head of Finance"])).toBeNull()
    expect(headlineFor("Data Analyst", ["Data Analyst to Senior Software Engineer"])).toBeNull()
  })

  it("strips a trailing period, a level or a date before matching (Revision 3, R18)", () => {
    expect(headlineFor("Head of Finance", ["Head of Finance from 2023"])).toBe("Head of Finance")
    // R21: an extra qualifier is a word the segment keeps, so it is not the posting title whole.
    expect(headlineFor("Head of Finance", ["Head of Finance for EMEA"])).toBeNull()
    expect(headlineFor("Engineer", ["Engineer II"])).toBe("Engineer")
    expect(headlineFor("Engineer", ["Engineer, present"])).toBe("Engineer")
    expect(headlineFor("Engineer", ["Engineer since March 2021"])).toBe("Engineer")
  })

  it("accepts the posting title only as the tail of a segment, behind a step-down word (Revision 3, R18)", () => {
    expect(headlineFor("Consultant", ["Senior Consultant"])).toBe("Consultant")
    // R21: "junior" is not a step down, so it is not a supported lead-in.
    expect(headlineFor("Engineer", ["Junior Engineer"])).toBeNull()
    expect(headlineFor("Engineer", ["Lead Engineer"])).toBe("Engineer")
    expect(headlineFor("Consultant", ["Associate Consultant"])).toBeNull()
    expect(headlineFor("Consultant", ["Senior Associate Consultant"])).toBeNull()
    // R21 changed case: with no relation cut, an entry that is exactly the posting title matches whole, so it
    // prints. Only an entry that holds the title inside a longer phrase prints nothing (and an approved
    // alternate is then the way out, 3h).
    expect(headlineFor("Assistant to the CFO", ["Assistant to the CFO"])).toBe("Assistant to the CFO")
    expect(headlineFor("Assistant to the CFO", ["Assistant to the CFO, EMEA"])).toBeNull()
    expect(headlineFor("Assistant to the CFO", [], ["Assistant to the CFO"])).toBe("Assistant to the CFO")
  })

  it("accepts a promotion written as a relation only through an approved alternate (Revision 3, R18 cost)", () => {
    expect(headlineFor("Head of Finance", ["Analyst promoted to Head of Finance"])).toBeNull()
    expect(headlineFor("Head of Finance", ["Analyst, later Head of Finance"])).toBeNull()
  })

  // Revision 4, R21: a qualifier after a separator is its own segment, so the entry no longer holds one title;
  // a qualifier the separator does not know stays in the one segment, where the whole match refuses it.
  it.each([
    ["Head of Sustainability Reporting (EMEA)", "Head of Sustainability"],
    ["Head of Sustainability Reporting - London", "Head of Sustainability"],
    ["Head of Sustainability Reporting & Assurance", "Head of Sustainability"],
    ["Head of Finance Reporting and Analysis", "Head of Finance"],
    ["Head of Finance Reporting, EMEA", "Head of Finance"],
    ["Head of Finance Reporting Systems", "Head of Finance"],
    ["Head of Finance (Intern)", "Head of Finance"],
    ["Head of Finance – Intern", "Head of Finance"],
    ["Head of Finance - Trainee", "Head of Finance"],
    ["Head of Finance, Deputy", "Head of Finance"],
    ["Head of Finance | Assistant", "Head of Finance"],
    ["Head of Finance [Apprentice]", "Head of Finance"],
    ["Head of Finance: Intern", "Head of Finance"],
    ["Analyst / Head of Finance", "Head of Finance"],
    ["Head of Finance & Operations", "Head of Finance"],
  ])("'%s' prints nothing for '%s' (Revision 4, R21: one segment, the posting title whole)", (title, posting) => {
    expect(headlineFor(posting, [title])).toBeNull()
  })

  it("drops a bare date or level segment, and trims a trailing one, before the whole match (Revision 4, R21)", () => {
    expect(headlineFor("Engineer", ["Engineer (2021–present)"])).toBe("Engineer")
    expect(headlineFor("Engineer", ["Engineer – 2023"])).toBe("Engineer")
    expect(headlineFor("Head of Finance", ["Head of Finance (from 2023)"])).toBe("Head of Finance")
  })

  it("ignores profile words the posting title does not have: a subset is enough", () => {
    expect(headlineFor("Consultant", ["Senior Consultant"])).toBe("Consultant")
    expect(headlineFor("Frontend Engineer", ["Senior Frontend Engineer", "Head of Finance"])).toBe("Frontend Engineer")
  })

  it("treats seniority words as ordinary words: Lead is not Senior", () => {
    expect(headlineFor("Lead Engineer", ["Senior Engineer"])).toBeNull()
    expect(headlineFor("Senior Engineer", ["Lead Engineer"])).toBeNull()
    expect(headlineFor("Principal Engineer", ["Staff Engineer"])).toBeNull()
  })

  it("never combines two profile titles into a third", () => {
    expect(headlineFor("Head of Sustainability", ["Sustainability Analyst", "Head of Finance"])).toBeNull()
    expect(headlineDecision("Head of Sustainability", ["Sustainability Analyst", "Head of Finance"]).missing).toBe(1)
  })

  it("matches plurals on both sides", () => {
    expect(headlineFor("Data Scientists", ["Data Scientist"])).toBe("Data Scientists")
    expect(headlineFor("Data Scientist", ["Data Scientists"])).toBe("Data Scientist")
  })

  it("compares acronyms as written, dot for dot, with no expansion", () => {
    expect(headlineFor("ESG Analyst", ["E.S.G. Analyst"])).toBe("ESG Analyst")
    // A dotted printed title is refused by letterName (sentence punctuation), so dots only appear on the profile side.
    expect(headlineFor("E.S.G. Analyst", ["ESG Analyst"])).toBeNull()
  })

  it("joins two adjacent words into one both ways: front end and frontend", () => {
    expect(headlineFor("Frontend Developer", ["Front End Developer"])).toBe("Frontend Developer")
    expect(headlineFor("Front End Developer", ["Frontend Developer"])).toBe("Front End Developer")
  })

  it("removes parenthesised parts such as (m/f/d) before printing", () => {
    expect(headlineFor("Senior Frontend Engineer (m/f/d)", ["Senior Frontend Engineer"])).toBe("Senior Frontend Engineer")
    expect(headlineFor("Senior Frontend Engineer (m/w/x) (Remote)", ["Senior Frontend Engineer"])).toBe("Senior Frontend Engineer")
  })

  it("prints nothing for a title holding a digit", () => {
    expect(headlineFor("Senior Engineer 2", ["Senior Engineer 2"])).toBeNull()
    expect(headlineFor("Engineer 3 (Remote)", ["Engineer 3"])).toBeNull()
  })

  it("prints nothing for a location suffix the profile does not state", () => {
    expect(headlineFor("Senior Frontend Engineer - London", ["Senior Frontend Engineer"])).toBeNull()
    expect(headlineDecision("Senior Frontend Engineer - London", ["Senior Frontend Engineer"]).missing).toBe(1)
  })

  it("prints nothing when letterName rejects the title", () => {
    expect(headlineFor("Former Head of Finance", ["Former Head of Finance"])).toBeNull()
    expect(headlineFor("Senior Engineer. I hold a PhD", ["Senior Engineer. I hold a PhD"])).toBeNull()
    expect(headlineDecision("Former Head of Finance", ["Former Head of Finance"])).toEqual({ headline: null, missing: 0 })
  })

  it("drops stop words, so only meaningful words must be supported", () => {
    expect(headlineFor("Head of the Finance Office", ["Head of the Finance Office"])).toBe("Head of the Finance Office")
    expect(headlineFor("Head of Finance", ["Head of Finance"])).toBe("Head of Finance")
  })

  it("treats a title written with ' and ' as two segments, so it never prints (Revision 1, R5)", () => {
    expect(headlineFor("Head of Finance and Operations", ["Head of Finance and Operations"])).toBeNull()
  })

  it("refuses a title longer than the printed limit", () => {
    const long = "Senior Principal Staff Head Chief Director VP Lead Engineer"
    expect(long.split(" ").length).toBeGreaterThan(HEADLINE_MAX_WORDS)
    expect(headlineFor(long, [long])).toBeNull()
  })

  it("accepts an owner-approved alternate title as one extra single title", () => {
    expect(headlineFor("Head of Sustainability", ["Head of Finance"], ["Head of Sustainability"])).toBe("Head of Sustainability")
  })

  it("prints nothing and counts every word when the profile has no title to offer", () => {
    expect(headlineDecision("Sustainability Consultant", [])).toEqual({ headline: null, missing: 2 })
    expect(headlineFor(null, ["Sustainability Consultant"])).toBeNull()
    expect(headlineDecision(undefined, ["Sustainability Consultant"])).toEqual({ headline: null, missing: 0 })
  })

  // Review fix (post-R26): the join enumeration was Fibonacci, so a title written with the separators
  // `normaliseForAts` splits on ("a*b*c*…", one space-separated word) or a profile title of the maximum length
  // the profile allows ran the api out of memory. Both are refused by the word and token limits, and the
  // matcher behind them is linear, so the answer comes back long before any frame budget.
  it("refuses a 40-token role title and a 40-token profile title quickly", () => {
    const letters = Array.from({ length: 40 }, (_, index) => String.fromCharCode(97 + (index % 26)))
    const roleTitle = letters.join("*")
    const profileTitle = letters.join(" ")
    expect(roleTitle.split(" ").length).toBeLessThanOrEqual(HEADLINE_MAX_WORDS)
    const started = performance.now()
    expect(headlineFor(roleTitle, [profileTitle])).toBeNull()
    expect(headlineFor(profileTitle, [roleTitle])).toBeNull()
    expect(headlineDecision(roleTitle, [profileTitle])).toEqual({ headline: null, missing: 0 })
    expect(performance.now() - started).toBeLessThan(200)
  })

  // Review fix (post-R26): a profile title past the token cap is not a title, so the longest one cannot reach
  // the matcher even though the posting title is short.
  it("refuses a profile title past the token cap", () => {
    const long = `${Array.from({ length: 20 }, (_, index) => String.fromCharCode(97 + (index % 26))).join(" ")} data analyst`
    expect(headlineFor("Data Analyst", [long])).toBeNull()
  })
})
