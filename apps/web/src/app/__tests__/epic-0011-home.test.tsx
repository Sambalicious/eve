import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { JobPostingDetail } from "@eve/contracts"
import { approvedState, controls, costPause, inviteeMe, operatorMe, rankedPosting, strongMatch, submission } from "@/shared/testing"
import { entryOf, openEve, profileInUse } from "./epic-0011-helpers"

const LINK = "https://boards.greenhouse.io/acme/jobs/4012345"
const match = (covered: number, total: number, verdict: "strong" | "weak" = "strong") => ({
  ...strongMatch(),
  verdict,
  weakReason: verdict === "weak" ? ("coverage_below_threshold" as const) : null,
  coveredCount: covered,
  totalCount: total,
})
const weakPosting = (o: Partial<JobPostingDetail> = {}) =>
  rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match", match: match(5, 10, "weak"), ...o })

async function paste(user: ReturnType<typeof openEve>["user"], text: string) {
  await user.type(await screen.findByRole("textbox", { name: "Job link or description" }), text)
  await user.click(screen.getByRole("button", { name: "Check this job" }))
}

describe("Home paste front door (paste-front-door.feature)", () => {
  it("FD:AC-1.1 the paste control leads Home, with Recent applications and Improve your results after it", async () => {
    openEve("/dashboard", { me: inviteeMe() })
    await screen.findByRole("button", { name: "Check this job" })
    await screen.findByRole("heading", { name: "Improve your results" })
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
    expect(headings.filter((h) => ["Paste a job", "Recent applications", "Improve your results"].includes(h ?? ""))).toEqual([
      "Paste a job",
      "Recent applications",
      "Improve your results",
    ])
    expect(headings[0]).toBe("Paste a job")
  })

  it("FD:AC-1.2 a pasted link shows the word, the Match line and a prepare action in place", async () => {
    const { user } = openEve("/dashboard", {
      me: inviteeMe(),
      discovery: { nextPasted: () => rankedPosting({ applicationUrl: LINK, match: match(78, 100) }) },
    })
    await paste(user, LINK)
    const result = await screen.findByTestId("paste-result")
    expect(within(result).getByText("Good match")).toBeVisible()
    expect(within(result).getByText("78% of core responsibilities backed by your profile")).toBeVisible()
    expect(within(result).getByRole("button", { name: "Prepare resume and cover letter" })).toBeVisible()
  })

  it("FD:AC-1.2 Prepare sends one create request and a Draft appears under Recent applications", async () => {
    const { user, documents } = openEve("/dashboard", {
      me: inviteeMe(),
      discovery: { nextPasted: () => rankedPosting({ applicationUrl: LINK, match: match(78, 100) }) },
    })
    await paste(user, LINK)
    await user.click(await screen.findByRole("button", { name: "Prepare resume and cover letter" }))
    expect(await screen.findByText("Writing your documents.")).toBeVisible()
    expect(screen.getByRole("link", { name: "Open the application" })).toBeVisible()
    expect(documents.requests.filter((r) => r.method === "POST" && r.path === "/v1/applications")).toHaveLength(1)
    const recent = screen.getByRole("heading", { name: "Recent applications" }).closest("section") as HTMLElement
    await waitFor(() => expect(within(recent).getByText("Draft")).toBeVisible())
  })

  it("FD:AC-1.2 while the check runs the result says Checking and shows no percentage", async () => {
    const { user } = openEve("/dashboard", {
      me: inviteeMe(),
      discovery: { nextPasted: () => rankedPosting({ applicationUrl: LINK, status: "checking", rank: null, match: null }) },
    })
    await paste(user, LINK)
    const result = await screen.findByTestId("paste-result")
    expect(within(result).getByText("Checking")).toBeVisible()
    expect(within(result).queryByText(/% of core responsibilities/)).not.toBeInTheDocument()
    expect(within(result).getByText("Your Match shows when the check finishes.")).toBeVisible()
  })

  it("FD:AC-1.2 a failed check shows Couldn't check with Check again", async () => {
    const { user } = openEve("/dashboard", {
      me: inviteeMe(),
      discovery: { nextPasted: () => rankedPosting({ applicationUrl: LINK, status: "evaluation_failed", rank: null, match: null, evaluationFailure: "provider_error" }) },
    })
    await paste(user, LINK)
    const result = await screen.findByTestId("paste-result")
    expect(within(result).getByText("Couldn't check")).toBeVisible()
    expect(within(result).getByRole("button", { name: "Check again" })).toBeVisible()
  })

  it("FD:AC-1.3 a Not a match job offers Prepare anyway with one confirm, and never says Override", async () => {
    const { user, documents } = openEve("/dashboard", {
      me: inviteeMe(),
      discovery: { nextPasted: () => weakPosting({ applicationUrl: LINK }) },
    })
    await paste(user, LINK)
    const result = await screen.findByTestId("paste-result")
    expect(within(result).getByText("Not a match")).toBeVisible()
    expect(within(result).getByText(/Your profile backs only 50% of the core responsibilities/)).toBeVisible()
    expect(document.body).not.toHaveTextContent(/Override|Apply anyway/)
    await user.click(within(result).getByRole("button", { name: "Prepare anyway" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText("Prepare this job anyway?")).toBeVisible()
    expect(documents.requests.filter((r) => r.path === "/v1/applications")).toHaveLength(0)
    await user.click(within(dialog).getByRole("button", { name: "Prepare" }))
    expect(await screen.findByRole("link", { name: "Open the application" })).toBeVisible()
    const sent = documents.requests.filter((r) => r.method === "POST" && r.path === "/v1/applications")
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toMatchObject({ acknowledgement: { confirmed: true } })
  })

  it.each([
    ["location", "This job needs a location that doesn't fit your criteria."],
    ["sponsorship", "This job doesn't offer the sponsorship you need."],
    ["pay", "The pay is below your minimum."],
    ["hours", "The hours don't fit your criteria."],
  ])("FD:AC-1.3 a job excluded for %s shows its reason and offers no prepare action", async (rule, line) => {
    const { user } = openEve("/dashboard", {
      me: inviteeMe(),
      // applyAnyway is the server's decision; a stored `excluded` posting for these rules is not overridable.
      discovery: { nextPasted: () => rankedPosting({ applicationUrl: LINK, status: "excluded", rank: null, skipReason: "violated_rule", skipDetail: rule, match: null }) },
    })
    await paste(user, LINK)
    const result = await screen.findByTestId("paste-result")
    expect(within(result).getByText("Not a match")).toBeVisible()
    expect(within(result).getByText(line)).toBeVisible()
    expect(within(result).queryByRole("button", { name: /Prepare/ })).not.toBeInTheDocument()
  })

  it("FD:AC-1.4 Recent applications lists at most five, newest first, with the board link", async () => {
    const entries = Array.from({ length: 7 }, (_, i) =>
      entryOf(submission(), { roleTitle: `Role ${i + 1}`, company: "Co", createdAt: `2026-10-0${i + 1}T09:00:00.000Z` })
    )
    openEve("/dashboard", { me: inviteeMe(), entries })
    const recent = (await screen.findByRole("heading", { name: "Recent applications" })).closest("section") as HTMLElement
    await waitFor(() => expect(within(recent).getAllByRole("listitem")).toHaveLength(5))
    expect(within(recent).getAllByRole("listitem")[0]).toHaveTextContent("Role 7")
    expect(within(recent).getByRole("link", { name: "See all on the board" })).toHaveAttribute("href", "/applications")
  })

  it("FD:AC-1.4 with no applications the section says what will appear", async () => {
    openEve("/dashboard", { me: inviteeMe() })
    expect(await screen.findByText("Applications Eve prepares appear here after you paste a job.")).toBeVisible()
  })

  it("FD:AC-1.5 with Advanced off Home shows no automation cards; with it on, it shows them", async () => {
    openEve("/dashboard", { me: inviteeMe() })
    await screen.findByRole("heading", { name: "Paste a job" })
    for (const name of ["Today's cap", "Automatic submission is off"]) expect(screen.queryByRole("heading", { name })).not.toBeInTheDocument()
  })

  it("FD:AC-1.5 with Advanced on Home shows the Automation status and Today's cap cards", async () => {
    openEve("/dashboard", { me: operatorMe() })
    expect(await screen.findByRole("heading", { name: "Today's cap" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Automatic submission is off" })).toBeVisible()
  })

  it.each([
    ["off", inviteeMe()],
    ["on", operatorMe()],
  ])("FD:AC-1.6 a global pause shows one banner with Advanced %s", async (_label, me) => {
    openEve("/dashboard", { me, controls: controls({ globalPaused: true, globalPausedAt: "2026-11-06T09:00:00.000Z" }) })
    const text = "Eve has paused checks. Your pasted job is saved."
    expect(await screen.findByText(text)).toBeVisible()
    expect(screen.getAllByText(text)).toHaveLength(1)
  })

  it("FD:AC-1.6 a cost pause names the date checks resume", async () => {
    openEve("/dashboard", { me: inviteeMe(), controls: controls({ costPause: costPause({ resumesAt: "2026-11-30T23:00:00.000Z" }) }) })
    expect(await screen.findByText("Eve has paused checks until 1 Dec 2026. Your pasted job is saved.")).toBeVisible()
  })

  it("FD:AC-1.6 the banner link turns Advanced on when it is off, then opens Pause and cost", async () => {
    const { user, meApi, currentPath } = openEve("/dashboard", { me: inviteeMe(), controls: controls({ globalPaused: true, globalPausedAt: "2026-11-06T09:00:00.000Z" }) })
    await user.click(await screen.findByRole("button", { name: "Go to Pause and cost" }))
    await screen.findByRole("heading", { name: "Pause and cost" })
    expect(currentPath()).toBe("/pause-and-cost")
    expect(meApi.writes).toEqual(["advanced:true"])
  })

  it("FD:AC-1.6 no pause means no banner", async () => {
    openEve("/dashboard", { me: inviteeMe() })
    await screen.findByRole("heading", { name: "Paste a job" })
    expect(screen.queryByText(/Eve has paused checks/)).not.toBeInTheDocument()
  })

  it("FD:AC-1.7 with the AI provider not approved the paste form is not rendered; one link goes to Upload", async () => {
    openEve("/dashboard", { me: inviteeMe(), career: { ...profileInUse(), approval: null } })
    expect(await screen.findByText("Eve needs your resume and approval before it can check a job.")).toBeVisible()
    expect(screen.queryByRole("textbox", { name: "Job link or description" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Go to upload" })).toHaveAttribute("href", "/welcome")
  })

  it("FD:AC-1.6a an invitee's pasted description waits with a plain reason and no Match; prepare is offered when the server allows", async () => {
    const { user } = openEve("/dashboard", {
      me: inviteeMe(),
      discovery: { pasteWaitingReason: "checks_not_enabled" },
    })
    const text = "Senior Frontend Engineer role building merchant dashboards. ".repeat(6)
    await user.type(await screen.findByRole("textbox", { name: "Job link or description" }), text)
    await user.type(screen.getByRole("textbox", { name: "Job title" }), "Senior Frontend Engineer")
    await user.type(screen.getByRole("textbox", { name: "Company" }), "Paystack")
    await user.click(screen.getByRole("button", { name: "Check this job" }))
    const result = await screen.findByTestId("paste-result")
    expect(within(result).getByText("Checking")).toBeVisible()
    expect(within(result).getByText("Your job is saved. It waits until checks are turned on for your account.")).toBeVisible()
    expect(within(result).queryByText(/% of core responsibilities/)).not.toBeInTheDocument()
  })

  it("FD:AC-1.1 pasting nothing shows the plain field error and sends nothing", async () => {
    const { user, discovery } = openEve("/dashboard", { me: inviteeMe() })
    await user.click(await screen.findByRole("button", { name: "Check this job" }))
    expect(await screen.findByText("This doesn't look like a job. Paste a job link or description.")).toBeVisible()
    expect(discovery.requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })

  it("AC-7.3 an existing account sees 'Eve is simpler now' once; dismissing keeps it gone", async () => {
    const { user, meApi } = openEve("/dashboard", { me: inviteeMe() })
    expect(await screen.findByText("Eve is simpler now")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Got it" }))
    await waitFor(() => expect(screen.queryByText("Eve is simpler now")).not.toBeInTheDocument())
    expect(meApi.writes).toEqual(["dismiss:simpler_now"])
  })

  it("AC-7.3 the note does not show with Advanced on", async () => {
    openEve("/dashboard", { me: operatorMe({ simplerNoteDue: true }) })
    await screen.findByRole("heading", { name: "Paste a job" })
    expect(screen.queryByText("Eve is simpler now")).not.toBeInTheDocument()
  })

  it("AC-2.1 a user with nothing uploaded and Advanced off goes to the Upload screen", async () => {
    const { currentPath } = openEve("/dashboard", { me: inviteeMe(), career: { ...approvedState(), versions: [] } })
    await screen.findByRole("heading", { name: "Upload your resume" })
    expect(currentPath()).toBe("/welcome")
  })
})

