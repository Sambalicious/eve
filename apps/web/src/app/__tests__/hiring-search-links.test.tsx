import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import {
  JOB_CRITERIA_PATH,
  roleFamilySchema,
  type RoleFamilyValue,
} from "@eve/contracts"

import { HIRING_SEARCH_INPUTS_PATH } from "@/shared/lib/hiring-contracts"
import {
  costPause,
  OPERATOR_PREFERENCES,
  server,
} from "@/shared/testing"
import { applicationLink, checkRegion, openHiring } from "./hiring-view-helpers"

/**
 * EPIC-0007 Phase 1 web: Hiring search links (design-spec r1 B1, H2, H3, H4
 * step 1) against the contract fakes. Scenario IDs are FILE:line in the r2
 * Gherkin (HV hiring-view, HSL hiring-search-links, OUT outbound-and-separation).
 * Deck strings (copy-deck.r1.md) are quoted so a copy change fails here.
 */
const HINT =
  "Search hints for LinkedIn and Google. Results will include posts that don't fit. Eve can't check pay, hours or sponsorship from a search or post."
const HELP_WITH_HINT =
  "Paste the employer's application link from the post, not the LinkedIn post link. No link? Add the job description. Eve checks that job with your usual rules."
const HELP_SOLO =
  "Eve can't check pay, hours or sponsorship in a LinkedIn post. Paste the employer's application link from the post, not the post link. No link? Add the job description. Eve checks that job with your usual rules."
const HOWTO = 'Create an alert with this query and set "Deliver to" to "RSS feed".'
const HOWTO_FEEDS =
  'Create an alert with this query, set "Deliver to" to "RSS feed", then paste the feed URL under Hiring alert feeds.'
const COPY_ERR = "Couldn't copy. The query is selected, so press Ctrl+C or Cmd+C."

const HIRING = '("we\'re hiring" OR "we are hiring" OR "now hiring" OR "join our team")'
const FRONTEND = '("frontend engineer" OR "frontend developer" OR "front-end engineer")'
const FULLSTACK = '("full stack engineer" OR "fullstack engineer" OR "full-stack developer")'
const BACKEND = '("backend engineer" OR "backend developer" OR "back-end engineer")'
const ALL_HINTS = '("remote" OR "relocation" OR "visa sponsorship")'

const NONE = { remoteAccepted: false, relocationAccepted: false, sponsorshipNeededForRelocation: false }

const decoded = (href: string, name: string) => new URL(href).searchParams.get(name)
const rawParam = (href: string, name: string) =>
  new URL(href).search
    .slice(1)
    .split("&")
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1)

const linksRegion = () => screen.findByRole("region", { name: "Hiring search links" })

/** Waits for the groups, then returns the group rows. */
async function groupRows() {
  const region = await linksRegion()
  await within(region).findAllByRole("link", { name: /^LinkedIn posts for/ })
  return within(region).getAllByRole("listitem")
}

function linksOf(row: HTMLElement) {
  return {
    linkedin: within(row).getByRole("link", { name: /^LinkedIn posts for/ }).getAttribute("href") ?? "",
    google: within(row).getByRole("link", { name: /^Google posts for/ }).getAttribute("href") ?? "",
  }
}

/** Expands a row's disclosure and returns its query text. */
async function queryOf(row: HTMLElement, user: ReturnType<typeof openHiring>["user"]) {
  const toggle = within(row).getByRole("button", { name: /^Google Alerts query for/ })
  if (toggle.getAttribute("aria-expanded") !== "true") await user.click(toggle)
  return within(row).getByLabelText(/^Hiring query for/).textContent ?? ""
}

const familySelect = () => screen.getByRole("combobox", { name: "Role family" })
const optionLabels = () => within(familySelect()).getAllByRole("option").map((o) => o.textContent)

describe("Hiring search links: PRD example and link shape (HSL, AC 3.2 to 3.6)", () => {
  it("HSL:29 / HSL:41 / HSL:59 the PRD example: one group; LinkedIn keywords, sortBy, datePosted; Google q and tbs; one query equal to q", async () => {
    const { user } = openHiring({
      criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"], technologies: ["TypeScript"] },
      hints: { preferences: OPERATOR_PREFERENCES },
    })
    const rows = await groupRows()
    expect(rows).toHaveLength(1)
    const { linkedin, google } = linksOf(rows[0])
    expect(linkedin.startsWith("https://www.linkedin.com/search/results/content/?")).toBe(true)
    expect(decoded(linkedin, "keywords")).toBe(`${HIRING} AND ${FRONTEND} AND ("React" OR "TypeScript") AND ${ALL_HINTS}`)
    expect(decoded(linkedin, "sortBy")).toBe('"date_posted"')
    expect(decoded(linkedin, "datePosted")).toBe('"past-week"')
    expect(google.startsWith("https://www.google.com/search?")).toBe(true)
    const q = `site:linkedin.com/posts ${HIRING} ${FRONTEND} ("React" OR "TypeScript") ${ALL_HINTS}`
    expect(decoded(google, "q")).toBe(q)
    expect(decoded(google, "tbs")).toBe("qdr:w")

    const query = await queryOf(rows[0], user)
    expect(within(rows[0]).getAllByLabelText(/^Hiring query for/)).toHaveLength(1)
    expect(query).toBe(q)
    expect(query).not.toMatch(/https:\/\/|tbs|qdr:w/)
  })

  it("HSL:51 one Google link per group and nothing points at /pulse", async () => {
    const { user } = openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    const [row] = await groupRows()
    expect(within(row).getAllByRole("link", { name: /^Google posts for/ })).toHaveLength(1)
    expect(within(row).queryByRole("link", { name: /articles/i })).not.toBeInTheDocument()
    await queryOf(row, user)
    expect((await linksRegion()).innerHTML).not.toContain("linkedin.com/pulse")
  })

  it("HSL:70 copying puts exactly the query on the clipboard; HV:206 announces 'Hiring query copied.'", async () => {
    const { user } = openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    const [row] = await groupRows()
    await queryOf(row, user)
    const button = within(row).getByRole("button", { name: "Copy hiring query for React" })
    await user.click(button)
    expect(await navigator.clipboard.readText()).toBe(`site:linkedin.com/posts ${HIRING} ${FRONTEND} ("React")`)
    expect(button).toHaveTextContent("Copied")
    expect(within(await linksRegion()).getByRole("status").textContent).toBe("Hiring query copied.")
  })

  it("HV:212 a refused copy is announced as failed, not as copied, and the query is selected", async () => {
    const { user } = openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    const [row] = await groupRows()
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new DOMException("denied", "NotAllowedError"))
    await queryOf(row, user)
    await user.click(within(row).getByRole("button", { name: "Copy hiring query for React" }))
    expect(await within(row).findByRole("alert")).toHaveTextContent(COPY_ERR)
    expect(screen.queryByText("Hiring query copied.")).not.toBeInTheDocument()
    expect(window.getSelection()?.toString()).toBe(`site:linkedin.com/posts ${HIRING} ${FRONTEND} ("React")`)
  })

  it("HSL:78 @phase3 the disclosure links to Google Alerts with C-HP-ALERTQ-HOWTO-FEEDS; its link moves to Hiring alert feeds", async () => {
    const { user } = openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    const [row] = await groupRows()
    await queryOf(row, user)
    const open = within(row).getByRole("link", { name: "Open Google Alerts (opens in a new tab)" })
    expect(open).toHaveAttribute("href", "https://www.google.com/alerts")
    const howTo = within(row).getByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").startsWith(`${HOWTO_FEEDS} `))
    expect(howTo).toBeVisible()
    expect(screen.queryByText(HOWTO, { exact: false })).not.toBeInTheDocument()
    await user.click(within(row).getByRole("link", { name: "Hiring alert feeds" }))
    await waitFor(() => expect(screen.getByRole("heading", { name: "Hiring alert feeds" })).toHaveFocus())
  })

  it("HV:228 every LinkedIn, Google and Google Alerts link opens in a new tab with rel noopener noreferrer", async () => {
    const { user } = openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    const [row] = await groupRows()
    await queryOf(row, user)
    const external = within(row)
      .getAllByRole("link")
      .filter((a) => /linkedin\.com|google\.com/.test(a.getAttribute("href") ?? ""))
    expect(external).toHaveLength(3)
    for (const link of external) {
      expect(link).toHaveAttribute("target", "_blank")
      expect(link).toHaveAttribute("rel", "noopener noreferrer")
    }
  })
})

describe("Role phrases (HSL AC 2.1)", () => {
  const PHRASES: [RoleFamilyValue, string, string][] = [
    ["senior_frontend", "Frontend", FRONTEND],
    ["technical_lead", "Hands-on technical lead", '("tech lead" OR "technical lead" OR "lead engineer")'],
    ["fullstack", "Fullstack", FULLSTACK],
    ["product_engineering", "Product engineering", '("product engineer")'],
    ["software_engineering", "Software engineering", '("software engineer" OR "software developer")'],
    ["backend", "Backend", BACKEND],
    ["mobile", "Mobile", '("mobile engineer" OR "iOS engineer" OR "Android engineer")'],
    ["platform_engineering", "Platform engineering", '("platform engineer")'],
    ["devops_platform", "DevOps and SRE", '("DevOps engineer" OR "site reliability engineer" OR "SRE")'],
    ["people_management", "Engineering management", '("engineering manager" OR "head of engineering")'],
    ["data_ml", "Data and ML", '("data engineer" OR "machine learning engineer" OR "ML engineer")'],
    ["solutions_customer", "Solutions and customer engineering", '("solutions architect" OR "customer architect")'],
  ]

  it.each(PHRASES)("HSL:107 %s (%s) uses its fixed role clause; the Job titles fact quotes the phrases", async (family, label, role) => {
    const { user } = openHiring({ criteria: { targetRoleFamilies: [family], frameworks: ["React"] } })
    const [row] = await groupRows()
    expect(await queryOf(row, user)).toBe(`site:linkedin.com/posts ${HIRING} ${role} ("React")`)
    expect(screen.getByText(`Role family: ${label}`)).toBeVisible()
    const titles = role.slice(1, -1).split(" OR ").join(", ")
    expect(within(await linksRegion()).getByText(titles)).toBeVisible()
  })

  it("HSL:130 / HV:316 each Candidate's links come from their own settings only", async () => {
    const ada = openHiring({ criteria: { targetRoleFamilies: ["fullstack"], frameworks: ["React"] } })
    const adaRow = (await groupRows())[0]
    expect(decoded(linksOf(adaRow).linkedin, "keywords")).toContain(FULLSTACK)
    ada.unmount()
    server.resetHandlers()

    const bola = openHiring({ criteria: { targetRoleFamilies: ["backend"], frameworks: ["Django"] } })
    const [row] = await groupRows()
    const all = [linksOf(row).linkedin, linksOf(row).google, await queryOf(row, bola.user)].map((v) =>
      v.startsWith("https://") ? decodeURIComponent(v) : v
    )
    for (const text of all) {
      expect(text).toContain("Django")
      expect(text).toContain('"backend engineer"')
      expect(text).not.toContain("React")
      expect(text).not.toContain("frontend")
    }
  })

  it("HSL:146 / HSL:152 the view offers no control to edit phrases; Job titles is plain text", async () => {
    openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    const region = await linksRegion()
    await groupRows()
    expect(within(region).queryAllByRole("textbox")).toEqual([])
    expect(within(region).getByText("Job titles").tagName).toBe("DT")
  })
})

describe("Role family choice (HSL AC 2.2)", () => {
  it("HSL:162 offers target families with phrases in display order, never Other", async () => {
    openHiring({ criteria: { targetRoleFamilies: ["backend", "senior_frontend", "other", "fullstack"], frameworks: ["React"] } })
    await groupRows()
    expect(optionLabels()).toEqual(["Frontend", "Fullstack", "Backend"])
    expect(familySelect()).toHaveValue("senior_frontend")
  })

  it("HSL:170 with no family value the first family is selected and used", async () => {
    openHiring({ criteria: { targetRoleFamilies: ["backend", "fullstack"], frameworks: ["React"] } })
    const [row] = await groupRows()
    expect(familySelect()).toHaveValue("fullstack")
    expect(decoded(linksOf(row).linkedin, "keywords")).toContain(` AND ${FULLSTACK} AND `)
  })

  it("HSL:178 / HSL:195 choosing a family replaces the URL (no new history entry), rebuilds every group, announces it and sends no request", async () => {
    const { user, currentPath, app } = openHiring({
      path: "/find-jobs?view=hiring",
      criteria: { targetRoleFamilies: ["senior_frontend", "fullstack", "backend"], frameworks: ["A", "B", "C", "D", "E"] },
    })
    await groupRows()
    const sent: string[] = []
    server.events.on("request:start", ({ request }) => void sent.push(request.url))

    await user.selectOptions(familySelect(), "fullstack")
    await user.selectOptions(familySelect(), "backend")
    expect(currentPath()).toBe("/find-jobs?view=hiring&family=backend")
    const rows = await groupRows()
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(decoded(linksOf(row).linkedin, "keywords")).toContain(` AND ${BACKEND} AND `)
    expect(familySelect()).toHaveFocus()
    expect(within(await linksRegion()).getByRole("status").textContent).toBe("Links now search for Backend roles.")
    server.events.removeAllListeners("request:start")
    expect(sent).toEqual([])

    // Replace, not push: the family choice adds no history entry.
    expect(app.router.state.historyAction).toBe("REPLACE")
  })

  it("HSL:187 opening the URL with a valid family shows that family", async () => {
    openHiring({
      path: "/stack-posts?view=hiring&family=fullstack",
      criteria: { targetRoleFamilies: ["senior_frontend", "fullstack"], frameworks: ["React"] },
    })
    const [row] = await groupRows()
    expect(familySelect()).toHaveValue("fullstack")
    expect(decoded(linksOf(row).linkedin, "keywords")).toContain(FULLSTACK)
  })

  it("HSL:203 the choice is not saved: nothing is written, and the URL is the only place it lives", async () => {
    const { career, stack } = openHiring({
      path: "/find-jobs?view=hiring&family=backend",
      criteria: { targetRoleFamilies: ["senior_frontend", "backend"], frameworks: ["React"] },
    })
    await groupRows()
    expect(familySelect()).toHaveValue("backend")
    expect([...career.requests, ...stack.requests].filter((r) => r.method !== "GET")).toEqual([])
    expect(Object.values(localStorage).join(" ")).not.toContain("backend")
  })

  it.each(["", "mobile", "other", "Fullstack", "frontend_senior", "senior_frontend%20", "%3Cscript%3E"])(
    "HSL:211 family=%j falls back to the first family with no error",
    async (value) => {
      openHiring({
        path: `/stack-posts?view=hiring&family=${value}`,
        criteria: { targetRoleFamilies: ["fullstack", "backend", "other"], frameworks: ["React"] },
      })
      await groupRows()
      expect(familySelect()).toHaveValue("fullstack")
      expect(within(await linksRegion()).queryByRole("alert")).not.toBeInTheDocument()
    }
  )

  it("HSL:229 a single family with phrases is a static line, not a select", async () => {
    openHiring({ criteria: { targetRoleFamilies: ["senior_frontend", "other"], frameworks: ["React"] } })
    await groupRows()
    expect(screen.queryByRole("combobox", { name: "Role family" })).not.toBeInTheDocument()
    expect(screen.getByText("Role family: Frontend")).toBeVisible()
  })

  it("HSL:236 all 13 targeted: 12 families offered in display order, Other not offered", async () => {
    openHiring({ criteria: { targetRoleFamilies: [...roleFamilySchema.options], frameworks: ["React"] } })
    await groupRows()
    expect(optionLabels()).toEqual([
      "Frontend",
      "Hands-on technical lead",
      "Fullstack",
      "Product engineering",
      "Software engineering",
      "Backend",
      "Mobile",
      "Platform engineering",
      "DevOps and SRE",
      "Engineering management",
      "Data and ML",
      "Solutions and customer engineering",
    ])
  })

  it("HSL:243 / HV:324 a bookmarked family that is no longer targeted falls back; no Backend phrase leaks", async () => {
    openHiring({
      path: "/stack-posts?view=hiring&family=backend",
      criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] },
    })
    const [row] = await groupRows()
    expect(screen.getByText("Role family: Frontend")).toBeVisible()
    expect(decodeURIComponent(linksOf(row).linkedin)).not.toContain("backend")
  })

  it("HV:324 / OUT:18 the family value is never sent to the API; the view only reads Eve's /v1 API", async () => {
    const sent: string[] = []
    server.events.on("request:start", ({ request }) => void sent.push(request.url))
    const { hints } = openHiring({
      path: "/stack-posts?view=hiring&family=fullstack",
      criteria: { targetRoleFamilies: ["backend"], frameworks: ["React"] },
    })
    await groupRows()
    server.events.removeAllListeners("request:start")
    expect(hints.requests).toHaveLength(1)
    expect(new URL(hints.requests[0].url).search).toBe("")
    expect(sent.length).toBeGreaterThan(0)
    for (const url of sent) {
      const parsed = new URL(url)
      expect(parsed.origin).toBe(window.location.origin)
      expect(parsed.pathname.startsWith("/v1/")).toBe(true)
      expect(parsed.search).not.toContain("family")
    }
  })
})

describe("Technology groups and clauses (HSL AC 2.3 to 3.3)", () => {
  it("HSL:254 / HSL:262 Frameworks then Technologies in saved order and entered form; the label joins them", async () => {
    openHiring({
      criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["nestjs", "React"], technologies: ["postgreSQL"] },
    })
    const [row] = await groupRows()
    expect(within(row).getByText("nestjs, React, postgreSQL")).toBeVisible()
    expect(decoded(linksOf(row).linkedin, "keywords")).toContain(' AND ("nestjs" OR "React" OR "postgreSQL")')
  })

  it("HSL:269 Hiring groups hold 4 terms while the Stack posts view keeps 8", async () => {
    const frameworks = Array.from({ length: 20 }, (_, i) => `F${i + 1}`)
    const technologies = Array.from({ length: 5 }, (_, i) => `T${i + 1}`)
    openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks, technologies } })
    const rows = await groupRows()
    expect(rows).toHaveLength(7)
    expect(within(rows[6]).getByText("T5")).toBeVisible()
    expect(within(rows[0]).getByText("Group 1 of 7")).toBeVisible()

    const stackLinks = await screen.findByRole("region", { name: "Search links" })
    await within(stackLinks).findAllByRole("link", { name: /^LinkedIn posts for/ })
    expect(within(stackLinks).getAllByRole("listitem")).toHaveLength(4)
  })

  it.each([
    [1, 0, 1, 1],
    [0, 1, 1, 1],
    [4, 0, 1, 4],
    [5, 0, 2, 1],
    [3, 2, 2, 1],
    [2, 2, 1, 4],
    [20, 19, 10, 3],
    [20, 20, 10, 4],
  ])("HSL:277 %i frameworks + %i technologies give %i groups, the last holding %i", async (f, t, groups, last) => {
    const frameworks = Array.from({ length: f }, (_, i) => `F${i + 1}`)
    const technologies = Array.from({ length: t }, (_, i) => `T${i + 1}`)
    openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks, technologies } })
    const rows = await groupRows()
    expect(rows).toHaveLength(groups)
    const lastLabel = within(rows[rows.length - 1]).getByText(/^[FT]\d+/).textContent ?? ""
    expect(lastLabel.split(", ")).toHaveLength(last)
    for (const row of rows) {
      expect(within(row).getAllByRole("link", { name: /^LinkedIn posts for/ })).toHaveLength(1)
      expect(within(row).getAllByRole("link", { name: /^Google posts for/ })).toHaveLength(1)
      expect(within(row).getAllByRole("button", { name: /^Google Alerts query for/ })).toHaveLength(1)
    }
  })

  it("HSL:297 / HSL:306 a group spans the Frameworks/Technologies boundary; every group repeats hiring, role and hint clauses", async () => {
    openHiring({
      criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React", "Next.js", "Vue"], technologies: ["TypeScript", "GraphQL"] },
      hints: { preferences: { ...NONE, remoteAccepted: true } },
    })
    const rows = await groupRows()
    expect(within(rows[0]).getByText("React, Next.js, Vue, TypeScript")).toBeVisible()
    expect(within(rows[1]).getByText("GraphQL")).toBeVisible()
    for (const row of rows) {
      const keywords = decoded(linksOf(row).linkedin, "keywords") ?? ""
      expect(keywords.startsWith(`${HIRING} AND ${FRONTEND} AND `)).toBe(true)
      expect(keywords.endsWith(' AND ("remote")')).toBe(true)
    }
  })

  it("HSL:315 a term with spaces stays one quoted term", async () => {
    openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], technologies: ["Google Cloud", "React Native"] } })
    const [row] = await groupRows()
    expect(decoded(linksOf(row).linkedin, "keywords")).toContain('("Google Cloud" OR "React Native")')
  })

  it("HSL:324 / HSL:331 every expression starts with the hiring clause and carries no exclusion", async () => {
    const technologies = Array.from({ length: 40 }, (_, i) => `T${i + 1}`)
    const { user } = openHiring({
      criteria: { targetRoleFamilies: ["senior_frontend"], technologies },
      hints: { preferences: OPERATOR_PREFERENCES },
    })
    const rows = await groupRows()
    expect(rows).toHaveLength(10)
    for (const row of rows) {
      const { linkedin, google } = linksOf(row)
      const texts = [decoded(linkedin, "keywords") ?? "", (decoded(google, "q") ?? "").replace("site:linkedin.com/posts ", ""), await queryOf(row, user)]
      expect(texts[0].startsWith(HIRING)).toBe(true)
      expect(texts[1].startsWith(HIRING)).toBe(true)
      expect(texts[2].startsWith(`site:linkedin.com/posts ${HIRING}`)).toBe(true)
      for (const text of texts) {
        for (const banned of ["NOT hiring", "-hiring", "-job", " NOT "]) expect(text).not.toContain(banned)
      }
    }
  })

  it("HSL:404 clause order hiring, role, technology, hint", async () => {
    openHiring({
      criteria: { targetRoleFamilies: ["backend"], technologies: ["Go"] },
      hints: { preferences: { ...NONE, relocationAccepted: true } },
    })
    const [row] = await groupRows()
    expect(decoded(linksOf(row).linkedin, "keywords")).toBe(`${HIRING} AND ${BACKEND} AND ("Go") AND ("relocation")`)
  })

  it("HSL:412 a single-phrase family is still quoted and parenthesised", async () => {
    openHiring({ criteria: { targetRoleFamilies: ["product_engineering"], frameworks: ["React"] } })
    const [row] = await groupRows()
    expect(decoded(linksOf(row).linkedin, "keywords")).toBe(`${HIRING} AND ("product engineer") AND ("React")`)
  })

  it("HSL:420 / HSL:431 no technologies: one 'Any technology' group with no technology clause, and a note linking to Job criteria", async () => {
    const { user, currentPath } = openHiring({
      criteria: { targetRoleFamilies: ["senior_frontend"] },
      hints: { preferences: { ...NONE, remoteAccepted: true } },
    })
    const rows = await groupRows()
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText("Any technology")).toBeVisible()
    expect(within(rows[0]).queryByText(/^Group 1/)).not.toBeInTheDocument()
    expect(decoded(linksOf(rows[0]).linkedin, "keywords")).toBe(`${HIRING} AND ${FRONTEND} AND ("remote")`)
    expect(await queryOf(rows[0], user)).toBe(`site:linkedin.com/posts ${HIRING} ${FRONTEND} ("remote")`)
    expect(within(rows[0]).getByRole("link", { name: "LinkedIn posts for Frontend roles, Any technology (opens in a new tab)" })).toBeVisible()

    const region = await linksRegion()
    expect(within(region).getByText("No frameworks or technologies saved, so these links match any technology.", { exact: false })).toBeVisible()
    await user.click(within(region).getByRole("link", { name: "Add job criteria" }))
    expect(currentPath()).toBe("/settings#job-criteria")
  })

  it("HSL:439 no technologies and no Job Preferences: hiring and role clauses only", async () => {
    openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"] }, hints: { preferences: null } })
    const [row] = await groupRows()
    expect(decoded(linksOf(row).linkedin, "keywords")).toBe(`${HIRING} AND ${FRONTEND}`)
  })
})

describe("Hint terms (HSL AC 2.5, 2.6)", () => {
  it.each([
    [true, true, true, ' ("remote" OR "relocation" OR "visa sponsorship")', "remote, relocation, visa sponsorship"],
    [true, true, false, ' ("remote" OR "relocation")', "remote, relocation"],
    [true, false, true, ' ("remote")', "remote"],
    [false, true, true, ' ("relocation" OR "visa sponsorship")', "relocation, visa sponsorship"],
    [false, true, false, ' ("relocation")', "relocation"],
    [false, false, true, "", null],
    [false, false, false, "", null],
  ])("HSL:348 remote %s, relocation %s, sponsorship %s → query ends with ('React')%s; 'Plus any of' shows %s", async (remote, relocation, sponsorship, ending, fact) => {
    const { user } = openHiring({
      criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] },
      hints: { preferences: { remoteAccepted: remote, relocationAccepted: relocation, sponsorshipNeededForRelocation: sponsorship } },
    })
    const [row] = await groupRows()
    expect(await queryOf(row, user)).toBe(`site:linkedin.com/posts ${HIRING} ${FRONTEND} ("React")${ending}`)
    const region = await linksRegion()
    if (fact === null) expect(within(region).queryByText("Plus any of")).not.toBeInTheDocument()
    else expect(within(region).getByText(fact)).toBeVisible()
  })

  it("HSL:367 the Operator's preferences give all three hint terms; HSL:375 no Job Preferences gives none", async () => {
    const ada = openHiring({
      criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] },
      hints: { preferences: OPERATOR_PREFERENCES },
    })
    expect(decoded(linksOf((await groupRows())[0]).linkedin, "keywords")?.endsWith(` AND ${ALL_HINTS}`)).toBe(true)
    ada.unmount()
    server.resetHandlers()
    openHiring({ criteria: { targetRoleFamilies: ["backend"], frameworks: ["Django"] }, hints: { preferences: null } })
    const keywords = decoded(linksOf((await groupRows())[0]).linkedin, "keywords") ?? ""
    expect(keywords.endsWith(' AND ("Django")')).toBe(true)
    expect(keywords).not.toMatch(/remote|relocation|visa sponsorship/)
  })

  it("HSL:384 nothing labels a group, link or term as eligible, met, unverified or violated, and nothing is written", async () => {
    const { career, stack, discovery } = openHiring({
      criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] },
      hints: { preferences: OPERATOR_PREFERENCES },
    })
    await groupRows()
    expect((await linksRegion()).textContent).not.toMatch(/eligible|met\b|unverified|violated/i)
    expect([...career.requests, ...stack.requests, ...discovery.requests].filter((r) => r.method !== "GET")).toEqual([])
  })
})

describe("Encoding (HSL AC 3.4, 3.6)", () => {
  it.each([
    ["C#", "#", "%23"],
    ["C++", "+", "%2B"],
    ["CI/CD", "/", "%2F"],
    [".NET", '"', "%22"],
  ])("HSL:448 %s survives in both links", async (term, raw, encoded) => {
    openHiring({ criteria: { targetRoleFamilies: ["software_engineering"], technologies: [term] }, hints: { preferences: null } })
    const [row] = await groupRows()
    const { linkedin, google } = linksOf(row)
    const keywords = rawParam(linkedin, "keywords") ?? ""
    expect(keywords).toContain(encoded)
    expect(keywords).not.toContain(raw)
    const software = '("software engineer" OR "software developer")'
    expect(decoded(linkedin, "keywords")).toBe(`${HIRING} AND ${software} AND ("${term}")`)
    expect(decoded(google, "q")).toBe(`site:linkedin.com/posts ${HIRING} ${software} ("${term}")`)
  })

  it("HSL:465 / HSL:473 no literal apostrophe in keywords or q; sortBy and datePosted are percent-encoded", async () => {
    openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    const [row] = await groupRows()
    const { linkedin, google } = linksOf(row)
    expect(rawParam(linkedin, "keywords")).not.toContain("'")
    expect(rawParam(google, "q")).not.toContain("'")
    expect(decoded(linkedin, "keywords")).toContain("we're hiring")
    expect(decoded(google, "q")).toContain("we're hiring")
    expect(rawParam(linkedin, "sortBy")).toBe("%22date_posted%22")
    expect(rawParam(linkedin, "datePosted")).toBe("%22past-week%22")
  })

  it("HSL:481 the query string shows terms unencoded", async () => {
    const { user } = openHiring({
      criteria: { targetRoleFamilies: ["software_engineering"], technologies: ["C#", "CI/CD"] },
      hints: { preferences: null },
    })
    const [row] = await groupRows()
    expect(await queryOf(row, user)).toBe(
      `site:linkedin.com/posts ${HIRING} ("software engineer" OR "software developer") ("C#" OR "CI/CD")`
    )
  })
})

describe("Freshness and build-only (HSL AC 3.8, 3.9)", () => {
  it.each([
    ["frameworks Vue", { frameworks: ["Vue"] }, null, (row: HTMLElement) => expect(within(row).getByText("Vue")).toBeVisible()],
    [
      "target families Backend only",
      { targetRoleFamilies: ["backend"] as RoleFamilyValue[] },
      null,
      (row: HTMLElement) => expect(decoded(linksOf(row).linkedin, "keywords")).toContain(BACKEND),
    ],
    [
      "relocation accepted and no remote",
      {},
      { ...NONE, relocationAccepted: true },
      (row: HTMLElement) => expect(decoded(linksOf(row).linkedin, "keywords")?.endsWith(' AND ("relocation")')).toBe(true),
    ],
  ])("HSL:510 after saving %s the next load uses the new values; HSL:524 the open view keeps its values", async (_name, criteria, prefs, check) => {
    const view = openHiring({
      criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] },
      hints: { preferences: { ...NONE, remoteAccepted: true } },
    })
    await groupRows()
    view.career.state.jobCriteria = { ...view.career.state.jobCriteria, ...criteria, version: 2 }
    if (prefs) view.hints.state.preferences = prefs
    const [stale] = await groupRows()
    expect(within(stale).getByText("React")).toBeVisible()
    expect(decoded(linksOf(stale).linkedin, "keywords")?.endsWith(' AND ("remote")')).toBe(true)
    view.unmount()

    const { renderApp } = await import("./test-app")
    renderApp("/stack-posts?view=hiring")
    check((await groupRows())[0])
  })

  it("HSL:610 loading twice builds identical links and writes nothing", async () => {
    const options = { criteria: { targetRoleFamilies: ["senior_frontend"] as RoleFamilyValue[], frameworks: ["React"], technologies: ["TypeScript"] } }
    const first = openHiring(options)
    const a = linksOf((await groupRows())[0])
    first.unmount()
    server.resetHandlers()
    const second = openHiring(options)
    const b = linksOf((await groupRows())[0])
    expect(b).toEqual(a)
    expect([...second.career.requests, ...second.stack.requests].filter((r) => r.method !== "GET")).toEqual([])
  })

  it.each([
    ["HSL:617 without a recorded Alert feed verification", {}],
    ["HSL:624 during a cost-ceiling pause", { controls: { costPause: costPause() } }],
    ["HSL:631 during a global pause", { controls: { globalPaused: true, globalPausedAt: "2026-10-24T09:00:00.000Z" } }],
  ])("%s the group shows its LinkedIn link, Google link and query", async (_name, extra) => {
    const { user } = openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] }, ...extra })
    const [row] = await groupRows()
    expect(within(row).getByRole("link", { name: /^LinkedIn posts for/ })).toBeVisible()
    expect(within(row).getByRole("link", { name: /^Google posts for/ })).toBeVisible()
    expect(await queryOf(row, user)).toContain("site:linkedin.com/posts")
  })
})

describe("Search-hint note and Check this job help (HV AC 1.4, H4 step 1)", () => {
  it("HV:245 / HV:251 / HV:258 the note is the section's first content, ends with the link to Check this job, and Check this job shows the short help", async () => {
    const { user } = openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    const region = await linksRegion()
    await groupRows()
    const note = within(region).getByText(HINT, { exact: false })
    const link = within(region).getByRole("link", { name: "Paste job links in Check this job" })
    expect(note).toContainElement(link)
    expect(note.textContent).toBe(`${HINT} Paste job links in Check this job`)

    const check = await checkRegion()
    expect(within(check).getByText(HELP_WITH_HINT)).toBeVisible()

    await user.click(link)
    expect(within(check).getByRole("heading", { level: 2, name: "Check this job" })).toHaveFocus()

    const field = await applicationLink()
    expect(field).toHaveAccessibleDescription(HELP_WITH_HINT)
    expect(screen.queryByText(HELP_SOLO)).not.toBeInTheDocument()
  })

  it("HV:265 the note comes before the first hiring link even with 10 groups", async () => {
    const technologies = Array.from({ length: 40 }, (_, i) => `T${i + 1}`)
    openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], technologies } })
    const region = await linksRegion()
    await groupRows()
    const note = within(region).getByText(HINT, { exact: false })
    const firstLink = within(region).getAllByRole("link", { name: /^LinkedIn posts for/ })[0]
    expect(note.compareDocumentPosition(firstLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const content = region.querySelector('[data-slot="section-content"]')
    expect(content?.querySelector('[data-slot="section-note"]')).toBe(note.closest('[data-slot="section-note"]'))
  })

  it("HV:278 / HSL:549 / HSL:559 / HSL:581 only Other: the empty state, no hint, no links or select; Check this job keeps its field and shows SOLO", async () => {
    const { user, currentPath, hints } = openHiring({ criteria: { targetRoleFamilies: ["other"], frameworks: ["React"] } })
    const region = await linksRegion()
    expect(await within(region).findByRole("heading", { level: 3, name: "No role family to search for" })).toBeVisible()
    expect(within(region).getByText("Hiring searches need job titles, and Other has none. Choose another role family in your job criteria.")).toBeVisible()
    expect(within(region).queryByText(HINT, { exact: false })).not.toBeInTheDocument()
    expect(within(region).queryByRole("link", { name: /LinkedIn|Google/ })).not.toBeInTheDocument()
    expect(within(region).queryByRole("combobox")).not.toBeInTheDocument()
    expect(within(region).queryByLabelText(/^Hiring query/)).not.toBeInTheDocument()
    expect(within(region).queryByRole("link", { name: "Change job criteria" })).not.toBeInTheDocument()

    const check = await checkRegion()
    expect(within(check).getByText(HELP_SOLO)).toBeVisible()
    expect(within(check).getByRole("button", { name: "Check this job" })).toBeVisible()
    expect(screen.queryByText(HELP_WITH_HINT)).not.toBeInTheDocument()
    // The empty state needs no hint terms (design-spec r1 H2: no queries).
    expect(hints.requests).toEqual([])

    await user.click(within(region).getByRole("link", { name: "Choose role families" }))
    expect(currentPath()).toBe("/settings#job-criteria")
  })

  it("HSL:566 / HSL:573 a family in the URL does not override the empty state; no technologies shows no any-technology note", async () => {
    openHiring({ path: "/stack-posts?view=hiring&family=senior_frontend", criteria: { targetRoleFamilies: ["other"] } })
    const region = await linksRegion()
    expect(await within(region).findByText("No role family to search for")).toBeVisible()
    expect(within(region).queryByRole("link", { name: /LinkedIn|Google/ })).not.toBeInTheDocument()
    expect(within(region).queryByText(/these links match any technology/)).not.toBeInTheDocument()
  })

  it.each([
    ["Frontend", ["senior_frontend"] as RoleFamilyValue[], "rendered"],
    ["Other only", ["other"] as RoleFamilyValue[], "not rendered"],
  ])("HV:297 Phases 2 and 1, %s: the hint is %s and the help follows it", async (_name, targetRoleFamilies, hint) => {
    openHiring({ criteria: { targetRoleFamilies, frameworks: ["React"] } })
    const check = await checkRegion()
    const region = await linksRegion()
    if (hint === "rendered") {
      expect(await within(region).findByText(HINT, { exact: false })).toBeVisible()
      expect(within(check).getByText(HELP_WITH_HINT)).toBeVisible()
      expect(within(check).queryByText(HELP_SOLO)).not.toBeInTheDocument()
    } else {
      expect(await within(region).findByText("No role family to search for")).toBeVisible()
      expect(within(region).queryByText(HINT, { exact: false })).not.toBeInTheDocument()
      expect(within(check).getByText(HELP_SOLO)).toBeVisible()
    }
  })

  it("H4 step 1: while the links load, Check this job shows SOLO and no hint; it swaps once the hint renders", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { http } = await import("msw")
    const view = openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    server.use(
      http.get(HIRING_SEARCH_INPUTS_PATH, async () => {
        await gate
        return Response.json({ hintTerms: [] })
      })
    )
    const check = await checkRegion()
    await screen.findByRole("region", { name: "Hiring search links" })
    expect(within(check).getByText(HELP_SOLO)).toBeVisible()
    expect(screen.queryByText(HINT, { exact: false })).not.toBeInTheDocument()
    release()
    expect(await within(check).findByText(HELP_WITH_HINT)).toBeVisible()
    view.unmount()
  })

  it("H4 step 1 / feedback matrix: a failed load shows the section alert with Try again and SOLO; retry recovers", async () => {
    const { user, hints } = openHiring({
      criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] },
      hints: { failing: true },
    })
    const region = await linksRegion()
    const alert = await within(region).findByRole("alert", {}, { timeout: 10_000 })
    expect(alert).toHaveTextContent("Couldn't load this page.")
    expect(within(await checkRegion()).getByText(HELP_SOLO)).toBeVisible()
    expect(within(region).queryByText(HINT, { exact: false })).not.toBeInTheDocument()

    hints.state.failing = false
    await user.click(within(alert).getByRole("button", { name: "Try again" }))
    await groupRows()
    expect(within(await checkRegion()).getByText(HELP_WITH_HINT)).toBeVisible()
  })

  it("a failed Job criteria load also shows the section alert and SOLO", async () => {
    const { apiErrorResponse } = await import("@/shared/testing")
    const { http } = await import("msw")
    openHiring({ criteria: { targetRoleFamilies: ["senior_frontend"], frameworks: ["React"] } })
    server.use(http.get(JOB_CRITERIA_PATH, () => apiErrorResponse("bad_request")))
    const region = await linksRegion()
    expect(await within(region).findByRole("alert")).toHaveTextContent("Couldn't load this page.")
    expect(within(await checkRegion()).getByText(HELP_SOLO)).toBeVisible()
  })
})
