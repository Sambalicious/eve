import { describe, expect, it } from "vitest"

import { headingClaimsMissing, factClaimsMissing, numbersIn, unsupportedScopeVerbs, writtenClaims } from "./claim-check.js"

const BRIGHTWAVE = "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024"
const HEADING_QUOTE = "Brightwave Ltd, Senior Frontend Engineer, 2021-2024"

// CR2-02 / SEC-203: backend code decides whether a fact says more than its quote.
describe("factClaimsMissing (Gherkin @r4 rows)", () => {
  it("keeps a rephrasing that adds no claim", () => {
    expect(factClaimsMissing("Led 4 frontend engineers at Brightwave Ltd from 2021 to 2024", BRIGHTWAVE)).toEqual([])
  })

  it.each([
    ["qualification", "Holds a PhD in Computer Science from MIT", "BSc Computer Science, University of Lagos, 2014", ["phd", "mit"]],
    ["number", "Led a team of 12 frontend engineers at Brightwave Ltd", BRIGHTWAVE, ["12"]],
    ["employer", "Led a team of 4 frontend engineers at Kora Payments, 2021-2024", BRIGHTWAVE, ["kora", "payments"]],
    ["dates", "Led a team of 4 frontend engineers at Brightwave Ltd, 2018-2024", BRIGHTWAVE, ["2018"]],
    // SEC-213: the opener "Engineering" is a claim too, not exempt as a sentence start.
    ["title", "Engineering Manager for 4 frontend engineers at Brightwave Ltd", BRIGHTWAVE, ["engineering", "manager"]],
  ])("drops an unsupported %s", (_label, fact, quote, missing) => {
    expect(factClaimsMissing(fact, quote)).toEqual(missing)
  })
})

describe("factClaimsMissing normalisation (false-drop guards)", () => {
  it.each([
    ["case and all-caps quotes", "Built the dashboard at Kora Payments", "BUILT THE DASHBOARD AT KORA PAYMENTS"],
    ["typographic dashes", "Brightwave Ltd, 2021–2024", "Brightwave Ltd, 2021-2024"],
    ["diacritics lost in extraction", "Analyst at Société Générale", "Analyst at Societe Generale"],
    ["thousands separators", "Served 1,000,000 users", "served 1000000 users"],
    ["magnitude words", "Managed a budget of USD 2 million", "managed a USD 2M budget"],
    ["percent", "Cut load time by 38%", "cut load time by 38 percent"],
    ["number words", "Led a team of 4 engineers", "led a team of four engineers"],
    ["compound number words", "Mentored 25 engineers", "mentored twenty-five engineers"],
    ["month name vs number", "Joined in January 2021", "joined 01/2021"],
    ["month abbreviation", "Joined in Sept 2021", "joined September 2021"],
    ["Present vs Current", "Staff Engineer, 2021–Present", "Staff Engineer, 2021 - current"],
    ["to date", "Staff Engineer, 2021 to present", "Staff Engineer since 2021 to date"],
    ["title abbreviations", "Senior Engineer at Brightwave Limited", "Sr. Engineer at Brightwave Ltd"],
    ["sentence-initial verbs may rephrase", "Shipped the merchant dashboard in React", "built the merchant dashboard in React"],
    ["tech names with punctuation", "Built APIs in Node.js and C#", "built APIs in Node.js and C#"],
  ])("keeps %s", (_label, fact, quote) => {
    expect(factClaimsMissing(fact, quote)).toEqual([])
  })

  it.each([
    ["a different magnitude", "Managed a budget of USD 2 billion", "managed a USD 2M budget", ["2000000000"]],
    ["an ongoing role the quote ends", "Engineer, 2021–Present", "Engineer, 2021-2024", ["present"]],
    ["a different month", "Joined in March 2021", "joined 01/2021", ["3"]],
    ["an acronym at the start", "AWS certified solutions architect", "certified solutions architect", ["aws"]],
    ["a word-boundary near miss", "Studied in Lagosville", "studied in Lagos", ["lagosville"]],
    ["a decimal", "Raised NPS by 4.5 points", "raised NPS by 4 points", ["4.5"]],
  ])("drops %s", (_label, fact, quote, missing) => {
    expect(factClaimsMissing(fact, quote)).toEqual(missing)
  })
})

describe("unsupportedScopeVerbs: only the whole fact is the fact's own wording (Revision 1, R1)", () => {
  it("a 3+ word excerpt with the verb in a non-doer position is still unsupported", () => {
    expect(unsupportedScopeVerbs("managed by the finance team", ["Tested a billing project managed by the finance team"])).toEqual(["managed"])
  })

  it("'manage the budget' from 'Did not manage the budget' is unsupported, so it goes to the judge", () => {
    expect(unsupportedScopeVerbs("manage the budget", ["Did not manage the budget"])).toEqual(["manage"])
  })

  it("the whole fact text passes, compared without case, extra spaces or one trailing full stop", () => {
    expect(unsupportedScopeVerbs("Did not manage the budget", ["Did not manage the budget"])).toEqual([])
    expect(unsupportedScopeVerbs("  did   not manage the budget. ", ["Did not manage the budget"])).toEqual([])
  })

  it("the whole fact text passes although the validator holds it with its section heading", () => {
    const support = "Supported a payments migration led by the platform team. Platform Analyst, Northwind Energy"
    expect(unsupportedScopeVerbs("Supported a payments migration led by the platform team", [support])).toEqual([])
  })
})

describe("headingClaimsMissing", () => {
  it("keeps a heading whose title, employer and dates match its quote", () => {
    expect(headingClaimsMissing({ title: "Senior Frontend Engineer", organization: "Brightwave Ltd", period: "2021–2024" }, HEADING_QUOTE)).toEqual([])
  })

  it.each([
    ["title", { title: "Engineering Manager", organization: "Brightwave Ltd", period: "2021-2024" }, ["engineering", "manager"]],
    ["employer", { title: "Senior Frontend Engineer", organization: "Brightwave Inc", period: "2021-2024" }, ["incorporated"]],
    ["dates", { title: "Senior Frontend Engineer", organization: "Brightwave Ltd", period: "2019-2024" }, ["2019"]],
    ["a first title word (no sentence-start exemption in headings)", { title: "Lead Frontend Engineer", organization: null, period: null }, ["lead"]],
  ])("drops a heading with an unsupported %s", (_label, heading, missing) => {
    expect(headingClaimsMissing(heading, HEADING_QUOTE)).toEqual(missing)
  })

  it("does not require generic section labels to appear in the quote", () => {
    expect(headingClaimsMissing({ title: "Technical Skills", organization: null, period: null }, "Skills: React, TypeScript, Node.js")).toEqual([])
    expect(headingClaimsMissing({ title: "Professional Summary", organization: null, period: null }, "Frontend engineer with 7 years of experience")).toEqual([])
  })

  it("checks an education heading word by word", () => {
    expect(headingClaimsMissing({ title: "BSc Computer Science", organization: "University of Lagos", period: "2017" }, "University of Lagos, BSc Computer Science, 2017")).toEqual([])
    expect(headingClaimsMissing({ title: "MSc Computer Science", organization: "University of Lagos", period: "2017" }, "University of Lagos, BSc Computer Science, 2017")).toEqual(["msc"])
  })
})

// SEC-213: a capitalised word at a sentence start or after a colon is a claim unless it
// is a common opening word (OPENING_WORDS). SEC-214: zero-width characters and soft
// hyphens can't split a word. Cases from RUN_ROOT/security-probes/claim-probe*.out.
describe("sentence starts and colons (SEC-213)", () => {
  const SKILLS = "Skills: React, TypeScript, Node.js, PostgreSQL"
  const TEAM = "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024"
  const PAYMENTS = "built apis for the payments team"

  it.each([
    ["an invented employer after a period", "Built APIs. Google hired me", PAYMENTS, ["google"]],
    ["an invented employer after a colon", "Employer: Google", PAYMENTS, ["employer", "google"]],
    ["an invented employer after a semicolon", "Built APIs; Microsoft", PAYMENTS, ["microsoft"]],
    ["an invented skill as the whole fact", "Kubernetes", SKILLS, ["kubernetes"]],
    ["an invented skill first in a list", "Kubernetes, React", SKILLS, ["kubernetes"]],
    ["another invented skill", "Python", SKILLS, ["python"]],
    ["an invented skill first, then a real one", "Terraform and React", SKILLS, ["terraform"]],
    ["an invented skill first after a colon", "Tech stack: Kubernetes, React", SKILLS, ["tech", "kubernetes"]],
    ["an invented university first", "Stanford graduate", "BSc Computer Science, University of Lagos, 2014", ["stanford"]],
    ["an invented title as the opener", "Manager for 4 frontend engineers at Brightwave Ltd", TEAM, ["manager"]],
    ["an invented title as the opener, with real dates", "Director of 4 frontend engineers at Brightwave Ltd, 2021-2024", TEAM, ["director"]],
    ["an invented employer opening a second sentence", "Led 4 frontend engineers at Brightwave Ltd. Google acquired the team", TEAM, ["google"]],
    ["an invented employer after an exclamation mark", "Led a team of 4 engineers! Kora Payments acquired it", TEAM, ["kora", "payments"]],
    ["an invented title after a colon", "Title: Director", TEAM, ["title", "director"]],
    ["an invented title after Promoted to", "Led 4 frontend engineers at Brightwave Ltd. Promoted to Director in 2023", TEAM, ["director", "2023"]],
    ["an invented skill after a descriptive opener", "Skilled in Kubernetes", SKILLS, ["kubernetes"]],
  ])("drops %s", (_label, fact, quote, missing) => {
    expect(factClaimsMissing(fact, quote)).toEqual(missing)
  })

  it.each(["Led", "Built", "Managed", "Shipped", "Designed", "Developed", "Delivered", "Mentored", "Owned", "Reduced"])(
    "keeps the opener verb %s although the quote uses another verb",
    (verb) => {
      expect(factClaimsMissing(`${verb} the payments APIs for 4 frontend engineers at Brightwave Ltd`, "built the payments APIs with 4 frontend engineers at Brightwave Ltd")).toEqual([])
    }
  )

  it.each([
    ["after a period", "Built the payments APIs at Brightwave Ltd. Led 4 frontend engineers", "Led a team of 4 frontend engineers at Brightwave Ltd; built the payments APIs"],
    ["after a colon", "Highlights: shipped the payments APIs at Brightwave Ltd", "Highlights: built the payments APIs at Brightwave Ltd"],
    ["after a colon, capitalised opener", "Role: Led 4 frontend engineers at Brightwave Ltd", "Role: Led a team of 4 frontend engineers at Brightwave Ltd"],
    ["function word openers", "The payments APIs at Brightwave Ltd were rebuilt", "rebuilt the payments APIs at Brightwave Ltd"],
    ["an opener with a sentence-initial In", "In 2021, led 4 frontend engineers at Brightwave Ltd", "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024"],
    ["a descriptive opener", "Skilled in React, TypeScript and Node.js", "Skills: React, TypeScript, Node.js, PostgreSQL"],
    ["Promoted to with a title the quote has", "Promoted to Senior Engineer at Brightwave Ltd", "Brightwave Ltd: promoted to Senior Engineer, 2023"],
  ])("keeps a supported fact with an opener %s", (_label, fact, quote) => {
    expect(factClaimsMissing(fact, quote)).toEqual([])
  })

  it("still keeps a capitalised opener that the quote contains", () => {
    expect(factClaimsMissing("Kubernetes and React", "Skills: Kubernetes, React")).toEqual([])
  })

  it("keeps the probes that were rightly kept", () => {
    expect(factClaimsMissing("Led a team of 4 engineers at Brightwave Ltd since 2021", "Led a team of 4 engineers at Brightwave Ltd, 2021-2024")).toEqual([])
  })
})

describe("zero-width characters and soft hyphens (SEC-214)", () => {
  const STARTUP = "Worked at a startup building payment APIs"

  it.each([
    ["zero-width space", "Worked at A\u200Bmazon building payment APIs"],
    ["zero-width non-joiner", "Worked at A\u200Cmazon building payment APIs"],
    ["zero-width joiner", "Worked at A\u200Dmazon building payment APIs"],
    ["word joiner", "Worked at A\u2060mazon building payment APIs"],
    ["byte-order mark", "Worked at A\uFEFFmazon building payment APIs"],
    ["soft hyphen", "Worked at A\u00ADmazon building payment APIs"],
  ])("drops an employer split by a %s", (_label, fact) => {
    expect(factClaimsMissing(fact, STARTUP)).toEqual(["amazon"])
  })

  it("drops a pronoun-led split (I + ZWSP + ntel)", () => {
    expect(factClaimsMissing("Worked at I\u200Bntel building payment APIs", STARTUP)).toEqual(["intel"])
  })

  it("matches a quote that itself contains zero-width characters", () => {
    expect(factClaimsMissing("Built APIs at Amazon", "built APIs at Ama\u200Bzon")).toEqual([])
  })

  it("strips them in headings too", () => {
    expect(headingClaimsMissing({ title: "Engineer", organization: "A\u200Bmazon", period: null }, "Engineer at a startup, 2021")).toEqual(["amazon"])
  })
})

describe("every default-ignorable code point (SEC-219)", () => {
  const STARTUP = "Worked at a startup building payment APIs"

  it.each([
    ["invisible times U+2062", "\u2062"],
    ["right-to-left override U+202E", "\u202E"],
    ["left-to-right isolate U+2066", "\u2066"],
    ["left-to-right mark U+200E", "\u200E"],
    ["Arabic letter mark U+061C", "\u061C"],
    ["Mongolian vowel separator U+180E", "\u180E"],
    ["tag letter U+E0041", "\u{E0041}"],
    ["musical symbol begin beam U+1D173", "\u{1D173}"],
  ])("drops an employer split by %s", (_label, char) => {
    expect(factClaimsMissing(`Worked at A${char}mazon building payment APIs`, STARTUP)).toEqual(["amazon"])
  })

  it("matches a quote that itself contains a default-ignorable character", () => {
    expect(factClaimsMissing("Built APIs at Amazon", "built APIs at Ama\u2066zon")).toEqual([])
  })
})

describe("QA-2B-05: QA's 12 faithful rewordings are kept", () => {
  const ECS = "• Led the migration of 14 services from Heroku to AWS ECS, cutting hosting costs by 31%"
  const GO = "Built route-optimisation APIs in Go serving 40,000 daily deliveries across 5 cities"
  const MENTOR = "Mentored 6 engineers; 3 were promoted to senior within 18 months"
  const SKILLS = "Skills: TypeScript, Go, Node.js, React, PostgreSQL, Redis, Kafka"
  it.each([
    ["Moved 14 services from Heroku to AWS ECS, cutting hosting costs by 31%", ECS],
    ["Migrated 14 services from Heroku to AWS ECS", ECS],
    ["Architected the move of 14 services from Heroku to AWS ECS", ECS],
    ["Cutting hosting costs by 31%, led a migration from Heroku to AWS ECS", ECS],
    ["Wrote route-optimisation APIs in Go for 40,000 daily deliveries", GO],
    ["Authored route-optimisation APIs in Go", GO],
    ["Go APIs for route optimisation, serving 40,000 daily deliveries across 5 cities", GO],
    ["Route-optimisation APIs in Go serve 40,000 daily deliveries", GO],
    ["Coached 6 engineers, 3 of whom were promoted to senior within 18 months", MENTOR],
    ["Six engineers mentored, three promoted to senior within 18 months", MENTOR],
    ["Skills: TypeScript, Go and React", SKILLS],
    ["Uses TypeScript, Go and React daily", SKILLS],
  ])("%s", (fact, quote) => {
    expect(factClaimsMissing(fact, quote)).toEqual([])
  })

  it.each(["Spearheaded", "Championed", "Streamlined", "Partnered", "Orchestrated", "Owns", "Leads", "Builds", "Maintains", "Delivers"])(
    "%s is a listed opener",
    (verb) => {
      expect(factClaimsMissing(`${verb} the payments dashboard rebuild`, "built the payments dashboard rebuild")).toEqual([])
    }
  )

  it.each(["Architect", "Lead", "Director", "Manager", "Principal", "Staff", "Head"])("%s stays a claim (title, not verb)", (title) => {
    expect(factClaimsMissing(`${title} of the payments dashboard rebuild`, "built the payments dashboard rebuild")).not.toEqual([])
  })
})

describe("CR-01: a lower-case month followed by a year is a date claim", () => {
  it("'joined in june 2021' against 'joined january 2021' drops the month", () => {
    expect(factClaimsMissing("Joined Brightwave in june 2021", "joined Brightwave january 2021")).toEqual(["6"])
  })

  it("a lower-case month and year in the quote supports the capitalised fact", () => {
    expect(factClaimsMissing("Joined Brightwave in June 2021", "joined Brightwave in june 2021")).toEqual([])
  })

  it("lower-case 'may' without a year is still a word", () => {
    expect(factClaimsMissing("Shipped what we may need", "built what we may need")).toEqual([])
  })
})

describe("CR-02: Co-founded is an opener, and 'co' before a hyphen is not 'company'", () => {
  it("'Co-founded a startup' against 'Started a startup' is kept", () => {
    expect(factClaimsMissing("Co-founded a payments startup", "Started a payments startup")).toEqual([])
  })

  it("'Co-founded Acme' still needs Acme in the quote", () => {
    expect(factClaimsMissing("Co-founded Acme", "Started a payments startup")).toEqual(["acme"])
  })
})

// EPIC-0009 repair: the fold map is indexed by UTF-16 unit, so an astral character (two units) must not shift later spans.
describe("astral characters keep spans and number order aligned", () => {
  const GRIN = "\u{1F600}"

  it("keeps numbers in order after astral characters", () => {
    expect(numbersIn(`${GRIN}${GRIN}${GRIN} 5 6 7 8`)).toEqual(["5", "6", "7", "8"])
  })

  it("keeps numbers in order with an astral character inside a number run", () => {
    expect(numbersIn(`5 6 ${GRIN} 7 ${GRIN}${GRIN} 8 9`)).toEqual(["5", "6", "7", "8", "9"])
  })

  it("keeps non-astral order unchanged", () => {
    expect(numbersIn("5 6 7 8")).toEqual(["5", "6", "7", "8"])
  })

  it("slices a term exactly when an astral character is adjacent to it", () => {
    const line = `${GRIN}Zorvex${GRIN} shipped ${GRIN} Zorvex`
    const zorvex = writtenClaims(line).filter((claim) => claim.value === "zorvex")
    expect(zorvex.map((claim) => claim.text)).toEqual(["Zorvex", "Zorvex"])
  })

  it("slices correctly when the line starts with an astral character", () => {
    const line = `${GRIN}${GRIN} Led 4 engineers at Zorvex`
    const claims = writtenClaims(line)
    for (const claim of claims) expect(line.slice(claim.start, claim.end)).toBe(claim.text)
    expect(claims.map((claim) => claim.text)).toEqual(["Led", "4", "engineers", "at", "Zorvex"])
  })

  it("never ends a span in the middle of a surrogate pair", () => {
    const line = "Shipped \u{1D400}\u{1D401} now"
    for (const claim of writtenClaims(line)) expect(claim.text).toMatch(/^(?:[^\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff])+$/)
  })
})
