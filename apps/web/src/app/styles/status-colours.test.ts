import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { contrast, cssBlock, fromHex, readTokens, resolveColour, type Rgb } from "@/shared/testing/colour"

// status-colours.feature: GitHub Primer success and danger tokens (design-spec.r3 P7).
// Vitest stubs CSS imports, so read the stylesheet and resolve the tokens here.
const css = readFileSync(`${(import.meta as ImportMeta & { dirname: string }).dirname}/index.css`, "utf8")

type Theme = "light" | "dark"

function tokens(theme: Theme): Record<string, string> {
  const out = readTokens(cssBlock(css, ":root"))
  return theme === "dark" ? readTokens(cssBlock(css, ".dark"), out) : out
}

function fail(name: string): never {
  throw new Error(`${name} missing`)
}

function hex(theme: Theme, token: string): Rgb {
  const table = tokens(theme)
  return resolveColour(table[token] ?? fail(token), table)
}

function ratio(theme: Theme, fg: string, bg: string): number {
  return contrast(hex(theme, fg), hex(theme, bg))
}

describe("status colours: text contrast (4.5:1)", () => {
  const surfaces = ["--background", "--popover", "--muted"]
  const cases: [Theme, string, string][] = []
  for (const theme of ["light", "dark"] as const) {
    for (const text of ["--success-text", "--destructive-text"]) {
      for (const s of [...surfaces, text.replace("-text", "-muted")]) cases.push([theme, text, s])
    }
  }
  it.each(cases)("%s %s on %s", (theme, fg, bg) => {
    expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(4.5)
  })
})

describe("status colours: white on fills (4.5:1)", () => {
  it.each([
    ["light", "--success-foreground", "--success"],
    ["light", "--destructive-foreground", "--destructive"],
    ["dark", "--success-foreground", "--success"],
    ["dark", "--destructive-foreground", "--destructive"],
  ] as [Theme, string, string][])("%s %s on %s", (theme, fg, bg) => {
    expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(4.5)
    expect(hex(theme, fg).map(Math.round)).toEqual([255, 255, 255])
  })
})

describe("status colours: fills as graphics (3:1)", () => {
  it.each([
    ["light", "--success", "--background"],
    ["light", "--destructive", "--background"],
    ["light", "--destructive", "--popover"],
    ["dark", "--success", "--background"],
    ["dark", "--success", "--popover"],
    ["dark", "--destructive", "--background"],
    ["dark", "--destructive", "--popover"],
  ] as [Theme, string, string][])("%s %s on %s", (theme, fg, bg) => {
    expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(3)
  })
})

describe("status colours: GitHub Primer values", () => {
  it.each([
    ["light", "--success-text", "#1a7f37"],
    ["light", "--success", "#1f883d"],
    ["light", "--success-muted", "#dafbe1"],
    ["light", "--destructive-text", "#d1242f"],
    ["light", "--destructive", "#cf222e"],
    ["light", "--destructive-muted", "#ffebe9"],
    ["dark", "--success-text", "#3fb950"],
    ["dark", "--success", "#238636"],
    ["dark", "--destructive-text", "#f85149"],
    ["dark", "--destructive", "#da3633"],
  ] as [Theme, string, string][])("%s %s renders as %s within 1 per channel", (theme, token, want) => {
    const got = hex(theme, token)
    fromHex(want).forEach((n, i) => expect(Math.abs(got[i] - n)).toBeLessThanOrEqual(1))
  })

  it("dark text tokens have their own values instead of copying the fill", () => {
    const dark = tokens("dark")
    expect(dark["--success-text"]).not.toBe("var(--success)")
    expect(dark["--destructive-text"]).not.toBe("var(--destructive)")
    expect(hex("dark", "--success-text")).not.toEqual(hex("dark", "--success"))
    expect(hex("dark", "--destructive-text")).not.toEqual(hex("dark", "--destructive"))
  })

  it("warning, info, primary, ring and neutral tokens are unchanged", () => {
    const pinned: Record<Theme, Record<string, string>> = {
      light: {
        "--warning": "oklch(0.74 0.14 75)",
        "--warning-text": "oklch(0.5 0.12 65)",
        "--info": "oklch(0.55 0.15 245)",
        "--info-text": "oklch(0.46 0.15 245)",
        "--primary": "oklch(0.53 0.19 262)",
        "--ring": "oklch(0.53 0.19 262)",
        "--background": "oklch(1 0 0)",
        "--foreground": "oklch(0.2 0.012 260)",
        "--muted": "oklch(0.967 0.004 255)",
        "--muted-foreground": "oklch(0.5 0.014 258)",
        "--popover": "oklch(1 0 0)",
      },
      dark: {
        "--warning": "oklch(0.8 0.13 80)",
        "--warning-text": "var(--warning)",
        "--info": "oklch(0.72 0.12 245)",
        "--info-text": "var(--info)",
        "--primary": "oklch(0.68 0.16 262)",
        "--ring": "oklch(0.68 0.16 262)",
        "--background": "oklch(0.175 0.008 260)",
        "--foreground": "oklch(0.95 0.004 255)",
        "--muted": "oklch(0.24 0.009 260)",
        "--muted-foreground": "oklch(0.71 0.012 258)",
        "--popover": "oklch(0.215 0.009 260)",
      },
    }
    for (const theme of ["light", "dark"] as const) {
      const table = tokens(theme)
      for (const [name, value] of Object.entries(pinned[theme])) expect(table[name], `${theme} ${name}`).toBe(value)
    }
  })
})
