import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { PublicHeader } from "./public-header"

const labels = { homeLink: "Eve home", nav: "Main", accessLink: "How access works", signIn: "Sign in", dashboard: "Open dashboard" }

/**
 * B4: at 375 px with text at 200 % the Sign in button overflowed the header by
 * 19 px. jsdom has no layout, so this pins the structure that lets the row wrap
 * (the rendered 375 px / 200 % check is in the frontend report).
 */
describe("PublicHeader enlarged-text wrap (B4)", () => {
  const setup = () =>
    render(
      <MemoryRouter>
        <PublicHeader labels={labels} cta="sign-in" />
      </MemoryRouter>
    )

  it("lets the row grow and wrap instead of clipping at a fixed 56 px", () => {
    setup()
    const row = screen.getByRole("navigation", { name: "Main" }).parentElement!
    expect(row).toHaveClass("flex-wrap", "min-h-14")
    expect(row).not.toHaveClass("h-14")
  })

  it("lets the nav shrink and wrap the link above the button, kept at the end", () => {
    setup()
    const nav = screen.getByRole("navigation", { name: "Main" })
    expect(nav).toHaveClass("flex-wrap", "min-w-0", "ms-auto", "justify-end")
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in")
  })
})
