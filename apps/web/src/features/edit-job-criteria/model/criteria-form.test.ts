import { describe, expect, it } from "vitest"

import { checkNewEntry, mapServerFieldErrors, parseMinCoreMatch, type Lists } from "./criteria-form"

const ERR = {
  match: "Enter a whole number from 1 to 100.",
  empty: "Enter a name to add.",
  full: "This list is full at 20 entries. Remove one to add another.",
  long: "Use 40 characters or fewer for each entry.",
  chars: "Use only letters, digits, spaces and these symbols: . + # - / _",
  dup: "Already in your list.",
}
const empty: Lists = { frameworks: [], technologies: [] }

describe("parseMinCoreMatch (AC 2.1, 2.2)", () => {
  it.each(["", "   ", "70.5", "0.7", "0", "-5", "101", "250", "seventy", "7O", "70%", "+70", "70.0", "7 0", "1e2", "000"])(
    "refuses %j",
    (input) => expect(parseMinCoreMatch(input)).toEqual({ ok: false, error: ERR.match })
  )

  it.each([
    ["1", 1],
    ["2", 2],
    ["70", 70],
    ["99", 99],
    ["100", 100],
    [" 70 ", 70],
    ["85 ", 85],
    ["  1", 1],
    ["100  ", 100],
    ["070", 70],
  ])("accepts %j as %i", (input, value) => expect(parseMinCoreMatch(input)).toEqual({ ok: true, value }))
})

describe("checkNewEntry (AC 3.1 to 3.3, 3.5)", () => {
  it.each(["Rust!", "Vue@3", "React<script>", "Go;", "Python (3)", "Elixir*"])("refuses disallowed characters in %j", (entry) =>
    expect(checkNewEntry(entry, "frameworks", empty)).toEqual({ ok: false, error: ERR.chars })
  )

  it.each([".", "-", " - ", "_", "./-"])("refuses %j, which has no letter or digit left after normalising (CR-01)", (entry) =>
    expect(checkNewEntry(entry, "technologies", empty)).toEqual({ ok: false, error: ERR.chars })
  )

  it.each(["C#", "C++", ".NET", "Node.js", "-x"])("still accepts %j, which keeps a letter or digit (CR-01)", (entry) =>
    expect(checkNewEntry(entry, "frameworks", empty)).toEqual({ ok: true, entry })
  )

  it.each(["", "   ", "\t"])("refuses the empty entry %j", (entry) =>
    expect(checkNewEntry(entry, "technologies", empty)).toEqual({ ok: false, error: ERR.empty })
  )

  it("accepts exactly 40 characters, measured after trimming, and refuses 41", () => {
    expect(checkNewEntry("   Amazon Web Services Elastic Beanstalk v2   ", "technologies", empty)).toEqual({
      ok: true,
      entry: "Amazon Web Services Elastic Beanstalk v2",
    })
    expect(checkNewEntry("Amazon Web Services Elastic Beanstalk v23", "technologies", empty)).toEqual({ ok: false, error: ERR.long })
  })

  it.each(["C#", "C++", "Node.js", "CI/CD", "Objective-C", "Ruby_on_Rails", "Next.js 14", "C"])("accepts %j", (entry) =>
    expect(checkNewEntry(entry, "technologies", empty)).toEqual({ ok: true, entry })
  )

  it("refuses a 21st entry in one list but not in the other", () => {
    const full = Array.from({ length: 20 }, (_, i) => `Tool${String.fromCharCode(65 + i)}`)
    expect(checkNewEntry("Elixir", "frameworks", { frameworks: full, technologies: [] })).toEqual({ ok: false, error: ERR.full })
    expect(checkNewEntry("Elixir", "technologies", { frameworks: full, technologies: full.slice(1) })).toEqual({ ok: true, entry: "Elixir" })
  })

  it.each([
    ["frameworks", "React", "technologies", "React.js"],
    ["frameworks", "React", "frameworks", "react"],
    ["frameworks", "React", "frameworks", "ReactJS"],
    ["frameworks", "Vue", "frameworks", "VueJS"],
    ["frameworks", "Next.js", "frameworks", "NextJS"],
    ["frameworks", "Next.js", "technologies", "Next"],
    ["frameworks", "Nuxt", "frameworks", "Nuxt.js"],
    ["technologies", "Node.js", "frameworks", "Node"],
    ["frameworks", "Express", "frameworks", "Express.js"],
    ["technologies", "TypeScript", "frameworks", "TS"],
    ["technologies", "JavaScript", "technologies", "ECMAScript"],
    ["technologies", "Go", "technologies", "Golang"],
    ["technologies", "Postgres", "technologies", "PostgreSQL"],
    ["technologies", "Kubernetes", "technologies", "K8s"],
    ["frameworks", "Tailwind CSS", "frameworks", "TailwindCSS"],
    ["frameworks", "React Native", "technologies", "RN"],
    ["technologies", "GraphQL", "technologies", "GQL"],
    ["technologies", "AWS", "technologies", "Amazon Web Services"],
    ["technologies", "GCP", "technologies", "Google Cloud Platform"],
    ["technologies", "Ruby on Rails", "frameworks", "Ruby-on-Rails"],
    ["technologies", "TypeScript", "technologies", "TYPESCRIPT"],
  ] as const)("in %s %j refuses %s %j as a duplicate", (existingList, existing, newList, entry) => {
    const lists = { ...empty, [existingList]: [existing] }
    expect(checkNewEntry(entry, newList, lists)).toEqual({ ok: false, error: ERR.dup })
  })

  it.each([
    ["frameworks", "Angular", "AngularJS"],
    ["technologies", "Java", "JavaScript"],
    ["frameworks", "React", "React Native"],
    ["technologies", "C", "C#"],
    ["technologies", "C", "C++"],
    ["technologies", "C#", "C++"],
  ] as const)("in %s %j accepts the look-alike %j", (list, existing, entry) =>
    expect(checkNewEntry(entry, list, { ...empty, [list]: [existing] })).toEqual({ ok: true, entry })
  )
})

describe("mapServerFieldErrors (contract v1.13.0 fieldErrors)", () => {
  const lists: Lists = { frameworks: ["React"], technologies: ["Go", "React.js"] }

  it("puts a Match error on the field and a duplicate on the chip at its position", () => {
    const mapped = mapServerFieldErrors(
      [
        { field: "minCoreMatchPercent", position: null, problem: "invalid" },
        { field: "technologies", position: 2, problem: "duplicate_entry" },
      ],
      lists
    )
    expect(mapped?.match).toBe(ERR.match)
    expect([...mapped!.lists.technologies.entries]).toEqual([[1, '"React.js" repeats another entry. Remove one to save.']])
    expect(mapped?.lists.frameworks.entries.size).toBe(0)
  })

  it("maps whole-list and entry problems to the copy deck strings", () => {
    const mapped = mapServerFieldErrors(
      [
        { field: "frameworks", position: null, problem: "too_many_entries" },
        { field: "technologies", position: 1, problem: "entry_disallowed_characters" },
      ],
      lists
    )
    expect(mapped?.lists.frameworks.list).toBe(ERR.full)
    expect(mapped?.lists.technologies.entries.get(0)).toBe(ERR.chars)
  })

  it("gives up (null) on an error it can't place, so the API message shows instead", () => {
    expect(mapServerFieldErrors([{ field: "frameworks", position: null, problem: "invalid" }], lists)).toBeNull()
    expect(mapServerFieldErrors([{ field: "frameworks", position: 5, problem: "entry_empty" }], lists)).toBeNull()
  })
})
