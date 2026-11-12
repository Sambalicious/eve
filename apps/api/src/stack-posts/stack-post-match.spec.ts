import { normaliseTechnologyName } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { nameAppearsInQuote } from "../discovery/technology-extraction.js"
import type { RawEntry } from "./alert-feed-parser.js"
import { MAX_ENTRIES } from "./alert-feed-parser.js"
import { type MatchCriteria, matchTechnologies, toStackPosts } from "./stack-post-builder.js"

/**
 * CR-E5-02 (architecture.r1.md item 1). The indexed matcher must find exactly
 * what the per-criterion rule finds, and convert the worst case (100 entries,
 * 300 + 1,000 characters, 40 criteria) within the 1 s budget after a warm-up.
 */

/** The pre-r1 rule: one `nameAppearsInQuote` call per criteria entry. The reference the indexed matcher must equal. */
function perCriterionMatch(criteria: MatchCriteria, title: string, snippet: string): string[] {
  const text = `${title} \n ${snippet}`
  const seen = new Set<string>()
  const matched: string[] = []
  for (const entry of [...criteria.frameworks, ...criteria.technologies]) {
    const key = normaliseTechnologyName(entry)
    if (key === "" || seen.has(key)) continue
    if (nameAppearsInQuote(entry, text)) {
      seen.add(key)
      matched.push(entry)
    }
  }
  return matched
}

const NOW = new Date("2026-10-21T13:00:00Z")

/** Gherkin stack-post-ingestion.feature r3 "The faster matcher finds exactly what the per-criterion rule finds". */
const GHERKIN_ROWS: ReadonlyArray<[string[], string[], string, string, string[]]> = [
  [["React", "React Native"], ["TypeScript"], "Building with React Native", "nothing else", ["React Native"]],
  [["React", "React Native"], ["TypeScript"], "React and React Native", "in TypeScript", ["React", "React Native", "TypeScript"]],
  [["React"], ["Redux"], "Our React/Redux stack", "nothing else", ["React", "Redux"]],
  [["Preact"], ["Java"], "Preact on a JavaScript site", "nothing else", ["Preact"]],
  [["React"], ["TypeScript"], "REACT react React", "typescript TS", ["React", "TypeScript"]],
  [["Next.js"], ["Node.js"], "NextJS with nodejs", "nothing else", ["Next.js", "Node.js"]],
]

const MIXED_CRITERIA: MatchCriteria = {
  frameworks: ["React", "React Native", "Next.js", "Vue", "Preact", "Spring Boot", "nextjs", "Google Cloud Platform", "Ruby on Rails", "Express"],
  technologies: ["TypeScript", "Java", "JavaScript", "Go", "C#", "C++", "C", ".NET", "Node.js", "CI/CD", "PostgreSQL", "k8s", "AWS", "Redux", "GraphQL", "Amazon Web Services"],
}

const TEXTS: ReadonlyArray<[string, string]> = [
  ["Shipping with React", "and TypeScript at scale"],
  ["ReactJS tips", "nothing else"],
  ["Notes on JavaScript", "modern tooling"],
  ["Java and Spring in 2026", "nothing else"],
  ["React Native vs React", "rn and reactnative"],
  ["Our React/Redux/GraphQL stack", "with gql"],
  ["C# and C++ but not C", ".NET 8 and dotnet; C-level"],
  ["CI/CD with k8s", "kubernetes, Postgres and postgres-sql"],
  ["Google Cloud Platform migration", "google cloud, GCP, Amazon Web Services and AWS"],
  ["Go, golang, good, going", "Gopher"],
  ["Ruby on Rails is not Rails", "ruby rails"],
  ["express.js", "Express Express ExpressJS"],
  ["(React)", "[Next.js], {Vue}! 'Preact'? \"Spring Boot\"|"],
  ["", ""],
  ["React Native React Native", "React"],
  ["Native React", "React-Native and react_native"],
  ["Ｒｅａｃｔ full width", "ＴｙｐｅＳｃｒｉｐｔ"],
  ["...React...", "--TypeScript--"],
  ["React/", "/TypeScript and a/b/c"],
  ["Spring", "Boot"],
  // Ordinary text that grows under NFKC stays below the growth limit, so it matches as before (CR-E5F-07).
  ["React… and TypeScript…", "ﬁxed Node.js in ½ the time™"],
  ["…".repeat(100) + " React", "C# ﬀ " + "…".repeat(300) + " Go"],
  ["Ｒｅａｃｔ　Ｎａｔｉｖｅ", "㎏ ㍿ React"],
]

describe("indexed matcher equals the per-criterion rule (CR-E5-02)", () => {
  it.each(GHERKIN_ROWS)("frameworks %j, technologies %j, %j / %j -> %j", (frameworks, technologies, title, snippet, matched) => {
    const criteria = { frameworks, technologies }
    expect(matchTechnologies(criteria, title, snippet)).toEqual(matched)
    expect(perCriterionMatch(criteria, title, snippet)).toEqual(matched)
  })

  it.each(TEXTS)("mixed criteria on %j / %j", (title, snippet) => {
    expect(matchTechnologies(MIXED_CRITERIA, title, snippet)).toEqual(perCriterionMatch(MIXED_CRITERIA, title, snippet))
  })

  it("agrees on a generated table of 2,000 random texts over the criteria vocabulary", { timeout: 60_000 }, () => {
    const vocabulary = [
      ...MIXED_CRITERIA.frameworks,
      ...MIXED_CRITERIA.technologies,
      "reactjs", "rn", "ts", "js", "golang", "postgres", "gql", "Native", "Platform", "Cloud", "Google", "Rails", "on",
      "and", "with", "/", "React/Redux", "C#/C++", "Javascript", "javascripts", "Reaction", "the", ",", "(", ")", ".",
    ]
    let seed = 42
    const random = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % n
    }
    for (let sample = 0; sample < 2_000; sample += 1) {
      const words = Array.from({ length: 1 + random(14) }, () => vocabulary[random(vocabulary.length)]!)
      const joiner = [" ", "/", ", ", "-"][random(4)]!
      const title = words.slice(0, random(words.length + 1)).join(joiner)
      const snippet = words.slice(title.length > 0 ? 0 : 1).join(" ")
      const pick = (list: readonly string[]) => list.filter(() => random(3) === 0)
      const criteria = { frameworks: pick(MIXED_CRITERIA.frameworks), technologies: pick(MIXED_CRITERIA.technologies) }
      expect(matchTechnologies(criteria, title, snippet), `${title} / ${snippet}`).toEqual(perCriterionMatch(criteria, title, snippet))
    }
  })
})

/** 20 Frameworks and 20 Technologies, up to 40 characters each, including multi-word names. */
const BUDGET_CRITERIA: MatchCriteria = {
  frameworks: [
    "React", "React Native", "Next.js", "Vue", "Nuxt", "Angular", "Svelte", "SvelteKit", "Remix", "Astro",
    "Spring Boot", "Ruby on Rails", "Django REST Framework", "Laravel", "Express", "NestJS", "FastAPI", "Flask",
    "Google Cloud Platform", "A framework name that is forty chars long",
  ],
  technologies: [
    "TypeScript", "JavaScript", "Java", "Go", "C#", "C++", ".NET", "Node.js", "CI/CD", "PostgreSQL",
    "Kubernetes", "AWS", "Redux", "GraphQL", "Amazon Web Services", "Terraform", "Docker", "Rust", "Kotlin",
    "A technology name that is forty chars lo",
  ],
}

const FILLER = ["the", "team", "shipped", "a", "new", "feature", "using", "with", "and", "for", "our", "platform", "in", "production"]
const NAMES = [...BUDGET_CRITERIA.frameworks, ...BUDGET_CRITERIA.technologies, "reactjs", "golang", "k8s", "React/Redux"]

function mixedText(length: number, offset: number): string {
  const words: string[] = []
  let size = 0
  for (let index = 0; size <= length; index += 1) {
    const word = index % 4 === 0 ? NAMES[(index + offset) % NAMES.length]! : FILLER[(index + offset) % FILLER.length]!
    words.push(word)
    size += word.length + 1
  }
  return words.join(" ").slice(0, length)
}

function budgetEntries(): RawEntry[] {
  return Array.from({ length: MAX_ENTRIES }, (_, index) => ({
    title: mixedText(300, index),
    titleIsHtml: false,
    link: `https://www.linkedin.com/posts/fixture_${index + 1}`,
    published: null,
    updated: null,
    snippet: mixedText(1_000, index * 7),
    snippetIsHtml: false,
  }))
}

/**
 * CPU time of `run`, the least of `RUNS` calls after a warm-up call
 * (CR-E5F-01). CPU time rather than wall time, and the least of several
 * calls, so other processes on a loaded host cannot push a fast matcher over
 * the budget, while a slow matcher is over it on every call.
 * CR-E5F2-02: `process.cpuUsage()` counts the whole process (GC and helper
 * threads included). This relies on Vitest's default `forks` pool, which runs
 * each test file in its own child process, so other test files never add to
 * the figure. Under the `threads` pool they would; the error is only ever
 * upward (a false failure, never a false pass).
 */
const RUNS = 5
function leastCpuMs<T>(run: () => T): { ms: number; wallMs: number; result: T } {
  let result = run()
  let ms = Number.POSITIVE_INFINITY
  let wallMs = Number.POSITIVE_INFINITY
  for (let call = 0; call < RUNS; call += 1) {
    const wallStart = performance.now()
    const start = process.cpuUsage()
    result = run()
    const used = process.cpuUsage(start)
    ms = Math.min(ms, (used.user + used.system) / 1_000)
    wallMs = Math.min(wallMs, performance.now() - wallStart)
  }
  return { ms, wallMs, result }
}

/** 100 entries filled to the caps with `unit`, e.g. U+FDFA, which NFKC expands to 18 characters and 4 words (CR-E5F-07). */
function expandingEntries(unit: string): RawEntry[] {
  const fill = (length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
  return Array.from({ length: MAX_ENTRIES }, (_, index) => ({
    title: fill(300),
    titleIsHtml: false,
    link: `https://www.linkedin.com/posts/expanding_${index + 1}`,
    published: null,
    updated: null,
    snippet: fill(1_000),
    snippetIsHtml: false,
  }))
}

describe("text with more tokens than half its length after NFKC (CR-E5F-07)", () => {
  // Intentional divergence from nameAppearsInQuote, on pathological text only: each field keeps at most
  // ceil(length / 2) tokens (and 4 times its length in characters), so names after the cut are not found.
  // Ordinary text never reaches either bound (see the mixed-criteria rows above).
  it("finds names before the cut and none after it", () => {
    const criteria = { frameworks: ["React"], technologies: ["TypeScript"] }
    const title = `React ${"\uFDFA".repeat(298)}`
    const snippet = `${"\uFDFA".repeat(900)} TypeScript`
    expect(perCriterionMatch(criteria, title, snippet)).toEqual(["React", "TypeScript"])
    expect(matchTechnologies(criteria, title, snippet)).toEqual(["React"])
  })

  it("does not join the cut title and the snippet into one name", () => {
    const criteria = { frameworks: ["React Native"], technologies: [] }
    expect(matchTechnologies(criteria, `${"\uFDFA".repeat(10)} React`, "Native")).toEqual([])
    expect(matchTechnologies(criteria, "React", "Native")).toEqual(perCriterionMatch(criteria, "React", "Native"))
  })

  /**
   * SEC-E5F-05, CR-E5F2-01 (architecture r4 item 4): a cut only removes matches. A known
   * multi-word name that crosses the cut still masks the shorter names inside it, through up to
   * 3 lookahead tokens; the crossing name itself is not found.
   */
  describe("a cut never creates a match (SEC-E5F-05, CR-E5F2-01)", () => {
    it.each([
      ["React and React Native", { frameworks: ["React", "React Native"], technologies: [] }],
      ["React alone", { frameworks: ["React"], technologies: [] }],
      ["React Native alone", { frameworks: ["React Native"], technologies: [] }],
    ])("security probe: two U+FDFA then React Native, criteria %s: nothing", (_name, criteria) => {
      expect(matchTechnologies(criteria, "\uFDFA\uFDFA React Native", "")).toEqual([])
    })

    it("code review probe: three U+FDFA then React Native zzzz, snippet x, Frameworks React: nothing", () => {
      expect(matchTechnologies({ frameworks: ["React"], technologies: [] }, "\uFDFA\uFDFA\uFDFA React Native zzzz", "x")).toEqual([])
    })

    it.each([
      ["React and React Native", { frameworks: ["React", "React Native"], technologies: [] }, "React Native"],
      ["Go and Google Cloud Platform", { frameworks: [], technologies: ["Go", "Google Cloud Platform"] }, "Google Cloud Platform"],
      ["Vue and Vue.js", { frameworks: ["Vue", "Vue.js"], technologies: [] }, "Vue js"],
    ])("sweep with %s: the cut text never finds more than the uncut rule, in either field", (_name, criteria, name) => {
      for (let n = 1; n <= 40; n += 1) {
        const pad = "\uFDFA".repeat(n)
        for (const [title, snippet] of [[`${pad} ${name} zzzz`, "x"], ["x", `${pad} ${name} zzzz`]] as const) {
          const uncut = perCriterionMatch(criteria, title, snippet)
          for (const found of matchTechnologies(criteria, title, snippet)) expect(uncut, `n = ${n}`).toContain(found)
        }
      }
    })

    it.each([
      ["in the title", (pad: string): [string, string] => [`${pad} React Native`, "x"]],
      ["in the snippet", (pad: string): [string, string] => ["x", `${pad} React Native`]],
    ] as const)("sweep: 1 to 40 leading U+FDFA before React Native %s never returns React alone", (_name, place) => {
      const criteria = { frameworks: ["React"], technologies: [] }
      for (let n = 1; n <= 40; n += 1) {
        const [title, snippet] = place("\uFDFA".repeat(n))
        expect(matchTechnologies(criteria, title, snippet), `n = ${n}`).toEqual([])
        // Never more than the uncut rule finds.
        expect(perCriterionMatch(criteria, title, snippet)).toEqual([])
      }
    })

    it("sweep: with both criteria, only React Native, and only when it is before the cut", () => {
      const criteria = { frameworks: ["React", "React Native"], technologies: [] }
      for (let n = 1; n <= 40; n += 1) {
        const found = matchTechnologies(criteria, `${"\uFDFA".repeat(n)} React Native`, "x")
        expect(found, `n = ${n}`).not.toContain("React")
        expect(perCriterionMatch(criteria, `${"\uFDFA".repeat(n)} React Native`, "x")).toEqual(["React Native"])
      }
    })
  })
})

describe("matching cost (CR-E5-02, CR-E5F-01, CR-E5F-07)", () => {
  const COST_BUDGET_MS = 1_000
  // Only the timed toStackPosts calls are held to COST_BUDGET_MS. Entry
  // generation, the warm-up, the repeated calls and the per-criterion
  // reference check are untimed and can pass vitest's default 5 s testTimeout
  // on a loaded machine (F-INT-E5F-01, CR-E5F-01), so each test gets a
  // generous explicit timeout.
  const TEST_TIMEOUT_MS = 60_000

  it(`converts ${MAX_ENTRIES} entries of 300 + 1,000 characters against 40 criteria within ${COST_BUDGET_MS} ms of CPU after a warm-up`, () => {
    const entries = budgetEntries()
    expect(entries.every((entry) => entry.title.length === 300 && entry.snippet.length === 1_000)).toBe(true)
    const { ms, wallMs, result: posts } = leastCpuMs(() => toStackPosts(entries, BUDGET_CRITERIA, NOW))
    expect(posts).toHaveLength(MAX_ENTRIES)
    console.info(`CR-E5-02 timed conversion: ${ms.toFixed(1)} ms CPU (${wallMs.toFixed(1)} ms wall), least of ${RUNS}`)
    expect(ms).toBeLessThan(COST_BUDGET_MS)
    for (const [index, post] of posts.entries()) {
      expect(post.matchedTechnologies).toEqual(perCriterionMatch(BUDGET_CRITERIA, entries[index]!.title, entries[index]!.snippet))
    }
  }, TEST_TIMEOUT_MS)

  it.each([
    ["U+FDFA (18 characters, 4 words)", "\uFDFA"],
    ["U+FDFA and a space", "\uFDFA "],
    ["U+FDFB (8 characters, 2 words)", "\uFDFB"],
    ["U+337F and a space (4 characters per 2)", "\u337F "],
    ["U+2026 (3 characters, one token)", "\u2026"],
    ["U+FB01 and a slash", "\uFB01/"],
  ])(`converts ${MAX_ENTRIES} entries filled to the caps with %s within ${COST_BUDGET_MS} ms of CPU`, (_name, unit) => {
    const entries = expandingEntries(unit)
    const { ms, wallMs, result: posts } = leastCpuMs(() => toStackPosts(entries, BUDGET_CRITERIA, NOW))
    expect(posts).toHaveLength(MAX_ENTRIES)
    console.info(`CR-E5F-07 timed conversion (${_name}): ${ms.toFixed(1)} ms CPU (${wallMs.toFixed(1)} ms wall), least of ${RUNS}`)
    expect(ms).toBeLessThan(COST_BUDGET_MS)
    expect(posts.every((post) => post.matchedTechnologies.length === 0)).toBe(true)
  }, TEST_TIMEOUT_MS)
})
