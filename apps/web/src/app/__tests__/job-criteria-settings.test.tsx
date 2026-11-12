import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"
import { CANDIDATE_CONTACT_PATH, CSRF_HEADER, DEFAULT_TARGET_ROLE_FAMILIES, JOB_CRITERIA_PATH } from "@eve/contracts"

import { apiErrorResponse, defaultJobCriteria, rankedPosting, server, strongMatch, TEST_CSRF_TOKEN } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { criteriaSection, openWithCriteria } from "./job-criteria-helpers"
import { renderApp } from "./test-app"

const MATCH_ERROR = "Enter a whole number from 1 to 100."
const CHARS_ERROR = "Use only letters, digits, spaces and these symbols: . + # - / _"
const EMPTY_ERROR = "Enter a name to add."
const LONG_ERROR = "Use 40 characters or fewer for each entry."
const FULL_ERROR = "This list is full at 20 entries. Remove one to add another."
const DUP_ERROR = "Already in your list."
const LIST_NAMES = { Frameworks: "frameworks", Technologies: "technologies" } as const
type ListLabel = keyof typeof LIST_NAMES

const twenty = (prefix: string) => Array.from({ length: 20 }, (_, i) => `${prefix}${String.fromCharCode(65 + i)}`)

async function setup(...args: Parameters<typeof openWithCriteria>) {
  const view = openWithCriteria(...args)
  const region = await criteriaSection()
  const ui = {
    region,
    match: () => within(region).getByLabelText("Minimum core Match"),
    input: (list: ListLabel) => within(region).getByRole("textbox", { name: list }),
    chips: (list: ListLabel) =>
      within(region)
        .queryByRole("list", { name: list })
        ?.querySelectorAll("li") ?? [],
    chipTexts: (list: ListLabel) => [...ui.chips(list)].map((li) => li.textContent),
    save: () => within(region).getByRole("button", { name: /Save job criteria|Saving…/ }),
    async setMatch(text: string) {
      await view.user.clear(ui.match())
      if (text !== "") await view.user.type(ui.match(), text)
    },
    async addEntry(list: ListLabel, text: string) {
      const input = ui.input(list)
      await view.user.clear(input)
      if (text !== "") await view.user.type(input, text)
      await view.user.click(within(region).getByRole("button", { name: `Add to ${list}` }))
    },
    putRequests: () => view.career.requestsTo("PUT", JOB_CRITERIA_PATH),
  }
  return { ...view, ...ui }
}

describe("Settings: Job criteria section (job-criteria-settings.feature)", () => {
  it("@ac-1.1 @superseded-by-B1 sits directly under Job preferences, then ATS minimum and Contact details, with id job-criteria", async () => {
    // EPIC-0004 job-criteria-settings.feature:47 is superseded by EPIC-0002 settings-b1.feature:35.
    const { region } = await setup("/settings")
    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
    const at = (title: string) => titles.indexOf(title)
    expect(at("Location and work authorization")).toBe(-1)
    expect(at("Job preferences")).toBe(0)
    expect(at("Job criteria")).toBe(at("Job preferences") + 1)
    // ATS (v1.26.0): the ATS minimum sits between Job criteria and Contact details once it loads.
    await screen.findByRole("heading", { level: 2, name: "ATS minimum" })
    const loaded = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
    expect(loaded.indexOf("ATS minimum")).toBe(loaded.indexOf("Job criteria") + 1)
    expect(loaded.indexOf("Contact details")).toBe(loaded.indexOf("ATS minimum") + 1)
    expect(region).toHaveAttribute("id", "job-criteria")
  })

  it("@ac-1.1 holds the three fields and exactly one Save changes action", async () => {
    const { region, match, input } = await setup("/settings")
    expect(match()).toBeVisible()
    expect(input("Frameworks")).toBeVisible()
    expect(input("Technologies")).toBeVisible()
    expect(within(region).getAllByRole("button", { name: "Save job criteria" })).toHaveLength(1)
    expect(within(region).getByText("These criteria decide which postings Eve shows and ranks. Saving applies them to postings Eve already found.")).toBeVisible()
  })

  it("@ac-1.2 a migrated installation shows 70, no entries and the technology-off note", async () => {
    const { region, match, chips } = await setup("/settings")
    expect(match()).toHaveValue("70")
    expect(match()).toHaveAttribute("inputmode", "numeric")
    expect(chips("Frameworks")).toHaveLength(0)
    expect(chips("Technologies")).toHaveLength(0)
    expect(within(region).getAllByText("None added.")).toHaveLength(2)
    expect(within(region).getByText("With both lists empty, Eve doesn't skip postings for technology.")).toBeVisible()
  })

  it("@ac-1.2 loads the stored values in their saved order", async () => {
    const { match, chipTexts, region } = await setup("/settings", {
      criteria: { minCoreMatchPercent: 65, frameworks: ["Vue", "Nuxt"], technologies: ["Go", "PostgreSQL"] },
    })
    expect(match()).toHaveValue("65")
    expect(chipTexts("Frameworks")).toEqual(["Vue", "Nuxt"])
    expect(chipTexts("Technologies")).toEqual(["Go", "PostgreSQL"])
    expect(within(region).getAllByText("2 of 20")).toHaveLength(2)
    expect(within(region).queryByText("With both lists empty, Eve doesn't skip postings for technology.")).not.toBeInTheDocument()
  })

  it("@ac-1.1 @ac-1.2 saves new criteria with the CSRF token, toasts Saved. and shows them after reload", async () => {
    let csrf: string | null = null
    server.events.on("request:start", ({ request }) => {
      if (request.method === "PUT" && request.url.endsWith(JOB_CRITERIA_PATH)) csrf = request.headers.get(CSRF_HEADER)
    })
    const view = await setup("/settings")
    await view.setMatch("80")
    await view.addEntry("Frameworks", "React")
    await view.addEntry("Frameworks", "Next.js")
    await view.addEntry("Technologies", "TypeScript")
    await view.user.click(view.save())

    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    server.events.removeAllListeners()
    expect(csrf).toBe(TEST_CSRF_TOKEN)
    expect(view.putRequests()).toEqual([
      { method: "PUT", path: JOB_CRITERIA_PATH, body: { minCoreMatchPercent: 80, frameworks: ["React", "Next.js"], technologies: ["TypeScript"], targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: "hide_entry_level" } },
    ])
    expect(view.career.state.jobCriteria).toMatchObject({ minCoreMatchPercent: 80, version: 2 })

    view.unmount()
    const reloaded = openWithCriteria("/settings", { criteria: view.career.state.jobCriteria })
    const region = await criteriaSection()
    expect(within(region).getByLabelText("Minimum core Match")).toHaveValue("80")
    expect(within(region).getByRole("list", { name: "Frameworks" })).toHaveTextContent("ReactNext.js")
    expect(within(region).getByRole("list", { name: "Technologies" })).toHaveTextContent("TypeScript")
    reloaded.unmount()
  })

  it("@ac-1.1 saving Job criteria leaves unsaved Contact edits on screen and stores nothing for Contact", async () => {
    const view = await setup("/settings", { documents: { contact: { fullName: "Ada Obi", lines: [] } } })
    const contact = await screen.findByRole("region", { name: "Contact details" })
    const name = within(contact).getByLabelText("Full name (Required)")
    await view.user.clear(name)
    await view.user.type(name, "Ada O. Obi")
    await view.setMatch("75")
    await view.user.click(view.save())

    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(name).toHaveValue("Ada O. Obi")
    expect(view.documents.state.contact.fullName).toBe("Ada Obi")
    expect(view.documents.requests.filter((r) => r.path === CANDIDATE_CONTACT_PATH)).toEqual([])
  })

  it("@ac-3.1 removes an entry and saves the rest", async () => {
    const view = await setup("/settings", { criteria: { frameworks: ["React", "Vue"] } })
    await view.user.click(within(view.region).getByRole("button", { name: "Remove Vue from Frameworks" }))
    await view.user.click(view.save())

    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria.frameworks).toEqual(["React"])
  })

  it("@ac-3.1 @ac-3.6 both lists can be saved empty", async () => {
    const view = await setup("/settings", { criteria: { frameworks: ["React"], technologies: ["TypeScript"] } })
    await view.user.click(within(view.region).getByRole("button", { name: "Remove React from Frameworks" }))
    await view.user.click(within(view.region).getByRole("button", { name: "Remove TypeScript from Technologies" }))
    expect(within(view.region).getByText("With both lists empty, Eve doesn't skip postings for technology.")).toBeVisible()
    await view.user.click(view.save())

    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria).toMatchObject({ frameworks: [], technologies: [] })
  })

  it("shows Saving… with the fields read-only while the save is in flight", async () => {
    let release: () => void = () => undefined
    const view = await setup("/settings")
    server.use(
      http.put(JOB_CRITERIA_PATH, async () => {
        await new Promise<void>((resolve) => (release = resolve))
        return HttpResponse.json({ ...defaultJobCriteria(), version: 2 })
      })
    )
    await view.user.click(view.save())

    const button = await within(view.region).findByRole("button", { name: "Saving…" })
    expect(button).toHaveAttribute("aria-busy", "true")
    expect(view.match()).toHaveAttribute("readonly")
    expect(view.input("Frameworks")).toHaveAttribute("readonly")
    release()
    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(within(view.region).getByRole("button", { name: "Save job criteria" })).toBeEnabled()
  })

  it("invalidates the postings queries after a save, so Postings shows re-decided statuses (AC 5.5)", async () => {
    const initech = rankedPosting({ title: "Frontend Engineer", company: "Initech" })
    const view = openWithCriteria("/postings", { discovery: { postings: [initech] } })
    expect(await screen.findAllByRole("link", { name: "Frontend Engineer at Initech" })).not.toHaveLength(0)
    // The server re-decides on save; mirror that in the postings fake.
    view.career.onJobCriteriaSaved(() => {
      view.discovery.state.postings = [
        { ...initech, status: "skipped", rank: null, skipReason: "weak_core_match", match: null },
      ]
    })
    await view.user.click(screen.getByRole("link", { name: "Settings" }))
    const region = await criteriaSection()
    await view.user.clear(within(region).getByLabelText("Minimum core Match"))
    await view.user.type(within(region).getByLabelText("Minimum core Match"), "80")
    await view.user.click(within(region).getByRole("button", { name: "Save job criteria" }))
    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    // The cached Ranked list is marked stale by the save itself, not only by remounting.
    expect(view.app.queryClient.getQueryState(["job-postings", "list", "ranked", "", ""])?.isInvalidated).toBe(true)

    await view.user.click(screen.getByRole("link", { name: "Jobs" }))
    await waitFor(() => expect(screen.queryByRole("link", { name: "Frontend Engineer at Initech" })).not.toBeInTheDocument())
  })
})

describe("Job criteria: failed saves (AC 1.3, design-spec.r1 J2 step 4)", () => {
  const RETRY = "Couldn't save your job criteria. Nothing changed. Try again."

  it("a 4xx refusal that maps to no field shows the API message verbatim and keeps the unsaved input", async () => {
    const view = await setup("/settings")
    server.use(
      http.put(JOB_CRITERIA_PATH, () =>
        HttpResponse.json({ error: { code: "bad_request", message: "The request is not valid." } }, { status: 400 })
      )
    )
    await view.setMatch("85")
    await view.addEntry("Frameworks", "Svelte")
    await view.user.click(view.save())

    const alert = await within(view.region).findByRole("alert")
    expect(alert).toHaveTextContent(/^The request is not valid\.$/)
    await waitFor(() => expect(alert).toHaveFocus())
    expect(view.match()).toHaveValue("85")
    expect(view.chipTexts("Frameworks")).toEqual(["Svelte"])
    expect(screen.queryByText("Job criteria saved.")).not.toBeInTheDocument()
  })

  it("SEC-006 (contract v1.15.0): a 429 too_many_requests shows the API message verbatim and keeps the unsaved input", async () => {
    const view = await setup("/settings")
    server.use(
      http.put(JOB_CRITERIA_PATH, () =>
        HttpResponse.json(
          { error: { code: "too_many_requests", message: "Too many requests. Wait a minute, then try again." } },
          { status: 429, headers: { "Retry-After": "42" } }
        )
      )
    )
    await view.setMatch("85")
    await view.addEntry("Frameworks", "Svelte")
    await view.user.click(view.save())

    const alert = await within(view.region).findByRole("alert")
    expect(alert).toHaveTextContent(/^Too many requests\. Wait a minute, then try again\.$/)
    await waitFor(() => expect(alert).toHaveFocus())
    expect(alert).not.toHaveTextContent(RETRY)
    expect(view.match()).toHaveValue("85")
    expect(view.chipTexts("Frameworks")).toEqual(["Svelte"])
    expect(view.career.state.jobCriteria).toMatchObject({ minCoreMatchPercent: 70, frameworks: [], version: 1 })
    expect(screen.queryByText("Job criteria saved.")).not.toBeInTheDocument()
  })

  it("a 500 with a message shows the retry line, never the server message, keeps the input and stores nothing", async () => {
    const view = await setup("/settings")
    view.career.failNextJobCriteriaSave()
    await view.setMatch("85")
    await view.addEntry("Frameworks", "Svelte")
    await view.user.click(view.save())

    const alert = await within(view.region).findByRole("alert")
    expect(alert).toHaveTextContent(RETRY)
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.queryByText("Something went wrong.")).not.toBeInTheDocument()
    expect(view.match()).toHaveValue("85")
    expect(view.chipTexts("Frameworks")).toEqual(["Svelte"])
    expect(view.career.state.jobCriteria).toMatchObject({ minCoreMatchPercent: 70, frameworks: [], version: 1 })
    expect(screen.queryByText("Job criteria saved.")).not.toBeInTheDocument()
  })

  it("re-decision-on-save r5: a failure during re-decision shows the retry line, not the server's message, and changes nothing", async () => {
    const initech = rankedPosting({ title: "Frontend Engineer", company: "Initech", match: { ...strongMatch(), coveredCount: 7, totalCount: 10 } })
    const hooli = rankedPosting({
      title: "Platform Engineer",
      company: "Hooli",
      status: "skipped",
      rank: null,
      skipReason: "weak_core_match",
      match: { ...strongMatch(), verdict: "weak", weakReason: "coverage_below_threshold", coveredCount: 6, totalCount: 10 },
    })
    const view = await setup("/settings", { discovery: { postings: [initech, hooli] } })
    // The API rolls the whole save back and answers 500 internal_error "Something went wrong." (backend-spec atomic save).
    view.career.failNextJobCriteriaSave()
    await view.setMatch("60")
    await view.addEntry("Frameworks", "React")
    await view.user.click(view.save())

    const alert = await within(view.region).findByRole("alert")
    expect(alert).toHaveTextContent(/^Couldn't save your job criteria\. Nothing changed\. Try again\.$/)
    expect(screen.queryByText("Something went wrong.")).not.toBeInTheDocument()
    expect(view.career.state.jobCriteria).toEqual({ ...defaultJobCriteria(), version: 1 })
    expect(view.putRequests().map((r) => r.body)).toEqual([{ minCoreMatchPercent: 60, frameworks: ["React"], technologies: [], targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: "hide_entry_level" }])

    await view.user.click(screen.getByRole("link", { name: "Jobs" }))
    const ranked = await screen.findByRole("region", { name: "Job Postings, scrolls horizontally" })
    expect(within(ranked).getByRole("link", { name: "Frontend Engineer at Initech" })).toBeVisible()
    await view.user.click(screen.getByRole("tab", { name: "Not a match" }))
    expect(await screen.findAllByText("Your profile backs only 60% of the core responsibilities. Your minimum is 70%.")).not.toHaveLength(0)
  })

  it("a 503 and a 4xx without a message also show the retry line", async () => {
    const view = await setup("/settings")
    server.use(http.put(JOB_CRITERIA_PATH, () => apiErrorResponse("service_unavailable")))
    await view.user.click(view.save())
    expect(await within(view.region).findByRole("alert")).toHaveTextContent(RETRY)
    expect(screen.queryByText("The service is unavailable. Try again shortly.")).not.toBeInTheDocument()

    server.use(
      http.put(JOB_CRITERIA_PATH, () => HttpResponse.json({ error: { code: "csrf_invalid", message: "" } }, { status: 403 }))
    )
    await view.user.click(view.save())
    await waitFor(() => expect(within(view.region).getByRole("alert")).toHaveTextContent(RETRY))
  })

  it("a save that never reaches the server shows the retry line and keeps the unsaved input", async () => {
    const view = await setup("/settings")
    server.use(http.put(JOB_CRITERIA_PATH, () => HttpResponse.error()))
    await view.setMatch("85")
    await view.addEntry("Frameworks", "Svelte")
    await view.user.click(view.save())

    expect(await within(view.region).findByRole("alert")).toHaveTextContent(RETRY)
    expect(view.match()).toHaveValue("85")
    expect(view.chipTexts("Frameworks")).toEqual(["Svelte"])
  })

  it("a refused CSRF token shows the API message verbatim and stores nothing", async () => {
    const view = await setup("/settings")
    server.use(http.put(JOB_CRITERIA_PATH, () => apiErrorResponse("csrf_invalid")))
    await view.setMatch("50")
    await view.user.click(view.save())

    expect(await within(view.region).findByRole("alert")).toHaveTextContent("The request is missing a valid CSRF token.")
    expect(view.career.state.jobCriteria.minCoreMatchPercent).toBe(70)
  })

  it("a save after the session ended goes to sign-in and stores nothing", async () => {
    const view = await setup("/settings")
    server.use(
      http.put(JOB_CRITERIA_PATH, () => apiErrorResponse("session_expired")),
      http.get("/v1/session", () => apiErrorResponse("session_expired"))
    )
    await view.setMatch("60")
    await view.user.click(view.save())

    await waitFor(() => expect(view.currentPath()).toBe("/sign-in?next=%2Fsettings&reason=expired"))
    expect(await screen.findByText("Your session ended. Sign in with Google again to continue where you left off.")).toBeVisible()
    expect(view.career.state.jobCriteria.minCoreMatchPercent).toBe(70)
  })

  it("a defensive 409 shows the conflict alert and Reload job criteria replaces the form with stored values", async () => {
    const view = await setup("/settings", { criteria: { minCoreMatchPercent: 60 } })
    server.use(
      http.put(JOB_CRITERIA_PATH, () =>
        HttpResponse.json({ error: { code: "application_state_conflict", message: "" } }, { status: 409 })
      )
    )
    await view.setMatch("90")
    await view.user.click(view.save())

    const alert = await within(view.region).findByRole("alert")
    expect(alert).toHaveTextContent("Job criteria changed elsewhere. Reload to see the saved values. Your edits here aren't saved.")
    expect(view.match()).toHaveValue("90")
    await view.user.click(within(alert).getByRole("button", { name: "Reload job criteria" }))
    await waitFor(() => expect(view.match()).toHaveValue("60"))
    expect(within(view.region).queryByRole("alert")).not.toBeInTheDocument()
  })

  it("loading Job criteria fails: the page shows the load error and retries", async () => {
    let fail = true
    const view = openWithCriteria("/settings")
    server.use(
      http.get(JOB_CRITERIA_PATH, () =>
        fail ? apiErrorResponse("bad_request") : HttpResponse.json({ ...defaultJobCriteria(), version: 1 })
      )
    )
    const retry = await screen.findByRole("button", { name: "Try again" })
    fail = false
    await view.user.click(retry)
    expect(await criteriaSection()).toBeVisible()
  })
})

describe("Job criteria: minimum core Match validation (AC 2.1, 2.2)", () => {
  it.each(["", "70.5", "0.7", "0", "-5", "101", "250", "seventy", "7O", "70%", "+70", "70.0", "7 0", "1e2", "000", "   "])(
    "refuses %j on Save, focuses the field and sends nothing",
    async (input) => {
      const view = await setup("/settings")
      await view.user.clear(view.match())
      if (input !== "") await view.user.type(view.match(), input)
      await view.user.click(view.save())

      expect(within(view.region).getByText(MATCH_ERROR)).toBeVisible()
      expect(view.match()).toHaveFocus()
      expect(view.putRequests()).toEqual([])
      expect(view.career.state.jobCriteria.minCoreMatchPercent).toBe(70)
    }
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
  ])("accepts %j and stores %i", async (input, stored) => {
    const view = await setup("/settings")
    await view.setMatch(input)
    await view.user.click(view.save())

    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria.minCoreMatchPercent).toBe(stored)
  })

  it("@ac-1.5 links the error to the field, marks it invalid, and clears it once the value is fixed", async () => {
    const view = await setup("/settings")
    await view.setMatch("101")
    await view.user.click(view.save())

    expect(view.match()).toHaveAttribute("aria-invalid", "true")
    expect(view.match()).toHaveAccessibleDescription(expect.stringContaining(MATCH_ERROR))
    await view.setMatch("100")
    expect(within(view.region).queryByText(MATCH_ERROR)).not.toBeInTheDocument()
    expect(view.match()).not.toHaveAttribute("aria-invalid")
  })
})

describe("Job criteria: list entries (AC 3.1 to 3.3)", () => {
  it.each([
    ["Rust!", "Frameworks"],
    ["Vue@3", "Frameworks"],
    ["React<script>", "Frameworks"],
    ["Go;", "Technologies"],
    ["Python (3)", "Technologies"],
    ["Elixir*", "Technologies"],
    // O3 (G2 Gherkin r9): allowed symbols only, but nothing left after normalisation
    [".", "Technologies"],
    ["-", "Technologies"],
    [" - ", "Technologies"],
    ["_", "Technologies"],
    ["./-", "Technologies"],
  ] as const)("refuses %j in %s with the characters error, keeping the text", async (entry, list) => {
    const view = await setup("/settings")
    await view.addEntry(list, entry)

    expect(within(view.region).getByText(CHARS_ERROR)).toBeVisible()
    expect(view.input(list)).toHaveAccessibleDescription(expect.stringContaining(CHARS_ERROR))
    expect(view.input(list)).toHaveValue(entry)
    expect(view.chips(list)).toHaveLength(0)
  })

  it.each([
    ["", "Frameworks"],
    ["", "Technologies"],
    ["   ", "Frameworks"],
    ["\t", "Technologies"],
  ] as const)("refuses the empty entry %j in %s", async (entry, list) => {
    const view = await setup("/settings")
    await view.user.click(view.input(list))
    await view.user.paste(entry)
    await view.user.click(within(view.region).getByRole("button", { name: `Add to ${list}` }))

    expect(within(view.region).getByText(EMPTY_ERROR)).toBeVisible()
    expect(view.chips(list)).toHaveLength(0)
  })

  it("accepts exactly 40 characters and refuses 41", async () => {
    const view = await setup("/settings")
    await view.addEntry("Technologies", "Amazon Web Services Elastic Beanstalk v23")
    expect(within(view.region).getByText(LONG_ERROR)).toBeVisible()
    expect(view.chips("Technologies")).toHaveLength(0)

    await view.addEntry("Technologies", "Amazon Web Services Elastic Beanstalk v2")
    expect(view.chipTexts("Technologies")).toEqual(["Amazon Web Services Elastic Beanstalk v2"])
    expect(within(view.region).queryByText(LONG_ERROR)).not.toBeInTheDocument()
  })

  it("measures an entry after trimming and saves the trimmed text", async () => {
    const view = await setup("/settings")
    await view.addEntry("Technologies", "   Amazon Web Services Elastic Beanstalk v2   ")
    await view.user.click(view.save())

    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria.technologies).toEqual(["Amazon Web Services Elastic Beanstalk v2"])
  })

  it.each([
    ["C#", "Technologies"],
    ["C++", "Technologies"],
    ["Node.js", "Technologies"],
    ["CI/CD", "Technologies"],
    ["Objective-C", "Technologies"],
    ["Ruby_on_Rails", "Frameworks"],
    ["Next.js 14", "Frameworks"],
    ["C", "Technologies"],
  ] as const)("accepts %j in %s and stores it", async (entry, list) => {
    const view = await setup("/settings")
    await view.addEntry(list, entry)
    await view.user.click(view.save())

    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria[LIST_NAMES[list]]).toEqual([entry])
  })

  it.each(["Frameworks", "Technologies"] as const)("%s holds up to 20 entries", async (list) => {
    const view = await setup("/settings", { criteria: { [LIST_NAMES[list]]: twenty("Tool").slice(0, 19) } })
    await view.addEntry(list, "Elixir")
    await view.user.click(view.save())

    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria[LIST_NAMES[list]]).toHaveLength(20)
  })

  it.each(["Frameworks", "Technologies"] as const)("%s refuses a 21st entry", async (list) => {
    const view = await setup("/settings", { criteria: { [LIST_NAMES[list]]: twenty("Tool") } })
    await view.addEntry(list, "Elixir")

    expect(within(view.region).getByText(FULL_ERROR)).toBeVisible()
    expect(view.chips(list)).toHaveLength(20)
    expect(view.input(list)).not.toBeDisabled()
  })

  it("each list has its own 20-entry limit", async () => {
    const view = await setup("/settings", { criteria: { frameworks: twenty("Fw"), technologies: twenty("Tech").slice(0, 19) } })
    await view.addEntry("Technologies", "Elixir")
    await view.user.click(view.save())

    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria.frameworks).toHaveLength(20)
    expect(view.career.state.jobCriteria.technologies).toHaveLength(20)
  })

  it.each([
    ["Frameworks", "React", "Technologies", "React.js"],
    ["Frameworks", "React", "Frameworks", "react"],
    ["Frameworks", "React", "Frameworks", "ReactJS"],
    ["Frameworks", "Vue", "Frameworks", "VueJS"],
    ["Frameworks", "Next.js", "Frameworks", "NextJS"],
    ["Frameworks", "Next.js", "Technologies", "Next"],
    ["Frameworks", "Nuxt", "Frameworks", "Nuxt.js"],
    ["Technologies", "Node.js", "Frameworks", "Node"],
    ["Frameworks", "Express", "Frameworks", "Express.js"],
    ["Technologies", "TypeScript", "Frameworks", "TS"],
    ["Technologies", "JavaScript", "Technologies", "ECMAScript"],
    ["Technologies", "Go", "Technologies", "Golang"],
    ["Technologies", "Postgres", "Technologies", "PostgreSQL"],
    ["Technologies", "Kubernetes", "Technologies", "K8s"],
    ["Frameworks", "Tailwind CSS", "Frameworks", "TailwindCSS"],
    ["Frameworks", "React Native", "Technologies", "RN"],
    ["Technologies", "GraphQL", "Technologies", "GQL"],
    ["Technologies", "AWS", "Technologies", "Amazon Web Services"],
    ["Technologies", "GCP", "Technologies", "Google Cloud Platform"],
    ["Technologies", "Ruby on Rails", "Frameworks", "Ruby-on-Rails"],
    ["Technologies", "TypeScript", "Technologies", "TYPESCRIPT"],
  ] as const)("with %s %j, refuses %s %j as Already in your list.", async (existingList, existing, newList, entry) => {
    const view = await setup("/settings", { criteria: { [LIST_NAMES[existingList]]: [existing] } })
    await view.addEntry(newList, entry)

    expect(within(view.region).getByText(DUP_ERROR)).toBeVisible()
    expect(view.chipTexts(newList)).not.toContain(entry)
  })

  it.each([
    ["Frameworks", "Angular", "AngularJS"],
    ["Technologies", "Java", "JavaScript"],
    ["Frameworks", "React", "React Native"],
    ["Technologies", "C", "C#"],
    ["Technologies", "C", "C++"],
    ["Technologies", "C#", "C++"],
  ] as const)("with %s %j, accepts the look-alike %j and saves it", async (list, existing, entry) => {
    const view = await setup("/settings", { criteria: { [LIST_NAMES[list]]: [existing] } })
    await view.addEntry(list, entry)
    await view.user.click(view.save())

    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria[LIST_NAMES[list]]).toEqual([existing, entry])
  })

  it("adds pending text on Save under the same rules, and blocks the save when it is invalid", async () => {
    const view = await setup("/settings")
    await view.user.type(view.input("Frameworks"), "Rust!")
    await view.user.click(view.save())
    expect(within(view.region).getByText(CHARS_ERROR)).toBeVisible()
    expect(view.input("Frameworks")).toHaveFocus()
    expect(view.putRequests()).toEqual([])

    await view.user.clear(view.input("Frameworks"))
    await view.user.type(view.input("Frameworks"), "Svelte")
    await view.user.click(view.save())
    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria.frameworks).toEqual(["Svelte"])
  })

  it("saving unchanged criteria twice shows Saved. after each save", async () => {
    const view = await setup("/settings", { criteria: { minCoreMatchPercent: 75, frameworks: ["React"] } })
    await view.user.click(view.save())
    await waitFor(() => expect(view.career.state.jobCriteria.version).toBe(2))
    await view.user.click(view.save())
    await waitFor(() => expect(view.career.state.jobCriteria.version).toBe(3))

    expect(await screen.findAllByText("Job criteria saved.")).not.toHaveLength(0)
    expect(view.putRequests().map((r) => r.body)).toEqual([
      { minCoreMatchPercent: 75, frameworks: ["React"], technologies: [], targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: "hide_entry_level" },
      { minCoreMatchPercent: 75, frameworks: ["React"], technologies: [], targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: "hide_entry_level" },
    ])
    expect(view.career.state.jobCriteria).toMatchObject({ minCoreMatchPercent: 75, frameworks: ["React"], technologies: [] })
  })
})

describe("Job criteria: server field errors (AC 3.7)", () => {
  it("marks the chip at the reported position and focuses its remove button", async () => {
    const view = await setup("/settings", { criteria: { frameworks: ["React"], technologies: ["Go", "React.js"] } })
    server.use(
      http.put(JOB_CRITERIA_PATH, () =>
        HttpResponse.json(
          { error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "technologies", position: 2, problem: "duplicate_entry" }] } },
          { status: 400 }
        )
      )
    )
    await view.user.click(view.save())

    const remove = within(view.region).getByRole("button", { name: "Remove React.js from Technologies" })
    await waitFor(() => expect(remove).toHaveFocus())
    expect(remove).toHaveAttribute("aria-invalid", "true")
    expect(remove).toHaveAccessibleDescription('"React.js" repeats another entry. Remove one to save.')
    expect(view.chipTexts("Technologies")).toEqual(["Go", "React.js"])
  })

  it("puts a server Match error under the Match field", async () => {
    const view = await setup("/settings")
    server.use(
      http.put(JOB_CRITERIA_PATH, () =>
        HttpResponse.json(
          { error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "minCoreMatchPercent", position: null, problem: "invalid" }] } },
          { status: 400 }
        )
      )
    )
    await view.user.click(view.save())

    await waitFor(() => expect(view.match()).toHaveFocus())
    expect(view.match()).toHaveAccessibleDescription(expect.stringContaining(MATCH_ERROR))
  })

  it("the fake API mirrors the real validation: a duplicate sent around the client check is refused at its position", async () => {
    const view = await setup("/settings")
    const response = await fetch(new URL(JOB_CRITERIA_PATH, window.location.origin), {
      method: "PUT",
      headers: { "content-type": "application/json", [CSRF_HEADER]: TEST_CSRF_TOKEN },
      body: JSON.stringify({ minCoreMatchPercent: 70, frameworks: ["Next.js", "Vue", "NextJS"], technologies: [], targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: "hide_entry_level" }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "frameworks", position: 3, problem: "duplicate_entry" }] },
    })
    expect(view.career.state.jobCriteria.version).toBe(1)
  })
})

describe("Job criteria: keyboard and screen reader (AC 1.5)", () => {
  it("every field is named by its visible label and focus moves Match, Frameworks, Technologies, Save changes", async () => {
    const view = await setup("/settings")
    const within_ = within(view.region)
    const expected = [
      view.match(),
      view.input("Frameworks"),
      within_.getByRole("button", { name: "Add to Frameworks" }),
      view.input("Technologies"),
      within_.getByRole("button", { name: "Add to Technologies" }),
      within_.getByRole("button", { name: "Save job criteria" }),
    ]
    view.match().focus()
    const visited: (Element | null)[] = [document.activeElement]
    for (let i = 1; i < expected.length; i++) {
      await view.user.tab()
      visited.push(document.activeElement)
    }
    // Each control was found by its role and accessible name above, so identity proves both order and naming.
    expect(visited).toEqual(expected)
    expect(view.match()).toHaveAccessibleName("Minimum core Match")
    expect(view.input("Frameworks")).toHaveAccessibleName("Frameworks")
    expect(view.input("Technologies")).toHaveAccessibleName("Technologies")
  })

  it("with entries saved, each chip's remove button sits in the order after its list's Add button", async () => {
    const view = await setup("/settings", { criteria: { frameworks: ["React"], technologies: ["Go"] } })
    const within_ = within(view.region)
    const expected = [
      view.match(),
      view.input("Frameworks"),
      within_.getByRole("button", { name: "Add to Frameworks" }),
      within_.getByRole("button", { name: "Remove React from Frameworks" }),
      view.input("Technologies"),
      within_.getByRole("button", { name: "Add to Technologies" }),
      within_.getByRole("button", { name: "Remove Go from Technologies" }),
      within_.getByRole("button", { name: "Save job criteria" }),
    ]
    view.match().focus()
    const visited: (Element | null)[] = [document.activeElement]
    for (let i = 1; i < expected.length; i++) {
      await view.user.tab()
      visited.push(document.activeElement)
    }
    expect(visited).toEqual(expected)
  })

  it("adds with Enter in each list and saves using only the keyboard", async () => {
    const view = await setup("/settings")
    await view.user.click(view.input("Frameworks"))
    await view.user.keyboard("React{Enter}")
    expect(view.input("Frameworks")).toHaveFocus()
    expect(view.input("Frameworks")).toHaveValue("")
    expect(await screen.findByText("Added React to Frameworks. 1 of 20.")).toBeInTheDocument()
    await view.user.tab()
    await view.user.tab()
    await view.user.tab()
    expect(view.input("Technologies")).toHaveFocus()
    await view.user.keyboard("Go{Enter}")
    await view.user.tab()
    await view.user.tab()
    await view.user.tab()
    expect(view.save()).toHaveFocus()
    await view.user.keyboard("{Enter}")

    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria).toMatchObject({ frameworks: ["React"], technologies: ["Go"] })
  })

  it("removes an entry from the keyboard and keeps focus inside the Frameworks field", async () => {
    const view = await setup("/settings", { criteria: { frameworks: ["React", "Vue"] } })
    within(view.region).getByRole("button", { name: "Remove Vue from Frameworks" }).focus()
    await view.user.keyboard("{Enter}")

    expect(view.chipTexts("Frameworks")).toEqual(["React"])
    await waitFor(() => expect(within(view.region).getByRole("button", { name: "Remove React from Frameworks" })).toHaveFocus())
    expect(screen.getByText("Removed Vue from Frameworks. 1 of 20.")).toBeInTheDocument()
  })

  it("Backspace in an empty input moves to the last chip without deleting; Escape clears the entry error", async () => {
    const view = await setup("/settings", { criteria: { frameworks: ["React", "Vue"] } })
    await view.user.click(view.input("Frameworks"))
    await view.user.keyboard("{Backspace}")
    expect(within(view.region).getByRole("button", { name: "Remove Vue from Frameworks" })).toHaveFocus()
    expect(view.chips("Frameworks")).toHaveLength(2)

    await view.user.click(view.input("Frameworks"))
    await view.user.keyboard("Rust!{Enter}")
    expect(within(view.region).getByRole("alert")).toHaveTextContent(CHARS_ERROR)
    await view.user.keyboard("{Escape}")
    expect(within(view.region).queryByText(CHARS_ERROR)).not.toBeInTheDocument()
    expect(view.input("Frameworks")).toHaveValue("Rust!")
  })

  it("the entry error is announced as an alert linked to its input", async () => {
    const view = await setup("/settings")
    await view.addEntry("Frameworks", "Rust!")

    expect(within(view.region).getByRole("alert")).toHaveTextContent(CHARS_ERROR)
    expect(view.input("Frameworks")).toHaveAttribute("aria-invalid", "true")
  })
})

describe("Job criteria: signed-out visitor (AC 1.1)", () => {
  it("a visitor who is not signed in opening /settings#job-criteria is sent to sign-in and sees no criteria", async () => {
    // No session handler installed: the default handlers answer 401 unauthenticated.
    const { currentPath } = renderApp("/settings#job-criteria")

    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeVisible()
    expect(currentPath()).toBe(`/sign-in?${new URLSearchParams({ next: "/settings#job-criteria" }).toString()}`)
    expect(screen.queryByRole("region", { name: "Job criteria" })).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Minimum core Match")).not.toBeInTheDocument()
  })
})

describe("Settings hash links move focus to the section heading (design-spec J5 step 5)", () => {
  it.each([
    ["#job-criteria", "Job criteria"],
    ["#contact", "Contact details"],
  ])("/settings%s focuses the %s heading without scrolling again, once the data has loaded", async (hash, title) => {
    const scrolls: Element[] = []
    const focusOptions: (FocusOptions | undefined)[] = []
    const scrollIntoView = Element.prototype.scrollIntoView
    const focus = HTMLElement.prototype.focus
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolls.push(this)
    }
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
      if (this.tagName === "H2") focusOptions.push(options)
      return focus.call(this, options)
    }
    try {
      openWithCriteria(`/settings${hash}`)
      const heading = await screen.findByRole("heading", { level: 2, name: title })
      await waitFor(() => expect(heading).toHaveFocus())
      expect(heading).toHaveAttribute("tabindex", "-1")
      expect(focusOptions).toEqual([{ preventScroll: true }])
      expect(scrolls).toEqual([document.getElementById(hash.slice(1))])
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView
      HTMLElement.prototype.focus = focus
    }
  })

  it("a section whose heading isn't focusable is scrolled to but focus stays put (#advanced)", async () => {
    openWithCriteria("/settings#advanced")
    await screen.findByRole("heading", { level: 2, name: "Advanced: automatic applying" })
    await criteriaSection()
    expect(document.activeElement).toBe(document.body)
  })

  it("without a hash, nothing is focused", async () => {
    openWithCriteria("/settings")
    await criteriaSection()
    expect(document.activeElement).toBe(document.body)
  })
})

describe("Job criteria: the UI never says Filters (AC 7.3)", () => {
  it("Settings has no Filters wording", async () => {
    await setup("/settings")
    expect(document.body).not.toHaveTextContent(/filters/i)
  })
})
