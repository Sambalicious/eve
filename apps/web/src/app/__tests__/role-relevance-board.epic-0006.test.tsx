import { screen, waitFor, within } from "@testing-library/react"
import { HttpResponse } from "msw"
import { describe, expect, it } from "vitest"
import { JOB_POSTINGS_CHECK_AGAIN_PATH } from "@eve/contracts"

import { apiErrorResponse } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { aged, counts, FAMILY_LABELS, openBoard, posting } from "./epic-0006-helpers"

/**
 * EPIC-0006 QA test authoring (step [5e]), UI journeys for the board: the
 * hidden-count line, the all-hidden empty state, age labels, Check again,
 * the hidden notice on the detail page and the paste result. Written from
 * gherkin r4 and copy-deck.r1 strings; expected to fail until the EPIC-0006
 * frontend lands. The repo has no Playwright e2e runner (only ad-hoc
 * scripts/*.mjs sweeps), so journeys run in Vitest + RTL + MSW like the rest
 * of apps/web; the QA gate repeats them in a real browser.
 */

const CHANGE = "Change job criteria"
const SETTINGS_HREF = "/settings#job-criteria"
const hiddenLine = (text: string | RegExp) => screen.findByText((_, el) => el?.tagName === "P" && (typeof text === "string" ? el.textContent?.replace(/\s+/g, " ").trim().startsWith(text) : text.test(el.textContent ?? "")) === true)
const criteriaLinks = () => screen.queryAllByRole("link").filter((a) => a.getAttribute("href") === SETTINGS_HREF)

describe("AC-3.5 @AC-3.5 the hidden-count line (hidden-postings-board.feature:266-347)", () => {
  it("board:267 one line names the total and each non-zero reason, links to Job criteria, and names no undated postings", async () => {
    openBoard("/postings", { postings: [1, 2, 3, 4, 5].map(() => posting()), hiddenCounts: counts({ offTarget: 1247, belowSeniorityFloor: 12, olderThan60Days: 34 }) })
    const line = await hiddenLine("1,293 postings hidden: 1,247 off-target roles, 12 entry-level and 34 older than 60 days.")
    expect(line.textContent).not.toMatch(/posted date/)
    expect(within(line).getByRole("link", { name: CHANGE })).toHaveAttribute("href", SETTINGS_HREF)
  })

  it.each([["Good matches"], ["Not a match"], ["All"]])("board:276 the same line shows on the %s tab", async (tab) => {
    const { user } = openBoard("/postings", { postings: [posting(), posting(), posting()], hiddenCounts: counts({ offTarget: 4, undated: 2 }) })
    await user.click(await screen.findByRole("tab", { name: tab }))
    await hiddenLine("6 postings hidden: 4 off-target roles and 2 with no posted date.")
  })

  it("board:288 the line's link opens Settings at the Job criteria section", async () => {
    const { user, currentPath } = openBoard("/postings", { postings: [posting()], hiddenCounts: counts({ offTarget: 4 }) })
    const line = await hiddenLine("4 postings hidden: 4 off-target roles.")
    await user.click(within(line).getByRole("link", { name: CHANGE }))
    await waitFor(() => expect(currentPath()).toBe(SETTINGS_HREF))
    expect(await screen.findByRole("region", { name: "Job criteria" })).toBeVisible()
  })

  it.each([
    [counts({ offTarget: 4 })],
    [counts({ belowSeniorityFloor: 2 })],
    [counts({ undated: 5 })],
    [counts({ olderThan60Days: 3 })],
    [counts({ undated: 5, olderThan60Days: 3 })],
  ])("board:294 (P15) the line links to Job criteria whatever the reasons: %j", async (hidden) => {
    openBoard("/postings", { postings: [posting(), posting(), posting()], hiddenCounts: hidden })
    const line = await hiddenLine(/postings? hidden:/)
    expect(within(line).getByRole("link", { name: CHANGE })).toHaveAttribute("href", SETTINGS_HREF)
  })

  it("board:309 one hidden posting reads in the singular", async () => {
    openBoard("/postings", { postings: [posting(), posting(), posting()], hiddenCounts: counts({ offTarget: 1 }) })
    await hiddenLine("1 posting hidden: 1 off-target role.")
  })

  it("board:316 no line when nothing is hidden", async () => {
    openBoard("/postings", { postings: [posting(), posting(), posting()] })
    await screen.findAllByRole("link", { name: /Senior Frontend Engineer at Acme/ })
    expect(screen.queryByText(/postings? hidden:/)).toBeNull()
  })

  it("board:322 the line ignores the Posting filter", async () => {
    openBoard("/postings?tab=good&families=backend&keyword=zzz", { postings: [posting(), posting(), posting()], hiddenCounts: counts({ offTarget: 4 }) })
    await hiddenLine("4 postings hidden: 4 off-target roles.")
  })

  it("board:329 the line is plain text with a link named 'Change job criteria'", async () => {
    openBoard("/postings", { postings: [posting()], hiddenCounts: counts({ offTarget: 4 }) })
    const line = await hiddenLine("4 postings hidden")
    expect(line).not.toHaveAttribute("aria-hidden", "true")
    expect(within(line).getByRole("link")).toHaveAccessibleName(CHANGE)
  })

  it("four reasons join with commas and a final 'and', no serial comma", async () => {
    openBoard("/postings", { postings: [posting()], hiddenCounts: counts({ offTarget: 1, belowSeniorityFloor: 2, undated: 3, olderThan60Days: 4 }) })
    await hiddenLine("10 postings hidden: 1 off-target role, 2 entry-level, 3 with no posted date and 4 older than 60 days.")
  })
})

describe("AC-3.6 @AC-3.6 @AC-8.4 empty states with hidden postings (board:347-410)", () => {
  it("board:350 an empty Ranked tab keeps its own empty state and shows the linked line", async () => {
    openBoard("/postings", { postings: [posting({ status: "skipped", rank: null, skipReason: "weak_core_match" }), posting({ status: "skipped", rank: null, skipReason: "weak_core_match" })], hiddenCounts: counts({ offTarget: 5 }) })
    expect(await screen.findByText("No good matches yet")).toBeVisible()
    const line = await hiddenLine("5 postings hidden: 5 off-target roles.")
    expect(within(line).getByRole("link", { name: CHANGE })).toBeVisible()
    expect(screen.queryByText("Every posting Eve found is hidden")).toBeNull()
  })

  it("board:359 with a filter on, the filter empty state shows, not the all-hidden one", async () => {
    openBoard("/postings?tab=all&keyword=Frontend", { hiddenCounts: counts({ offTarget: 10 }) })
    expect(await screen.findByText("No postings match these filters")).toBeVisible()
    expect(screen.queryByText("Every posting Eve found is hidden")).toBeNull()
    const line = await hiddenLine("10 postings hidden: 10 off-target roles.")
    expect(within(line).getByRole("link", { name: CHANGE })).toBeVisible()
  })

  it("board:368 the all-hidden state does not show while a visible posting exists on another tab", async () => {
    openBoard("/postings", { postings: [posting({ status: "skipped", rank: null, skipReason: "weak_core_match" })], hiddenCounts: counts({ undated: 8 }) })
    expect(await screen.findByText("No good matches yet")).toBeVisible()
    expect(screen.queryByText("Every posting Eve found is hidden")).toBeNull()
  })

  it("board:376 / migration:189 all 2,222 undated: the all-hidden state, the undated body, one link, and a line without a link", async () => {
    openBoard("/postings", { hiddenCounts: counts({ undated: 2222 }) })
    expect(await screen.findByRole("heading", { name: "Every posting Eve found is hidden" })).toBeVisible()
    expect(screen.getByText("Posted dates fill in the next time Eve reads each job board. Your job criteria decide the rest.")).toBeVisible()
    expect(screen.queryByText("No jobs yet")).toBeNull()
    const line = await hiddenLine("2,222 postings hidden: 2,222 with no posted date.")
    expect(within(line).queryByRole("link")).toBeNull()
    expect(criteriaLinks()).toHaveLength(1)
    expect(criteriaLinks()[0]).toHaveAccessibleName(CHANGE)
  })

  it("board:388 with no postings at all, the first-run state and no line", async () => {
    openBoard("/postings")
    expect(await screen.findByText("No jobs yet")).toBeVisible()
    expect(screen.queryByText(/postings? hidden:/)).toBeNull()
  })

  it("board:394 all off-target on the All tab: the settings body and exactly one Job criteria link", async () => {
    openBoard("/postings?tab=all", { hiddenCounts: counts({ offTarget: 10 }) })
    expect(await screen.findByRole("heading", { name: "Every posting Eve found is hidden" })).toBeVisible()
    expect(screen.getByText("Your role families, seniority setting and the 60-day age limit decide what shows. The line above gives each reason.")).toBeVisible()
    expect(criteriaLinks()).toHaveLength(1)
  })
})

describe("AC-6.3 @AC-6.3 @AC-6.4 age labels from ageDays (posting-age.feature:96-190)", () => {
  it.each([
    [30, "published", null],
    [31, "published", "Posted 31 days ago"],
    [45, "published", "Posted 45 days ago"],
    [60, "published", "Posted 60 days ago"],
    [45, "updated", "Updated 45 days ago"],
    [4, "updated", null],
  ] as const)("posting-age:96 age %i (%s) shows %j", async (days, kind, label) => {
    openBoard("/postings", { postings: [aged(days, kind)] })
    await screen.findAllByRole("link", { name: /Senior Frontend Engineer at Acme/ })
    if (label) expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    else expect(screen.queryByText(/(Posted|Updated) \d+ days ago/)).toBeNull()
  })

  it("posting-age:107 the label uses the server's ageDays, not the browser clock", async () => {
    openBoard("/postings", { postings: [posting({ postedOn: "2026-09-14", postedAt: "2026-09-13T23:00:00.000Z", ageDays: 40 })] })
    expect((await screen.findAllByText("Posted 40 days ago")).length).toBeGreaterThan(0)
  })

  it("the label is a <time> carrying the WAT posted date", async () => {
    openBoard("/postings", { postings: [aged(45)] })
    const [label] = await screen.findAllByText("Posted 45 days ago")
    expect(label!.closest("time")).toHaveAttribute("datetime", "2026-09-09")
  })

  it("posting-age:150 the detail page shows a Posted fact with the WAT date for a dated posting", async () => {
    const p = aged(45)
    openBoard(`/postings/${p.id}`, { postings: [p] })
    expect(await screen.findByText("Posted")).toBeVisible()
    expect(screen.getByText("9 Sep 2026")).toBeVisible()
  })

  it("posting-age:160 an updated-basis posting's detail shows an Updated fact", async () => {
    const p = aged(45, "updated")
    openBoard(`/postings/${p.id}`, { postings: [p] })
    expect(await screen.findByText("Updated")).toBeVisible()
  })
})

describe("AC-1.2 @AC-1.2 family labels on the board (role-family-catalog:52-82)", () => {
  it.each(FAMILY_LABELS.filter(([key]) => key !== "other"))("family %s reads %j on the Ranked row", async (key, label) => {
    openBoard("/postings", { postings: [posting({ roleFamily: key as never })], targetRoleFamilies: FAMILY_LABELS.map(([k]) => k) })
    const [row] = await screen.findAllByRole("link", { name: /Senior Frontend Engineer at Acme/ })
    expect(row!.closest("tr, li, article")).toHaveTextContent(label)
  })

  it("role-family-catalog:76 the old labels no longer appear", async () => {
    openBoard("/postings", { postings: [posting({ roleFamily: "senior_frontend" }), posting({ roleFamily: "devops_platform" }), posting({ roleFamily: "people_management" })] })
    await screen.findAllByRole("link", { name: /Senior Frontend Engineer at Acme/ })
    expect(screen.queryByText("Senior frontend")).toBeNull()
    expect(screen.queryByText("DevOps and platform")).toBeNull()
    expect(screen.queryByText("People management")).toBeNull()
  })
})

describe("AC-7.3 @AC-7.3 @AC-7.5 Check again on the board (check-again-and-worker-key.feature:150-330)", () => {
  const failed = () => posting({ status: "evaluation_failed", rank: null, evaluationFailure: "not_configured" })
  const notChecked = () => posting({ status: "not_checked", rank: null })

  it.each([["Good matches"], ["Not a match"], ["All"]])("check-again:150 the panel is above the tabs with count 3 on %s", async (tab) => {
    const { user } = openBoard("/postings", { postings: [failed(), failed(), notChecked()] })
    await user.click(await screen.findByRole("tab", { name: tab }))
    const button = await screen.findByRole("button", { name: "Check again" })
    expect(screen.getByText("3 postings on your board haven't been checked.")).toBeVisible()
    const tablist = screen.getByRole("tablist")
    expect(button.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Q-4: the page renders tab content in a <section> labelled with the tab name (no tabpanel role).
    expect(screen.getByRole("region", { name: tab }).contains(button)).toBe(false)
  })

  it("check-again:159 a filter does not change the count", async () => {
    openBoard("/postings?tab=all&families=mobile&keyword=zzz", { postings: [failed(), failed(), posting({ status: "not_checked", rank: null, roleFamily: "backend" })] })
    expect(await screen.findByText("3 postings on your board haven't been checked.")).toBeVisible()
  })

  it("check-again:184 / :195 pressing asks for confirmation naming the count and the AI spend; Cancel sends nothing", async () => {
    const { user, requests } = openBoard("/postings", { postings: Array.from({ length: 929 }, failed) })
    await user.click(await screen.findByRole("button", { name: "Check again" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Check 929 postings again?" })
    expect(within(dialog).getByText("Each check uses AI spend and counts toward this month's cost ceiling. If the ceiling is reached, the rest wait until the cost pause ends.")).toBeVisible()
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus())
    expect(within(dialog).getByRole("button", { name: "Check 929 postings" })).toBeVisible()
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(requests.filter((r) => r.path === JOB_POSTINGS_CHECK_AGAIN_PATH)).toEqual([])
    expect(screen.getByText("929 postings on your board haven't been checked.")).toBeVisible()
  })

  it("check-again:218 confirming sends {} once, shows the queued toast, and the panel goes away", async () => {
    const { user, requests } = openBoard("/postings?tab=all", { postings: [failed(), failed(), failed(), notChecked()] })
    await user.click(await screen.findByRole("button", { name: "Check again" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Check 4 postings" }))
    await findToast("4 postings queued for a check.")
    const posts = requests.filter((r) => r.path === JOB_POSTINGS_CHECK_AGAIN_PATH)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body === null || JSON.stringify(posts[0]!.body) === "{}").toBe(true)
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check again" })).toBeNull())
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("check-again:228 a 200 without queued shows the network error in the dialog and no toast", async () => {
    const { user } = openBoard("/postings", { postings: [failed(), failed(), failed()], checkAgain: () => HttpResponse.json({ ok: true }) })
    await user.click(await screen.findByRole("button", { name: "Check again" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Check 3 postings" }))
    expect(await within(dialog).findByText("Couldn't queue the checks. Nothing changed. Try again.")).toBeVisible()
    expect(screen.queryByText(/queued for a check/)).toBeNull()
  })

  it("a 500 keeps the dialog open with the network error; the confirm button retries", async () => {
    const { user, requests, state } = openBoard("/postings", { postings: [failed()], checkAgain: () => apiErrorResponse("internal_error") })
    await user.click(await screen.findByRole("button", { name: "Check again" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Check 1 posting again?" })
    await user.click(within(dialog).getByRole("button", { name: "Check 1 posting" }))
    expect(await within(dialog).findByText("Couldn't queue the checks. Nothing changed. Try again.")).toBeVisible()
    expect(state.checkAgain).toBeNull()
    await user.click(within(dialog).getByRole("button", { name: "Check 1 posting" }))
    await findToast("1 posting queued for a check.")
    expect(requests.filter((r) => r.path === JOB_POSTINGS_CHECK_AGAIN_PATH)).toHaveLength(2)
  })

  it("a 4xx with a message shows the message verbatim in the dialog", async () => {
    const { user } = openBoard("/postings", { postings: [failed()], checkAgain: () => apiErrorResponse("csrf_invalid") })
    await user.click(await screen.findByRole("button", { name: "Check again" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Check 1 posting" }))
    expect(await within(dialog).findByText("The request is missing a valid CSRF token.")).toBeVisible()
  })

  it("check-again:394 (AC-7.5) a second press that queues 0 shows the info toast", async () => {
    const { user } = openBoard("/postings", { postings: [failed()], checkAgain: () => ({ queued: 0, movedTo: "checking" }) })
    await user.click(await screen.findByRole("button", { name: "Check again" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Check 1 posting" }))
    await findToast("Nothing new to check. Those postings are already queued.")
  })

  it("per-candidate:271 a non-Operator press moved to waiting shows the waiting toast", async () => {
    const { user } = openBoard("/postings", { postings: [failed(), failed(), notChecked()], checkAgain: () => ({ queued: 3, movedTo: "waiting_to_be_checked" }) })
    await user.click(await screen.findByRole("button", { name: "Check again" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Check 3 postings" }))
    await findToast("3 postings moved to waiting. They aren't checked until the person who runs your Eve turns on checks for you.")
    expect(screen.queryByText(/queued for a check/)).toBeNull()
  })

  it.each([
    ["5 ranked/skipped + 2 waiting + 1 checking", () => [posting(), posting({ status: "waiting_to_be_checked", rank: null }), posting({ status: "checking", rank: null })]],
    ["no postings", () => []],
  ])("check-again:240 / :250 the panel is absent with %s", async (_label, make) => {
    openBoard("/postings?tab=all", { postings: make(), waitingToBeCheckedCount: 1 })
    await waitFor(() => expect(screen.getByRole("tablist")).toBeVisible())
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull()
  })

  it("check-again:264 exactly one eligible posting reads in the singular", async () => {
    openBoard("/postings", { postings: [failed()] })
    expect(await screen.findByText("1 posting on your board hasn't been checked.")).toBeVisible()
  })
})

describe("AC-4.3 @AC-4.3 @AC-7.10 Not checked yet and failure lines (settings-apply, evaluation-failure-lines)", () => {
  it("settings-apply:156 a not_checked posting shows the Couldn't check word and its line on All", async () => {
    openBoard("/postings?tab=all", { postings: [posting({ status: "not_checked", rank: null })] })
    expect((await screen.findAllByText("Couldn't check")).length).toBeGreaterThan(0)
    expect(screen.getAllByText("Not checked while it was hidden. Use Check again on Jobs.").length).toBeGreaterThan(0)
  })

  it.each([
    ["provider_error", "Not checked: Anthropic didn't answer. Use Check again on Jobs to retry."],
    ["invalid_output", "Not checked: the AI answer couldn't be used. Use Check again on Jobs to retry."],
    ["timed_out", "Not checked: the check took too long. Use Check again on Jobs to retry."],
    ["not_configured", "Not checked: the Anthropic API key isn't set on the server. Set it there, then use Check again."],
    ["no_career_profile", "Not checked: the Career Profile isn't approved. Approve it, then use Check again."],
  ] as const)("failure kind %s reads %j", async (kind, line) => {
    openBoard("/postings?tab=all", { postings: [posting({ status: "evaluation_failed", rank: null, evaluationFailure: kind })] })
    expect((await screen.findAllByText(line)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Paste the link again later/)).toBeNull()
  })
})

describe("AC-7.4 @AC-7.4 the waiting notice follows the waiting reason (per-candidate:347-398)", () => {
  it("cost_pause (Operator) shows the cost-pause text", async () => {
    openBoard("/postings", { postings: [posting()], waitingToBeCheckedCount: 2, waitingReason: "cost_pause" })
    const notice = await screen.findByText(/2 postings are waiting to be checked\./)
    expect(notice).toHaveTextContent("2 postings are waiting to be checked. Eve checks them when the cost pause ends, then ranks them with the rest.")
    expect(screen.getByRole("link", { name: "See them" })).toBeVisible()
  })

  it("checks_not_enabled (non-Operator) shows the invitee text and no cost-pause wording", async () => {
    openBoard("/postings", { postings: [posting()], waitingToBeCheckedCount: 1, waitingReason: "checks_not_enabled" })
    const notice = await screen.findByText(/1 posting is waiting to be checked\./)
    expect(notice).toHaveTextContent("1 posting is waiting to be checked. It isn't checked until the person who runs your Eve turns on checks for you.")
    expect(notice.textContent).not.toMatch(/cost pause/)
  })
})

describe("AC-3.8 @AC-3.8 the hidden notice on the detail page (applications-and-links:28-110)", () => {
  it.each([
    ["off_target", "Hidden from your board: off-target role, not one of your role families.", true],
    ["below_seniority_floor", "Hidden from your board: entry-level role, below your seniority setting.", true],
    ["undated", "Hidden from your board: no posted date.", false],
    ["older_than_60_days", "Hidden from your board: posted more than 60 days ago.", false],
  ] as const)("reason %s: notice title, body, and a Job criteria link only for setting reasons", async (reason, title, link) => {
    const p = posting({ hiddenReason: reason, rank: null, postedAt: reason === "undated" ? null : "2026-08-01T10:00:00.000Z", postedOn: reason === "undated" ? null : "2026-08-01", postedDateKind: reason === "undated" ? null : "published", ageDays: reason === "undated" ? null : 84 })
    openBoard(`/postings/${p.id}`, { hidden: [p] })
    // Q-4: the title is its own element; the notice is its container (title and body are siblings).
    const notice = (await screen.findByText(title)).parentElement!
    expect(within(notice as HTMLElement).getByText("Eve keeps this posting, and any Application for it still links here. No new Application can start from it.")).toBeVisible()
    const links = within(notice as HTMLElement).queryAllByRole("link", { name: CHANGE })
    expect(links).toHaveLength(link ? 1 : 0)
    if (link) expect(links[0]).toHaveAttribute("href", SETTINGS_HREF)
    expect(screen.queryByText(/^#\d+$/)).toBeNull()
  })

  it("applications-and-links:80 a hidden ranked posting offers no action that starts an Application", async () => {
    const p = posting({ hiddenReason: "off_target", rank: null, roleFamily: "data_ml", title: "Senior Data Engineer" })
    openBoard(`/postings/${p.id}`, { hidden: [p] })
    await screen.findByText("Hidden from your board: off-target role, not one of your role families.")
    expect(screen.queryByRole("button", { name: /Prepare|Start|Create|Manual Application/i })).toBeNull()
  })

  it("applications-and-links:108 a visible posting's detail shows no hidden notice", async () => {
    const p = posting()
    openBoard(`/postings/${p.id}`, { postings: [p] })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByText(/Hidden from your board/)).toBeNull()
  })
})

describe("AC-5.7 @AC-5.7 the paste result for a hidden link (posted-date:363-398)", () => {
  async function pasteIt(user: ReturnType<typeof openBoard>["user"], url: string) {
    await user.type(await screen.findByRole("textbox", { name: /job link/i }), url)
    await user.click(screen.getByRole("button", { name: "Check link" }))
  }

  it.each([
    ["undated", "Saved, but hidden: no posted date."],
    ["off_target", "Saved, but hidden: off-target role."],
    ["below_seniority_floor", "Saved, but hidden: entry-level role."],
    ["older_than_60_days", "Saved, but hidden: posted more than 60 days ago."],
  ] as const)("a new hidden link (%s) shows the status line with 'View it' and no success toast", async (reason, text) => {
    const p = posting({ status: "not_checked", rank: null, hiddenReason: reason, applicationUrl: "https://jobs.lever.co/globex/abc-999", applyUrl: "https://jobs.lever.co/globex/abc-999", applicationSystem: "Lever" })
    const { user } = openBoard("/postings", { paste: { status: 201, created: true, posting: p } })
    await pasteIt(user, "https://jobs.lever.co/globex/abc-999")
    const status = await screen.findByText((_, el) => el?.getAttribute("role") === "status" && (el.textContent ?? "").includes(text))
    expect(within(status).getByRole("link", { name: "View it" })).toHaveAttribute("href", `/postings/${p.id}`)
  })

  it("a known hidden link says it is already saved and names the reason", async () => {
    const p = posting({ status: "not_checked", rank: null, hiddenReason: "undated", postedAt: null, postedOn: null, postedDateKind: null, ageDays: null })
    const { user } = openBoard("/postings", { paste: { status: 200, created: false, posting: p } })
    await pasteIt(user, "https://jobs.lever.co/globex/abc-999")
    expect(await screen.findByText((_, el) => el?.getAttribute("role") === "status" && (el.textContent ?? "").includes("You already have this Job Posting. It's hidden: no posted date."))).toBeVisible()
  })

  it("a visible pasted link names no hidden reason", async () => {
    const p = posting({ status: "checking", rank: null })
    const { user } = openBoard("/postings", { paste: { status: 201, created: true, posting: p } })
    await pasteIt(user, "https://jobs.lever.co/globex/fe-1")
    await waitFor(() => expect(screen.queryByText(/hidden:/)).toBeNull())
  })
})
