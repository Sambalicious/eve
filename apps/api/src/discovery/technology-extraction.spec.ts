import { describe, expect, it } from "vitest"

import { POSTING_TEXT_LIMIT, postingExtractionSchema } from "./posting-extraction.js"
import { nameAppearsInQuote, verifyTechnologies } from "./technology-extraction.js"

const BASE = {
  workArrangement: "remote",
  locationQuote: null,
  relocationCountry: null,
  relocationQuote: null,
  sponsorshipQuote: null,
  payQuote: null,
  hoursQuote: null,
  employerBusiness: null,
  businessQuote: null,
  employmentType: null,
  coreResponsibilities: [],
  mandatoryPrerequisites: [],
  niceToHave: [],
}

/** What the tolerant schema hands verifyTechnologies for a raw model `technologies` value. */
function parsed(technologies: unknown) {
  const body = technologies === "omit" ? BASE : { ...BASE, technologies }
  const result = postingExtractionSchema.safeParse(body)
  if (!result.success) throw new Error("the extraction must still parse")
  return result.data.technologies
}

const names = (result: ReturnType<typeof verifyTechnologies>) => result.technologies?.map((item) => item.name) ?? null

describe("tolerant technologies field (AC 4.8)", () => {
  it.each([["omit"], [null], ["React, TypeScript"], [{ name: "React" }], [3]])("%j parses as no technology data and the extraction succeeds", (value) => {
    expect(verifyTechnologies(parsed(value), "anything").technologies).toBeNull()
  })

  it("a valid empty array is technology data with zero technologies", () => {
    expect(verifyTechnologies(parsed([]), "We build in Vue.").technologies).toEqual([])
  })

  it("an array whose items are all dropped is technology data with zero technologies", () => {
    const result = verifyTechnologies(parsed([{ name: "React", quote: "We build in React." }, { name: "", quote: "We build in Vue." }]), "We build in Vue.")
    expect(result.technologies).toEqual([])
    expect(result.droppedCount).toBe(2)
  })
})

describe("item verification (AC 4.1, 4.2, 4.9)", () => {
  const text = "You will build features in React and TypeScript on a Node.js backend."

  it("keeps names the quote uses, each with its quote", () => {
    const result = verifyTechnologies(parsed([{ name: "React", quote: text }, { name: "TypeScript", quote: text }, { name: "Node.js", quote: text }]), text)
    expect(result.technologies).toEqual([
      { name: "React", quote: text },
      { name: "TypeScript", quote: text },
      { name: "Node.js", quote: text },
    ])
  })

  it("accepts the canonical name when the alias table maps it", () => {
    const posting = "Our frontend is ReactJS with a Golang API."
    const result = verifyTechnologies(parsed([{ name: "React", quote: "Our frontend is ReactJS" }, { name: "Go", quote: "a Golang API" }]), posting)
    expect(names(result)).toEqual(["React", "Go"])
  })

  it("matches quotes with the same normalisation as other quotes", () => {
    const posting = "Strong   experience with\nKubernetes  and Terraform."
    expect(names(verifyTechnologies(parsed([{ name: "Kubernetes", quote: "Strong experience with Kubernetes and Terraform." }]), posting))).toEqual(["Kubernetes"])
  })

  it("keeps a verbatim name such as Phoenix", () => {
    const posting = "Experience with Elixir and Phoenix is a plus."
    expect(names(verifyTechnologies(parsed([{ name: "Phoenix", quote: posting }]), posting))).toEqual(["Phoenix"])
  })

  it("drops a technology whose quote is not in the posting", () => {
    expect(names(verifyTechnologies(parsed([{ name: "React", quote: "We build in React." }]), "We build in Vue."))).toEqual([])
  })

  it.each([
    ["Our UI is built with Preact.", "React"],
    ["Legacy AngularJS app to maintain.", "Angular"],
    ["Scripts in JavaScript run in browsers.", "Java"],
    ["We deploy to Heroku.", "AWS"],
    ["Mobile app written in React Native.", "React"],
    ["Our stack is modern and fast.", "TypeScript"],
  ])("drops %j when the model returns %j", (text, name) => {
    expect(names(verifyTechnologies(parsed([{ name, quote: text }]), text))).toEqual([])
  })

  it.each([
    ["R", "kept"],
    ["Amazon Web Services Elastic Container Service for Kubernetes", "kept"],
    ["Amazon Web Services Elastic Container Service for Kubernetes2", "dropped"],
  ])("a name of %j is %s alone, and Vue is still kept", (name, result) => {
    const posting = `We use ${name} and also Vue daily.`
    const output = names(verifyTechnologies(parsed([{ name, quote: posting }, { name: "Vue", quote: posting }]), posting))
    expect(output).toEqual(result === "kept" ? [name, "Vue"] : ["Vue"])
  })

  it.each([
    [{ name: "", quote: "We use React and Vue." }],
    [{ quote: "We use React and Vue." }],
    [{ name: "React" }],
    [{ name: 42, quote: "We use React and Vue." }],
    [{ name: "React", quote: ["We use"] }],
    [{ name: null, quote: "We use React and Vue." }],
    ["React"],
  ])("drops the malformed item %j alone", (bad) => {
    const posting = "We use React and Vue."
    expect(names(verifyTechnologies(parsed([bad, { name: "Vue", quote: posting }]), posting))).toEqual(["Vue"])
  })

  const many = (count: number) => Array.from({ length: count }, (_, i) => `Tool${i + 1}`)
  const posting = (tools: string[]) => tools.map((tool) => `We use ${tool} here.`).join(" ")
  const items = (tools: string[]) => tools.map((tool) => ({ name: tool, quote: `We use ${tool} here.` }))

  it.each([
    [1, 1, 1],
    [39, 39, 39],
    [40, 40, 40],
    [45, 41, 40],
    [60, 60, 40],
  ])("posting names %i, model returns %i passing items: keeps the first %i in model order", (named, returned, stored) => {
    const tools = many(named)
    const result = verifyTechnologies(parsed(items(tools.slice(0, returned))), posting(tools))
    expect(names(result)).toEqual(tools.slice(0, stored))
  })

  it("dropped items do not count toward the 40 kept", () => {
    const tools = many(45)
    const returned = items(tools).map((item, index) => (index === 2 || index === 9 ? { ...item, quote: "Not in the posting at all." } : item))
    const result = verifyTechnologies(parsed(returned), posting(tools))
    expect(names(result)).toEqual([...tools.slice(0, 2), ...tools.slice(3, 9), ...tools.slice(10, 42)])
  })

  it("a matching technology beyond the 40th passing item is discarded", () => {
    const tools = [...many(40), "Elixir"]
    expect(names(verifyTechnologies(parsed(items(tools)), posting(tools)))).not.toContain("Elixir")
  })
})

// SEC-001 (security-review.md): the quote must sit in the posting on word boundaries, and the name is checked
// against the posting's own whole tokens at that place, never against a model-cut fragment.
describe("quotes anchored on word boundaries (SEC-001, AC 4.2)", () => {
  const keep = (name: string, quote: string, posting: string) => names(verifyTechnologies(parsed([{ name, quote }]), posting))

  it.each([
    ["Java", "java", "Frontend role. Scripts in JavaScript run in browsers."],
    ["Java", "Java", "We write JavaScript and TypeScript."],
    ["Go", "go", "Good communication and trust in a nice team."],
    ["Rust", "rust", "Good communication and trust in a nice team."],
    ["C", "c", "Good communication and trust in a nice team."],
    ["React", "react", "Our UI is built with Preact."],
    ["React", "react", "We value reactive programming."],
    ["React", "React", "Reactive streams power our backend."],
    ["Go", "Go", "Strong Golang-adjacent tooling knowledge is a plus."],
    ["Java", "java", "We use Java8 everywhere."],
    ["C", "C", "Services in C# and .NET."],
    ["C", "C", "Performance work in C++ is required."],
    ["React", "React", "Mobile app written in React Native."],
    ["Angular", "Angular", "Legacy AngularJS app to maintain."],
    ["Java", "ava", "Frontend role. Java is used."],
  ])("drops %j with quote %j on %j", (name, quote, posting) => {
    expect(keep(name, quote, posting)).toEqual([])
  })

  it.each([
    ["C#", "C#", "Services in C# and .NET."],
    ["C#", "Services in C# and .NET", "Our Services in C# and .NET run on Azure."],
    [".NET", ".NET", "Services in C# and .NET."],
    ["C++", "C++", "Performance work in C++ is required."],
    ["C++", "work in C++ is", "Performance work in C++ is required."],
    ["Node.js", "Node.js", "A Node.js backend serves the API."],
    ["Node", "Node", "A Node.js backend serves the API."],
    ["Vue.js", "Vue.js", "The UI uses Vue.js 3."],
    ["Vue", "Vue.js", "The UI uses Vue.js 3."],
    ["Go", "Go", "Our services are written in Go."],
    ["Go", "go", "Our services are written in Go."],
    ["Java", "Java", "Backend in Java, frontend in JavaScript."],
    ["React", "React/Redux", "Experience with React/Redux is required."],
    ["React", "react", "We build in React."],
    ["React Native", "React Native", "Mobile app written in React Native."],
    ["C", "C", "Firmware in C and Rust."],
  ])("keeps %j with quote %j on %j", (name, quote, posting) => {
    expect(keep(name, quote, posting)).toEqual([name])
  })

  it("a quote that occurs once inside a word and once on boundaries is kept by the boundary occurrence", () => {
    expect(keep("Java", "java", "JavaScript today; Java tomorrow.")).toEqual(["Java"])
  })

  it("a partial-word quote no longer ranks a JavaScript-only posting under the criterion Java", () => {
    const result = verifyTechnologies(parsed([{ name: "Java", quote: "java" }]), "Frontend role. Scripts in JavaScript run in browsers.")
    expect(result).toEqual({ technologies: [], droppedCount: 1 })
  })
})

describe("quote length cap (SEC-004, AC 4.9)", () => {
  it.each([
    [600, ["React", "Vue"]],
    [601, ["Vue"]],
  ])("a %i-character quote: kept items are %j", (length, expected) => {
    const prefix = "We build in React "
    const long = `${prefix}${"x".repeat(length - prefix.length)}`
    const posting = `${long} and also Vue daily.`
    const result = verifyTechnologies(parsed([{ name: "React", quote: long }, { name: "Vue", quote: "also Vue daily" }]), posting)
    expect(names(result)).toEqual(expected)
  })
})

// SEC-005 (security-review.md, prd.r3 AC 4.10, technology-extraction.feature r7): a quote carrying a Unicode bidi
// control character could visually reorder the text on the detail page, so its item is dropped alone under AC 4.9.
describe("bidi control characters in a quote (SEC-005, AC 4.10)", () => {
  const BIDI = [
    ["U+202A", "\u202A"],
    ["U+202B", "\u202B"],
    ["U+202C", "\u202C"],
    ["U+202D", "\u202D"],
    ["U+202E", "\u202E"],
    ["U+2066", "\u2066"],
    ["U+2067", "\u2067"],
    ["U+2068", "\u2068"],
    ["U+2069", "\u2069"],
    ["U+200E", "\u200E"],
    ["U+200F", "\u200F"],
    ["U+061C", "\u061C"],
  ] as const
  const posting = "We use React and Vue."

  it.each(BIDI)("a quote with %s after 'We use ' drops only that item, even though it otherwise verifies", (_label, character) => {
    const quote = `We use ${character}React and Vue.`
    const result = verifyTechnologies(parsed([{ name: "React", quote }, { name: "Vue", quote: posting }]), posting)
    expect(result).toEqual({ technologies: [{ name: "Vue", quote: posting }], droppedCount: 1 })
  })

  it.each(BIDI)("a quote ending in %s is dropped", (_label, character) => {
    expect(names(verifyTechnologies(parsed([{ name: "React", quote: `We use React${character}` }]), posting))).toEqual([])
  })

  it("every bidi item dropped means zero technologies, not 'not checked' (AC 4.8)", () => {
    const result = verifyTechnologies(parsed([{ name: "React", quote: "We use \u202EReact" }, { name: "Vue", quote: "and \u2066Vue." }]), posting)
    expect(result).toEqual({ technologies: [], droppedCount: 2 })
  })

  it("no kept quote contains a bidi control character", () => {
    const quotes = BIDI.map(([, character], index) => ({ name: index % 2 === 0 ? "React" : "Vue", quote: `We use ${character}React and Vue.` }))
    const result = verifyTechnologies(parsed([...quotes, { name: "React", quote: posting }]), posting)
    expect(result.technologies?.map((item) => item.quote)).toEqual([posting])
    expect(result.technologies?.some((item) => /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u.test(item.quote))).toBe(false)
  })

  it("other invisible characters that are not bidi controls keep their existing handling (zero-width space)", () => {
    expect(names(verifyTechnologies(parsed([{ name: "React", quote: "We use \u200BReact" }]), posting))).toEqual(["React"])
  })

  it("bidi-dropped items do not count toward the 40 kept", () => {
    const tools = Array.from({ length: 42 }, (_, i) => `Tool${i + 1}`)
    const text = tools.map((tool) => `We use ${tool} here.`).join(" ")
    const returned = tools.map((tool, index) => ({ name: tool, quote: index === 4 ? `We use \u202E${tool} here.` : `We use ${tool} here.` }))
    const result = verifyTechnologies(parsed(returned), text)
    expect(names(result)).toEqual([...tools.slice(0, 4), ...tools.slice(5, 41)])
  })
})

// Replaces the QA scratch probe (zz-qa-perf-probe.spec.ts). The model's quotes are untrusted and need not be
// distinctive: 40 one-character quotes that occur thousands of times must not cost seconds of worker CPU.
describe("verification cost on short, frequent quotes (AC 4.9)", () => {
  const BUDGET_MS = 500
  const sentence = "We use a React app. "
  const postings = [
    ["30,000", sentence.repeat(1500)],
    ["210,000", sentence.repeat(10500)],
  ] as const

  it.each(
    postings.flatMap(([size, text]) => [
      [size, ".", text],
      [size, "a", text],
    ])
  )(
    "a %s-character posting with 40 items each quoting %j finishes under 500 ms and keeps nothing",
    (_size, quote, text) => {
      const items = Array.from({ length: 40 }, () => ({ name: "Nonexistent", quote }))
      const started = performance.now()
      const result = verifyTechnologies(parsed(items), text)
      const elapsed = performance.now() - started
      expect(result).toEqual({ technologies: [], droppedCount: 40 })
      expect(elapsed).toBeLessThan(BUDGET_MS)
    },
    5000
  )
})

describe("verification bounds keep the anchored-name rules (SEC-001, AC 4.2)", () => {
  const filler = "Lorem ipsum dolor sit amet. ".repeat(4000)

  it("masking by a longer known name still applies deep inside a long posting", () => {
    // CR-03: placed near the end of the first 30,000 characters, the part the model saw and verification reads.
    const posting = `${"Lorem ipsum dolor sit amet. ".repeat(1000)}We build with React Native daily. ${filler}`
    expect(names(verifyTechnologies(parsed([{ name: "React", quote: "React" }, { name: "React Native", quote: "React Native" }]), posting))).toEqual([
      "React Native",
    ])
  })

  it("a verifying occurrence within the first 64 boundary occurrences keeps the item", () => {
    const posting = `${"React Native, ".repeat(63)}and plain React.`
    expect(names(verifyTechnologies(parsed([{ name: "React", quote: "React" }]), posting))).toEqual(["React"])
  })

  it("only the first 64 boundary occurrences are examined; a later one does not verify", () => {
    const posting = `${"React Native, ".repeat(64)}and plain React.`
    expect(names(verifyTechnologies(parsed([{ name: "React", quote: "React" }]), posting))).toEqual([])
  })

  it("a match inside a posting token longer than 600 characters is skipped", () => {
    const posting = `Stack: ${"x".repeat(700)}.React.${"y".repeat(700)} and Vue.`
    expect(names(verifyTechnologies(parsed([{ name: "React", quote: "React" }, { name: "Vue", quote: "Vue" }]), posting))).toEqual(["Vue"])
  })
})

describe("verification reads what the model read and counts raw hits (CR-03, SEC-009, AC 4.11)", () => {
  const BUDGET_MS = 500

  it("a quote found only after the first 30,000 characters is dropped", () => {
    const posting = `${"Lorem ipsum dolor sit amet. ".repeat(1100)}We build with Elixir daily.`
    expect(posting.indexOf("Elixir")).toBeGreaterThan(POSTING_TEXT_LIMIT)
    expect(verifyTechnologies(parsed([{ name: "Elixir", quote: "We build with Elixir daily." }]), posting)).toEqual({ technologies: [], droppedCount: 1 })
  })

  it("a quote inside the first 30,000 characters still verifies when the posting is longer", () => {
    const posting = `We build with Elixir daily. ${"Lorem ipsum dolor sit amet. ".repeat(2000)}`
    expect(names(verifyTechnologies(parsed([{ name: "Elixir", quote: "We build with Elixir daily." }]), posting))).toEqual(["Elixir"])
  })

  it("boundary-rejected occurrences count toward the 64: a 65th raw hit is never examined", () => {
    const posting = `${"Preact, ".repeat(64)}and plain React.`
    expect(names(verifyTechnologies(parsed([{ name: "React", quote: "React" }]), posting))).toEqual([])
  })

  it("a verifying occurrence that is the 64th raw hit keeps the item", () => {
    const posting = `${"Preact, ".repeat(63)}and plain React.`
    expect(names(verifyTechnologies(parsed([{ name: "React", quote: "React" }]), posting))).toEqual(["React"])
  })

  it("a 2,000,000-character run with 40 items of 600-character word-run quotes finishes under 500 ms", () => {
    const posting = "a".repeat(2_000_000)
    const items = Array.from({ length: 40 }, () => ({ name: "Nonexistent", quote: "a".repeat(600) }))
    const started = performance.now()
    const result = verifyTechnologies(parsed(items), posting)
    const elapsed = performance.now() - started
    expect(result).toEqual({ technologies: [], droppedCount: 40 })
    expect(elapsed).toBeLessThan(BUDGET_MS)
  }, 10_000)
})

describe("nameAppearsInQuote (AC 4.2)", () => {
  it.each([
    ["React", "Experience with React/Redux"],
    ["React Native", "Mobile app written in React Native."],
    ["Node.js", "a Node.js backend"],
    ["Tailwind", "styled with Tailwind CSS"],
    ["GCP", "on Google Cloud Platform"],
    ["C#", "Services in C# and .NET"],
  ])("%j is in %j", (name, quote) => {
    expect(nameAppearsInQuote(name, quote)).toBe(true)
  })

  it.each([
    ["C", "Services in C# and .NET"],
    ["Java", "JavaScript everywhere"],
    ["Go", "on Google Cloud"],
  ])("%j is not in %j", (name, quote) => {
    expect(nameAppearsInQuote(name, quote)).toBe(false)
  })
})

// SEC-009 part 2 (security-review.r1.md; .runs/f3/reports/security.md, security-r2.md): spaced, repetitive quotes
// that verify on word boundaries cost about 300 tokens x 12 n-gram sizes per occurrence. A per-call comparison budget
// bounds the whole call; items left when it runs out are dropped under AC 4.9 and the evaluation still succeeds.
describe("per-call comparison budget (SEC-009 part 2, AC 4.9, AC 4.12 proposal)", () => {
  const BUDGET_MS = 500
  const forty = (quote: string, name = "Nonexistent") => Array.from({ length: 40 }, () => ({ name, quote }))

  it.each([
    ['"a a a"', "a ".repeat(300).slice(0, 600), "a ".repeat(15_000)],
    ['"a a a" on a 2,000,000-character posting', "a ".repeat(300).slice(0, 600), "a ".repeat(1_000_000)],
    ['"a,a"', "a,".repeat(300), "a,".repeat(15_000)],
    ['"a b"', "a b ".repeat(150), "a b ".repeat(7500)],
    ["a 12-token cycle", "a b c d e f g h i j k l ".repeat(25).slice(0, 600), "a b c d e f g h i j k l ".repeat(1250)],
    ["dot runs", ("a" + ".".repeat(298) + "a ").repeat(2).slice(0, 600), ("a" + ".".repeat(298) + "a ").repeat(100)],
  ])(
    "40 spaced worst-case quotes (%s) finish under 500 ms, drop every item and the call succeeds",
    (_label, quote, posting) => {
      const started = performance.now()
      const result = verifyTechnologies(parsed(forty(quote)), posting)
      const elapsed = performance.now() - started
      expect(result.technologies).toEqual([])
      expect(result.droppedCount).toBe(40)
      expect(elapsed).toBeLessThan(BUDGET_MS)
    },
    10_000
  )

  // QA-G4-1 (finding-g4-tests): dot runs are few, long tokens, so only the per-COMPARISON_CHARS charge spends the
  // budget on them; without it the dot-run case finishes without the budget dropping anything.
  it("the dot-run case is dropped by the budget (per-64-character charge)", () => {
    const quote = ("a" + ".".repeat(298) + "a ").repeat(2).slice(0, 600)
    const result = verifyTechnologies(parsed(forty(quote)), ("a" + ".".repeat(298) + "a ").repeat(100))
    expect(result.droppedCount).toBe(40)
    expect(result.budgetDroppedCount).toBeDefined()
    expect(result.budgetDroppedCount).toBeGreaterThan(0)
  })

  it("reports how many items the spent budget dropped", () => {
    const result = verifyTechnologies(parsed(forty("a ".repeat(300).slice(0, 600))), "a ".repeat(15_000))
    expect(result.budgetDroppedCount).toBeGreaterThan(0)
    expect(result.budgetDroppedCount).toBeLessThanOrEqual(40)
  })

  it("items checked before the budget runs out are kept; later items are dropped even when they would verify", () => {
    const posting = `We build with React and Vue. ${"a ".repeat(14_000)}`
    const spaced = "a ".repeat(300).slice(0, 600)
    const items = [
      { name: "React", quote: "We build with React" },
      ...Array.from({ length: 5 }, () => ({ name: "Nonexistent", quote: spaced })),
      { name: "Vue", quote: "React and Vue" },
    ]
    const result = verifyTechnologies(parsed(items), posting)
    expect(names(result)).toEqual(["React"])
    expect(result.droppedCount).toBe(6)
    expect(result.budgetDroppedCount).toBeGreaterThanOrEqual(1)
    expect(result.budgetDroppedCount).toBeLessThanOrEqual(6)
  })

  // QA-G8-4 (.runs/g8/reports/qa-r2.md, mutation M2): the cases above drain the budget to exactly 0 with 1-unit
  // charges. Here a junk quote of N spaced "a" tokens fails on its large known-span charge while budget is still
  // left (for these sizes the remainder is between 16 and 3N+12 units, enough for the cheap React check). AC 4.12:
  // the item being checked and every later item are dropped, so React must not verify after the junk was dropped.
  it.each([
    [1, 60],
    [1, 64],
    [2, 35],
  ])("%i junk item(s) of %i spaced tokens fail a large charge with budget left; a later cheap item is still dropped", (junk, size) => {
    const posting = `We use React. ${"a ".repeat(14_000)}`
    const spaced = "a ".repeat(size).trim()
    const react = { name: "React", quote: "We use React" }
    expect(names(verifyTechnologies(parsed([react]), posting))).toEqual(["React"])
    const items = [...Array.from({ length: junk }, () => ({ name: "Nonexistent", quote: spaced })), react]
    const result = verifyTechnologies(parsed(items), posting)
    expect(result).toEqual({ technologies: [], droppedCount: junk + 1, budgetDroppedCount: 2 })
  })

  it("an unspent budget adds no budget field (existing result shape)", () => {
    const result = verifyTechnologies(parsed([{ name: "React", quote: "React" }]), "We use React.")
    expect(result).toEqual({ technologies: [{ name: "React", quote: "React" }], droppedCount: 0 })
    expect("budgetDroppedCount" in result).toBe(false)
  })

  it("a realistic 40-item answer of sentence quotes on 28,000 characters of prose keeps every item", () => {
    const technologies = [
      "React", "Vue", "Angular", "Svelte", "TypeScript", "JavaScript", "Node.js", "Express", "NestJS", "Next.js",
      "GraphQL", "PostgreSQL", "MySQL", "Redis", "Kafka", "RabbitMQ", "Docker", "Kubernetes", "Terraform", "AWS",
      "GCP", "Azure", "Python", "Django", "Flask", "Go", "Rust", "Java", "Kotlin", "Spring",
      "Elixir", "Phoenix", "Ruby", "Rails", "Swift", "Tailwind", "Vite", "Jest", "Playwright", "React Native",
    ]
    const sentences = technologies.map(
      (name, index) => `In team ${index} you will design, build and operate production services with ${name} alongside other engineers every week.`
    )
    const filler = "Our customers rely on us to ship careful, well tested work and to keep improving it over time. "
    const posting = `${filler.repeat(124)}${sentences.join(" ")} ${filler.repeat(124)}`
    expect(posting.length).toBeGreaterThan(28_000)
    expect(posting.length).toBeLessThan(POSTING_TEXT_LIMIT)
    const items = technologies.map((name, index) => ({ name, quote: sentences[index] as string }))
    const result = verifyTechnologies(parsed(items), posting)
    expect(names(result)).toEqual(technologies)
    expect(result.droppedCount).toBe(0)
    expect("budgetDroppedCount" in result).toBe(false)
  })

  it("a realistic 40-item answer of near-600-character prose quotes, name last, keeps every item", () => {
    const words = "you will design build test review and operate careful production services for our customers with".split(" ")
    const prose = (index: number) => Array.from({ length: 90 }, (_, at) => words[(at + index) % words.length]).join(" ")
    const technologies = Array.from({ length: 40 }, (_, index) => `Tech${index}`)
    const quotes = technologies.map((name, index) => `${prose(index)} ${name}.`)
    expect(Math.min(...quotes.map((quote) => quote.length))).toBeGreaterThan(500)
    expect(Math.max(...quotes.map((quote) => quote.length))).toBeLessThanOrEqual(600)
    const posting = quotes.join(" ")
    expect(posting.length).toBeLessThan(POSTING_TEXT_LIMIT)
    const result = verifyTechnologies(parsed(technologies.map((name, index) => ({ name, quote: quotes[index] as string }))), posting)
    expect(names(result)).toEqual(technologies)
    expect("budgetDroppedCount" in result).toBe(false)
  })
})

// QA-G4-1 (finding-g4-tests): the linear scan that replaced the edge-trim regex in `tokenise`. The trim is not
// exported, so these tests reach it through the public `nameAppearsInQuote`, which tokenises the quote the same way
// and is not budgeted.
describe("edge-punctuation trim in tokenise (SEC-009 part 2, dot runs)", () => {
  /** The trim as origin/main had it before SEC-009 part 2 (quadratic on a long inner run). */
  const OLD_EDGE_TRIM = /^[.\-_]+|[.\-_]+$/gu
  /** origin/main's TOKEN_SPLIT, so the reference tokenises exactly as the product does. */
  const TOKEN_SPLIT = /[\s,;:()[\]{}!?"'|]+/u
  const MAX_NGRAM = 12

  it("a 50,000-character inner dot run is tokenised under 100 ms", () => {
    const quote = `a${".".repeat(50_000)}a`
    const started = performance.now()
    expect(nameAppearsInQuote("Nonexistent", quote)).toBe(false)
    expect(performance.now() - started).toBeLessThan(100)
  })

  /** Seeded PRNG (mulberry32) so a failure reproduces. */
  function random(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
    }
  }

  /** The old pipeline's answer: the name, stripped, is a run of at most 12 old-regex tokens. */
  function referenceAppears(name: string, quote: string): boolean {
    const strip = (text: string) => text.toLowerCase().replace(/[\s.\-_]/gu, "")
    const target = strip(name)
    if (target === "") return false
    const tokens = quote
      .toLowerCase()
      .split(TOKEN_SPLIT)
      .map((token) => token.replace(OLD_EDGE_TRIM, ""))
      .filter((token) => token.length > 0)
    for (let size = 1; size <= Math.min(MAX_NGRAM, tokens.length); size += 1) {
      for (let start = 0; start + size <= tokens.length; start += 1) {
        if (strip(tokens.slice(start, start + size).join(" ")) === target) return true
      }
    }
    return false
  }

  it("matches the old regex trim on 1,000 seeded random quotes of '.', '-', '_' and letters", () => {
    // x, y and z form no alias or known multi-word name, so masking never applies and the reference stays exact.
    const next = random(0x5ec009)
    const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T
    const token = () => {
      const length = 1 + Math.floor(next() * 6)
      const punctuationOnly = next() < 0.3
      return Array.from({ length }, () => pick(punctuationOnly ? [".", "-", "_"] : [".", "-", "_", "x", "y", "z"])).join("")
    }
    let matched = 0
    for (let run = 0; run < 1000; run += 1) {
      const raw = Array.from({ length: 1 + Math.floor(next() * 24) }, token)
      const quote = raw.join(pick([" ", " ", ", "]))
      const from = Math.floor(next() * raw.length)
      const name = next() < 0.8 ? raw.slice(from, from + 8 + Math.floor(next() * 10)).join(" ") : token()
      const expected = referenceAppears(name, quote)
      expect(nameAppearsInQuote(name, quote), `seed run ${run}: name ${JSON.stringify(name)} in ${JSON.stringify(quote)}`).toBe(expected)
      if (expected) matched += 1
    }
    // Both outcomes are exercised, including names past the 12-token limit once punctuation-only tokens are dropped.
    expect(matched).toBeGreaterThan(100)
    expect(matched).toBeLessThan(900)
  })
})
