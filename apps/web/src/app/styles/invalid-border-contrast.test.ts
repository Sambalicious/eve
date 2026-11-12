import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { contrast, cssBlock, over, readTokens, resolveColour, type Rgb } from "@/shared/testing/colour"

// status-colours.feature "Invalid field borders meet 3:1 in both themes" (F-QA-E3C-03).
// Reads the real tokens and the real class lists, so an alpha suffix on the
// invalid border (e.g. `dark:aria-invalid:border-destructive/50`) is counted.
// Scans every source file under apps/web/src that sets an `aria-invalid:border`
// class, so a local copy of the shared field classes can't drift back.
const dir = (import.meta as ImportMeta & { dirname: string }).dirname
const srcRoot = `${dir}/../..`
const css = readFileSync(`${dir}/index.css`, "utf8")

const INVALID_BORDER = /aria-invalid:border-/
const sources: [string, string][] = readdirSync(srcRoot, { recursive: true })
  .map((file) => file.replaceAll("\\", "/"))
  .filter((file) => /\.(tsx?|css)$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file))
  .map((file): [string, string] => [file, readFileSync(`${srcRoot}/${file}`, "utf8")])
  .filter(([, text]) => INVALID_BORDER.test(text))

type Theme = "light" | "dark"

function tokens(theme: Theme): Record<string, string> {
  const out = readTokens(cssBlock(css, ":root"))
  return theme === "dark" ? readTokens(cssBlock(css, ".dark"), out) : out
}

function colour(theme: Theme, token: string): Rgb {
  const table = tokens(theme)
  const value = table[`--${token}`]
  if (!value) throw new Error(`--${token} missing`)
  return resolveColour(value, table)
}

/** The invalid border colour token and alpha a theme applies, from the class list. */
function invalidBorder(classes: string, theme: Theme): { token: string; alpha: number } {
  const pattern = (prefix: string) => new RegExp(`(?:^|[\\s"'\`])${prefix}aria-invalid:border-([a-z-]+)(?:/(\\d+))?(?=[\\s"'\`]|$)`)
  const match = (theme === "dark" ? classes.match(pattern("dark:")) : null) ?? classes.match(pattern(""))
  if (!match) throw new Error("no aria-invalid border class")
  return { token: match[1]!, alpha: match[2] ? Number(match[2]) / 100 : 1 }
}

describe("invalid field border contrast against the dialog surface (3:1)", () => {
  it("finds the shared fields and the request-access fields", () => {
    const files = sources.map(([file]) => file)
    expect(files).toEqual(
      expect.arrayContaining(["shared/ui/input.tsx", "shared/ui/textarea.tsx", "features/request-access/ui/fields.tsx"]),
    )
  })

  it.each(sources.map(([file]) => file))("%s has no opacity suffix on a dark invalid border", (file) => {
    const text = sources.find(([name]) => name === file)![1]
    expect(text.match(/dark:aria-invalid:border-[a-z-]+\/\d+/g) ?? []).toEqual([])
  })

  const cases: [string, Theme][] = []
  for (const [file] of sources) for (const theme of ["light", "dark"] as const) cases.push([file, theme])

  it.each(cases)("%s in the %s theme", (file, theme) => {
    const { token, alpha } = invalidBorder(sources.find(([name]) => name === file)![1], theme)
    const surface = colour(theme, "popover")
    const border = over(colour(theme, token), alpha, surface)
    expect(contrast(border, surface)).toBeGreaterThanOrEqual(3)
  })
})
