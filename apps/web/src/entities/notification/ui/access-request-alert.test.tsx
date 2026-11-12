import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { AccessRequestAlert } from "./access-request-alert"

describe("AccessRequestAlert (dashboard.access_requests.*)", () => {
  it("shows nothing when nothing is waiting or failed", () => {
    const { container } = render(<AccessRequestAlert counts={{ waiting: 0, failed: 0 }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    [1, "1 access request is waiting because email isn't set up."],
    [2, "2 access requests are waiting because email isn't set up."],
  ])("waiting %i: title and plural text", (waiting, start) => {
    render(<AccessRequestAlert counts={{ waiting, failed: 0 }} />)
    const alert = screen.getByRole("status")
    expect(alert).toHaveTextContent("Access requests are waiting")
    expect(alert).toHaveTextContent(`${start} Eve stored them and sends them once Gmail is set up in the server's environment. Eve deletes unsent requests after 90 days.`)
  })

  it.each([
    [1, "1 access request couldn't be emailed to you from your Gmail account."],
    [3, "3 access requests couldn't be emailed to you from your Gmail account."],
  ])("failed %i: title and plural text", (failed, start) => {
    render(<AccessRequestAlert counts={{ waiting: 0, failed }} />)
    const alert = screen.getByRole("status")
    expect(alert).toHaveTextContent("Access request emails didn't send")
    expect(alert).toHaveTextContent(`${start} The requests are stored, but Eve won't try those emails again. Check the Gmail app password in the server's environment.`)
  })

  it("when both apply, shows waiting only", () => {
    render(<AccessRequestAlert counts={{ waiting: 2, failed: 1 }} />)
    expect(screen.getAllByRole("status")).toHaveLength(1)
    expect(screen.getByRole("status")).toHaveTextContent("Access requests are waiting")
    expect(screen.queryByText("Access request emails didn't send")).not.toBeInTheDocument()
  })

  it("never shows visitor data", () => {
    render(<AccessRequestAlert counts={{ waiting: 2, failed: 0 }} />)
    expect(screen.getByRole("status").textContent).not.toMatch(/@/)
  })
})
