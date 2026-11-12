import { useState } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog"
import { HelpPopover, HelpPopoverNote } from "./help-popover"

const TRIGGER = "Why this matters"
const TITLE = "Why it matters"

function Help(props: Partial<React.ComponentProps<typeof HelpPopover>>) {
  return (
    <HelpPopover triggerLabel={TRIGGER} title={TITLE} {...props}>
      <p>Body paragraph.</p>
      <a href="#target">Go somewhere</a>
      <HelpPopoverNote>Note.</HelpPopoverNote>
    </HelpPopover>
  )
}

function Page() {
  return (
    <div>
      <p>Help line</p>
      <Help />
      <button type="button">Elsewhere</button>
    </div>
  )
}

const trigger = () => screen.getByRole("button", { name: TRIGGER })
const popup = () => screen.queryByRole("dialog", { name: TITLE })

async function expectClosedWithFocusOnTrigger() {
  await waitFor(() => expect(popup()).not.toBeInTheDocument())
  expect(trigger()).toHaveAttribute("aria-expanded", "false")
  await waitFor(() => expect(trigger()).toHaveFocus())
}

describe("HelpPopover", () => {
  it("is a named button that reports collapsed and that it opens a popup", () => {
    render(<Page />)
    expect(trigger().tagName).toBe("BUTTON")
    expect(trigger()).toHaveAttribute("type", "button")
    expect(trigger()).toHaveAttribute("aria-expanded", "false")
    expect(trigger()).toHaveAttribute("aria-haspopup")
    expect(trigger()).toHaveClass("size-7", "pointer-coarse:size-10")
  })

  it("under reduced motion the popup turns off both the enter and the exit animation (DR-01)", async () => {
    const user = userEvent.setup()
    render(<Page />)
    await user.click(trigger())
    const dialog = await screen.findByRole("dialog", { name: TITLE })
    // popover.tsx animates with data-open:animate-in and data-closed:animate-out; a plain
    // motion-reduce:animate-none loses to them, so each reduce class carries the same data variant.
    expect(dialog).toHaveClass("data-open:animate-in", "data-closed:animate-out")
    expect(dialog).toHaveClass(
      "motion-reduce:data-open:animate-none",
      "motion-reduce:data-closed:animate-none",
      "motion-reduce:transition-none"
    )
    expect(dialog).not.toHaveClass("motion-reduce:animate-none")
    expect(trigger()).toHaveClass("motion-reduce:transition-none")
    expect(screen.getByRole("button", { name: "Close help" })).toHaveClass("motion-reduce:transition-none")
  })

  it("does not open on hover", async () => {
    const user = userEvent.setup()
    render(<Page />)
    await user.hover(trigger())
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(popup()).not.toBeInTheDocument()
    expect(trigger()).toHaveAttribute("aria-expanded", "false")
  })

  it("opens on click as a dialog named by its title, with focus moved into it", async () => {
    const user = userEvent.setup()
    render(<Page />)
    await user.click(trigger())
    const dialog = await screen.findByRole("dialog", { name: TITLE })
    expect(trigger()).toHaveAttribute("aria-expanded", "true")
    await waitFor(() => expect(dialog).toHaveFocus())
    expect(dialog).toHaveTextContent("Body paragraph.")
  })

  it.each(["{Enter}", " "])("opens with the keyboard key %j", async (key) => {
    const user = userEvent.setup()
    render(<Page />)
    trigger().focus()
    await user.keyboard(key)
    const dialog = await screen.findByRole("dialog", { name: TITLE })
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  it("Tab reaches the close button, then the body links", async () => {
    const user = userEvent.setup()
    render(<Page />)
    trigger().focus()
    await user.keyboard("{Enter}")
    const dialog = await screen.findByRole("dialog", { name: TITLE })
    await waitFor(() => expect(dialog).toHaveFocus())
    await user.tab()
    expect(screen.getByRole("button", { name: "Close help" })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole("link", { name: "Go somewhere" })).toHaveFocus()
  })

  it("Escape closes it and returns focus to the trigger", async () => {
    const user = userEvent.setup()
    render(<Page />)
    await user.click(trigger())
    await screen.findByRole("dialog", { name: TITLE })
    await user.keyboard("{Escape}")
    await expectClosedWithFocusOnTrigger()
  })

  it("the close button, named 'Close help' by default, closes it and returns focus", async () => {
    const user = userEvent.setup()
    render(<Page />)
    await user.click(trigger())
    await user.click(await screen.findByRole("button", { name: "Close help" }))
    await expectClosedWithFocusOnTrigger()
  })

  it("the trigger closes it again", async () => {
    const user = userEvent.setup()
    render(<Page />)
    await user.click(trigger())
    await screen.findByRole("dialog", { name: TITLE })
    await user.click(trigger())
    await expectClosedWithFocusOnTrigger()
  })

  it("an outside click closes it and returns focus to the trigger", async () => {
    // Base UI returns focus after an outside press only where focus({ preventScroll }) is supported
    // (every target browser except Chrome on Android). jsdom ignores focus options, so read the option
    // here the way a supporting browser does.
    const focus = HTMLElement.prototype.focus
    const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
      void options?.preventScroll
      focus.call(this, options)
    })
    try {
      const user = userEvent.setup()
      render(<Page />)
      await user.click(trigger())
      await screen.findByRole("dialog", { name: TITLE })
      await user.click(screen.getByText("Help line"))
      await expectClosedWithFocusOnTrigger()
    } finally {
      spy.mockRestore()
    }
  })

  it("controlled with finalFocus false: closing from outside leaves focus where the caller puts it", async () => {
    const user = userEvent.setup()
    function Controlled() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <HelpPopover triggerLabel={TRIGGER} title={TITLE} open={open} onOpenChange={setOpen} finalFocus={false}>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                document.getElementById("target")?.focus()
              }}
            >
              Jump
            </button>
          </HelpPopover>
          <h2 id="target" tabIndex={-1}>
            Target
          </h2>
        </>
      )
    }
    render(<Controlled />)
    await user.click(trigger())
    await user.click(await screen.findByRole("button", { name: "Jump" }))
    await waitFor(() => expect(popup()).not.toBeInTheDocument())
    expect(screen.getByRole("heading", { name: "Target" })).toHaveFocus()
  })

  describe("inside a modal Dialog", () => {
    function InDialog() {
      const [open, setOpen] = useState(true)
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Outer dialog</DialogTitle>
            <div className="flex">
              <DialogDescription>Outer description</DialogDescription>
              <Help />
            </div>
            <input aria-label="Field" defaultValue="typed" />
          </DialogContent>
        </Dialog>
      )
    }
    const outer = () => screen.queryByRole("dialog", { name: "Outer dialog" })

    it("Escape in the popover closes only the popover; the next Escape closes the dialog", async () => {
      const user = userEvent.setup()
      render(<InDialog />)
      await user.click(trigger())
      await screen.findByRole("dialog", { name: TITLE })
      await user.keyboard("{Escape}")
      await expectClosedWithFocusOnTrigger()
      expect(outer()).toBeInTheDocument()
      expect(screen.getByRole("textbox", { name: "Field" })).toHaveValue("typed")

      await user.keyboard("{Escape}")
      await waitFor(() => expect(outer()).not.toBeInTheDocument())
    })

    it("a click inside the dialog outside the popover closes only the popover", async () => {
      const user = userEvent.setup()
      render(<InDialog />)
      await user.click(trigger())
      await screen.findByRole("dialog", { name: TITLE })
      await user.click(screen.getByText("Outer description"))
      await waitFor(() => expect(popup()).not.toBeInTheDocument())
      expect(outer()).toBeInTheDocument()
    })

    it("the trigger's name is not part of the dialog's description", () => {
      render(<InDialog />)
      expect(outer()).toHaveAccessibleDescription("Outer description")
    })
  })
})
