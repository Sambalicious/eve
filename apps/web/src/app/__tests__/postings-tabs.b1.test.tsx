import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import {
  createCareerSetupApi,
  createDiscoveryApi,
  createPreferencesApi,
  preferencesRecord,
  rankedPosting,
  server,
  signedInSession,
  type DiscoveryState,
} from "@/shared/testing"
import { DEFAULT_ROLE_FAMILY_TIERS, type PreferencesValues } from "@eve/contracts"
import { renderApp } from "./test-app"

/** EPIC-0002 B1: four tabs (F18a, B-POST-0), skip reasons (B-POST-1, B-POST-2), job-postings-per-candidate.feature. */
function open(path: string, discovery: Partial<DiscoveryState>, prefs: Partial<PreferencesValues> = {}) {
  const api = createDiscoveryApi(discovery)
  const preferences = createPreferencesApi({ record: preferencesRecord(2, prefs) })
  server.use(signedInSession, ...createCareerSetupApi().handlers, ...api.handlers, ...preferences.handlers)
  const user = userEvent.setup({ delay: null })
  return { ...renderApp(path), api, user }
}

const mobileExcluded = { roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, mobile: "excluded" as const } }
const flutter = () => rankedPosting({ title: "Flutter Developer", company: "Beta Ltd", status: "skipped", rank: null, roleFamily: "mobile", skipReason: "excluded_role_family", match: null, eligibility: null })
const vue = () => rankedPosting({ title: "Platform Engineer", company: "Gamma", status: "skipped", rank: null, roleFamily: "platform_engineering", skipReason: "keyword_mismatch", match: null, eligibility: null })
const ranked = () => rankedPosting({ title: "Senior Frontend Engineer", company: "Acme", rank: 1 })

async function listRegion() {
  return screen.findByRole("region", { name: "Job Postings, scrolls horizontally" })
}

const familyLine = "Mobile is outside the role families you picked."
const keywordLine = "The title doesn't contain your saved keyword."

describe("Jobs tabs (B1 reasons, EPIC-0011 AC-4.5)", () => {
  it(":507 shows the tabs in order, named by the posting words, plus the v1.28.0 manual lane", async () => {
    open("/postings", { postings: [ranked()] })
    const tabs = await screen.findAllByRole("tab")
    expect(tabs.map((t) => t.textContent)).toEqual(["Good matches", "Manual apply", "Not a match", "All"])
  })

  it(":360 :605 Not a match stacks the rule-based rows and, in their own section, the excluded-family rows, each with its reason", async () => {
    const { user, currentPath } = open("/postings", { postings: [ranked(), flutter(), vue()] }, mobileExcluded)
    await user.click(await screen.findByRole("tab", { name: "Not a match" }))
    expect(currentPath()).toBe("/postings?tab=not_a_match")
    expect((await screen.findAllByText(keywordLine)).length).toBeGreaterThan(0)
    const section = (await screen.findByRole("heading", { name: "Outside your role families" })).closest("section") as HTMLElement
    expect((await within(section).findAllByText(familyLine)).length).toBeGreaterThan(0)
    expect(within(section).queryByText("Platform Engineer at Gamma")).toBeNull()
    expect(screen.getByRole("heading", { name: "Doesn't fit your criteria" })).toBeVisible()
  })

  it("DP-B1-04 rows ruled out by family or keyword show no Eligibility summary", async () => {
    open("/postings?tab=not_a_match", { postings: [ranked(), flutter(), vue()] }, mobileExcluded)
    const keywordRow = (await screen.findAllByText(keywordLine))[0].closest("[role=row], tr, li")!
    expect(within(keywordRow as HTMLElement).queryByText("All rules met")).toBeNull()
    const familyRow = (await screen.findAllByText(familyLine))[0].closest("[role=row], tr, li")!
    expect(within(familyRow as HTMLElement).queryByText("All rules met")).toBeNull()
  })

  it(":590 All names the Not a match tab while a family is excluded, and the link keeps the filter", async () => {
    const { user, currentPath } = open("/postings?tab=all&families=mobile,backend", { postings: [ranked(), flutter(), rankedPosting({ title: "Backend Engineer", roleFamily: "backend", rank: 2 })] }, mobileExcluded)
    const hint = await screen.findByText(/Postings in excluded role families aren't listed here\./)
    const link = within(hint).getByRole("link", { name: "Not a match" })
    expect(link).toHaveAttribute("href", "/postings?tab=not_a_match&families=backend,mobile")
    await user.click(link)
    expect(currentPath()).toBe("/postings?tab=not_a_match&families=backend,mobile")
  })

  it(":597 All shows no hint when no family is excluded", async () => {
    open("/postings?tab=all", { postings: [ranked()] })
    await listRegion()
    expect(screen.queryByText(/aren't listed here/)).toBeNull()
  })

  it(":603 an old link to tab=skipped opens Not a match with its filter kept", async () => {
    const { currentPath } = open("/postings?tab=skipped&families=platform_engineering&keyword=engineer", { postings: [vue()] })
    expect(await screen.findByRole("tab", { name: "Not a match" })).toHaveAttribute("aria-selected", "true")
    await waitFor(() => expect(currentPath()).toBe("/postings?tab=not_a_match&families=platform_engineering&keyword=engineer"))
  })

  it("an old link to tab=excluded_family opens Not a match at the excluded-family section", async () => {
    const { currentPath } = open("/postings?tab=excluded_family", { postings: [ranked(), flutter()] }, mobileExcluded)
    expect(await screen.findByRole("tab", { name: "Not a match" })).toHaveAttribute("aria-selected", "true")
    expect(await screen.findByRole("heading", { name: "Outside your role families" })).toBeVisible()
    await waitFor(() => expect(currentPath()).toBe("/postings?tab=not_a_match#excluded-families"))
  })

  it(":618 an unknown tab value opens Good matches and drops the value", async () => {
    const { currentPath } = open("/postings?tab=excluded", { postings: [ranked()] })
    expect(await screen.findByRole("tab", { name: "Good matches" })).toHaveAttribute("aria-selected", "true")
    await waitFor(() => expect(currentPath()).toBe("/postings"))
  })

  it("Not a match with only excluded-family rows shows that section and no empty state", async () => {
    open("/postings?tab=not_a_match", { postings: [ranked(), flutter()] }, mobileExcluded)
    expect((await screen.findAllByText(familyLine)).length).toBeGreaterThan(0)
    expect(screen.queryByRole("heading", { level: 2, name: "Nothing ruled out" })).toBeNull()
    expect(screen.queryByRole("heading", { level: 2, name: "No jobs yet" })).toBeNull()
  })

  it(":698 Not a match with nothing ruled out says what will appear", async () => {
    open("/postings?tab=not_a_match", { postings: [ranked()] })
    expect(await screen.findByRole("heading", { level: 2, name: "Nothing ruled out" })).toBeVisible()
    expect(screen.getByText("Jobs Eve rules out appear here, with the reason.")).toBeVisible()
  })

  it(":705 the Good matches empty state says what will appear", async () => {
    open("/postings", { postings: [vue()] })
    expect(await screen.findByRole("heading", { level: 2, name: "No good matches yet" })).toBeVisible()
    expect(screen.getByText("Jobs that fit your profile appear here. Paste one on Home or set up alerts.")).toBeVisible()
  })

  it(":711 filtering Not a match to a family with no postings gives the filter empty state", async () => {
    open("/postings?tab=not_a_match&families=backend", { postings: [flutter()] }, mobileExcluded)
    expect(await screen.findByRole("heading", { level: 2, name: "No postings match these filters" })).toBeVisible()
  })

  it(":742 the senior_frontend family reads Frontend", async () => {
    open("/postings", { postings: [ranked()] })
    const region = await listRegion()
    expect(within(region).getAllByText("Frontend").length).toBeGreaterThan(0)
    expect(screen.queryByText("Senior frontend")).toBeNull()
  })

  it(":996 the saved keyword is not the default on-screen filter", async () => {
    const { currentPath } = open("/postings", { postings: [ranked()] }, { titleKeyword: "react" })
    await listRegion()
    expect(screen.getByRole("searchbox", { name: "Search job titles" })).toHaveValue("")
    expect(currentPath()).toBe("/postings")
  })
})

describe("Posting detail, skipped by preference (B-POST-2)", () => {
  it(":369 the excluded-family detail names the family and links to Job preferences", async () => {
    const posting = flutter()
    open(`/postings/${posting.id}`, { postings: [posting] }, mobileExcluded)
    expect(await screen.findByText("Mobile is outside the role families you picked, so Eve won't apply to it.")).toBeVisible()
    expect(screen.getByRole("link", { name: "Change job preferences" })).toHaveAttribute("href", "/settings#preferences")
    // DP-B1-09: reading order is skip line, Change job preferences, Open employer page.
    const line = screen.getByText(/Mobile is outside the role families you picked, so Eve won't apply to it/)
    const change = screen.getByRole("link", { name: "Change job preferences" })
    const employer = screen.getByRole("link", { name: /Open employer page/ })
    expect(line.compareDocumentPosition(change) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(change.compareDocumentPosition(employer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it(":788 the keyword detail quotes the saved keyword", async () => {
    const posting = vue()
    open(`/postings/${posting.id}`, { postings: [posting] }, { titleKeyword: "react" })
    expect(await screen.findByText('The title doesn\'t contain "react", your saved keyword, so Eve won\'t apply to it.')).toBeVisible()
    expect(screen.getByRole("link", { name: "Change job preferences" })).toBeVisible()
  })

  it("the keyword detail falls back when no keyword is saved", async () => {
    const posting = vue()
    open(`/postings/${posting.id}`, { postings: [posting] })
    expect(await screen.findByText("The title doesn't contain your saved keyword, so Eve won't apply to it.")).toBeVisible()
  })
})
