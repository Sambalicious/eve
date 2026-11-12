import { act, screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import {
  EXISTING_APPLICATIONS_COMPLETE_PATH,
  EXISTING_APPLICATIONS_PATH,
} from "@eve/contracts"
import { describe, expect, it } from "vitest"

import {
  apiErrorResponse,
  existingApplication,
  server,
  submissionStatus,
} from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { openSubmission } from "./submission-helpers"

type User = ReturnType<typeof openSubmission>["user"]

const C_EXIST_1 = "No existing applications recorded"
const C_EXIST_8 =
  "Not marked complete. Automatic submission stays off until you mark it."
const C_CONFIRM_2 = "Mark existing applications complete?"

/** Opens `/existing-applications` with these records; `completedAt` null means the step is incomplete. */
function openPage(
  existing: ReturnType<typeof existingApplication>[] = [],
  completedAt: string | null = null
) {
  return openSubmission("/existing-applications", [], {
    status: submissionStatus({ existingApplicationsCompletedAt: completedAt }),
    existing,
  })
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]
const ORDINAL = (d: number) =>
  d % 10 === 1 && d !== 11
    ? "st"
    : d % 10 === 2 && d !== 12
      ? "nd"
      : d % 10 === 3 && d !== 13
        ? "rd"
        : "th"

/** Picks `YYYY-MM-DD` in the "Date applied" calendar popover. */
async function pickDate(user: User, value: string) {
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ]
  await user.click(screen.getByRole("button", { name: /^Date applied/ }))
  const form = screen.queryByRole("dialog", { name: "Add existing application" })
  const dialog = (await screen.findAllByRole("dialog")).find((d) => d !== form)!
  if (!dialog) throw new Error("the calendar did not open")
  await user.selectOptions(
    within(dialog).getByRole("combobox", { name: "Choose the Year" }),
    String(year)
  )
  await user.selectOptions(
    within(dialog).getByRole("combobox", { name: "Choose the Month" }),
    String(month - 1)
  )
  const weekday = new Date(year, month - 1, day).toLocaleDateString("en-US", {
    weekday: "long",
  })
  await user.click(
    within(dialog).getByRole("button", {
      name: new RegExp(
        `^${weekday}, ${MONTHS[month - 1]} ${day}${ORDINAL(day)}, ${year}`
      ),
    })
  )
  await waitFor(() =>
    expect(screen.queryByRole("combobox", { name: "Choose the Year" })).not.toBeInTheDocument()
  )
}

interface Entry {
  company?: string
  roleTitle?: string
  applicationUrl?: string
  requisitionId?: string
  appliedOn?: string
}

async function fillForm(user: User, entry: Entry) {
  const form = await openAddDialog(user)
  const type = async (label: string, value?: string) => {
    if (value) await user.type(within(form).getByLabelText(label), value)
  }
  await type("Company", entry.company)
  await type("Role", entry.roleTitle)
  await type("Employer application URL", entry.applicationUrl)
  await type("Requisition ID (optional)", entry.requisitionId)
  if (entry.appliedOn) await pickDate(user, entry.appliedOn)
}

/** The form lives in the add dialog at every width: open it unless it is already open. */
async function openAddDialog(user: User): Promise<HTMLElement> {
  const open = screen.queryByRole("dialog", { name: "Add existing application" })
  if (open) return open
  await user.click(screen.getByRole("button", { name: "Add existing application" }))
  return await screen.findByRole("dialog", { name: "Add existing application" })
}

async function submit(user: User) {
  const form = screen.getByRole("dialog", { name: "Add existing application" })
  await user.click(
    within(form).getByRole("button", { name: "Add existing application" })
  )
}

const globex: Entry = {
  company: "Globex",
  roleTitle: "Frontend Lead",
  applicationUrl: "https://jobs.lever.co/globex/abc-123",
  requisitionId: "L-77",
  appliedOn: "2026-09-30",
}

function tableRows() {
  const table = screen.getByRole("table")
  return within(table).getAllByRole("row").slice(1)
}

describe("Existing applications (/existing-applications, F1 step 6a)", () => {
  it("opens at /existing-applications (reached from Home's Improve your results and Settings): title, description and document title (C-EXIST-4)", async () => {
    const { currentPath } = openPage()
    expect(currentPath()).toBe("/existing-applications")
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Existing applications",
      })
    ).toBeVisible()
    expect(
      screen.getByText(
        "Jobs you applied to before Eve, so it never applies to them twice."
      )
    ).toBeVisible()
    expect(document.title).toBe("Existing applications · Eve")
  })

  it("@ac-1.6 a new installation shows C-EXIST-1 and can mark the step complete with zero applications", async () => {
    const { user, api } = openPage()
    expect(await screen.findByText(C_EXIST_1)).toBeVisible()
    expect(
      screen.getByText(
        "Add every role you've already applied to so the assistant doesn't apply twice. If there are none, mark this step complete."
      )
    ).toBeVisible()
    expect(screen.getByText(C_EXIST_8)).toBeVisible()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Mark this step complete" })
    )
    const dialog = await screen.findByRole("alertdialog", { name: C_CONFIRM_2 })
    await user.click(
      within(dialog).getByRole("button", { name: "Mark complete" })
    )
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    )
    expect(
      await screen.findByText("Marked complete on 20 Oct 2026.")
    ).toBeVisible()
    expect(
      api.requests.filter((r) => r.path === EXISTING_APPLICATIONS_COMPLETE_PATH)
    ).toHaveLength(1)
  })

  it("@ac-1.6 records one existing application: toast, the dialog closes, focus returns to the opener, row at the bottom", async () => {
    const earlier = existingApplication({
      company: "Initech",
      roleTitle: "Fullstack Engineer",
      applicationUrl: "https://x.test/1",
      requisitionId: null,
      appliedOn: "2026-08-01",
    })
    const { user, api } = openPage([earlier])
    await screen.findByRole("table")
    await fillForm(user, globex)
    await submit(user)

    expect(await findToast("Existing application added.")).not.toBeNull()
    expect(
      within(screen.getByRole("region", { name: "Messages" })).getByText(
        "Existing application added."
      )
    ).toBeInTheDocument()
    const rows = await waitFor(() => {
      const r = tableRows()
      expect(r).toHaveLength(2)
      return r
    })
    const cells = within(rows[1])
      .getAllByRole("cell")
      .map((c) => c.textContent)
    expect(cells).toEqual([
      "Globex",
      "Frontend Lead",
      "https://jobs.lever.co/globex/abc-123",
      "L-77",
      "30 Sep 2026",
    ])
    expect(within(rows[1]).queryByRole("link")).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add existing application" })).not.toBeInTheDocument()
    )
    await waitFor(() => expect(screen.getByRole("button", { name: "Add existing application" })).toHaveFocus())
    const posted = api.requests.find(
      (r) => r.method === "POST" && r.path === EXISTING_APPLICATIONS_PATH
    )
    expect(posted?.body).toEqual({
      company: "Globex",
      roleTitle: "Frontend Lead",
      applicationUrl: "https://jobs.lever.co/globex/abc-123",
      requisitionId: "L-77",
      appliedOn: "2026-09-30",
    })
  })

  it("@ac-1.6 records one without a requisition ID: sent as null, shown as None (C-EXIST-7)", async () => {
    const { user, api } = openPage()
    await screen.findByText(C_EXIST_1)
    await fillForm(user, {
      company: "Hooli",
      roleTitle: "Senior Frontend Engineer",
      applicationUrl: "https://jobs.ashbyhq.com/hooli/77ab",
      appliedOn: "2026-10-01",
    })
    await submit(user)

    const row = await screen.findByRole("row", { name: /Hooli/ })
    expect(within(row).getAllByRole("cell")[3]).toHaveTextContent("None")
    expect(within(row).getAllByRole("cell")[4]).toHaveTextContent("1 Oct 2026")
    expect(
      api.requests.find(
        (r) => r.method === "POST" && r.path === EXISTING_APPLICATIONS_PATH
      )?.body
    ).toMatchObject({ requisitionId: null })
  })

  it("the fields have their exact names, C-EXIST-6 is the requisition help, and the table has its column headers", async () => {
    const { user } = openPage([existingApplication()])
    await screen.findByRole("table")
    expect(
      within(screen.getByRole("table"))
        .getAllByRole("columnheader")
        .map((h) => h.textContent)
    ).toEqual([
      "Company",
      "Role",
      "Employer application URL",
      "Requisition ID",
      "Date applied",
    ])
    await openAddDialog(user)
    for (const name of [
      "Company",
      "Role",
      "Employer application URL",
      "Requisition ID (optional)",
    ])
      expect(screen.getByRole("textbox", { name })).toBeVisible()
    expect(screen.getByRole("button", { name: "Date applied" })).toBeVisible()
    expect(
      screen.getByRole("textbox", { name: "Requisition ID (optional)" })
    ).toHaveAccessibleDescription(
      "Leave it empty if the posting didn't show one."
    )
  })

  it("@ac-1.6 marks the step complete with recorded applications: C-CONFIRM-2, pending label, then C-EXIST-2 and no button", async () => {
    const { user, api } = openPage([
      existingApplication(),
      existingApplication({
        applicationUrl: "https://x.test/2",
        requisitionId: "X-2",
      }),
    ])
    api.state.existingCompletesAt = "2026-10-17T09:00:00.000Z"
    let release: () => void = () => undefined
    server.use(
      http.post(EXISTING_APPLICATIONS_COMPLETE_PATH, async () => {
        await new Promise<void>((resolve) => (release = resolve))
        // Falls through to the fake's own handler, which records the completion.
        return undefined
      })
    )
    await user.click(
      await screen.findByRole("button", { name: "Mark this step complete" })
    )
    const dialog = await screen.findByRole("alertdialog", { name: C_CONFIRM_2 })
    expect(
      within(dialog).getByText(
        "This is needed before automatic submission can be turned on. You can still add more later."
      )
    ).toBeVisible()
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Cancel" })
      ).toHaveFocus()
    )
    await user.click(
      within(dialog).getByRole("button", { name: "Mark complete" })
    )
    expect(
      await within(dialog).findByRole("button", { name: "Marking complete…" })
    ).toBeInTheDocument()
    act(() => release())

    expect(
      await screen.findByText("Marked complete on 17 Oct 2026.")
    ).toBeVisible()
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    )
    expect(
      screen.queryByRole("button", { name: "Mark this step complete" })
    ).not.toBeInTheDocument()
    expect(screen.queryByText(C_EXIST_8)).not.toBeInTheDocument()
  })

  it("@ac-1.6 more can be added after the step is complete, and the status line stays", async () => {
    const { user } = openPage(
      [existingApplication()],
      "2026-10-17T09:00:00.000Z"
    )
    expect(
      await screen.findByText("Marked complete on 17 Oct 2026.")
    ).toBeVisible()
    await fillForm(user, {
      company: "Initech",
      roleTitle: "Fullstack Engineer",
      applicationUrl: "https://boards.greenhouse.io/initech/jobs/998",
      requisitionId: "I-998",
      appliedOn: "2026-10-02",
    })
    await submit(user)
    expect(await screen.findByRole("row", { name: /Initech/ })).toBeVisible()
    expect(screen.getByText("Marked complete on 17 Oct 2026.")).toBeVisible()
  })

  it.each([
    [
      "company",
      { ...globex, company: undefined },
      "Enter the company.",
      "Company",
    ],
    ["role", { ...globex, roleTitle: undefined }, "Enter the role.", "Role"],
    [
      "employer application URL",
      { ...globex, applicationUrl: undefined },
      "Enter the employer application URL.",
      "Employer application URL",
    ],
    [
      "date applied",
      { ...globex, appliedOn: undefined },
      "Enter the date you applied.",
      "Date applied",
    ],
  ])(
    "@validation %s left empty shows C-VAL-EXIST-1, focuses the field and records nothing",
    async (_field, entry, error, label) => {
      const { user, api } = openPage()
      await screen.findByText(C_EXIST_1)
      await fillForm(user, entry)
      await submit(user)

      const field = screen.getByRole(
        label === "Date applied" ? "button" : "textbox",
        { name: label }
      )
      expect(await screen.findByText(error)).toBeVisible()
      expect(screen.getByRole("alert")).toHaveTextContent(error)
      expect(field).toHaveAttribute("aria-invalid", "true")
      expect(field).toHaveAccessibleDescription(error)
      await waitFor(() => expect(field).toHaveFocus())
      expect(api.requests.filter((r) => r.method === "POST")).toEqual([])
      expect(api.state.existing).toEqual([])
      expect(screen.getByText(C_EXIST_1)).toBeVisible()
    }
  )

  it("only the first empty field shows its error, in the contract's order", async () => {
    const { user } = openPage()
    await screen.findByText(C_EXIST_1)
    await openAddDialog(user)
    await submit(user)
    expect(await screen.findByText("Enter the company.")).toBeVisible()
    expect(screen.queryByText("Enter the role.")).not.toBeInTheDocument()
  })

  it("a URL that isn't absolute http(s) shows C-VAL-EXIST-2 under it before any request", async () => {
    const { user, api } = openPage()
    await screen.findByText(C_EXIST_1)
    await fillForm(user, { ...globex, applicationUrl: "jobs.lever.co/globex" })
    await submit(user)
    const url = screen.getByRole("textbox", {
      name: "Employer application URL",
    })
    expect(
      await screen.findByText(
        "Enter a full link that starts with https:// or http://."
      )
    ).toBeVisible()
    expect(url).toHaveAttribute("aria-invalid", "true")
    expect(api.requests.filter((r) => r.method === "POST")).toEqual([])
  })

  it("a backend 422 shows its field's C-VAL-EXIST-1 and keeps the values", async () => {
    const { user } = openPage()
    await screen.findByText(C_EXIST_1)
    server.use(
      http.post(EXISTING_APPLICATIONS_PATH, () =>
        apiErrorResponse("existing_application_role_empty")
      )
    )
    await fillForm(user, globex)
    await submit(user)
    expect(await screen.findByText("Enter the role.")).toBeVisible()
    expect(screen.getByRole("textbox", { name: "Role" })).toHaveAttribute(
      "aria-invalid",
      "true"
    )
    expect(screen.getByRole("textbox", { name: "Company" })).toHaveValue(
      "Globex"
    )
  })

  it("a backend 400 shows C-VAL-EXIST-2's field-unknown line above the button and keeps the values", async () => {
    const { user } = openPage()
    await screen.findByText(C_EXIST_1)
    server.use(
      http.post(EXISTING_APPLICATIONS_PATH, () =>
        apiErrorResponse("bad_request")
      )
    )
    await fillForm(user, globex)
    await submit(user)
    expect(
      await screen.findByText(
        "Check the employer application URL and the date applied."
      )
    ).toBeVisible()
    expect(
      screen.getByRole("textbox", { name: "Employer application URL" })
    ).toHaveValue("https://jobs.lever.co/globex/abc-123")
  })

  it("@duplicate recording the same application twice keeps one record: C-EXIST-3, values kept, View it highlights the row for 2 s", async () => {
    const stored = existingApplication()
    const { user, api } = openPage([stored])
    await screen.findByRole("table")
    await fillForm(user, globex)
    await submit(user)

    const notice = await screen.findByText(
      /^You already recorded this application: Frontend Lead at Globex, applied 30 Sep 2026\. Nothing new was added\./
    )
    expect(notice.closest('[role="status"]')).not.toBeNull()
    expect(
      screen.queryByText("Existing application added.")
    ).not.toBeInTheDocument()
    expect(api.state.existing).toHaveLength(1)
    expect(screen.getByRole("textbox", { name: "Company" })).toHaveValue(
      "Globex"
    )

    await user.click(screen.getByRole("button", { name: "View it" }))
    expect(tableRows()).toHaveLength(1)
    const row = tableRows()[0]
    expect(row).toHaveAttribute("data-highlighted", "true")
    expect(row).toHaveFocus()
    await waitFor(() => expect(row).not.toHaveAttribute("data-highlighted"), {
      timeout: 3500,
    })
  })

  it("a page load failure shows C-ERR-1 with Try again", async () => {
    const { user, api } = openPage()
    server.use(
      http.get(EXISTING_APPLICATIONS_PATH, () =>
        apiErrorResponse("internal_error")
      )
    )
    expect(
      await screen.findByText("Couldn't load this page.", {}, { timeout: 8000 })
    ).toBeVisible()
    server.use(...api.handlers)
    await user.click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByText(C_EXIST_1)).toBeVisible()
  })

  it("an add that fails on the server shows C-ERR-2 and keeps the values", async () => {
    const { user } = openPage()
    await screen.findByText(C_EXIST_1)
    server.use(
      http.post(EXISTING_APPLICATIONS_PATH, () =>
        apiErrorResponse("internal_error")
      )
    )
    await fillForm(user, globex)
    await submit(user)
    expect(
      await findToast(
        "Couldn't add this application. Nothing changed. Try again."
      )
    ).not.toBeNull()
    expect(screen.getByRole("textbox", { name: "Company" })).toHaveValue(
      "Globex"
    )
  })

  it("a completion that fails shows C-ERR-2 and the dialog stays open", async () => {
    const { user } = openPage()
    await screen.findByText(C_EXIST_1)
    server.use(
      http.post(EXISTING_APPLICATIONS_COMPLETE_PATH, () => HttpResponse.error())
    )
    await user.click(
      screen.getByRole("button", { name: "Mark this step complete" })
    )
    const dialog = await screen.findByRole("alertdialog", { name: C_CONFIRM_2 })
    await user.click(
      within(dialog).getByRole("button", { name: "Mark complete" })
    )
    expect(
      await findToast(
        "Couldn't mark this step complete. Nothing changed. Try again."
      )
    ).not.toBeNull()
    expect(screen.getByRole("alertdialog", { name: C_CONFIRM_2 })).toBeVisible()
  })

  it("completing the step updates the Activation Gate row: the link goes and the check shows", async () => {
    const { user } = openPage()
    await screen.findByText(C_EXIST_1)
    await user.click(
      screen.getByRole("button", { name: "Mark this step complete" })
    )
    await user.click(
      within(
        await screen.findByRole("alertdialog", { name: C_CONFIRM_2 })
      ).getByRole("button", { name: "Mark complete" })
    )
    await screen.findByText("Marked complete on 20 Oct 2026.")
    await user.click(screen.getByRole("link", { name: "Check first sends" }))
    const label = await screen.findByText("Jobs you've already applied to")
    expect(label.closest("a")).toBeNull()
    expect(
      label.closest("li")?.querySelector('[aria-label="Done"]')
    ).not.toBeNull()
  })

  it("DR-EA-01: one filled primary per view; the inline submit is outline until the step is complete", async () => {
    const filled = () =>
      screen
        .getAllByRole("button")
        .filter(
          (b) =>
            b.getAttribute("data-slot") === "button" &&
            /(^|\s)bg-primary(\s|$)/.test(b.className)
        )
        .map((b) => b.textContent)
    const { user } = openPage()
    await screen.findByText(C_EXIST_1)
    expect(filled()).toEqual(["Mark this step complete"])

    await user.click(
      screen.getByRole("button", { name: "Mark this step complete" })
    )
    await user.click(
      within(
        await screen.findByRole("alertdialog", { name: C_CONFIRM_2 })
      ).getByRole("button", { name: "Mark complete" })
    )
    await screen.findByText("Marked complete on 20 Oct 2026.")
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    )
    await openAddDialog(user)
    expect(filled()).toEqual(["Add existing application"])
  })

  it("worst case: a long URL and long names render whole, with no truncation", async () => {
    const longUrl = `https://boards.greenhouse.io/${"a".repeat(300)}/jobs/1`
    const longCompany =
      "International Business Machines Corporation Global Services Division "
        .repeat(3)
        .trim()
    openPage([
      existingApplication({ company: longCompany, applicationUrl: longUrl }),
    ])
    const row = (await screen.findAllByRole("row"))[1]
    expect(within(row).getByText(longCompany)).toBeInTheDocument()
    expect(within(row).getByText(longUrl)).toHaveClass("break-all")
  })
})

describe("The add form in a modal", () => {
  it(
    "opens a modal titled C-EXIST-5; it closes on success and focus returns to the opener",
    { timeout: 20000 },
    async () => {
      const { user } = openPage()
      await screen.findByText(C_EXIST_1)
      expect(
        screen.queryByRole("region", { name: "Add existing application" })
      ).not.toBeInTheDocument()
      const opener = screen.getByRole("button", {
        name: "Add existing application",
      })
      await user.click(opener)
      const sheet = await screen.findByRole("dialog", {
        name: "Add existing application",
      })
      await user.type(
        within(sheet).getByRole("textbox", { name: "Company" }),
        "Globex"
      )
      await user.type(
        within(sheet).getByRole("textbox", { name: "Role" }),
        "Frontend Lead"
      )
      await user.type(
        within(sheet).getByRole("textbox", {
          name: "Employer application URL",
        }),
        "https://jobs.lever.co/globex/abc-123"
      )
      await user.click(
        within(sheet).getByRole("button", { name: "Date applied" })
      )
      const calendar = (await screen.findAllByRole("dialog")).find(
        (d) => d !== sheet
      ) as HTMLElement
      await user.selectOptions(
        within(calendar).getByRole("combobox", { name: "Choose the Year" }),
        "2026"
      )
      await user.selectOptions(
        within(calendar).getByRole("combobox", { name: "Choose the Month" }),
        "8"
      )
      await user.click(
        within(calendar).getByRole("button", {
          name: /^Wednesday, September 30th, 2026/,
        })
      )
      await user.click(
        within(sheet).getByRole("button", { name: "Add existing application" })
      )

      expect(await findToast("Existing application added.")).not.toBeNull()
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Add existing application" })
        ).not.toBeInTheDocument()
      )
      expect(
        await screen.findByRole("row", { name: /Frontend Lead/ })
      ).toBeInTheDocument()
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Add existing application" })
        ).toHaveFocus()
      )
    }
  )

  it("stays open on a refusal and keeps the values", async () => {
    const { user } = openPage()
    await screen.findByText(C_EXIST_1)
    await user.click(
      screen.getByRole("button", { name: "Add existing application" })
    )
    const sheet = await screen.findByRole("dialog", {
      name: "Add existing application",
    })
    await user.type(
      within(sheet).getByRole("textbox", { name: "Company" }),
      "Globex"
    )
    await user.click(
      within(sheet).getByRole("button", { name: "Add existing application" })
    )
    expect(await within(sheet).findByText("Enter the role.")).toBeVisible()
    expect(within(sheet).getByRole("textbox", { name: "Company" })).toHaveValue(
      "Globex"
    )
  })
})
