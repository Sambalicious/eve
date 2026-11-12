import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Dialog, DialogContent } from "./dialog"
import { OverlayHeader } from "./overlay-header"

describe("OverlayHeader", () => {
  it("puts the title and a named close control in one header row with a divider", () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <OverlayHeader title="Request access" closeLabel="Close" />
        </DialogContent>
      </Dialog>
    )
    const dialog = screen.getByRole("dialog", { name: "Request access" })
    const header = dialog.querySelector('[data-slot="overlay-header"]')!
    expect(header).toHaveClass("border-b")
    expect(header).toContainElement(screen.getByRole("heading", { name: "Request access" }))
    expect(header).toContainElement(screen.getByRole("button", { name: "Close" }))
  })

  it.each(["inline", "end"] as const)(
    "with closePlacement %s, the close control is 32px on fine pointers and 40px on coarse, and never shrinks",
    (closePlacement) => {
      render(
        <Dialog open>
          <DialogContent showCloseButton={false}>
            <OverlayHeader title="Request access" closeLabel="Close" closePlacement={closePlacement} />
          </DialogContent>
        </Dialog>
      )
      const close = screen.getByRole("button", { name: "Close" })
      expect(close).toHaveClass("size-8", "pointer-coarse:size-10", "shrink-0")
      expect(close).not.toHaveClass("size-7")
      const spacer = screen.getByRole("dialog").querySelector('[data-slot="overlay-header"] > span[aria-hidden="true"]')
      if (closePlacement === "end") expect(spacer).toHaveClass("size-8", "pointer-coarse:size-10")
    }
  )

  it("with closePlacement end, puts the close control after the body in DOM order", () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <OverlayHeader title="Request access" closeLabel="Close" closePlacement="end">
            <input aria-label="Email" />
          </OverlayHeader>
        </DialogContent>
      </Dialog>
    )
    const email = screen.getByRole("textbox", { name: "Email" })
    const close = screen.getByRole("button", { name: "Close" })
    expect(email.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole("dialog").querySelector('[data-slot="overlay-header"]')).toHaveClass("border-b")
  })
})
