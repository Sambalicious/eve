import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Button } from "./button"

const DIMMED = ["disabled:opacity-50", "disabled:pointer-events-none", "data-disabled:opacity-50", "data-disabled:pointer-events-none"]

/**
 * A disabled Button looks disabled whether or not it keeps focus. With
 * `focusableWhenDisabled` (the pending Settings Save buttons and the header
 * pause control) there is no native `disabled`, so the dim hangs on Base UI's
 * `data-disabled`. jsdom loads no stylesheet, so this checks the hook the
 * styles use; the real look is checked in a browser (report evidence).
 */
describe("Button disabled look", () => {
  it("a focusable disabled button carries data-disabled and the dim, and stays focusable", () => {
    render(
      <Button disabled focusableWhenDisabled>
        Save
      </Button>
    )
    const button = screen.getByRole("button", { name: "Save" })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute("aria-disabled", "true")
    expect(button).toHaveAttribute("data-disabled")
    expect(button).toHaveClass(...DIMMED)
    button.focus()
    expect(button).toHaveFocus()
  })

  it("a natively disabled button keeps its native disabled state and the same dim", () => {
    render(<Button disabled>Save</Button>)
    const button = screen.getByRole("button", { name: "Save" })
    expect(button).toBeDisabled()
    expect(button).toHaveClass(...DIMMED)
  })

  it("an enabled button, or one with only a hand-set aria-disabled, has no data-disabled, so the dim does not apply", () => {
    render(
      <>
        <Button>Pause automation</Button>
        <Button aria-disabled>Load more</Button>
      </>
    )
    expect(screen.getByRole("button", { name: "Pause automation" })).not.toHaveAttribute("data-disabled")
    expect(screen.getByRole("button", { name: "Load more" })).not.toHaveAttribute("data-disabled")
  })
})
