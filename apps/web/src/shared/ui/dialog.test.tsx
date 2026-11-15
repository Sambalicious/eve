import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./dialog"

/**
 * `dismissDisabled` (Check this job while a request is in flight): every close
 * path the dialog owns does nothing, and its Close is disabled and dimmed.
 * With it off, the same paths close the dialog as before.
 */
function Harness({
  dismissDisabled = false,
  showCloseButton,
  onOpenChange,
}: {
  dismissDisabled?: boolean
  showCloseButton?: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open onOpenChange={onOpenChange} dismissDisabled={dismissDisabled}>
      <DialogContent showCloseButton={showCloseButton}>
        <DialogHeader>
          <DialogTitle>Check this job</DialogTitle>
        </DialogHeader>
        <p>Body</p>
      </DialogContent>
    </Dialog>
  )
}

function overlay() {
  return document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement
}

describe("Dialog dismissDisabled", () => {
  it("blocks Escape, an overlay press and the Close button: onOpenChange is never called", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<Harness dismissDisabled onOpenChange={onOpenChange} />)

    await user.keyboard("{Escape}")
    await user.click(overlay())
    fireEvent.click(screen.getByRole("button", { name: "Close" }))

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog", { name: "Check this job" })).toBeInTheDocument()
  })

  it("disables the Close button while a request is in flight", () => {
    render(<Harness dismissDisabled onOpenChange={() => {}} />)

    const close = screen.getByRole("button", { name: "Close" })
    expect(close).toBeDisabled()
    expect(close).toHaveAttribute("data-slot", "dialog-close")
  })

  it("keeps the default behaviour: Escape and Close both ask to close", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<Harness onOpenChange={onOpenChange} />)

    expect(screen.getByRole("button", { name: "Close" })).not.toBeDisabled()
    await user.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange.mock.calls[0]![0]).toBe(false)

    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(onOpenChange).toHaveBeenCalledTimes(2)
    expect(onOpenChange.mock.calls[1]![0]).toBe(false)
  })

  it("keeps the default overlay dismissal", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<Harness onOpenChange={onOpenChange} />)

    await user.click(overlay())
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange.mock.calls[0]![0]).toBe(false)
  })

  it("puts Close at the title's first line, with the coarse-pointer target sizes", () => {
    render(<Harness onOpenChange={() => {}} />)

    const close = screen.getByRole("button", { name: "Close" })
    expect(close).toHaveClass(
      "absolute",
      "top-[20.5px]",
      "right-4",
      "size-8",
      "pointer-coarse:top-[16.5px]",
      "pointer-coarse:right-3",
      "pointer-coarse:size-10"
    )
    expect(close).not.toHaveClass("top-2", "right-2")
    // The ghost icon button is unchanged; only its geometry moved.
    expect(close).toHaveClass("hover:bg-muted")
    expect(close.querySelector(".sr-only")).toHaveTextContent("Close")
  })
})

/**
 * The corner Close sits at the title's right edge, so the title reserves its
 * width (`pe-10`) only when the popup actually renders one. `data-has-close` is
 * the popup's own record of that, which the title reads with `in-data-[has-close]`.
 */
describe("DialogTitle and the corner Close", () => {
  it("marks the popup with data-has-close when it renders the Close button", () => {
    render(<Harness onOpenChange={() => {}} />)

    const popup = screen.getByRole("dialog", { name: "Check this job" })
    expect(popup).toHaveAttribute("data-has-close", "")
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument()
  })

  it("omits data-has-close with showCloseButton={false}, so nothing reserves room for a Close that is not there", () => {
    render(<Harness showCloseButton={false} onOpenChange={() => {}} />)

    const popup = screen.getByRole("dialog", { name: "Check this job" })
    expect(popup).not.toHaveAttribute("data-has-close")
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
  })

  it("keeps pe-10 conditional on a Close, and wraps a long title either way", () => {
    const { unmount } = render(<Harness onOpenChange={() => {}} />)
    const withClose = screen.getByRole("heading", { name: "Check this job" })
    expect(withClose).toHaveClass("in-data-[has-close]:pe-10", "[overflow-wrap:anywhere]")
    // Never unconditional: a bare pe-10 would pad the title even without a Close.
    expect(withClose).not.toHaveClass("pe-10")
    unmount()

    render(<Harness showCloseButton={false} onOpenChange={() => {}} />)
    const withoutClose = screen.getByRole("heading", { name: "Check this job" })
    // The class stays in the list but is inert: the popup does not set data-has-close.
    expect(screen.getByRole("dialog", { name: "Check this job" })).not.toHaveAttribute("data-has-close")
    expect(withoutClose).not.toHaveClass("pe-10")
    expect(withoutClose).toHaveClass("[overflow-wrap:anywhere]")
  })
})
