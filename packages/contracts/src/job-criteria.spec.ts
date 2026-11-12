import { describe, expect, it } from "vitest"

import { apiErrorResponseSchema } from "./errors.js"
import { findDuplicateEntries, isAllowedJobCriteriaEntry, jobCriteriaFieldErrors, jobCriteriaRequestSchema, jobCriteriaResponseSchema } from "./job-criteria.js"

// v1.18.0: every body carries the two EPIC-0006 fields, which are required.
const roleRelevance = { targetRoleFamilies: ["senior_frontend"], seniorityFloor: "hide_entry_level" }
const valid = { minCoreMatchPercent: 70, frameworks: [], technologies: [], ...roleRelevance }

describe("jobCriteriaRequestSchema (AC 2.7, 3.1, 3.2, 3.7, 1.4)", () => {
  it.each([70, 70.0, 1, 100])("accepts the JSON number %d", (value) => {
    expect(jobCriteriaRequestSchema.parse({ ...valid, minCoreMatchPercent: value }).minCoreMatchPercent).toBe(value)
  })

  it.each([["70"], [70.5], [0], [101], [-1], [null], [true], [[70]], [{ value: 70 }], [undefined]])("refuses the Match value %j", (value) => {
    expect(jobCriteriaRequestSchema.safeParse({ ...valid, minCoreMatchPercent: value }).success).toBe(false)
  })

  it("refuses an unknown key such as baseVersion", () => {
    expect(jobCriteriaRequestSchema.safeParse({ ...valid, baseVersion: 1 }).success).toBe(false)
  })

  it.each(["C#", "C++", "Node.js", "CI/CD", "Objective-C", "Ruby_on_Rails", "Next.js 14", "C", "Amazon Web Services Elastic Beanstalk v2", "Élixir"])(
    "accepts the entry %j",
    (value) => {
      expect(jobCriteriaRequestSchema.safeParse({ ...valid, technologies: [value] }).success).toBe(true)
    }
  )

  it("trims entries and measures them after trimming", () => {
    const parsed = jobCriteriaRequestSchema.parse({ ...valid, technologies: ["   Amazon Web Services Elastic Beanstalk v2   "] })
    expect(parsed.technologies).toEqual(["Amazon Web Services Elastic Beanstalk v2"])
  })

  it.each(["", "   ", "\t", "Amazon Web Services Elastic Beanstalk v23", "Rust!", "Vue@3", "React<script>", "Go;", "Python (3)", "Elixir*", "a\tb"])(
    "refuses the entry %j",
    (value) => {
      expect(jobCriteriaRequestSchema.safeParse({ ...valid, frameworks: [value] }).success).toBe(false)
    }
  )

  it.each([".", "-", "_", "...", " - ", "._-", ". -_", "./-", "\u037A", "\uFF9E"])("refuses %j, which keeps no letter or digit after normalisation (CR-01, O3)", (value) => {
    const result = jobCriteriaRequestSchema.safeParse({ ...valid, technologies: [value] })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => [issue.code, issue.path])).toEqual([["invalid_format", ["technologies", 0]]])
    expect(isAllowedJobCriteriaEntry(value.trim())).toBe(false)
  })

  it.each(["C", "C#", "C++", "9", ".NET", "-a", "Élixir", "CI/CD"])("keeps %j, which has a letter or digit after normalisation", (value) => {
    expect(isAllowedJobCriteriaEntry(value)).toBe(true)
  })

  it("refuses an entry outside AC 3.1 in the shared check too", () => {
    expect(isAllowedJobCriteriaEntry("Rust!")).toBe(false)
  })

  it("holds 20 entries per list and refuses 21", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `Tech${i}`)
    expect(jobCriteriaRequestSchema.safeParse({ ...valid, frameworks: names(20), technologies: names(20).map((n) => `${n}x`) }).success).toBe(true)
    expect(jobCriteriaRequestSchema.safeParse({ ...valid, frameworks: names(21) }).success).toBe(false)
  })

  it.each([
    [["React", "react"], [], "frameworks", 2],
    [["React", "ReactJS"], [], "frameworks", 2],
    [["React"], ["React.js"], "technologies", 1],
    [[], ["Go", "TypeScript", "Golang"], "technologies", 3],
    [["Next.js", "Vue", "NextJS"], [], "frameworks", 3],
    [["Ruby on Rails"], ["TS", "Ruby-on-Rails"], "technologies", 2],
    [["Tailwind CSS"], ["  tailwindcss  "], "technologies", 1],
  ])("refuses frameworks %j with technologies %j at %s position %i", (frameworks, technologies, list, position) => {
    const result = jobCriteriaRequestSchema.safeParse({ ...valid, frameworks, technologies })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([[list, position - 1]])
  })

  it("reports every entry that normalises to an earlier form, even an empty one (CR-01b)", () => {
    expect(findDuplicateEntries({ frameworks: [".", "-"], technologies: ["_"] })).toEqual([
      { list: "frameworks", position: 2 },
      { list: "technologies", position: 1 },
    ])
  })

  it("accepts entries that only look alike", () => {
    const body = { ...valid, frameworks: ["Angular", "AngularJS", "React Native"], technologies: ["React", "Java", "JavaScript", "C", "C#", "C++"] }
    expect(jobCriteriaRequestSchema.parse(body)).toEqual(body)
  })
})

describe("jobCriteriaResponseSchema and the field-error envelope", () => {
  it("carries a positive version", () => {
    expect(jobCriteriaResponseSchema.safeParse({ ...valid, version: 1 }).success).toBe(true)
    expect(jobCriteriaResponseSchema.safeParse({ ...valid, version: 0 }).success).toBe(false)
  })

  it("accepts fieldErrors on the error envelope and rejects unknown problems or keys", () => {
    const base = { code: "bad_request", message: "The request is not valid." }
    expect(apiErrorResponseSchema.safeParse({ error: { ...base, fieldErrors: [{ field: "frameworks", position: 2, problem: "duplicate_entry" }] } }).success).toBe(true)
    expect(apiErrorResponseSchema.safeParse({ error: { ...base, fieldErrors: [{ field: "minCoreMatchPercent", position: null, problem: "invalid" }] } }).success).toBe(true)
    expect(apiErrorResponseSchema.safeParse({ error: { ...base, fieldErrors: [] } }).success).toBe(false)
    expect(apiErrorResponseSchema.safeParse({ error: { ...base, fieldErrors: [{ field: "frameworks", position: 0, problem: "invalid" }] } }).success).toBe(false)
    expect(apiErrorResponseSchema.safeParse({ error: { ...base, fieldErrors: [{ field: "x", position: null, problem: "invalid" }] } }).success).toBe(false)
    expect(apiErrorResponseSchema.safeParse({ error: { ...base, fieldErrors: [{ field: "frameworks", position: 1, problem: "invalid", value: "x" }] } }).success).toBe(false)
  })
})

describe("jobCriteriaFieldErrors (api-contract.r2 fieldErrors table; moved from the API, F3)", () => {
  const body = { minCoreMatchPercent: 70, frameworks: ["React"], technologies: ["TypeScript"], ...roleRelevance }
  const many = (count: number) => Array.from({ length: count }, (_, i) => `Tech${i}`)
  const errorsFor = (value: unknown) => {
    const parsed = jobCriteriaRequestSchema.safeParse(value)
    return jobCriteriaFieldErrors(value, parsed.success ? [] : parsed.error.issues)
  }

  it.each<[string, unknown, unknown[]]>([
    ["a valid body", body, []],
    ["a non-object body", "text", []],
    ["an array body", [body], []],
    ["null", null, []],
    ["an unknown key", { ...body, baseVersion: 3 }, []],
    ["a missing Match value", { frameworks: [], technologies: [], ...roleRelevance }, [{ field: "minCoreMatchPercent", position: null, problem: "invalid" }]],
    ["Match 0", { ...body, minCoreMatchPercent: 0 }, [{ field: "minCoreMatchPercent", position: null, problem: "invalid" }]],
    ["Match \"70\"", { ...body, minCoreMatchPercent: "70" }, [{ field: "minCoreMatchPercent", position: null, problem: "invalid" }]],
    ["a list that is not an array", { ...body, frameworks: "React" }, [{ field: "frameworks", position: null, problem: "invalid" }]],
    ["21 entries", { ...body, technologies: many(21) }, [{ field: "technologies", position: null, problem: "too_many_entries" }]],
    ["an empty entry", { ...body, frameworks: ["React", "   "] }, [{ field: "frameworks", position: 2, problem: "entry_empty" }]],
    ["a 41-character entry", { ...body, technologies: ["x".repeat(41)] }, [{ field: "technologies", position: 1, problem: "entry_too_long" }]],
    ["a disallowed character", { ...body, frameworks: ["Rust!"] }, [{ field: "frameworks", position: 1, problem: "entry_disallowed_characters" }]],
    [
      "entries with no letter or digit (O3)",
      { ...body, frameworks: [".", "-"], technologies: ["_"] },
      [
        { field: "frameworks", position: 1, problem: "entry_disallowed_characters" },
        { field: "frameworks", position: 2, problem: "entry_disallowed_characters" },
        { field: "technologies", position: 1, problem: "entry_disallowed_characters" },
      ],
    ],
    ["a duplicate across lists", { ...body, frameworks: ["Node.js"], technologies: ["NodeJS"] }, [{ field: "technologies", position: 1, problem: "duplicate_entry" }]],
    ["a non-string entry", { ...body, technologies: [42] }, [{ field: "technologies", position: 1, problem: "invalid" }]],
    [
      "several problems, one error per field and position",
      { minCoreMatchPercent: 101, frameworks: ["", `${"x".repeat(41)}!`], technologies: many(22), ...roleRelevance },
      [
        { field: "minCoreMatchPercent", position: null, problem: "invalid" },
        { field: "frameworks", position: 1, problem: "entry_empty" },
        { field: "frameworks", position: 2, problem: "entry_too_long" },
        { field: "technologies", position: null, problem: "too_many_entries" },
      ],
    ],
  ])("%s", (_name, value, expected) => {
    expect(errorsFor(value)).toEqual(expected)
  })

  it("gives a plain bad_request when an issue names no known field", () => {
    expect(jobCriteriaFieldErrors(body, [{ code: "custom", message: "x", path: ["other", 0], input: undefined }])).toEqual([])
  })
})
