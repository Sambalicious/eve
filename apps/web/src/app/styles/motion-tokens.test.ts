import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { CSS_TOKENS } from "@/shared/lib/motion"

// Vitest stubs CSS imports, so read the stylesheet itself.
const css = readFileSync(`${(import.meta as ImportMeta & { dirname: string }).dirname}/index.css`, "utf8")
const normalize = (value: string) => value.replace(/\s+/g, " ").replace(/\(\s/g, "(").replace(/\s\)/g, ")").trim()

describe("motion tokens", () => {
  it.each(Object.entries(CSS_TOKENS))("%s in index.css equals tokens.ts", (name, value) => {
    const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css)
    expect(match, `${name} missing from index.css`).not.toBeNull()
    expect(normalize(match![1])).toBe(normalize(value))
  })
})
