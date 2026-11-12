import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { renderApp } from "./test-app"

const HEADLINE = "Applies for you. Asks instead of guessing."

async function openLanding(path = "/") {
  const view = renderApp(path)
  await screen.findByRole("heading", { level: 1, name: HEADLINE })
  return view
}

describe("landing structure (page-structure.feature, a11y-keyboard.feature)", () => {
  it("renders outside the app shell with one banner, main and contentinfo", async () => {
    await openLanding()
    expect(screen.getAllByRole("banner")).toHaveLength(1)
    expect(screen.getAllByRole("main")).toHaveLength(1)
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1)
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
  })

  it("has one h1 and the section headings in order with no skipped level", async () => {
    await openLanding()
    const headings = screen.getAllByRole("heading").map((h) => [h.tagName, h.textContent])
    expect(headings).toEqual([
      ["H1", HEADLINE],
      ["H2", "How Eve works"],
      ["H3", "Find postings"],
      ["H3", "Check Eligibility and Match"],
      ["H3", "Write Tailored Documents"],
      ["H3", "Apply"],
      ["H3", "Report by email"],
      ["H2", "When Eve stops and asks"],
      ["H2", "Limits you control"],
      ["H2", "How access works"],
    ])
  })

  it("shows every hero string from the copy deck", async () => {
    await openLanding()
    const hero = screen.getByRole("region", { name: HEADLINE })
    expect(within(hero).getByText("Eve finds roles you can be hired for and writes resumes from your record. At most five applications a day.")).toBeVisible()
    expect(within(hero).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in")
    expect(within(hero).getByRole("link", { name: "How access works" })).toHaveAttribute("href", "#access")
    expect(within(hero).getByText("Eve works for one Candidate. Sign in with the Google account it was set up with.")).toBeVisible()
    expect(within(hero).getByText("Example. Made-up company and role.")).toBeInTheDocument()
  })

  it("lists the nine Blocked reasons and the five limits verbatim", async () => {
    await openLanding()
    const stops = screen.getByRole("region", { name: "When Eve stops and asks" })
    expect(within(stops).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "A required question with no Approved Answer yet",
      "A login to an employer site",
      "Email verification",
      "A CAPTCHA",
      "An assessment or test",
      "A declaration you would have to sign",
      "A request for personal data, such as bank details or an ID number",
      "A second application at the same company",
      "A form it can't finish",
    ])
    const limits = screen.getByRole("region", { name: "Limits you control" })
    expect(within(limits).getAllByRole("term").map((t) => t.textContent)).toEqual(["Daily cap", "Activation Gate", "Pause", "Cost ceiling", "Outcomes"])
    expect(within(limits).getByText("Running costs are capped at USD 50 a month. Paid automation pauses before that limit is crossed.")).toBeVisible()
  })

  it("section 6 shows its items in order with an outline Request access button before the signed-invite line", async () => {
    await openLanding()
    const access = screen.getByRole("region", { name: "How access works" })
    const texts = [
      "Eve is invite-only. The person who runs this installation invites people by their Google account email.",
      "There's no sign-up form and no waitlist. Only the account this instance was set up with can sign in.",
      "No invite? Ask the person who runs Eve. They decide on invites.",
      "Request access",
      "Got an invite? Sign in with the Google account it was sent to.",
      "Privacy page",
      "Sign in",
    ]
    const nodes = texts.map((t) => within(access).getByText(t))
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i - 1].compareDocumentPosition(nodes[i]) & Node.DOCUMENT_POSITION_FOLLOWING, texts[i]).toBeTruthy()
    }
    const button = within(access).getByRole("button", { name: "Request access" })
    expect(button).toHaveAttribute("aria-haspopup", "dialog")
    expect(button.className).toMatch(/border-border/)
    expect(button.className).not.toMatch(/bg-primary/)
  })

  it("offers only allowed links, no mailto and no form while the dialog is closed", async () => {
    await openLanding()
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"))
    for (const href of hrefs) expect(["/sign-in", "/", "/privacy", "#access", "#main"]).toContain(href)
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull()
    expect(document.querySelector("form, input, textarea")).toBeNull()
    const buttons = screen.getAllByRole("button").filter((b) => !b.hidden)
    expect(buttons.map((b) => b.textContent)).toEqual(["Request access"])
  })

  it("the header holds the wordmark link, the access jump and an outline Sign in", async () => {
    await openLanding()
    const header = screen.getByRole("banner")
    expect(within(header).getByRole("link", { name: "Eve, home" })).toHaveAttribute("href", "/")
    const nav = within(header).getByRole("navigation", { name: "Page" })
    expect(within(nav).getByRole("link", { name: "How access works" })).toHaveAttribute("href", "#access")
    expect(within(nav).getByRole("link", { name: "Sign in" }).className).toMatch(/border-border/)
  })

  it("the footer holds only the wordmark and Privacy, with a hidden outline wordmark of fixed size", async () => {
    await openLanding()
    const footer = screen.getByRole("contentinfo")
    expect(within(footer).getAllByRole("link").map((a) => [a.getAttribute("href"), a.getAttribute("aria-label") ?? a.textContent])).toEqual([
      ["/", "Eve, home"],
      ["/privacy", "Privacy"],
    ])
    const svg = footer.querySelector("svg.landing-outline-wordmark")!
    expect(svg).toHaveAttribute("aria-hidden", "true")
    expect(svg).toHaveAttribute("width", "1120")
    expect(svg).toHaveAttribute("height", "336")
  })

  it("the skip link comes first and moves focus to main", async () => {
    const user = userEvent.setup({ delay: null })
    await openLanding()
    await user.tab()
    const skip = screen.getByRole("link", { name: "Skip to content" })
    expect(skip).toHaveFocus()
    expect(skip).toHaveAttribute("href", "#main")
  })

  it("Tab order follows the visual order (Replay hidden without motion)", async () => {
    const user = userEvent.setup({ delay: null })
    await openLanding()
    const names: string[] = []
    for (let i = 0; i < 11; i++) {
      await user.tab()
      const el = document.activeElement as HTMLElement
      names.push(el.getAttribute("aria-label") ?? el.textContent ?? "")
    }
    expect(names).toEqual([
      "Skip to content",
      "Eve, home",
      "How access works",
      "Sign in",
      "Sign in",
      "How access works",
      "Request access",
      "Privacy page",
      "Sign in",
      "Eve, home",
      "Privacy",
    ])
  })

  it("the access jump focuses the section heading and keeps the hash", async () => {
    const user = userEvent.setup({ delay: null })
    const { currentPath } = await openLanding()
    const hero = screen.getByRole("region", { name: HEADLINE })
    await user.click(within(hero).getByRole("link", { name: "How access works" }))
    expect(screen.getByRole("heading", { name: "How access works" })).toHaveFocus()
    expect(window.location.hash === "#access" || currentPath() === "/").toBe(true)
  })

  it("the frame is hidden from assistive tech, inert, and summarised before it", async () => {
    await openLanding()
    const frame = document.querySelector(".hf")!
    expect(frame).toHaveAttribute("aria-hidden", "true")
    expect(frame).toHaveAttribute("inert")
    expect(screen.getByText(/^Example with a made-up company\./)).toHaveClass("sr-only")
    // The only live region is the app toaster (design-spec r3: Sonner, app.toast.region_label); the page adds none (AC 6.3).
    expect([...document.querySelectorAll("[aria-live]")].map((el) => el.getAttribute("aria-label"))).toEqual(["Messages"])
  })

  it("without motion the frame rests on its end state, Replay is hidden and nothing is hidden by a reveal", async () => {
    await openLanding()
    expect(document.querySelector(".hf")).toHaveAttribute("data-motion", "end")
    const replay = document.querySelector<HTMLButtonElement>('button[aria-label="Replay animation"]')!
    expect(replay).toHaveAttribute("hidden")
    expect(replay).not.toBeVisible()
    expect(document.documentElement).not.toHaveClass("motion-ready")
  })

  // design-spec r3 S1 changes 1 to 6 (page-structure.feature r2).
  it("the headline's second line is a separate ink span and the accessible name is unchanged", async () => {
    await openLanding()
    const h1 = screen.getByRole("heading", { level: 1 })
    expect(h1).toHaveAccessibleName(HEADLINE)
    expect(h1.textContent).toBe(HEADLINE)
    expect(h1.querySelector(".landing-h1-ink")).toHaveTextContent("Asks instead of guessing.")
  })

  it("grounds run hero field, white, tint (Stops), white (Limits), tint (Access)", async () => {
    await openLanding()
    expect(document.querySelector("[data-landing-root]")).toHaveClass("landing-root")
    const ground = (name: string) => screen.getByRole("region", { name }).getAttribute("data-ground")
    expect(ground("How Eve works")).toBeNull()
    expect(ground("When Eve stops and asks")).toBe("tint")
    expect(ground("Limits you control")).toBeNull()
    expect(ground("How access works")).toBe("tint")
  })

  it("each of the nine Stops icons sits in a disc, hidden from assistive tech", async () => {
    await openLanding()
    const stops = screen.getByRole("region", { name: "When Eve stops and asks" })
    const discs = stops.querySelectorAll(".landing-stop-disc")
    expect(discs).toHaveLength(9)
    discs.forEach((disc) => {
      expect(disc).toHaveAttribute("aria-hidden", "true")
      expect(disc.querySelector("svg")).not.toBeNull()
    })
  })
})
