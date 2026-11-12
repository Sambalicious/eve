import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, server } from "@/shared/testing"
import { EMPLOYER_LIST_APPROVE_PATH } from "@eve/contracts"
import { confirmDialog, findDialog, findToast } from "./career-setup-helpers"
import { openDiscovery } from "./discovery-helpers"

function boardRow(name: string) {
  return screen.getByRole("listitem", { name })
}

describe("Job Sources: employer list (F1 step 7a)", () => {
  it("before approval: C-SRC-6, C-SRC-5, the companies with board URLs as text, the crypto flag, and the count", async () => {
    const { currentPath } = openDiscovery("/sources")

    // EPIC-0011 R5: /sources opens Find jobs at the job boards, for the Operator.
    expect(await screen.findByRole("heading", { level: 1, name: "Find jobs" })).toBeVisible()
    expect(currentPath()).toBe("/find-jobs#job-sources")
    const card = await screen.findByRole("region", { name: "Employer list" })
    expect(
      within(card).getByText("Not approved yet. The daily 08:00 WAT discovery stays off until you approve this list. Pasted links still work.")
    ).toBeVisible()
    expect(within(card).getByText(/^Companies on Greenhouse, Lever or Ashby that hire senior frontend/)).toBeVisible()
    expect(within(card).getByText("3 companies")).toBeVisible()
    const rows = within(card).getAllByRole("row").slice(1)
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("RailwayAshbyhttps://api.ashbyhq.com/posting-api/job-board/railway"),
      expect.stringContaining("Phantom"),
      expect.stringContaining("GitLabGreenhouse"),
    ])
    expect(within(rows[1]).getByText("Crypto")).toBeVisible()
    expect(within(rows[1]).getByText("Crypto wallet. Decide at approval.")).toBeVisible()
    expect(within(card).queryByRole("link")).not.toBeInTheDocument()
  })

  it("approves after C-CONFIRM-20: toast C-SRC-9, status C-SRC-7, button gone", async () => {
    const { user, api } = openDiscovery("/sources")

    await user.click(await screen.findByRole("button", { name: "Approve employer list" }))
    const dialog = await findDialog("Approve this employer list?")
    expect(dialog).toHaveTextContent(
      "The assistant will check these 3 companies' job boards every day at 08:00 WAT and apply to eligible, strong-Match roles under your rules."
    )
    await expect.poll(() => document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }))
    await confirmDialog(user, "Approve this employer list?", "Approve list")

    expect(await findToast("Employer list approved. Discovery starts at 08:00 WAT.")).toBeInTheDocument()
    expect(
      await screen.findByText("Approved on 19 Oct 2026. Discovery checks these 3 companies every day at 08:00 WAT.")
    ).toBeVisible()
    expect(screen.queryByRole("button", { name: "Approve employer list" })).not.toBeInTheDocument()
    expect(api.requests).toEqual([{ method: "POST", path: "/v1/job-sources/employer-list/approve", body: null }])
  })

  it("Cancel sends nothing", async () => {
    const { user, api } = openDiscovery("/sources")

    await user.click(await screen.findByRole("button", { name: "Approve employer list" }))
    await confirmDialog(user, "Approve this employer list?", "Cancel")

    expect(screen.getByRole("button", { name: "Approve employer list" })).toBeVisible()
    expect(api.requests).toEqual([])
  })

  it("a failed approval toasts C-ERR-2 and keeps the dialog open", async () => {
    const { user } = openDiscovery("/sources")
    server.use(http.post(EMPLOYER_LIST_APPROVE_PATH, () => apiErrorResponse("internal_error")))

    await user.click(await screen.findByRole("button", { name: "Approve employer list" }))
    await confirmDialog(user, "Approve this employer list?", "Approve list")

    expect(await findToast("Couldn't approve the employer list. Nothing changed. Try again.")).toBeInTheDocument()
    expect(await findDialog("Approve this employer list?")).toBeVisible()
  })
})

describe("Job Sources: remote-job boards (AC 1.7, 1.9)", () => {
  it("lists the boards in the fixed order with C-SRC-2 / C-SRC-4, and Remotive locked with its reason", async () => {
    openDiscovery("/sources")

    const region = await screen.findByRole("region", { name: "Remote-job boards" })
    expect(within(region).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual([
      "Himalayas",
      "Remote OK",
      "Remotive",
      "We Work Remotely",
    ])
    expect(boardRow("Himalayas")).toHaveTextContent("Verified 19 Oct 2026: Terms clauses 30A and 113 allow API use with credit.")
    expect(boardRow("We Work Remotely")).toHaveTextContent("Not verified")
    expect(boardRow("Remotive")).toHaveTextContent("Remotive's terms (section 8) require written permission")
    expect(within(boardRow("Remotive")).queryByRole("switch")).not.toBeInTheDocument()
    expect(within(boardRow("Remotive")).queryByRole("button", { name: /Mark verified/ })).not.toBeInTheDocument()
  })

  it("enables a verified board", async () => {
    const { user, api } = openDiscovery("/sources")

    const toggle = within(await screen.findByRole("listitem", { name: "Himalayas" })).getByRole("switch")
    expect(toggle).not.toBeChecked()
    await user.click(toggle)

    await expect.poll(() => within(boardRow("Himalayas")).getByRole("switch")).toBeChecked()
    expect(api.state.sources.remoteBoards[0].enabled).toBe(true)
  })

  it("an unverified board stays disabled and shows C-SRC-3, sending nothing", async () => {
    const { user, api } = openDiscovery("/sources")

    const toggle = within(await screen.findByRole("listitem", { name: "We Work Remotely" })).getByRole("switch")
    expect(toggle).toHaveAttribute("aria-disabled", "true")
    await user.click(toggle)

    expect(within(boardRow("We Work Remotely")).getByRole("alert")).toHaveTextContent(
      "Verify this board before you enable it. Eve reads only verified boards."
    )
    expect(within(boardRow("We Work Remotely")).getByRole("switch")).not.toBeChecked()
    expect(api.requests).toEqual([])
  })

  it("Mark verified requires both fields, then records the date and basis", async () => {
    const { user, api } = openDiscovery("/sources")

    await user.click(within(await screen.findByRole("listitem", { name: "We Work Remotely" })).getByRole("button", { name: /Mark verified/ }))
    const dialog = await screen.findByRole("dialog", { name: "Mark verified: We Work Remotely" })
    const date = within(dialog).getByLabelText(/Verification date/)
    await user.clear(date)
    await user.click(within(dialog).getByRole("button", { name: "Mark verified" }))
    expect(within(dialog).getByText("Enter the verification date.")).toBeVisible()
    expect(within(dialog).getByText("Enter the basis for permitted use.")).toBeVisible()
    expect(date).toHaveFocus()

    await user.type(date, "2026-10-17")
    await user.type(within(dialog).getByLabelText(/Basis for permitted use/), "Terms of service section 4 permits automated access")
    await user.click(within(dialog).getByRole("button", { name: "Mark verified" }))

    expect(
      await screen.findByText("Verified 17 Oct 2026: Terms of service section 4 permits automated access")
    ).toBeVisible()
    expect(api.requests).toEqual([
      {
        method: "PUT",
        path: "/v1/job-sources/remote-boards/weworkremotely/verification",
        body: { verifiedOn: "2026-10-17", basis: "Terms of service section 4 permits automated access" },
      },
    ])
  })

  it("the backend's job_source_not_verified refusal also shows C-SRC-3", async () => {
    const { user } = openDiscovery("/sources")
    server.use(http.put("/v1/job-sources/remote-boards/:key/enabled", () => apiErrorResponse("job_source_not_verified")))

    await user.click(within(await screen.findByRole("listitem", { name: "Remote OK" })).getByRole("switch"))

    expect(await within(boardRow("Remote OK")).findByRole("alert")).toHaveTextContent(
      "Verify this board before you enable it. Eve reads only verified boards."
    )
  })
})

/** EPIC-0009 copy deck strings, quoted so a copy change fails here. */
const VERIFY_DESC =
  "Once enabled, Eve reads this board on its own every day. Its terms need to allow that. Saving here records that you checked them."
const VERIFY_BASIS_HELP =
  'Where you checked and what it says, for example "Terms page, section 4 allows API use with credit."'
const VERIFY_TRIGGER = "Why Eve asks you to verify"
const VERIFY_TITLE = "Why Eve needs this record"
const VERIFY_WHY = [
  "A site's terms can forbid programs from reading it automatically. Eve won't read this board until you save this record.",
  "The record notes the date and what you checked, so you can look back later. It covers only this board.",
  "Examples of a basis",
  'A terms page and its section: "Terms page, section 4 allows API use with credit."',
  'A permission email: "Email from support, 27 Oct 2026, says daily reading is OK."',
  'A public feed or API policy: "API policy page allows public feed use."',
  "These show how to write a basis. They don't mean any board allows it. Eve doesn't check terms for you, and this isn't legal advice.",
]
const SRC_HELP = 'Each board must be verified before you can enable it. "Mark verified" records that you checked its terms.'
const SRC_TRIGGER = "Why verify a board first"
const SRC_TITLE = "Why boards need verifying first"
const SRC_WHY = [
  "Eve reads each enabled board by itself every day. A site's terms can forbid that kind of automatic reading, so you check the terms first and note what you found.",
  "Once a board is verified, you can enable it. Eve then reads it in the daily 08:00 WAT discovery, which runs once you approve the employer list.",
  "Eve doesn't check the terms for you. The record notes what you found. It isn't legal advice.",
]
const SRC_3 = "Verify this board before you enable it. Eve reads only verified boards."
const OLD_SRC_3 = "Verify this Job Source for permitted use before enabling it."

async function openVerifyDialog(user: ReturnType<typeof openDiscovery>["user"], board = "We Work Remotely") {
  await user.click(within(await screen.findByRole("listitem", { name: board })).getByRole("button", { name: /Mark verified/ }))
  return screen.findByRole("dialog", { name: `Mark verified: ${board}` })
}

describe("EPIC-0009 S1: Mark verified dialog help (mark-verified-help.feature)", () => {
  it("@ac-1 shows C-EH-VERIFY-DESC under the title as the dialog's accessible description; focus stays on the date", async () => {
    const { user } = openDiscovery("/sources")
    const dialog = await openVerifyDialog(user)
    expect(within(dialog).getByText(VERIFY_DESC)).toBeVisible()
    expect(dialog).toHaveAccessibleDescription(VERIFY_DESC)
    await expect.poll(() => document.activeElement).toBe(within(dialog).getByLabelText(/Verification date/))
    expect(within(dialog).getByRole("button", { name: VERIFY_TRIGGER })).not.toHaveFocus()
  })

  it("@ac-1 the description is shown when opened from the C-SRC-3 refusal and for a verified board", async () => {
    const { user } = openDiscovery("/sources")
    await user.click(within(await screen.findByRole("listitem", { name: "We Work Remotely" })).getByRole("switch"))
    await user.click(within(within(boardRow("We Work Remotely")).getByRole("alert")).getByRole("button", { name: "Mark verified" }))
    const fromRefusal = await screen.findByRole("dialog", { name: "Mark verified: We Work Remotely" })
    expect(fromRefusal).toHaveAccessibleDescription(VERIFY_DESC)
    await user.click(within(fromRefusal).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    const verified = await openVerifyDialog(user, "Himalayas")
    expect(within(verified).getByText(VERIFY_DESC)).toBeVisible()
  })

  it("@ac-2 the basis help line is visible and describes the field; after an error it is followed by the error", async () => {
    const { user, api } = openDiscovery("/sources")
    const dialog = await openVerifyDialog(user)
    const basis = within(dialog).getByLabelText(/Basis for permitted use/)
    expect(within(dialog).getByText(VERIFY_BASIS_HELP)).toBeVisible()
    expect(basis).toHaveAccessibleDescription(VERIFY_BASIS_HELP)

    await user.click(within(dialog).getByRole("button", { name: "Mark verified" }))
    expect(basis).toHaveAccessibleDescription(`${VERIFY_BASIS_HELP} Enter the basis for permitted use.`)
    const help = within(dialog).getByText(VERIFY_BASIS_HELP)
    const error = within(dialog).getByText("Enter the basis for permitted use.")
    expect(help.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(help).toBeVisible()
    expect(basis).toHaveFocus()
    expect(api.requests).toEqual([])
  })

  it("@ac-1 @ac-2 the trigger's name is in neither the dialog description nor the basis description", async () => {
    const { user } = openDiscovery("/sources")
    const dialog = await openVerifyDialog(user)
    expect(dialog).not.toHaveAccessibleDescription(expect.stringContaining(VERIFY_TRIGGER))
    expect(within(dialog).getByLabelText(/Basis for permitted use/)).not.toHaveAccessibleDescription(
      expect.stringContaining(VERIFY_TRIGGER)
    )
  })

  it("@ac-3 one collapsed (i) after the description; it opens the why with three examples as a list, in order", async () => {
    const { user } = openDiscovery("/sources")
    const dialog = await openVerifyDialog(user)
    const triggers = within(dialog).getAllByRole("button", { name: /^Why/ })
    expect(triggers).toHaveLength(1)
    const trigger = triggers[0]
    expect(trigger).toHaveAccessibleName(VERIFY_TRIGGER)
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(within(dialog).getByText(VERIFY_DESC).compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await user.click(trigger)
    const popover = await screen.findByRole("dialog", { name: VERIFY_TITLE })
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    const texts = [...popover.querySelectorAll("p, li")].map((el) => el.textContent).filter((t) => t !== VERIFY_TITLE)
    expect(texts).toEqual(VERIFY_WHY)
    expect(within(popover).getAllByRole("listitem")).toHaveLength(3)
  })

  it.each([
    ["pressing Escape", async (user: ReturnType<typeof openDiscovery>["user"]) => user.keyboard("{Escape}")],
    ["the close button", async (user: ReturnType<typeof openDiscovery>["user"]) => user.click(screen.getByRole("button", { name: "Close help" }))],
    ["the trigger again", async (user: ReturnType<typeof openDiscovery>["user"]) => user.click(screen.getByRole("button", { name: VERIFY_TRIGGER }))],
    [
      "a click inside the dialog outside the popover",
      async (user: ReturnType<typeof openDiscovery>["user"]) => user.click(screen.getByText(VERIFY_BASIS_HELP)),
    ],
  ])("@ac-3 @ac-14 closing by %s keeps the typed values and the dialog open", async (_name, close) => {
    const { user } = openDiscovery("/sources")
    const dialog = await openVerifyDialog(user)
    const date = within(dialog).getByLabelText(/Verification date/)
    const basis = within(dialog).getByLabelText(/Basis for permitted use/)
    await user.clear(date)
    await user.type(date, "2026-10-28")
    await user.type(basis, "Terms page section 4 allows API use with credit")
    await user.click(within(dialog).getByRole("button", { name: VERIFY_TRIGGER }))
    await screen.findByRole("dialog", { name: VERIFY_TITLE })

    await close(user)

    await waitFor(() => expect(screen.queryByRole("dialog", { name: VERIFY_TITLE })).not.toBeInTheDocument())
    expect(screen.getByRole("dialog", { name: "Mark verified: We Work Remotely" })).toBeVisible()
    expect(date).toHaveValue("2026-10-28")
    expect(basis).toHaveValue("Terms page section 4 allows API use with credit")
  })

  it("@ac-14 Escape closes only the popover and returns focus to (i); the next Escape closes the dialog and sends nothing", async () => {
    const { user, api } = openDiscovery("/sources")
    const dialog = await openVerifyDialog(user)
    await user.type(within(dialog).getByLabelText(/Basis for permitted use/), "Written permission email from support, 2026-10-27")
    const trigger = within(dialog).getByRole("button", { name: VERIFY_TRIGGER })
    trigger.focus()
    await user.keyboard("{Enter}")
    const popover = await screen.findByRole("dialog", { name: VERIFY_TITLE })
    await waitFor(() => expect(popover.contains(document.activeElement)).toBe(true))

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog", { name: VERIFY_TITLE })).not.toBeInTheDocument())
    expect(screen.getByRole("dialog", { name: "Mark verified: We Work Remotely" })).toBeVisible()
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Mark verified: We Work Remotely" })).not.toBeInTheDocument())
    expect(boardRow("We Work Remotely")).toHaveTextContent("Not verified")
    expect(api.requests).toEqual([])
  })

  it("@ac-4 after reading the help, submit sends exactly the date and trimmed basis", async () => {
    const { user, api } = openDiscovery("/sources")
    const dialog = await openVerifyDialog(user)
    await user.click(within(dialog).getByRole("button", { name: VERIFY_TRIGGER }))
    await user.click(await screen.findByRole("button", { name: "Close help" }))
    const date = within(dialog).getByLabelText(/Verification date/)
    await user.clear(date)
    await user.type(date, "2026-10-28")
    await user.type(within(dialog).getByLabelText(/Basis for permitted use/), "  Terms page section 4 allows API use with credit  ")
    await user.click(within(dialog).getByRole("button", { name: "Mark verified" }))

    expect(await screen.findByText("Verified 28 Oct 2026: Terms page section 4 allows API use with credit")).toBeVisible()
    expect(api.requests).toEqual([
      {
        method: "PUT",
        path: "/v1/job-sources/remote-boards/weworkremotely/verification",
        body: { verifiedOn: "2026-10-28", basis: "Terms page section 4 allows API use with credit" },
      },
    ])
  })

  it("@ac-3 opening and closing the popover five times keeps one trigger, one popover at most and the typed basis", async () => {
    const { user } = openDiscovery("/sources")
    const dialog = await openVerifyDialog(user)
    const basis = within(dialog).getByLabelText(/Basis for permitted use/)
    await user.type(basis, "API policy page, public feed allowed")
    for (let i = 0; i < 5; i++) {
      await user.click(within(dialog).getByRole("button", { name: VERIFY_TRIGGER }))
      expect(await screen.findAllByRole("dialog", { name: VERIFY_TITLE })).toHaveLength(1)
      await user.click(screen.getByRole("button", { name: "Close help" }))
      await waitFor(() => expect(screen.queryByRole("dialog", { name: VERIFY_TITLE })).not.toBeInTheDocument())
    }
    expect(within(dialog).getAllByRole("button", { name: VERIFY_TRIGGER })).toHaveLength(1)
    expect(basis).toHaveValue("API policy page, public feed allowed")
  })
})

describe("EPIC-0009 S2: Remote-job boards help (job-sources-help.feature)", () => {
  it("@ac-5 @ac-6 one help line under the heading and one collapsed (i) outside the heading and every row", async () => {
    openDiscovery("/sources")
    const region = await screen.findByRole("region", { name: "Remote-job boards" })
    expect(within(region).getByText(SRC_HELP)).toBeVisible()
    expect(screen.getAllByText(SRC_HELP)).toHaveLength(1)
    const triggers = within(region).getAllByRole("button", { name: /^Why/ })
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toHaveAccessibleName(SRC_TRIGGER)
    expect(triggers[0]).toHaveAttribute("aria-expanded", "false")
    expect(within(region).getByRole("heading", { name: "Remote-job boards" })).not.toContainElement(triggers[0])
    for (const name of ["Himalayas", "Remote OK", "Remotive", "We Work Remotely"]) {
      expect(boardRow(name)).not.toContainElement(triggers[0])
    }
    expect(within(region).getByText(SRC_HELP).compareDocumentPosition(triggers[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("@ac-6 the popover gives P1, P2 and the note, in order, and sends nothing", async () => {
    const { user, api } = openDiscovery("/sources")
    const trigger = await screen.findByRole("button", { name: SRC_TRIGGER })
    await user.click(trigger)
    const popover = await screen.findByRole("dialog", { name: SRC_TITLE })
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect([...popover.querySelectorAll("p")].map((p) => p.textContent).filter((t) => t !== SRC_TITLE)).toEqual(SRC_WHY)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(api.requests).toEqual([])
  })

  it("@ac-7 the refusal states the revised reason, keeps Mark verified, describes the switch and replaces the old text", async () => {
    const { user, api } = openDiscovery("/sources")
    const row = await screen.findByRole("listitem", { name: "We Work Remotely" })
    await user.click(within(row).getByRole("switch"))
    await user.click(within(row).getByRole("switch"))
    const alerts = within(row).getAllByRole("alert")
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent(`${SRC_3} Mark verified`)
    expect(within(row).getByRole("switch")).toHaveAccessibleDescription(`${SRC_3} Mark verified`)
    expect(within(row).getByRole("switch")).not.toBeChecked()
    expect(screen.queryByText(OLD_SRC_3, { exact: false })).not.toBeInTheDocument()
    expect(api.requests).toEqual([])
  })

  it("@ac-6 @ac-7 the section popover and a refusal show together", async () => {
    const { user } = openDiscovery("/sources")
    await user.click(within(await screen.findByRole("listitem", { name: "We Work Remotely" })).getByRole("switch"))
    await user.click(screen.getByRole("button", { name: SRC_TRIGGER }))
    expect(await screen.findByRole("dialog", { name: SRC_TITLE })).toBeVisible()
    expect(within(boardRow("We Work Remotely")).getByRole("alert")).toHaveTextContent(SRC_3)
  })

  it("@ac-8 row states and controls are unchanged", async () => {
    openDiscovery("/sources")
    await screen.findByRole("region", { name: "Remote-job boards" })
    expect(boardRow("Remote OK")).toHaveTextContent("Verified 19 Oct 2026: API terms allow use with a link back.")
    expect(boardRow("Remotive")).toHaveTextContent(
      "Remotive's terms (section 8) require written permission for automated access. The Candidate must obtain it first."
    )
    for (const name of ["Himalayas", "Remote OK", "Remotive", "We Work Remotely"]) {
      expect(boardRow(name)).toHaveTextContent("Remote-job board")
    }
  })

  it("@ac-14 only one help popover is open at a time on Job Sources", async () => {
    const { user } = openDiscovery("/sources")
    await user.click(await screen.findByRole("button", { name: SRC_TRIGGER }))
    await screen.findByRole("dialog", { name: SRC_TITLE })
    const dialog = await openVerifyDialog(user)
    await user.click(within(dialog).getByRole("button", { name: VERIFY_TRIGGER }))
    await screen.findByRole("dialog", { name: VERIFY_TITLE })
    expect(screen.queryByRole("dialog", { name: SRC_TITLE })).not.toBeInTheDocument()
  })
})
