import { afterEach, describe, expect, it, vi } from "vitest"

import { roleFamilySchema } from "./discovery.js"
import { HIRING_SEARCH_INPUTS_PATH, hiringSearchInputsResponseSchema } from "./stack-posts.js"
import * as links from "./stack-search-links.js"
import {
  HIRING_PHRASES,
  HIRING_SEARCH_GROUP_SIZE,
  ROLE_FAMILY_HIRING_PHRASES,
  STACK_SEARCH_GROUP_SIZE,
  buildHiringSearchGroups,
  buildStackSearchGroups,
  hiringFamilies,
  hiringHintTermSchema,
  hiringHintTerms,
  resolveHiringFamily,
} from "./stack-search-links.js"

/**
 * EPIC-0007 Phase 1, contract v1.19.0 (api-contract.md "Phase 1"; hiring-search-links.feature).
 * Expected strings are copied from the contract and the Gherkin, not derived from the code.
 */
const decoded = (url: string, key: string) => new URL(url).searchParams.get(key)
const raw = (url: string, key: string) => new URL(url).search.slice(1).split("&").find((pair) => pair.startsWith(`${key}=`))!.slice(key.length + 1)

const HIRING = '("we\'re hiring" OR "we are hiring" OR "now hiring" OR "join our team")'
const FRONTEND = '("frontend engineer" OR "frontend developer" OR "front-end engineer")'
const SOFTWARE = '("software engineer" OR "software developer")'
const ALL_HINTS = { remoteAccepted: true, relocationAccepted: true, sponsorshipNeededForRelocation: true }

/** api-contract.md "Worked example" (PRD AC 3.4), byte for byte. */
const AC_3_4 = {
  linkedinExpression:
    '("we\'re hiring" OR "we are hiring" OR "now hiring" OR "join our team") AND ("frontend engineer" OR "frontend developer" OR "front-end engineer") AND ("React" OR "TypeScript") AND ("remote" OR "relocation" OR "visa sponsorship")',
  linkedin:
    "https://www.linkedin.com/search/results/content/?keywords=(%22we%27re%20hiring%22%20OR%20%22we%20are%20hiring%22%20OR%20%22now%20hiring%22%20OR%20%22join%20our%20team%22)%20AND%20(%22frontend%20engineer%22%20OR%20%22frontend%20developer%22%20OR%20%22front-end%20engineer%22)%20AND%20(%22React%22%20OR%20%22TypeScript%22)%20AND%20(%22remote%22%20OR%20%22relocation%22%20OR%20%22visa%20sponsorship%22)&sortBy=%22date_posted%22&datePosted=%22past-week%22",
  google:
    "https://www.google.com/search?q=site%3Alinkedin.com%2Fposts%20(%22we%27re%20hiring%22%20OR%20%22we%20are%20hiring%22%20OR%20%22now%20hiring%22%20OR%20%22join%20our%20team%22)%20(%22frontend%20engineer%22%20OR%20%22frontend%20developer%22%20OR%20%22front-end%20engineer%22)%20(%22React%22%20OR%20%22TypeScript%22)%20(%22remote%22%20OR%20%22relocation%22%20OR%20%22visa%20sponsorship%22)&tbs=qdr%3Aw",
  alertsQuery:
    'site:linkedin.com/posts ("we\'re hiring" OR "we are hiring" OR "now hiring" OR "join our team") ("frontend engineer" OR "frontend developer" OR "front-end engineer") ("React" OR "TypeScript") ("remote" OR "relocation" OR "visa sponsorship")',
}

const example = () => buildHiringSearchGroups({ family: "senior_frontend", frameworks: ["React"], technologies: ["TypeScript"], hintTerms: hiringHintTerms(ALL_HINTS) })

describe("v1.19.0 constants (AC 2.1, 2.4, D4)", () => {
  it("hiring groups hold 4 terms; Stack posts groups keep 8", () => {
    expect(HIRING_SEARCH_GROUP_SIZE).toBe(4)
    expect(STACK_SEARCH_GROUP_SIZE).toBe(8)
  })

  it("the hiring phrases are fixed, in order, with a straight apostrophe", () => {
    expect(HIRING_PHRASES).toEqual(["we're hiring", "we are hiring", "now hiring", "join our team"])
  })

  it("the phrase table has exactly the 13 role family keys, and only Other has no phrase", () => {
    expect(Object.keys(ROLE_FAMILY_HIRING_PHRASES).sort()).toEqual([...roleFamilySchema.options].sort())
    expect(roleFamilySchema.options.filter((family) => ROLE_FAMILY_HIRING_PHRASES[family].length === 0)).toEqual(["other"])
  })

  it("the phrase table cannot be changed at runtime", () => {
    expect(Object.isFrozen(ROLE_FAMILY_HIRING_PHRASES)).toBe(true)
  })

  it('no phrase contains a double quote (HSL "No phrase contains a double quote")', () => {
    const all = [...HIRING_PHRASES, ...Object.values(ROLE_FAMILY_HIRING_PHRASES).flat()]
    expect(all.filter((phrase) => phrase.includes('"'))).toEqual([])
  })

  it('no phrase carries a seniority word except the PRD\'s lead titles (HSL "No phrase carries a seniority word")', () => {
    const allowed = new Set(["tech lead", "technical lead", "lead engineer"])
    const offenders = Object.values(ROLE_FAMILY_HIRING_PHRASES)
      .flat()
      .filter((phrase) => !allowed.has(phrase) && /\b(senior|junior|staff|principal|intern|lead)\b/i.test(phrase))
    expect(offenders).toEqual([])
  })

  it("the hint terms are the three AC 2.5 terms in order", () => {
    expect(hiringHintTermSchema.options).toEqual(["remote", "relocation", "visa sponsorship"])
  })
})

describe("hiringHintTerms (AC 2.5, HSL \"Hint terms follow the Candidate's Job Preferences\")", () => {
  it.each([
    [true, true, true, ["remote", "relocation", "visa sponsorship"]],
    [true, false, false, ["remote"]],
    [true, false, true, ["remote"]],
    [false, true, false, ["relocation"]],
    [false, true, true, ["relocation", "visa sponsorship"]],
    [false, false, true, []],
    [false, false, false, []],
  ])("remote %s, relocation %s, sponsorship %s -> %j", (remoteAccepted, relocationAccepted, sponsorshipNeededForRelocation, expected) => {
    expect(hiringHintTerms({ remoteAccepted, relocationAccepted, sponsorshipNeededForRelocation })).toEqual(expected)
  })

  it("no Job Preferences gives no hint terms", () => {
    expect(hiringHintTerms(null)).toEqual([])
  })
})

describe("hiringFamilies and resolveHiringFamily (AC 2.2, 3.7, threat model P1-5)", () => {
  it("keeps targets with phrases, in catalog order, unique", () => {
    expect(hiringFamilies(["backend", "fullstack", "senior_frontend"])).toEqual(["senior_frontend", "fullstack", "backend"])
    expect(hiringFamilies(["mobile", "other", "mobile"])).toEqual(["mobile"])
    expect(hiringFamilies(["other"])).toEqual([])
    expect(hiringFamilies([...roleFamilySchema.options])).toHaveLength(12)
  })

  it("uses a requested family that is a target with phrases", () => {
    expect(resolveHiringFamily(["senior_frontend", "backend"], "backend")).toBe("backend")
  })

  it.each([null, undefined, "", "__proto__", "constructor", "toString", "<script>", "mobile", "other", "BACKEND", " backend"])("falls back to the first family for requested %j", (requested) => {
    expect(resolveHiringFamily(["backend", "senior_frontend", "other"], requested)).toBe("senior_frontend")
  })

  it("is null when no target family has phrases, whatever is requested", () => {
    expect(resolveHiringFamily(["other"], "other")).toBeNull()
    expect(resolveHiringFamily(["other"], "senior_frontend")).toBeNull()
  })
})

describe("buildHiringSearchGroups: the PRD AC 3.4 example (HSL LinkedIn and Google link scenarios)", () => {
  it("matches the contract's worked example byte for byte", () => {
    const groups = example()
    expect(groups).toHaveLength(1)
    expect(groups[0]).toEqual({
      label: "React, TypeScript",
      terms: ["React", "TypeScript"],
      linkedinExpression: AC_3_4.linkedinExpression,
      googleExpression: AC_3_4.alertsQuery.slice("site:linkedin.com/posts ".length),
      linkedin: AC_3_4.linkedin,
      google: AC_3_4.google,
      alertsQuery: AC_3_4.alertsQuery,
    })
  })

  it("the decoded Google q equals the Alerts query string; one Google link, no articles link", () => {
    const [group] = example()
    expect(decoded(group!.google, "q")).toBe(group!.alertsQuery)
    expect(decoded(group!.google, "tbs")).toBe("qdr:w")
    expect(Object.keys(group!).filter((key) => key.toLowerCase().includes("google"))).toEqual(["googleExpression", "google"])
  })

  it("encodes the apostrophe and the quotes in sortBy and datePosted", () => {
    const [group] = example()
    for (const value of [raw(group!.linkedin, "keywords"), raw(group!.google, "q")]) expect(value).not.toContain("'")
    expect(decoded(group!.linkedin, "keywords")).toContain("we're hiring")
    expect(raw(group!.linkedin, "sortBy")).toBe("%22date_posted%22")
    expect(raw(group!.linkedin, "datePosted")).toBe("%22past-week%22")
  })

  it("never excludes hiring posts", () => {
    const [group] = example()
    for (const text of [group!.linkedinExpression, group!.googleExpression, group!.alertsQuery, group!.linkedin, group!.google]) {
      expect(text).not.toMatch(/NOT hiring|-hiring|-job|\/pulse/)
    }
  })
})

describe("buildHiringSearchGroups: clauses and groups (AC 2.1-2.5, 3.2, 3.3)", () => {
  it.each(roleFamilySchema.options.filter((family) => family !== "other"))("%s uses its phrases as the role clause", (family) => {
    const [group] = buildHiringSearchGroups({ family, frameworks: ["React"], technologies: [], hintTerms: [] })
    const role = `(${ROLE_FAMILY_HIRING_PHRASES[family].map((phrase) => `"${phrase}"`).join(" OR ")})`
    expect(group!.alertsQuery).toBe(`site:linkedin.com/posts ${HIRING} ${role} ("React")`)
  })

  it("the Gherkin role clauses for single-phrase and three-phrase families", () => {
    const query = (family: (typeof roleFamilySchema.options)[number]) => buildHiringSearchGroups({ family, frameworks: ["React"], technologies: [], hintTerms: [] })[0]!.alertsQuery
    expect(query("product_engineering")).toBe(`site:linkedin.com/posts ${HIRING} ("product engineer") ("React")`)
    expect(query("devops_platform")).toBe(`site:linkedin.com/posts ${HIRING} ("DevOps engineer" OR "site reliability engineer" OR "SRE") ("React")`)
  })

  it("Other gives no group", () => {
    expect(buildHiringSearchGroups({ family: "other", frameworks: ["React"], technologies: [], hintTerms: ["remote"] })).toEqual([])
  })

  it("a family value outside the table gives no group (no inherited key is read)", () => {
    expect(buildHiringSearchGroups({ family: "__proto__" as never, frameworks: ["React"], technologies: [], hintTerms: [] })).toEqual([])
  })

  it("no technologies give one any-technology group with no technology clause (with all hints)", () => {
    const groups = buildHiringSearchGroups({ family: "senior_frontend", frameworks: [], technologies: [], hintTerms: hiringHintTerms(ALL_HINTS) })
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ label: "", terms: [], linkedinExpression: `${HIRING} AND ${FRONTEND} AND ("remote" OR "relocation" OR "visa sponsorship")` })
  })

  it("no technologies and no Job Preferences give hiring and role clauses only", () => {
    const [group] = buildHiringSearchGroups({ family: "senior_frontend", frameworks: [], technologies: [], hintTerms: hiringHintTerms(null) })
    expect(decoded(group!.linkedin, "keywords")).toBe(`${HIRING} AND ${FRONTEND}`)
  })

  it('"React", remote only gives a ("remote") hint clause; no Job Preferences gives none', () => {
    const remote = buildHiringSearchGroups({ family: "senior_frontend", frameworks: ["React"], technologies: [], hintTerms: hiringHintTerms({ remoteAccepted: true, relocationAccepted: false, sponsorshipNeededForRelocation: true }) })
    expect(remote[0]!.linkedinExpression).toBe(`${HIRING} AND ${FRONTEND} AND ("React") AND ("remote")`)
    const none = buildHiringSearchGroups({ family: "senior_frontend", frameworks: ["React"], technologies: [], hintTerms: hiringHintTerms(null) })
    expect(none[0]!.linkedinExpression).toBe(`${HIRING} AND ${FRONTEND} AND ("React")`)
  })

  it("orders Frameworks then Technologies in saved order and entered form, without dedupe", () => {
    const [group] = buildHiringSearchGroups({ family: "senior_frontend", frameworks: ["nestjs", "React"], technologies: ["postgreSQL", "react"], hintTerms: [] })
    expect(group!.terms).toEqual(["nestjs", "React", "postgreSQL", "react"])
    expect(group!.label).toBe("nestjs, React, postgreSQL, react")
  })

  it.each([
    [0, 0, 1, 0],
    [1, 0, 1, 1],
    [4, 0, 1, 4],
    [5, 0, 2, 1],
    [3, 2, 2, 1],
    [20, 19, 10, 3],
    [20, 20, 10, 4],
    [0, 40, 10, 4],
  ])("%d frameworks + %d technologies -> %d groups, last of %d", (f, t, groups, last) => {
    const built = buildHiringSearchGroups({
      family: "senior_frontend",
      frameworks: Array.from({ length: f }, (_, i) => `F${i + 1}`),
      technologies: Array.from({ length: t }, (_, i) => `T${i + 1}`),
      hintTerms: [],
    })
    expect(built).toHaveLength(groups)
    expect(built.at(-1)!.terms).toHaveLength(last)
    expect(built.flatMap((g) => g.terms)).toHaveLength(f + t)
  })

  it("a group spans the Frameworks/Technologies boundary, and every group repeats the same hiring, role and hint clauses", () => {
    const built = buildHiringSearchGroups({ family: "senior_frontend", frameworks: ["React", "Next.js", "Vue"], technologies: ["TypeScript", "GraphQL"], hintTerms: ["remote"] })
    expect(built.map((g) => g.label)).toEqual(["React, Next.js, Vue, TypeScript", "GraphQL"])
    for (const group of built) {
      expect(group.linkedinExpression.startsWith(`${HIRING} AND ${FRONTEND} AND (`)).toBe(true)
      expect(group.linkedinExpression.endsWith(' AND ("remote")')).toBe(true)
    }
  })

  it("a term containing spaces stays one quoted term", () => {
    const [group] = buildHiringSearchGroups({ family: "senior_frontend", frameworks: [], technologies: ["Google Cloud", "React Native"], hintTerms: [] })
    expect(group!.linkedinExpression).toBe(`${HIRING} AND ${FRONTEND} AND ("Google Cloud" OR "React Native")`)
  })

  it("is deterministic: equal input gives equal links (page and summary build the same)", () => {
    expect(example()).toEqual(example())
  })
})

describe("buildHiringSearchGroups: encoding (AC 3.4-3.6, 3.9; threat model P1-1)", () => {
  it.each([
    ["C#", "#", "%23"],
    ["C++", "+", "%2B"],
    ["CI/CD", "/", "%2F"],
    [".NET", '"', "%22"],
  ])("%s survives encoding in every hiring link", (term, rawChar, encoded) => {
    const [group] = buildHiringSearchGroups({ family: "software_engineering", frameworks: [], technologies: [term], hintTerms: [] })
    const keywords = raw(group!.linkedin, "keywords")
    expect(keywords).toContain(encoded)
    expect(keywords).not.toContain(rawChar)
    expect(decoded(group!.linkedin, "keywords")).toBe(`${HIRING} AND ${SOFTWARE} AND ("${term}")`)
    expect(decoded(group!.google, "q")).toBe(`site:linkedin.com/posts ${HIRING} ${SOFTWARE} ("${term}")`)
  })

  it('C#, C++ and CI/CD encode to %22C%23%22, %22C%2B%2B%22 and %22CI%2FCD%22', () => {
    const [group] = buildHiringSearchGroups({ family: "software_engineering", frameworks: [], technologies: ["C#", "C++", "CI/CD"], hintTerms: [] })
    for (const encoded of ["%22C%23%22", "%22C%2B%2B%22", "%22CI%2FCD%22"]) {
      expect(raw(group!.linkedin, "keywords")).toContain(encoded)
      expect(raw(group!.google, "q")).toContain(encoded)
    }
  })

  it("an Alerts query string shows terms unencoded", () => {
    const [group] = buildHiringSearchGroups({ family: "software_engineering", frameworks: [], technologies: ["C#", "CI/CD"], hintTerms: [] })
    expect(group!.alertsQuery).toBe(`site:linkedin.com/posts ${HIRING} ${SOFTWARE} ("C#" OR "CI/CD")`)
  })

  it("terms with URL structure characters never change the origin, path or parameter keys", () => {
    const hostile = ["a&b=c", "x#frag", "q?y=1", "100%", "line\nbreak", "<b>", "C#", "C++", "CI/CD", "x'y"]
    const groups = buildHiringSearchGroups({ family: "software_engineering", frameworks: hostile, technologies: [], hintTerms: ["remote"] })
    // SEC-P1-02: the line break is stripped; every other character is kept as entered.
    expect(groups.flatMap((group) => group.terms)).toEqual(hostile.map((term) => (term === "line\nbreak" ? "linebreak" : term)))
    for (const group of groups) {
      const li = new URL(group.linkedin)
      expect(`${li.origin}${li.pathname}`).toBe("https://www.linkedin.com/search/results/content/")
      expect([...li.searchParams.keys()]).toEqual(["keywords", "sortBy", "datePosted"])
      expect(li.hash).toBe("")
      expect(li.searchParams.get("keywords")).toBe(group.linkedinExpression)
      const g = new URL(group.google)
      expect(`${g.origin}${g.pathname}`).toBe("https://www.google.com/search")
      expect([...g.searchParams.keys()]).toEqual(["q", "tbs"])
      expect(g.hash).toBe("")
      expect(g.searchParams.get("q")).toBe(group.alertsQuery)
      expect(group.linkedin).not.toMatch(/[\n'<>]/)
      expect(group.google).not.toMatch(/[\n'<>]/)
    }
  })
})

describe('buildHiringSearchGroups: quote handling (SEC-E7-04, threat model P1-2)', () => {
  /** Every `"` is a phrase delimiter: an even count, and each quoted phrase is one whole term. */
  const balanced = (expression: string) => (expression.match(/"/g) ?? []).length % 2 === 0

  it('strips " from a term, so React" OR site:evil.example " cannot close its phrase', () => {
    const [group] = buildHiringSearchGroups({ family: "senior_frontend", frameworks: ['React" OR site:evil.example "'], technologies: [], hintTerms: [] })
    expect(group!.terms).toEqual(["React OR site:evil.example "])
    expect(group!.linkedinExpression).toBe(`${HIRING} AND ${FRONTEND} AND ("React OR site:evil.example ")`)
    expect(group!.googleExpression).toBe(`${HIRING} ${FRONTEND} ("React OR site:evil.example ")`)
    for (const expression of [group!.linkedinExpression, group!.googleExpression, group!.alertsQuery]) expect(balanced(expression)).toBe(true)
  })

  it('drops a term that is only quotes or blank after stripping; quotes alone give the any-technology group', () => {
    const built = buildHiringSearchGroups({ family: "senior_frontend", frameworks: ['"', '""', "React"], technologies: [' " '], hintTerms: [] })
    expect(built.map((group) => group.terms)).toEqual([["React"]])
    expect(buildHiringSearchGroups({ family: "senior_frontend", frameworks: ['"'], technologies: [], hintTerms: [] })[0]!.terms).toEqual([])
  })

  it('a hint term with " (not reachable through the schema) is stripped too', () => {
    const [group] = buildHiringSearchGroups({ family: "senior_frontend", frameworks: ["React"], technologies: [], hintTerms: ['remote" OR "x' as never] })
    expect(group!.linkedinExpression.endsWith('AND ("remote OR x")')).toBe(true)
    expect(balanced(group!.linkedinExpression)).toBe(true)
  })
})

describe("buildHiringSearchGroups: control characters and line separators (SEC-P1-02)", () => {
  const SEPARATORS = /[\p{Cc}\u2028\u2029]/u

  it("strips CR/LF, NUL, tab, DEL, C1 controls and U+2028/U+2029 from every term, label and expression", () => {
    const built = buildHiringSearchGroups({
      family: "senior_frontend",
      frameworks: ["line\r\nBcc: evil@x", "\u0000nul", "ta\tb", "de\u007fl", "c1\u0085x"],
      technologies: ["ls\u2028x", "ps\u2029y"],
      hintTerms: ["remote\n" as never],
    })
    expect(built.flatMap((group) => group.terms)).toEqual(["lineBcc: evil@x", "nul", "tab", "del", "c1x", "lsx", "psy"])
    for (const group of built) {
      for (const text of [group.label, group.linkedinExpression, group.googleExpression, group.alertsQuery]) {
        expect(text).not.toMatch(SEPARATORS)
      }
      expect(group.linkedinExpression.endsWith('AND ("remote")')).toBe(true)
      expect(decodeURIComponent(group.linkedin)).not.toMatch(SEPARATORS)
      expect(decodeURIComponent(group.google)).not.toMatch(SEPARATORS)
    }
  })

  it("drops a term that is only control characters or separators after stripping", () => {
    const built = buildHiringSearchGroups({ family: "senior_frontend", frameworks: ["\r\n", "\u2028", "\t\u0000", "React"], technologies: [], hintTerms: [] })
    expect(built.map((group) => group.terms)).toEqual([["React"]])
  })

  it("leaves valid terms byte-identical", () => {
    const valid = ["C#", "C++", "CI/CD", "Zürich", "node.js", "a_b-c"]
    const built = buildHiringSearchGroups({ family: "senior_frontend", frameworks: valid, technologies: [], hintTerms: [] })
    expect(built.flatMap((group) => group.terms)).toEqual(valid)
  })
})

describe("no I/O (AC 3.9, 10.3; threat model P1-3)", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("every builder export runs with fetch, XMLHttpRequest, WebSocket and EventSource throwing", () => {
    const thrower = vi.fn(() => {
      throw new Error("outbound request from a link builder")
    })
    for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) vi.stubGlobal(name, thrower)

    expect(hiringHintTerms(ALL_HINTS)).toHaveLength(3)
    expect(hiringFamilies(["senior_frontend"])).toEqual(["senior_frontend"])
    expect(resolveHiringFamily(["senior_frontend"], null)).toBe("senior_frontend")
    expect(buildHiringSearchGroups({ family: "senior_frontend", frameworks: Array.from({ length: 20 }, (_, i) => `F${i}`), technologies: Array.from({ length: 20 }, (_, i) => `T${i}`), hintTerms: ["remote"] })).toHaveLength(10)
    expect(buildStackSearchGroups(["React"], ["TypeScript"])).toHaveLength(1)
    expect(thrower).not.toHaveBeenCalled()
  })

  it("the module exports only constants, schemas and pure functions", () => {
    expect(Object.keys(links).sort()).toEqual([
      "GOOGLE_ALERTS_URL",
      "GOOGLE_SEARCH_BASE",
      "HIRING_PHRASES",
      "HIRING_SEARCH_GROUP_SIZE",
      "LINKEDIN_CONTENT_SEARCH_BASE",
      "ROLE_FAMILY_HIRING_PHRASES",
      "STACK_SEARCH_GROUP_SIZE",
      "buildHiringSearchGroups",
      "buildStackSearchGroups",
      "hiringFamilies",
      "hiringHintTermSchema",
      "hiringHintTerms",
      "resolveHiringFamily",
    ])
  })
})

describe("GET /v1/stack-posts/hiring-search-inputs response (v1.19.0)", () => {
  it("has the contract path", () => {
    expect(HIRING_SEARCH_INPUTS_PATH).toBe("/v1/stack-posts/hiring-search-inputs")
  })

  it.each([[[]], [["remote"]], [["remote", "relocation", "visa sponsorship"]]])("accepts hintTerms %j", (hintTerms) => {
    expect(hiringSearchInputsResponseSchema.parse({ hintTerms })).toEqual({ hintTerms })
  })

  it.each([
    [{}],
    [{ hintTerms: ["onsite"] }],
    [{ hintTerms: ["remote", "relocation", "visa sponsorship", "remote"] }],
    [{ hintTerms: [], extra: true }],
    [{ hintTerms: "remote" }],
  ])("refuses %j", (body) => {
    expect(hiringSearchInputsResponseSchema.safeParse(body).success).toBe(false)
  })
})
