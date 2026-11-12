import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { contrast, cssBlock, over, readTokens, resolveColour, type Rgb } from "@/shared/testing/colour"

// design-spec.r3 P6 (Persuade, landing only), page-structure.feature (visual system,
// display sizes, stops discs), illustrations.feature (hero field contrast, forced
// colours, reduced transparency). Vitest stubs CSS imports, so read the files.
const dir = (import.meta as ImportMeta & { dirname: string }).dirname
const index = readFileSync(`${dir}/index.css`, "utf8")
const landing = readFileSync(`${dir}/landing.css`, "utf8")

type Theme = "light" | "dark"

function tokens(theme: Theme): Record<string, string> {
  const t = readTokens(cssBlock(index, ":root"))
  if (theme === "dark") readTokens(cssBlock(index, ".dark"), t)
  readTokens(cssBlock(landing, ".landing-root"), t)
  if (theme === "dark") readTokens(cssBlock(landing, ".dark .landing-root"), t)
  return t
}
const colour = (theme: Theme, name: string): Rgb => {
  const t = tokens(theme)
  if (!t[name]) throw new Error(`${theme} ${name} missing`)
  return resolveColour(t[name], t)
}
const ratio = (theme: Theme, fg: string, bg: string) => contrast(colour(theme, fg), colour(theme, bg))

const PERSUADE = ["--persuade-accent", "--persuade-ink", "--persuade-tint", "--persuade-tint-strong", "--illo-fill", "--illo-fill-2", "--illo-stroke", "--illo-accent", "--illo-paper"]

describe("Persuade tokens (P6)", () => {
  it("are defined on .landing-root only, never on the app root", () => {
    for (const name of PERSUADE) {
      expect(cssBlock(landing, ".landing-root"), name).toContain(`${name}:`)
      expect(index, name).not.toContain(`${name}:`)
    }
  })

  it.each(["light", "dark"] as const)("%s: text pairs on the tint and field meet the spec floor", (theme) => {
    expect(ratio(theme, "--foreground", "--persuade-tint")).toBeGreaterThanOrEqual(15)
    expect(ratio(theme, "--muted-foreground", "--persuade-tint")).toBeGreaterThanOrEqual(4.5)
    expect(ratio(theme, "--primary", "--persuade-tint")).toBeGreaterThanOrEqual(4.5)
    expect(ratio(theme, "--persuade-ink", "--background")).toBeGreaterThanOrEqual(7)
    expect(ratio(theme, "--persuade-ink", "--persuade-tint")).toBeGreaterThanOrEqual(7)
  })

  it.each(["light", "dark"] as const)("%s: graphics on their grounds meet 3:1", (theme) => {
    expect(ratio(theme, "--primary", "--persuade-tint-strong")).toBeGreaterThanOrEqual(3)
    expect(ratio(theme, "--persuade-accent", "--background")).toBeGreaterThanOrEqual(3)
  })

  it.each(["light", "dark"] as const)("%s: both headline lines keep 7:1 on the hero field's strongest point", (theme) => {
    // Field peak: each radial at its full strength over the tint (the linear base's top).
    const t = tokens(theme)
    for (const [radial, strength] of [["--primary", t["--hero-field-a"]], ["--persuade-accent", t["--hero-field-b"]]] as const) {
      const peak = over(colour(theme, radial), parseFloat(strength) / 100, colour(theme, "--persuade-tint"))
      expect(contrast(colour(theme, "--foreground"), peak)).toBeGreaterThanOrEqual(7)
      expect(contrast(colour(theme, "--persuade-ink"), peak)).toBeGreaterThanOrEqual(7)
      expect(contrast(colour(theme, "--muted-foreground"), peak)).toBeGreaterThanOrEqual(4.5)
    }
  })
})

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  if (!match) throw new Error(`${selector} missing`)
  return match[2]
}

describe("Persuade layer CSS", () => {
  it("display type: h1 clamp(40, 5.2vw + 12, 76) at 650 and h2 clamp(28, 2.2vw + 14, 44)", () => {
    const h1 = rule(landing, ".landing-root .landing-h1")
    expect(h1).toContain("font-size: clamp(40px, 5.2vw + 12px, 76px)")
    expect(h1).toContain("font-weight: 650")
    expect(h1).toContain("letter-spacing: -0.035em")
    expect(h1).toContain("line-height: 1")
    const h2 = rule(landing, ".landing-root .landing-h2")
    expect(h2).toContain("font-size: clamp(28px, 2.2vw + 14px, 44px)")
    expect(h2).toContain("letter-spacing: -0.025em")
    expect(rule(landing, ".landing-root .landing-h1-ink")).toContain("color: var(--persuade-ink)")
  })

  it("the hero field is static CSS with no blur and is removed for reduced transparency and forced colours", () => {
    const field = rule(landing, ".landing-hero::before")
    expect(field).toContain("radial-gradient")
    expect(field).not.toMatch(/blur|animation|transition/)
    expect(landing).toMatch(/@media \(prefers-reduced-transparency: reduce\)\s*\{[^@]*\.landing-hero::before\s*\{\s*display: none;/)
    expect(landing).toMatch(/@media \(forced-colors: active\)\s*\{[^@]*\.landing-hero::before[^{]*\{\s*display: none;/)
  })

  it("Stops and Access sit on the tint; ground changes drop the hairline; forced colours restore it", () => {
    expect(rule(landing, '.landing-section[data-ground="tint"]')).toContain("background: var(--persuade-tint)")
    expect(rule(landing, '.landing-section[data-ground="tint"] > .landing-ruled::before, .landing-section[data-ground="tint"] + .landing-section > .landing-ruled::before')).toContain("display: none")
    expect(landing).toMatch(/@media \(forced-colors: active\)\s*\{[^@]*\[data-ground="tint"\][^{]*\{[^}]*display: block;/)
  })

  it("Stops icons sit in 32px discs of --persuade-tint-strong with cobalt strokes", () => {
    const disc = rule(landing, ".landing-stop-disc")
    expect(disc).toContain("width: 32px")
    expect(disc).toContain("height: 32px")
    expect(disc).toContain("background: var(--persuade-tint-strong)")
    expect(disc).toContain("color: var(--primary)")
    expect(disc).toContain("flex-shrink: 0")
  })

  it("the azure accent is never used for text, links or controls", () => {
    const uncommented = landing.replace(/\/\*[\s\S]*?\*\//g, "")
    const uses = [...uncommented.matchAll(/([^{}]+)\{[^}]*var\(--persuade-accent\)[^}]*\}/g)].map((m) => m[1].trim())
    for (const selector of uses) expect(selector).not.toMatch(/link|button|(^|[\s,])a\b|landing-h[1-3]|text|input/)
  })
})
