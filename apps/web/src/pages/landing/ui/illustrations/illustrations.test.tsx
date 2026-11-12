import { readFileSync } from "node:fs"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { LandingContent } from "../landing-content"
import { HeroFragments } from "./hero-fragments"

// illustrations.feature: presence, accessibility, inline markup, labels.
const css = readFileSync(`${(import.meta as ImportMeta & { dirname: string }).dirname}/../../../../app/styles/landing.css`, "utf8")

function renderPage() {
  return render(
    <MemoryRouter>
      <LandingContent path="/" signedIn={false} />
    </MemoryRouter>
  )
}

describe("landing illustrations", () => {
  it("renders five step spots, I-STOPS and I-LIMITS, each hidden from assistive tech with no title, label or role", () => {
    renderPage()
    const spots = document.querySelectorAll(".illo")
    expect([...spots].map((el) => [...el.classList].find((c) => /^illo-(step-\d|stops|limits)$/.test(c)))).toEqual([
      "illo-step-1",
      "illo-step-2",
      "illo-step-3",
      "illo-step-4",
      "illo-step-5",
      "illo-stops",
      "illo-limits",
    ])
    for (const el of spots) {
      expect(el).toHaveAttribute("aria-hidden", "true")
      const svg = el.querySelector("svg")!
      expect(svg).toHaveAttribute("focusable", "false")
      expect(svg.querySelector("title")).toBeNull()
      expect(svg).not.toHaveAttribute("role")
      expect(svg).not.toHaveAttribute("aria-label")
      expect(el.getAttribute("style")).toMatch(/aspect-ratio/)
    }
  })

  it("puts each step's spot inside its step, the stops art in the stops section and the limits art in the limits section", () => {
    renderPage()
    const steps = screen.getByRole("region", { name: "How Eve works" }).querySelectorAll("li")
    steps.forEach((step, index) => expect(step.querySelector(`.illo-step-${index + 1}`)).not.toBeNull())
    expect(screen.getByRole("region", { name: "When Eve stops and asks" }).querySelector(".illo-stops")).not.toBeNull()
    expect(screen.getByRole("region", { name: "Limits you control" }).querySelector(".illo-limits")).not.toBeNull()
  })

  it("is inline vector markup only: no image, no external file, no SMIL, no ids that could collide", () => {
    const { container } = renderPage()
    expect(container.querySelectorAll(".illo img, .hero-frags img, .illo image, .hero-frags image, .illo use")).toHaveLength(0)
    expect(container.querySelectorAll(".illo animate, .illo animateTransform, .hero-frags animate")).toHaveLength(0)
    expect(container.querySelectorAll(".illo [id], .hero-frags [id]")).toHaveLength(0)
    expect(container.querySelectorAll(".illo [filter], .illo linearGradient, .illo radialGradient")).toHaveLength(0)
  })

  it("paints only through the --illo tokens (no literal colours, no status colour in the spots)", () => {
    renderPage()
    for (const el of document.querySelectorAll(".illo svg *")) {
      expect(el.getAttribute("fill") ?? "none").toMatch(/^(none)$/)
      expect(el.getAttribute("stroke")).toBeNull()
    }
    const illoRules = css.slice(css.indexOf("/* ── Illustrations"), css.indexOf("/* ── Hero fragments"))
    expect(illoRules).not.toMatch(/--success|--destructive|--warning|#[0-9a-f]{3,6}\b|oklch\(/i)
  })

  it("the hero fragments are hidden from assistive tech and the pointer, and are never focusable", async () => {
    renderPage()
    const frags = document.querySelector(".hero-frags")!
    expect(frags).toHaveAttribute("aria-hidden", "true")
    expect(css).toMatch(/\.hero-frags \{[^}]*pointer-events: none;/)
    expect(frags.querySelectorAll("a, button, input, [tabindex]")).toHaveLength(0)
    const user = userEvent.setup()
    for (let n = 0; n < 40; n += 1) {
      await user.tab()
      expect(frags.contains(document.activeElement)).toBe(false)
      expect(document.activeElement?.closest(".illo")).toBeNull()
    }
  })

  it("fragment labels come from the copy deck; F4 has no text", () => {
    render(<HeroFragments />)
    const text = (n: number) => document.querySelector(`[data-fragment="${n}"]`)?.textContent
    expect(text(1)).toBe("Passes Eligibility")
    expect(text(2)).toBe("Strong core Match")
    expect(text(3)).toBe("Confirmed Submission")
    expect(text(4)).toBe("")
  })

  it("a fragment with an empty label is not rendered at all", () => {
    render(<HeroFragments labels={{ eligibility: "Passes Eligibility", match: "", confirmed: "Confirmed Submission" }} />)
    expect(document.querySelector('[data-fragment="2"]')).toBeNull()
    expect(document.querySelectorAll("[data-fragment]")).toHaveLength(3)
  })

  it("a long label truncates with an ellipsis inside a 200 px chip", () => {
    expect(css).toMatch(/\.hero-chip \{[^}]*max-width: 200px;/)
    expect(css).toMatch(/\.hero-chip-label \{[^}]*text-overflow: ellipsis;/)
  })

  it("the screen-reader text of the page never includes fragment labels", () => {
    renderPage()
    const main = screen.getByRole("main")
    const readable = [...main.querySelectorAll("*")].filter((el) => !el.closest("[aria-hidden='true']") && el.children.length === 0).map((el) => el.textContent).join(" ")
    expect(readable).not.toContain("Passes Eligibility")
  })
})

describe("hero fragment visible sets and preferences (CSS)", () => {
  it("F2 and F4 everywhere, F3 from 768, F1 from 1280, none on short landscape", () => {
    expect(css).toMatch(/\.hero-frag-2,\s*\.hero-frag-4 \{ display: block; \}/)
    expect(css).toMatch(/@media \(min-width: 768px\) \{\s*\.hero-frag-3 \{ display: block; \}/)
    expect(css).toMatch(/@media \(min-width: 1280px\) \{\s*\.hero-frag-1 \{ display: block; \}/)
    expect(css).toMatch(/@media \(max-height: 479px\) \{\s*\.hero-frag \{ display: none !important; \}/)
  })

  it("drift is transform-only keyframes, out of phase, 4 to 8 px over 6 to 9.5 s, paused by attribute, layer hint only while visible", () => {
    expect(css).toMatch(/@keyframes hero-drift \{\s*from \{ transform: translate3d\(0, 0, 0\); \}\s*to \{ transform: translate3d\(0, calc\(var\(--amp\) \* -1\), 0\); \}/)
    expect(css).toContain(".landing-hero[data-drift-paused] .hero-frag-drift {\n  animation-play-state: paused;")
    expect(css).toMatch(/\.landing-hero\[data-drift="on"\]\[data-hero-visible\]:not\(\[data-drift-paused\]\) \.hero-frag-drift \{\s*will-change: transform;/)
    const phases = [...css.matchAll(/--phase: (-[\d.]+s)/g)].map((m) => m[1])
    expect(new Set(phases).size).toBe(4)
  })

  it("reduced motion removes entrance, drift and parallax", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.hero-frag,\s*\.hero-frag-drift,\s*\.hero-frag-card \{\s*animation: none !important;\s*transform: none !important;/)
  })

  it("fragment cards are hidden only while the frame is armed under motion-ok (visible without JS)", () => {
    expect(css).toMatch(/html\.motion-ok \.hf-stage:has\(> \.hf\[data-motion="armed"\]\) \.hero-frag-card \{\s*opacity: 0;/)
  })

  it("forced colours draw illustrations in Canvas and CanvasText", () => {
    const block = css.slice(css.indexOf("@media (forced-colors: active) {\n  .illo svg *"))
    expect(block).toMatch(/fill: Canvas;/)
    expect(block).toMatch(/stroke: CanvasText;/)
  })
})
