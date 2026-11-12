import type { ApprovedAnswer } from "@eve/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, server } from "@/shared/testing"
import { confirmDialog, findDialog, findToast, openSignedIn } from "./career-setup-helpers"

const UPDATED = "2026-10-17T09:00:00.000Z"
const answer = (patch: Partial<ApprovedAnswer> & Pick<ApprovedAnswer, "group">): ApprovedAnswer =>
  ({ id: "11111111-1111-4111-8111-111111111111", value: "4 weeks", updatedAt: UPDATED, ...patch }) as ApprovedAnswer

function section(name: string) {
  return screen.getByRole("region", { name })
}

/**
 * The section once the page is reachable again. After "Save answer" the sheet
 * closes, and until it has, the dialog keeps the page `aria-hidden`, so the
 * section is not yet in the accessibility tree.
 */
function findSection(name: string) {
  return screen.findByRole("region", { name })
}

async function openSheetFor(user: ReturnType<typeof import("@testing-library/user-event").default.setup>, group: string) {
  await user.click(await screen.findByRole("button", { name: `Add answer, ${group}` }))
  return screen.findByRole("dialog")
}

describe("Approved Answers (career-profile.feature, @ac-1.3)", () => {
  it("@empty-state A new installation has no Approved Answers", async () => {
    openSignedIn("/answers")

    expect(await screen.findByRole("heading", { name: "No Approved Answers yet" })).toBeVisible()
    expect(
      screen.getByText("A required question without an Approved Answer blocks the Application. Add the ones you know now.")
    ).toBeVisible()
    for (const name of ["Standard", "Salary", "Sensitive", "Custom questions"]) {
      expect(section(name)).toBeVisible()
    }
  })

  describe("@happy Creating a standard Approved Answer", () => {
    it.each([
      ["Notice period", "notice_period", "4 weeks"],
      ["Profile links", "profile_links", "https://github.com/ada-okafor"],
    ])("stores %s exactly as entered", async (label, topic, value) => {
      const { user, api } = openSignedIn("/answers")

      const sheet = await openSheetFor(user, "Standard")
      await user.selectOptions(within(sheet).getByRole("combobox", { name: "Topic" }), label)
      await user.type(within(sheet).getByRole("textbox", { name: /Answer/ }), value)
      await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

      expect(await findToast("Saved.")).toBeVisible()
      expect(api.requestsTo("POST", "/v1/approved-answers")[0].body).toEqual({ group: "standard", topic, value })
      const row = within(section("Standard")).getByText(value).closest("li") as HTMLElement
      expect(row).toHaveTextContent(label)
      expect(row).toHaveTextContent("Last edited 18 Oct 2026")
    })

    it("stores relocation willingness as the chosen C-ANS-10 option label", async () => {
      const { user, api } = openSignedIn("/answers")

      const sheet = await openSheetFor(user, "Standard")
      await user.selectOptions(within(sheet).getByRole("combobox", { name: "Topic" }), "Relocation willingness")
      const group = within(sheet).getByRole("radiogroup", { name: /Are you willing to relocate\?/ })
      expect(within(group).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual([
        "Yes, with employer visa sponsorship",
        "No",
      ])
      await user.click(within(group).getByRole("radio", { name: "Yes, with employer visa sponsorship" }))
      await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

      await findToast("Saved.")
      expect(api.requestsTo("POST", "/v1/approved-answers")[0].body).toEqual({
        group: "standard",
        topic: "relocation_willingness",
        value: "Yes, with employer visa sponsorship",
      })
    })

    it("asks for a relocation choice before sending", async () => {
      const { user, api } = openSignedIn("/answers")

      const sheet = await openSheetFor(user, "Standard")
      await user.selectOptions(within(sheet).getByRole("combobox", { name: "Topic" }), "Relocation willingness")
      await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

      expect(within(sheet).getByText("Enter an answer.")).toBeVisible()
      expect(api.requests).toEqual([])
    })

    it("stores profile links one per line, with C-ANS-9 help, and refuses a line that isn't a link (C-VAL-ANS-4)", async () => {
      const { user, api } = openSignedIn("/answers")

      const sheet = await openSheetFor(user, "Standard")
      await user.selectOptions(within(sheet).getByRole("combobox", { name: "Topic" }), "Profile links")
      const field = within(sheet).getByRole("textbox", { name: /Answer/ })
      expect(field).toHaveAccessibleDescription("One link per line, for example your GitHub and LinkedIn.")
      await user.type(field, "https://github.com/ada-okafor{Enter}linkedin.com/in/ada-okafor")
      await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

      expect(within(sheet).getByText("Enter each link on its own line, starting with https:// or http://.")).toBeVisible()
      expect(api.requests).toEqual([])

      await user.clear(field)
      await user.type(field, "  https://github.com/ada-okafor  {Enter}{Enter}https://www.linkedin.com/in/ada-okafor")
      await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

      await findToast("Saved.")
      expect(api.requestsTo("POST", "/v1/approved-answers")[0].body).toEqual({
        group: "standard",
        topic: "profile_links",
        value: "https://github.com/ada-okafor\nhttps://www.linkedin.com/in/ada-okafor",
      })
    })

    it("asks for the skill name with C-VAL-ANS-3", async () => {
      const { user, api } = openSignedIn("/answers")

      const sheet = await openSheetFor(user, "Standard")
      await user.selectOptions(within(sheet).getByRole("combobox", { name: "Topic" }), "Skill years")
      await user.type(within(sheet).getByRole("spinbutton", { name: /Answer/ }), "7")
      await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

      expect(within(sheet).getByText("Enter the skill.")).toBeVisible()
      expect(api.requests).toEqual([])
    })

    it("stores a start date from the date field", async () => {
      const { user, api } = openSignedIn("/answers")

      const sheet = await openSheetFor(user, "Standard")
      await user.selectOptions(within(sheet).getByRole("combobox", { name: "Topic" }), "Start date")
      await user.type(within(sheet).getByLabelText(/Answer/), "2026-12-01")
      await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

      await findToast("Saved.")
      expect(api.state.answers).toMatchObject([{ group: "standard", topic: "start_date", value: "2026-12-01" }])
    })

    it("stores skill years for a named skill", async () => {
      const { user, api } = openSignedIn("/answers")

      const sheet = await openSheetFor(user, "Standard")
      await user.selectOptions(within(sheet).getByRole("combobox", { name: "Topic" }), "Skill years")
      await user.type(within(sheet).getByRole("textbox", { name: /Skill/ }), "React")
      await user.type(within(sheet).getByRole("spinbutton", { name: /Answer/ }), "7")
      await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

      expect(await within(await findSection("Standard")).findByText("Skill years: React")).toBeVisible()
      expect(api.requestsTo("POST", "/v1/approved-answers")[0].body).toEqual({
        group: "standard",
        topic: "skill_years",
        skill: "React",
        value: "7",
      })
    })
  })

  describe("@happy Creating a sensitive-question Approved Answer", () => {
    it.each([
      ["Demographic", "demographic", "Black or African"],
      ["Disability", "disability", "I do not wish to answer"],
      ["Veteran status", "veteran_status", "I am not a veteran"],
    ])("stores %s exactly as entered", async (label, topic, value) => {
      const { user, api } = openSignedIn("/answers")

      const sheet = await openSheetFor(user, "Sensitive")
      expect(sheet).toHaveTextContent(
        "Used only where a form asks. If a sensitive question has no answer here, the Application is blocked. Nothing is inferred."
      )
      await user.selectOptions(within(sheet).getByRole("combobox", { name: "Topic" }), label)
      await user.type(within(sheet).getByRole("textbox", { name: /Answer/ }), value)
      await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

      expect(await within(await findSection("Sensitive")).findByText(value)).toBeVisible()
      expect(api.state.answers).toMatchObject([{ group: "sensitive", topic, value }])
    })
  })

  it("creates a custom question answer with the question as the form asks it", async () => {
    const { user, api } = openSignedIn("/answers")

    const sheet = await openSheetFor(user, "Custom questions")
    await user.type(within(sheet).getByRole("textbox", { name: /Question/ }), "Why do you want to work at Acme?")
    await user.type(within(sheet).getByRole("textbox", { name: /Answer/ }), "Payments infrastructure at scale")
    await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

    expect(await within(await findSection("Custom questions")).findByText("Why do you want to work at Acme?")).toBeVisible()
    expect(api.state.answers).toMatchObject([{ group: "custom", question: "Why do you want to work at Acme?" }])
  })

  describe("validation", () => {
    it("C-VAL-ANS-1 and C-VAL-ANS-2 inline, focus on the first invalid field, nothing sent", async () => {
      const { user, api } = openSignedIn("/answers")

      const sheet = await openSheetFor(user, "Custom questions")
      await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

      expect(within(sheet).getByText("Enter the question as the form asks it.")).toBeVisible()
      expect(within(sheet).getByText("Enter an answer.")).toBeVisible()
      await waitFor(() => expect(within(sheet).getByRole("textbox", { name: /Question/ })).toHaveFocus())
      expect(within(sheet).getByRole("textbox", { name: /Question/ })).toHaveAccessibleDescription(
        "Enter the question as the form asks it."
      )
      expect(api.requests).toEqual([])
    })

    it("shows C-ANS-6 for a duplicate question, and \"Edit it\" opens the existing answer", async () => {
      const { user, api } = openSignedIn("/answers", {
        answers: [answer({ group: "custom", question: "Why Acme?", value: "Payments at scale" } as ApprovedAnswer)],
      })

      const sheet = await openSheetFor(user, "Custom questions")
      await user.type(within(sheet).getByRole("textbox", { name: /Question/ }), "why  acme?")
      await user.type(within(sheet).getByRole("textbox", { name: /Answer/ }), "Because")
      await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

      expect(
        await within(sheet).findByText("You already have an Approved Answer for this question. Edit that one instead.")
      ).toBeVisible()
      await user.click(within(sheet).getByRole("button", { name: "Edit it" }))

      const editSheet = await screen.findByRole("dialog", { name: "Why Acme?" })
      expect(within(editSheet).getByRole("textbox", { name: /Answer/ })).toHaveValue("Payments at scale")
      expect(api.state.answers).toHaveLength(1)
    })

    it("a server failure shows C-ERR-2 and keeps the sheet open with its values", async () => {
      const { user } = openSignedIn("/answers")
      server.use(http.post("/v1/approved-answers", () => apiErrorResponse("internal_error")))

      const sheet = await openSheetFor(user, "Standard")
      await user.type(within(sheet).getByRole("textbox", { name: /Answer/ }), "4 weeks")
      await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

      expect(await findToast("Couldn't save the answer. Nothing changed. Try again.")).toBeVisible()
      expect(within(screen.getByRole("dialog")).getByRole("textbox", { name: /Answer/ })).toHaveValue("4 weeks")
    })
  })

  it("@happy Editing an Approved Answer", async () => {
    const { user, api } = openSignedIn("/answers", {
      answers: [answer({ group: "standard", topic: "notice_period", skill: null, value: "4 weeks" } as ApprovedAnswer)],
    })

    await user.click(await screen.findByRole("button", { name: "Edit Notice period" }))
    const sheet = await screen.findByRole("dialog", { name: "Notice period" })
    expect(within(sheet).queryByRole("combobox", { name: "Topic" })).not.toBeInTheDocument()
    const value = within(sheet).getByRole("textbox", { name: /Answer/ })
    expect(value).toHaveValue("4 weeks")
    await user.clear(value)
    await user.type(value, "2 weeks")
    await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

    expect(await within(await findSection("Standard")).findByText("2 weeks")).toBeVisible()
    expect(api.requestsTo("PATCH", "/v1/approved-answers/11111111-1111-4111-8111-111111111111")[0].body).toEqual({
      value: "2 weeks",
    })
  })

  it("@happy Deleting an Approved Answer after C-CONFIRM-14", async () => {
    const { user, api } = openSignedIn("/answers", {
      answers: [answer({ group: "standard", topic: "start_date", skill: null, value: "2026-12-01" } as ApprovedAnswer)],
    })

    await user.click(await screen.findByRole("button", { name: "Delete Start date" }))
    const dialog = await findDialog("Delete this Approved Answer?")
    expect(dialog).toHaveTextContent("Forms that ask this question will be blocked until you add it again.")
    await confirmDialog(user, "Delete this Approved Answer?", "Delete answer")

    expect(await screen.findByRole("heading", { name: "No Approved Answers yet" })).toBeVisible()
    expect(api.state.answers).toEqual([])
  })

  it("cancelling the delete keeps the answer", async () => {
    const { user, api } = openSignedIn("/answers", {
      answers: [answer({ group: "standard", topic: "start_date", skill: null, value: "2026-12-01" } as ApprovedAnswer)],
    })

    await user.click(await screen.findByRole("button", { name: "Delete Start date" }))
    await confirmDialog(user, "Delete this Approved Answer?", "Cancel")

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(within(section("Standard")).getByText("2026-12-01")).toBeVisible()
    expect(api.state.answers).toHaveLength(1)
  })

  it("hides Add answer for Sensitive once all three topics are answered", async () => {
    openSignedIn("/answers", {
      answers: (["demographic", "disability", "veteran_status"] as const).map((topic, i) =>
        answer({ id: `00000000-0000-4000-8000-00000000000${i}`, group: "sensitive", topic } as ApprovedAnswer)
      ),
    })

    await screen.findByRole("region", { name: "Sensitive" })
    expect(screen.queryByRole("button", { name: "Add answer, Sensitive" })).not.toBeInTheDocument()
  })
})

describe("Salary (career-profile.feature, @ac-1.4)", () => {
  it("@happy Setting the gross-salary Approved Answer policy", async () => {
    const { user, api } = openSignedIn("/answers")

    const card = await screen.findByRole("region", { name: "Gross-salary policy" })
    expect(card).toHaveTextContent(
      "Entered when a form asks for expected gross salary. Questions this policy doesn't cover block the Application."
    )
    await user.click(within(card).getByRole("button", { name: "Add answer" }))
    await user.type(within(card).getByRole("textbox", { name: "Amount" }), "48,000")
    expect(within(card).getByRole("combobox", { name: "Currency" })).toHaveValue("USD")
    expect(within(card).getByRole("combobox", { name: "Period" })).toHaveValue("year")
    await user.click(within(card).getByRole("button", { name: "Save answer" }))

    expect(await within(card).findByText("USD 48,000 per year")).toBeVisible()
    expect(api.requestsTo("PUT", "/v1/salary/gross-salary-policy")[0].body).toEqual({
      amount: 48000,
      currency: "USD",
      period: "year",
    })
  })

  it("@happy The net pay preference is stored separately from the gross-salary policy", async () => {
    const { user, api } = openSignedIn("/answers", {
      salary: {
        grossSalaryPolicy: { amount: 48000, currency: "USD", period: "year", display: "USD 48,000 per year" },
        currentSalary: null,
        preferredNetPay: null,
      },
    })

    const net = await screen.findByRole("region", { name: "Preferred pay (net)" })
    expect(within(net).getByText("Never entered into a form")).toBeVisible()
    expect(net).toHaveTextContent("Your target take-home pay. Kept for reference and never entered into a gross-salary field.")
    await user.click(within(net).getByRole("button", { name: "Add answer" }))
    // The net card has no period choice: it is always per month net.
    expect(within(net).queryByRole("combobox", { name: "Period" })).not.toBeInTheDocument()
    expect(within(net).getByText("per month net")).toBeVisible()
    await user.type(within(net).getByRole("textbox", { name: "Amount" }), "5000")
    await user.click(within(net).getByRole("button", { name: "Save answer" }))

    expect(await within(net).findByText("USD 5,000 per month net")).toBeVisible()
    const gross = screen.getByRole("region", { name: "Gross-salary policy" })
    expect(within(gross).getByText("USD 48,000 per year")).toBeVisible()
    expect(within(gross).queryByText(/5,000/)).not.toBeInTheDocument()
    expect(api.requestsTo("PUT", "/v1/salary/preferred-net-pay")[0].body).toEqual({ amount: 5000, currency: "USD" })
    expect(api.requestsTo("PUT", "/v1/salary/gross-salary-policy")).toEqual([])
    expect(api.state.salary.grossSalaryPolicy?.display).toBe("USD 48,000 per year")
  })

  it("the current-salary card says forms will block while it's empty, and can be cleared", async () => {
    const { user, api } = openSignedIn("/answers", {
      salary: {
        grossSalaryPolicy: null,
        currentSalary: { amount: 3500, currency: "USD", period: "month", display: "USD 3,500 per month" },
        preferredNetPay: null,
      },
    })

    const card = await screen.findByRole("region", { name: "Current salary" })
    expect(card).toHaveTextContent("Leave empty to keep it private. Forms that require it will be blocked.")
    await user.click(within(card).getByRole("button", { name: "Delete" }))

    expect(await within(card).findByText("Not approved. Forms that require it will be blocked.")).toBeVisible()
    expect(api.state.salary.currentSalary).toBeNull()
  })

  it("shows C-ANS-7 and C-ANS-8 on the empty gross-policy and net cards", async () => {
    openSignedIn("/answers")

    expect(
      await within(await screen.findByRole("region", { name: "Gross-salary policy" })).findByText(
        "No policy yet. Forms that ask for expected gross salary will be blocked."
      )
    ).toBeVisible()
    expect(
      within(screen.getByRole("region", { name: "Preferred pay (net)" })).getByText(
        "Not set. It's only for your reference, so nothing is blocked without it."
      )
    ).toBeVisible()
  })

  it("offers the r3 currency list in order, USD first, and keeps a stored code outside it", async () => {
    const { user } = openSignedIn("/answers", {
      salary: {
        grossSalaryPolicy: { amount: 48000, currency: "ZAR", period: "year", display: "ZAR 48,000 per year" },
        currentSalary: null,
        preferredNetPay: null,
      },
    })

    const gross = await screen.findByRole("region", { name: "Gross-salary policy" })
    await user.click(within(gross).getByRole("button", { name: "Edit" }))
    const select = within(gross).getByRole("combobox", { name: "Currency" })
    expect(select).toHaveValue("ZAR")
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "USD, US dollar",
      "EUR, euro",
      "GBP, British pound",
      "CAD, Canadian dollar",
      "NGN, Nigerian naira",
      "ZAR",
    ])

    const net = screen.getByRole("region", { name: "Preferred pay (net)" })
    await user.click(within(net).getByRole("button", { name: "Add answer" }))
    expect(within(net).getByRole("combobox", { name: "Currency" })).toHaveValue("USD")
  })

  const CARDS = {
    "gross-salary Approved Answer policy": { region: "Gross-salary policy", path: "/v1/salary/gross-salary-policy", key: "grossSalaryPolicy" },
    "current salary": { region: "Current salary", path: "/v1/salary/current-salary", key: "currentSalary" },
    "preferred net pay": { region: "Preferred pay (net)", path: "/v1/salary/preferred-net-pay", key: "preferredNetPay" },
  } as const
  type CardName = keyof typeof CARDS

  async function saveAmount(user: ReturnType<typeof import("@testing-library/user-event").default.setup>, card: CardName, amount: string) {
    const region = await screen.findByRole("region", { name: CARDS[card].region })
    await user.click(within(region).getByRole("button", { name: /^(Add answer|Edit)$/ }))
    const field = within(region).getByRole("textbox", { name: "Amount" })
    await user.clear(field)
    if (amount !== "") await user.type(field, amount)
    await user.click(within(region).getByRole("button", { name: "Save answer" }))
    return region
  }

  describe("@validation @ac-1.4 @r4 A salary amount that is empty, not above zero, over the maximum, or has more than 2 decimals is refused", () => {
    it.each([
      ["gross-salary Approved Answer policy", "", "Enter an amount like 48000 or 4000.50."],
      ["gross-salary Approved Answer policy", "forty", "Enter an amount like 48000 or 4000.50."],
      ["gross-salary Approved Answer policy", "0.00", "Enter an amount greater than 0."],
      ["gross-salary Approved Answer policy", "0", "Enter an amount greater than 0."],
      ["gross-salary Approved Answer policy", "4800.105", "Use at most 2 decimal places, like 4000.50."],
      ["gross-salary Approved Answer policy", "0.075", "Use at most 2 decimal places, like 4000.50."],
      ["gross-salary Approved Answer policy", "100000000.01", "Enter 100,000,000 or less."],
      ["current salary", "0.00", "Enter an amount greater than 0."],
      ["current salary", "4800.105", "Use at most 2 decimal places, like 4000.50."],
      ["preferred net pay", "-1.00", "Enter an amount greater than 0."],
      ["preferred net pay", "0.00", "Enter an amount greater than 0."],
      ["preferred net pay", "0", "Enter an amount greater than 0."],
      ["preferred net pay", "4800.105", "Use at most 2 decimal places, like 4000.50."],
    ] as const)("the %s refuses %j with %j and keeps its previous value", async (card, amount, error) => {
      const previous = { amount: 3000, currency: "USD", display: "USD 3,000" }
      const { user, api } = openSignedIn("/answers", {
        salary: {
          grossSalaryPolicy: { ...previous, period: "year", display: "USD 3,000 per year" },
          currentSalary: { ...previous, period: "month", display: "USD 3,000 per month" },
          preferredNetPay: { ...previous, period: "month_net", display: "USD 3,000 per month net" },
        },
      })

      const region = await saveAmount(user, card, amount)

      const field = within(region).getByRole("textbox", { name: "Amount" })
      expect(within(region).getByRole("alert")).toHaveTextContent(error)
      expect(field).toHaveAccessibleDescription(error)
      await waitFor(() => expect(field).toHaveFocus())
      expect(api.requests).toEqual([])
      expect(api.state.salary[CARDS[card].key]?.amount).toBe(3000)
    })
  })

  describe("@boundary @ac-1.4 @r4 A salary amount with at most 2 decimals is accepted", () => {
    it.each([
      ["gross-salary Approved Answer policy", "0.07", 0.07],
      ["gross-salary Approved Answer policy", "0.29", 0.29],
      ["gross-salary Approved Answer policy", "4800.10", 4800.1],
      ["gross-salary Approved Answer policy", "0.01", 0.01],
      ["current salary", "0.07", 0.07],
      ["current salary", "0.29", 0.29],
      ["current salary", "4800.10", 4800.1],
      ["preferred net pay", "0.07", 0.07],
      ["preferred net pay", "0.29", 0.29],
      ["preferred net pay", "4800.10", 4800.1],
      ["preferred net pay", "4800", 4800],
      ["gross-salary Approved Answer policy", "100000000", 100_000_000],
    ] as const)("the %s stores %j", async (card, typed, amount) => {
      const { user, api } = openSignedIn("/answers")

      const region = await saveAmount(user, card, typed)

      expect(await findToast("Saved.")).toBeVisible()
      expect(within(region).queryByRole("alert")).not.toBeInTheDocument()
      expect(api.requestsTo("PUT", CARDS[card].path)[0].body).toMatchObject({ amount })
      expect(api.state.salary[CARDS[card].key]?.amount).toBe(amount)
    })
  })
})

describe("Work authorization (career-profile.feature, @ac-1.5)", () => {
  // EPIC-0002 B1 (settings-b1.feature:41, design-spec.r6 "B1 interim Settings" decision 3):
  // career-profile.feature:182 and :191 are superseded. Job preferences owns country, work
  // authorization and sponsorship; the free-text section, C-SET-1 and its line are gone.
  it("@superseded-by-B1 Settings has no free-text work authorization field, C-SET-1 or sponsorship line", async () => {
    openSignedIn("/settings")
    expect(await screen.findByRole("region", { name: "Job preferences" })).toBeVisible()
    expect(screen.queryByRole("textbox", { name: "Work authorization" })).toBeNull()
    expect(screen.queryByText(/Location and work authorization questions are answered truthfully/)).toBeNull()
    expect(screen.queryByText("Sponsorship need: always answered Yes")).toBeNull()
  })
})
